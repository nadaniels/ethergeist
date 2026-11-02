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
import type { Kind } from "./functions.js";
import type { MockCall } from "./types.js";

/** A contract's mock, as messages describe it. */
type Mock = {
  abiItem: AbiFunction;
  pinned: unknown;
  limit: number | undefined;
  remaining: number | undefined;
  resolver: unknown;
};

/**
 * The error for a call no mock answers, on the contract `label`: the mocks
 * `registered` for its function, each with the arg it `missed` on, or that
 * there are none.
 */
export function missError(
  call: MockCall,
  kind: Kind,
  label: string,
  registered: readonly Mock[],
  missed: ReadonlyMap<Mock, PinnedKey>,
): MockNotFoundError {
  const lines = registered.map((mock) => {
    const key = missed.get(mock);
    const reason = formatMissReason(key === undefined ? undefined : argName(mock, key));
    return `  ${describeMock(call.functionName, mock)}${reason}`;
  });
  const what = kind === "estimate" ? "estimateGas mock" : "mock";
  const none =
    kind === "estimate"
      ? `No estimateGas mocks registered for "${call.functionName}"; a simulate mock doesn't answer estimates.`
      : `No mocks registered for "${call.functionName}".`;
  return new MockNotFoundError(
    `No ${what} for ${formatCall(call.functionName, call.args)} on ${label}.`,
    { details: lines.length > 0 ? `Registered:\n${lines.join("\n")}` : none },
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
