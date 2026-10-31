import type { AbiFunction, Address, Hex } from "viem";
import type { ActionCalls } from "../actions/types.js";
import type { MockCall } from "../contracts/types.js";
import type { MockNotFoundError, MockResolverError } from "../errors.js";
import type { MockNodeFault } from "../mocking/types.js";

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

/** A contract call the mock dispatched, directly or inside a multicall. */
export type MockCallRecord = {
  address: Address;
  /** The contract's name, if it was registered with one. */
  name: string | undefined;
  /** The function called, from the contract's ABI; `undefined` when it couldn't be decoded. */
  abiItem: AbiFunction | undefined;
  /** The decoded call, or `undefined` if it couldn't be decoded (no contract, unknown selector, an empty address). */
  call: MockCall | undefined;
  outcome: MockOutcome;
};

type EntryBase<type extends string> = {
  type: type;
  method: string;
  params: unknown;
  outcome: MockOutcome;
};

/** One JSON-RPC request the mock received, and how it was answered. Retries are separate entries. */
export type MockHistoryEntry =
  | (EntryBase<"call"> & { to: Address | undefined; call: MockCallRecord | undefined })
  | (EntryBase<"multicall"> & { batchId: number | undefined; calls: MockCallRecord[] })
  | {
      [action in keyof ActionCalls]: EntryBase<"action"> & {
        action: action;
        call: ActionCalls[action] | undefined;
      } & (action extends "estimateGas"
          ? {
              /** The registered contract's function estimated, decoded, if `to` is one. */
              contract?: MockCallRecord;
            }
          : unknown);
    }[keyof ActionCalls]
  | EntryBase<"method">
  | EntryBase<"builtIn">;
