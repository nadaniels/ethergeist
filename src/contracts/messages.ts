import { type AbiFunction, type Address, toFunctionSignature } from "viem";

import {
  type ReceivedCall,
  describeMock,
  formatCall,
  formatMismatch,
  formatValue,
  formatNoAnswer,
  formatReceived,
  missedLines,
  removedLines,
} from "../mocking/format.js";
import { mismatches, mismatchesAsMatched } from "../mocking/matching.js";
import type { Answer, PinnedKey } from "../mocking/types.js";
import { MockNotFoundError } from "../shared/errors.js";
import { type Pins, pinMismatches } from "./functions.js";
import type { MockCall, MockNamespace } from "./types.js";

/** A contract's mock, as messages describe it. */
type Mock = {
  namespace: MockNamespace;
  abiItem: AbiFunction;
  pinned: unknown;
  pins: Pins | undefined;
  limit: number | undefined;
  remaining: number | undefined;
  answer: Answer | undefined;
};

/**
 * A namespace's mocks for a call's function, the arg or pin each one
 * `missed` on, and those the last restore removed that match the call.
 */
type Candidates = {
  registered: readonly Mock[];
  missed: ReadonlyMap<Mock, PinnedKey>;
  removed: readonly Mock[];
};

/**
 * The error for a call no mock answers, on the contract `label`: its `own`
 * namespace's mocks for its function, each with the arg it missed on, or that
 * there are none. An estimate's also lists its function's `write` mocks
 * (`writes`), which imply the estimate of a send they match, for an estimate
 * with `from`. Then come the mocks on the function's other overloads
 * (`overloads.others`), which can't answer it, each in another namespace
 * than the call's marked with it; with any, the call's own overload
 * (`overloads.called`) is named by its signature. Then the mocks of both
 * that the last restore removed, and last the `after` lines of a turn's
 * caller.
 */
export function missError(
  call: MockCall,
  namespace: MockNamespace,
  label: string,
  own: Candidates,
  {
    writes,
    overloads,
    after = [],
  }: {
    writes?: Candidates;
    overloads?: { called: AbiFunction; others: readonly Mock[] };
    after?: readonly string[];
  } = {},
): MockNotFoundError {
  const describe = ({ registered, missed }: Candidates) =>
    missedLines(call.functionName, registered, missed, argName);
  const lines = describe(own);
  const writeLines = writes === undefined ? [] : describe(writes);
  const others = overloads?.others ?? [];
  const name =
    overloads !== undefined && others.length > 0
      ? toFunctionSignature(overloads.called)
      : `"${call.functionName}"`;
  const what = namespace === "read" || namespace === "simulate" ? "mock" : `${namespace} mock`;
  const none = {
    read: `No mocks registered for ${name}.`,
    simulate: `No mocks registered for ${name}.`,
    estimateGas: `No estimateGas mocks registered for ${name}; ${call.from === undefined ? "a write mock implies one only for an estimate with a sender" : "a write mock that matches the send implies one"}, and a simulate mock doesn't answer estimates.`,
    write: `No write mocks registered for ${name}; a simulate mock doesn't answer sends.`,
  }[namespace];
  const pinned = [...own.registered, ...(writes?.registered ?? [])].flatMap((mock) =>
    Object.keys(mock.pins ?? {}),
  );
  const metaMessages = lines.length > 0 ? ["Registered:", ...lines] : [];
  if (writeLines.length > 0)
    metaMessages.push("Write mocks, which imply the estimate of a send they match:", ...writeLines);
  if (metaMessages.length === 0) metaMessages.push(none);
  if (others.length > 0)
    metaMessages.push(
      `Mocks on ${call.functionName}'s other overloads, which don't answer this one:`,
      ...others.map(
        (mock) =>
          `  ${describeMock(call.functionName, mock)}${mock.namespace === namespace ? "" : `, a ${mock.namespace} mock`}`,
      ),
    );
  const removed = [...own.removed, ...(writes?.removed ?? [])].map(
    (mock) => `  ${describeMock(call.functionName, mock)}`,
  );
  metaMessages.push(...removedLines(removed), ...after);
  return new MockNotFoundError(
    `No ${what} for ${formatCall(call.functionName, call.args)}${formatPins(call, pinned)} on ${label}.`,
    { metaMessages },
  );
}

/**
 * An unused mock on the contract `label`, with the `calls` its function
 * received instead.
 */
export function unusedLine(
  mock: Mock,
  label: string,
  calls: readonly MockCall[],
  /** Every call received, including those dropped past `historyLimit`. */
  total: number,
): string {
  const name = mock.abiItem.name;
  const after =
    mock.answer === undefined
      ? formatNoAnswer(
          mock.namespace === "read"
            ? ".returns(), .reverts() or .fails()"
            : ".returns(), .reverts(), .fails() or .refuses()",
        )
      : formatReceived(
          name,
          calls.map((call) => received(mock, call)),
          total,
        );
  return `${describeMock(name, mock)} on ${label}${after}`;
}

/**
 * A call `mock`'s function received, and where it first differs from
 * `mock`'s args, or else its `from` and `value`, shown when they differ.
 */
function received(mock: Mock, call: MockCall): ReceivedCall {
  const mismatched = mismatchesAsMatched((options) => [
    ...mismatches(mock.pinned, call.args, options),
    ...pinMismatches(mock.pins, call, options),
  ]);
  const [key] = mismatched;
  return {
    call: `${formatMismatch(call.functionName, call.args, mismatched)}${formatPins(call, mismatched)}`,
    differs: key === undefined ? undefined : argName(mock, key),
  };
}

/**
 * A call's `from` and `value` among `keys`, after its args, e.g.
 * ` { from: 0x… }`; empty for none.
 */
function formatPins(call: MockCall, keys: readonly PinnedKey[]): string {
  const shown = Object.entries({ from: call.from, value: call.value }).filter(([key]) =>
    keys.includes(key),
  );
  return shown.length === 0 ? "" : ` ${formatValue(Object.fromEntries(shown))}`;
}

/**
 * Arg `index` of `mock`'s function by its ABI name; unnamed inputs (`""`) are
 * numbered from 1, and `null` is all of them. `from` and `value` are pins,
 * named as they're pinned (`{ from }`), apart from inputs with those names.
 */
function argName(mock: Mock, index: PinnedKey): string {
  if (index === null) return "args";
  if (typeof index === "string") return `{ ${index} }`;
  return inputName(mock.abiItem, index);
}

/**
 * Input `index` of `abiItem` by its ABI name, or numbered from 1 when it's
 * unnamed (`""`) or the function isn't known yet: an overload not chosen.
 */
export function inputName(abiItem: AbiFunction | undefined, index: number): string {
  const name = abiItem?.inputs[index]?.name;
  return name === undefined || name === "" ? `arg ${index + 1}` : name;
}

/** A contract for messages: its name and address, or just the address. */
export function formatContract(address: Address, name: string | undefined): string {
  return name === undefined ? address : `${name} (${address})`;
}
