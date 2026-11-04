import type { AbiFunction, Address } from "viem";

import {
  type ReceivedCall,
  describeMock,
  formatCall,
  formatMismatch,
  formatMissReason,
  formatNoAnswer,
  formatReceived,
} from "../mocking/format.js";
import { mismatches } from "../mocking/matching.js";
import type { PinnedKey } from "../mocking/types.js";
import { MockNotFoundError } from "../shared/errors.js";
import type { MockCall, MockNamespace } from "./types.js";

/** A contract's mock, as messages describe it. */
type Mock = {
  abiItem: AbiFunction;
  pinned: unknown;
  limit: number | undefined;
  remaining: number | undefined;
  resolver: unknown;
};

/** A namespace's mocks for a call's function, and the arg each one `missed` on. */
type Candidates = { registered: readonly Mock[]; missed: ReadonlyMap<Mock, PinnedKey> };

/**
 * The error for a call no mock answers, on the contract `label`: its `own`
 * namespace's mocks for its function, each with the arg it missed on, or that
 * there are none. An estimate's also lists its function's `writes`, which
 * imply the estimate of a send they match (only for an estimate with `from`).
 */
export function missError(
  call: MockCall,
  namespace: MockNamespace,
  label: string,
  own: Candidates,
  writes?: Candidates,
): MockNotFoundError {
  const describe = ({ registered, missed }: Candidates) =>
    registered.map((mock) => {
      const key = missed.get(mock);
      const reason = formatMissReason(key === undefined ? undefined : argName(mock, key));
      return `  ${describeMock(call.functionName, mock)}${reason}`;
    });
  const lines = describe(own);
  const writeLines = writes === undefined ? [] : describe(writes);
  const name = `"${call.functionName}"`;
  const what = namespace === "read" || namespace === "simulate" ? "mock" : `${namespace} mock`;
  const none = {
    read: `No mocks registered for ${name}.`,
    simulate: `No mocks registered for ${name}.`,
    estimateGas: `No estimateGas mocks registered for ${name}; a write mock that matches the send implies one, and a simulate mock doesn't answer estimates.`,
    write: `No write mocks registered for ${name}; a simulate mock doesn't answer sends.`,
  }[namespace];
  const metaMessages = lines.length > 0 ? ["Registered:", ...lines] : [];
  if (writeLines.length > 0)
    metaMessages.push("Write mocks, which imply the estimate of a send they match:", ...writeLines);
  if (metaMessages.length === 0) metaMessages.push(none);
  return new MockNotFoundError(
    `No ${what} for ${formatCall(call.functionName, call.args)} on ${label}.`,
    { metaMessages },
  );
}

/** An unused mock on the contract `label`, with the `calls` its function received instead. */
export function unusedLine(
  mock: Mock,
  label: string,
  calls: readonly MockCall[],
  /** Every call received, including those dropped past `historyLimit`. */
  total: number,
): string {
  const name = mock.abiItem.name;
  const after =
    mock.resolver === undefined
      ? formatNoAnswer(".returns(), .reverts() or .fails()")
      : formatReceived(
          name,
          calls.map((call) => received(mock, call)),
          total,
        );
  return `${describeMock(name, mock)} on ${label}${after}`;
}

/** A call `mock`'s function received, and where it first differs from `mock`'s args. */
function received(mock: Mock, call: MockCall): ReceivedCall {
  const mismatched = mock.pinned === undefined ? [] : mismatches(mock.pinned, call.args);
  const index = mismatched[0];
  return {
    call: formatMismatch(call.functionName, call.args, mismatched),
    differs: index === undefined ? undefined : argName(mock, index),
  };
}

/**
 * Arg `index` of `mock`'s function by its ABI name; unnamed inputs (`""`) are
 * numbered from 1, and `null` is all of them.
 */
function argName(mock: Mock, index: PinnedKey): string {
  if (index === null) return "args";
  // Args are pinned as an array, so keys are always indexes.
  if (typeof index === "string") return index;
  const inputName = mock.abiItem.inputs[index]?.name;
  return inputName === undefined || inputName === "" ? `arg ${index + 1}` : inputName;
}

/** A contract for messages: its name and address, or just the address. */
export function formatContract(address: Address, name: string | undefined): string {
  return name === undefined ? address : `${name} (${address})`;
}
