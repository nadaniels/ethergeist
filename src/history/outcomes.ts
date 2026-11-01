import type { Abi } from "viem";

import { revertOutcome } from "../contracts/answers.js";
import { MockFailure } from "../mocking/faults.js";
import {
  MockNotFoundError,
  MockResolverError,
  MockRevertError,
  MockRpcError,
} from "../shared/errors.js";
import type { MockOutcome } from "./types.js";

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
