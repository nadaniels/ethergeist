import type { Address } from "viem";

import type { ActionCalls } from "../actions/types.js";
import type { MockCallRecord } from "../contracts/types.js";
import type { MockOutcome } from "../mocking/outcomes.js";
import type { MockError } from "../shared/errors.js";

/** What every history entry has. */
type EntryBase<type extends string> = {
  /**
   * The kind of request: a contract call, a Multicall3 batch, a typed
   * action, a raw method, or a built-in (`eth_chainId`, `eth_blockNumber`).
   */
  type: type;
  /** Its JSON-RPC method. */
  method: string;
  /** Its params, as sent. */
  params: unknown;
  /** How it was answered: see `MockOutcome`. */
  outcome: MockOutcome;
};

/**
 * One JSON-RPC request the mock received, and how it was answered. Retries
 * are separate entries.
 */
export type MockHistoryEntry =
  | (EntryBase<"call"> & {
      /** The address called, checksummed; `undefined` without a valid one. */
      to: Address | undefined;
      /**
       * The call's record; `undefined` when the request failed before it was
       * dispatched.
       */
      call: MockCallRecord | undefined;
    })
  | (EntryBase<"multicall"> & {
      /**
       * Its batch's `id`, as each sub-call's `MockBatch` has it; `undefined`
       * when the request failed before it was dispatched.
       */
      batchId: number | undefined;
      /** Each sub-call's record, by its index in the batch. */
      calls: MockCallRecord[];
    })
  | {
      [action in keyof ActionCalls]: EntryBase<"action"> & {
        /** The typed action its method belongs to, e.g. `"getBalance"`. */
        action: action;
        /**
         * The decoded call; `undefined` when the request failed before it was
         * decoded.
         */
        call: ActionCalls[action] | undefined;
        /**
         * The registered contract's record of the call, for an estimate or a
         * send with data whose `to` is one, whichever mocks answered it. A
         * raw send of bytes already mined has none: no mock answers it again.
         */
        contract?: MockCallRecord;
      };
    }[keyof ActionCalls]
  | EntryBase<"method">
  | EntryBase<"builtIn">;

/**
 * A JSON-RPC request, as `mock.request()` and a transport take it: its
 * method, and its params, if any.
 */
export type RpcRequest = { method: string; params?: unknown };

/**
 * A request the mock couldn't answer, with its error: nothing was mocked for
 * it (`MockNotFoundError`), a resolver threw (`MockResolverError`), a static
 * answer doesn't fit it (`MockSetupError`), or the mock itself failed
 * (`MockInternalError`).
 */
export type UnhandledRequest = RpcRequest & { error: MockError };
