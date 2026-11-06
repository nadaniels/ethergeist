import {
  decodeFunctionResult,
  hexToBigInt,
  hexToNumber,
  isHex,
  multicall3Abi,
  type Address,
  getAddress,
  isAddress,
} from "viem";

import type { ActionName } from "../actions/typedActions.js";
import type { Reporter, MockTaggedCall } from "../contracts/types.js";
import { type FaultOutcome, failureOutcome, type MockOutcome } from "../mocking/outcomes.js";
import {
  type MockError,
  MockInternalError,
  MockRevertError,
  MockSetupError,
  summaryOf,
} from "../shared/errors.js";
import { createRecordList, type RecordLimit } from "../shared/records.js";
import { isPlainObject } from "../shared/values.js";
import { type FormatContext, type HistoryView, formatEntry } from "./format.js";
import type { MockHistoryEntry, RpcRequest, UnhandledRequest } from "./types.js";

/**
 * How a request that threw `error` ended, for history: a revert as the
 * contract's record decoded it, with the contract's ABI, or else as
 * `failureOutcome` gives it.
 */
export function outcomeOf(entry: MockHistoryEntry, error: unknown): MockOutcome {
  const record =
    entry.type === "call" ? entry.call : entry.type === "action" ? entry.contract : undefined;
  if (error instanceof MockRevertError && record?.outcome.type === "revert") return record.outcome;
  return failureOutcome(error);
}

/**
 * Where contract calls report their records: the entry's call, or its
 * batch's slots.
 */
export function reporterFor(entry: MockHistoryEntry): Reporter {
  if (entry.type === "multicall")
    return {
      batch(id) {
        entry.batchId = id;
      },
      call(record, { batch }) {
        if (batch) entry.calls[batch.index] = record;
      },
    };
  return {
    batch() {},
    call(record) {
      if (entry.type === "call") entry.call = record;
    },
  };
}

/**
 * A request's answer in viem's types, for history: a built-in's number, a
 * contract call's decoded result, or a multicall's decoded results. Any
 * other answer stays as JSON-RPC: an action's value comes from its table.
 */
export function valueOf(entry: MockHistoryEntry, rpc: unknown): unknown {
  if (entry.type === "builtIn" && isHex(rpc))
    return entry.method === "eth_chainId" ? hexToNumber(rpc) : hexToBigInt(rpc);
  if (entry.type === "call")
    return entry.call?.outcome.type === "result" ? entry.call.outcome.value : rpc;
  if (entry.type === "multicall" && isHex(rpc))
    return decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data: rpc });
  return rpc;
}

/** What the mock records about requests: see `createRecorder`. */
export type Recorder = ReturnType<typeof createRecorder>;

/**
 * What the mock records about requests: each one as received and how it
 * was answered (`history`), every decoded contract call (`calls`), and
 * those it couldn't answer (`unhandled`), each kept to `recordLimit`.
 * As a part, `clearCalls()` clears them; they're never saved.
 */
