import { type Abi, type Hex, decodeErrorResult } from "viem";

import { builtinErrors } from "../shared/abiValues.js";
import { MockError, MockInternalError, MockRevertError, MockRpcError } from "../shared/errors.js";
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
  /**
   * Failed with a fault, or a node's refusal by name, from
   * `mock.failRequests()` or a mock's `.fails()` or `fail()`: `source` says
   * which.
   */
  | { type: "fault"; fault: MockNodeFault; source: "failRequests" | "mock" }
  /**
   * Refused with the JSON-RPC error a node gives for the same request, e.g.
   * an `eth_getLogs` block range past the head. It's an answer, not
   * unhandled.
   */
  | { type: "rpcError"; code: number; message: string }
  /**
   * Not answered: nothing was mocked (`MockNotFoundError`), a resolver threw
   * (`MockResolverError`), a static answer doesn't fit the request
   * (`MockSetupError`), or the mock itself failed (`MockInternalError`).
   */
  | { type: "unhandled"; error: MockError };

/**
 * A fault's outcome: the request failed with a fault, from a mock or
 * `mock.failRequests()`.
 */
export type FaultOutcome = Extract<MockOutcome, { type: "fault" }>;

/**
 * A revert's data, decoded against `abi` and the built-in errors where
 * possible.
 */
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

/**
 * Whether `error` is an answer: a revert, a fault, or a node's refusal. The
 * mock throws these on purpose; adapters turn them into their client's errors.
 */
export const isAnswer = (error: unknown) =>
  error instanceof MockRevertError || error instanceof MockFailure || error instanceof MockRpcError;

const wrapped = new WeakMap<object, MockInternalError>();

/**
 * `error` as one of the mock's errors: as is if it's one, or else wrapped in
 * a `MockInternalError`, the same one each time for the same error, so a
 * request and the contract call inside it record the same error.
 */
export function asMockError(error: unknown): MockError {
  if (error instanceof MockError) return error;
  if (typeof error !== "object" || error === null) return new MockInternalError(error);
  let internal = wrapped.get(error);
  if (internal === undefined) {
    internal = new MockInternalError(error);
    wrapped.set(error, internal);
  }
  return internal;
}

/**
 * The outcome of an error thrown while answering, other than reverts and
 * faults.
 */
export function errorOutcome(error: unknown): MockOutcome {
  if (error instanceof MockRpcError)
    return { type: "rpcError", code: error.code, message: error.shortMessage };
  return { type: "unhandled", error: asMockError(error) };
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
