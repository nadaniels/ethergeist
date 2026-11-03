import type { Address } from "viem";

import type { ActionCalls } from "../actions/types.js";
import type { MockCallRecord } from "../contracts/types.js";
import type { MockOutcome } from "../mocking/outcomes.js";
import type { MockError } from "../shared/errors.js";

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
        /**
         * The registered contract's record of the call, when the contract had
         * a turn at answering it: an estimate whose `to` is one.
         */
        contract?: MockCallRecord;
      };
    }[keyof ActionCalls]
  | EntryBase<"method">
  | EntryBase<"builtIn">;

export type RpcRequest = { method: string; params?: unknown };

/**
 * A request the mock couldn't answer: nothing was mocked for it
 * (`MockNotFoundError`), a resolver threw (`MockResolverError`), or the mock
 * itself failed (`MockInternalError`).
 */
export type UnhandledRequest = RpcRequest & { error: MockError };