export function createRecorder({
  multicallAddress,
  actionFor,
  debug,
  formatContext,
  recordLimit,
}: {
  multicallAddress: Address | undefined;
  /** The typed action answering a JSON-RPC method, if any. */
  actionFor: (method: string) => ActionName | undefined;
  /** `createMockRpc()`'s `debug` option. */
  debug: boolean | ((line: string, entry: MockHistoryEntry) => void) | undefined;
  formatContext: FormatContext;
  recordLimit: RecordLimit;
}) {
  const history = createRecordList<MockHistoryEntry>(recordLimit);
  const calls = createRecordList<MockTaggedCall>(recordLimit);
  const unhandled = createRecordList<UnhandledRequest>(recordLimit);
  /**
   * Each entry's number, kept beside it, not in it, so entries stay as users
   * see them. A number holds until the next clear, which starts them over.
   */
  const numbers = new WeakMap<MockHistoryEntry, { number: number; clears: number }>();
  let clears = 0;
  /** The fault each retry retries. */
  const retries = new WeakMap<MockHistoryEntry, FaultOutcome>();
  /** The last request received, to tell whether the next one retries it. */
  let last: MockHistoryEntry | undefined;
  const view: HistoryView = {
    get entries() {
      return history.kept;
    },
    get dropped() {
      return history.dropped;
    },
    numberOf(entry) {
      const numbered = numbers.get(entry);
      return numbered?.clears === clears ? numbered.number : undefined;
    },
    faultRetried: (entry) => retries.get(entry),
  };
  const log =
    debug === true
      ? (line: string) => {
          console.log(line);
        }
      : debug === false
        ? undefined
        : debug;

  /**
   * A history entry for a request, typed by what it asks for; details fill
   * in as it's answered.
   */
  function entryFor(method: string, params: unknown): MockHistoryEntry {
    const base = { method, params, outcome: { type: "pending" } as const };
    if (method === "eth_chainId" || method === "eth_blockNumber")
      return { ...base, type: "builtIn" };
    if (method === "eth_call") {
      const to = Array.isArray(params) && isPlainObject(params[0]) ? params[0].to : undefined;
      const target =
        typeof to === "string" && isAddress(to, { strict: false }) ? getAddress(to) : undefined;
      return target !== undefined && target === multicallAddress
        ? { ...base, type: "multicall", batchId: undefined, calls: [] }
        : { ...base, type: "call", to: target, call: undefined };
    }
    const action = actionFor(method);
    if (action !== undefined) return { ...base, type: "action", action, call: undefined };
    return { ...base, type: "method" };
  }

  return {
    history,
    calls,
    /** Requests the mock couldn't answer; added to with `markUnhandled()`. */
    unhandled,
    /** The history, for formatting: see `HistoryView`. */
    view,
    /**
     * Records a request as received, marked a retry if it repeats one that
     * just faulted, and returns its history entry.
     */
    start(request: RpcRequest): MockHistoryEntry {
      const entry = entryFor(request.method, request.params);
      // viem retries only once the attempt before has failed, so its outcome
      // is known by now.
      const fault = last === undefined ? undefined : retriedFault(last, entry);
      if (fault) retries.set(entry, fault);
      last = entry;
      history.add(entry);
      numbers.set(entry, { number: history.total, clears });
      return entry;
    },
    /**
     * Records how a request ended, and logs it when `debug` is on. A `debug`
     * function that throws is a setup error, thrown once it's recorded.
     */
    settle(entry: MockHistoryEntry, outcome: MockOutcome) {
      entry.outcome = outcome;
      if (log === undefined) return;
      let line: string;
      try {
        line = formatEntry(view, entry, formatContext);
      } catch (error) {
        throw new MockInternalError(error);
      }
      try {
        log(line, entry);
      } catch (error) {
        throw new MockSetupError(`The debug function threw: ${summaryOf(error)}`, {
          cause: error instanceof Error ? error : undefined,
        });
      }
    },
    /**
     * Records a request the mock couldn't answer, for `unhandled` and
     * `assertNoUnhandled()`.
     */
    markUnhandled(request: RpcRequest, error: MockError) {
      unhandled.add({ ...request, error });
    },
    /** Records a decoded contract call, tagged, from any contract. */
    onCall: (call: MockTaggedCall) => {
      calls.add(call);
    },
    clearCalls() {
      history.clear();
      calls.clear();
      unhandled.clear();
      last = undefined;
      clears += 1;
    },
  };
}

/**
 * The fault `entry` retries: `previous`'s, if it faulted and `entry` is the
 * same request.
 */
function retriedFault(
  previous: MockHistoryEntry,
  entry: MockHistoryEntry,
): FaultOutcome | undefined {
  if (previous.outcome.type !== "fault") return undefined;
  const same =
    previous.method === entry.method &&
    JSON.stringify(previous.params) === JSON.stringify(entry.params);
  return same ? previous.outcome : undefined;
}
