import type { AbiFunction } from "viem";

import {
  type ReceivedCall,
  describeMock,
  formatCall,
  formatMismatch,
  formatReceived,
} from "../mocking/format.js";
import { mismatches } from "../mocking/matching.js";
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
 * `registered` for its function, or that there are none.
 */
export function missError(
  call: MockCall,
  kind: Kind,
  label: string,
  registered: readonly Mock[],
): MockNotFoundError {
  const lines = registered.map((mock) => `  ${describeMock(call.functionName, mock)}`);
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
export function unusedLine(mock: Mock, label: string, calls: readonly MockCall[]): string {
  const name = mock.abiItem.name;
  return `${describeMock(name, mock)} on ${label}${formatReceived(
    name,
    calls.map((call) => received(mock, call)),
  )}`;
}

/** A call `mock`'s function received, and where it first differs from `mock`'s args. */
function received(mock: Mock, call: MockCall): ReceivedCall {
  const mismatched = mock.pinned === undefined ? [] : mismatches(mock.pinned, call.args);
  const index = mismatched[0];
  // Inputs may be unnamed (`""`); those are numbered from 1.
  const inputName = typeof index === "number" ? mock.abiItem.inputs[index]?.name : undefined;
  const differs =
    index === undefined
      ? undefined
      : inputName === undefined || inputName === ""
        ? `arg ${Number(index) + 1}`
        : inputName;
  return { call: formatMismatch(call.functionName, call.args, mismatched), differs };
}
