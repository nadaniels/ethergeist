import { type Abi, type Hex, decodeErrorResult } from "viem";

import { builtinErrors } from "../shared/abiValues.js";
import {
  MockNotFoundError,
  MockResolverError,
  MockRevertError,
  MockRpcError,
} from "../shared/errors.js";
import { MockFailure } from "./faults.js";
import type { MockNodeFault } from "./types.js";

/** How the mock answered a request, or a contract call inside one. */
export type MockOutcome =
  /** Still in flight. */
  | { type: "pending" }
  /** Answered. `value` is in viem's types: what the app receives. */
  | { type: "result"; value: unknown }
  /** Reverted, decoded against the contract's ABI where possible. */
  | { type: "revert"; data: Hex; errorName?: string; args?: readonly unknown[]; reason?: string }
  /** Failed at the network level, by `failRequests()` or a mock's `.fails()`/`fail()`. */
  | { type: "fault"; fault: MockNodeFault; source: "failRequests" | "mock" }
  /**
   * Refused with the JSON-RPC error a node gives for the same request, e.g. a
   * `getLogs` block range past the head. An answer, not unhandled.
   */
  | { type: "rpcError"; code: number; message: string }
  /** Not answered: nothing was mocked, or a resolver threw. */
  | { type: "unhandled"; error: MockNotFoundError | MockResolverError }
  /** The mock itself failed unexpectedly, e.g. on a malformed request. */
  | { type: "error"; error: unknown };

/** A fault's outcome: the request failed at the transport, from a mock or `failRequests()`. */
export type FaultOutcome = Extract<MockOutcome, { type: "fault" }>;

/** A revert's data, decoded against `abi` and the built-in errors where possible. */
function revertOutcome(abi: Abi, data: Hex): Extract<MockOutcome, { type: "revert" }> {
  try {
    const { errorName, args } = decodeErrorResult({ abi: [...abi, ...builtinErrors], data });
    if (errorName === "Error" && typeof args[0] === "string")
      return { type: "revert", data, reason: args[0] };
    return { type: "revert", data, errorName, args: args ?? [] };
  } catch {
    return { type: "revert", data };
  }
}

/** The outcome of an error thrown while answering, other than reverts and faults. */
export function errorOutcome(error: unknown): MockOutcome {
  if (error instanceof MockNotFoundError || error instanceof MockResolverError)
    return { type: "unhandled", error };
  if (error instanceof MockRpcError)
    return { type: "rpcError", code: error.code, message: error.shortMessage };
  return { type: "error", error };
}

/**
 * The outcome of an error thrown while answering: a revert decoded against
 * `abi` and the built-in errors, a mock's fault, or what `errorOutcome` says.
 */
export function failureOutcome(error: unknown, abi: Abi = []): MockOutcome {
  if (error instanceof MockRevertError) return revertOutcome(abi, error.data);
  if (error instanceof MockFailure) return { type: "fault", fault: error.fault, source: "mock" };
  return errorOutcome(error);
}
