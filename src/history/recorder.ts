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

import type { ActionReport } from "../actions/table.js";
import type { ActionName } from "../actions/typedActions.js";
import type { Reporter, MockTaggedCall } from "../contracts/types.js";
import { formatValue } from "../mocking/format.js";
import { type FaultOutcome, failureOutcome, type MockOutcome } from "../mocking/outcomes.js";
import type { MockFault } from "../mocking/types.js";
import { MockInternalError, MockRevertError, MockSetupError, summaryOf } from "../shared/errors.js";
import { createRecordList, type RecordLimit } from "../shared/records.js";
import { isPlainObject } from "../shared/values.js";
import { type FormatContext, type HistoryView, formatEntry } from "./format.js";
import type { MockHistoryEntry, RpcRequest, UnhandledRequest } from "./types.js";

/**
 * How a request that threw `error` ended, for history: a revert as the
 * contract's record decoded it, with the contract's ABI, or else as
 * `failureOutcome` gives it.
 */
function outcomeOf(entry: MockHistoryEntry, error: unknown): MockOutcome {
  const record =
    entry.type === "call" ? entry.call : entry.type === "action" ? entry.contract : undefined;
  if (error instanceof MockRevertError && record?.outcome.type === "revert") return record.outcome;
  return failureOutcome(error);
}

/**
 * Where contract calls report their records: the entry's call, or its
 * batch's slots.
 */
function reporterFor(entry: MockHistoryEntry): Reporter {
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
function valueOf(entry: MockHistoryEntry, rpc: unknown): unknown {
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
 * A request's history entry while it's answered: the parts that answer the
 * request report to it, and it records how the request ended.
 */
export type Recording = {
  entry: MockHistoryEntry;
  /** Where the request's contract calls report their records. */
  reporter: Reporter;
  /**
   * Hears an action's report: its decoded call, the contract's record if
   * the contract had a turn, and the answer in viem's types if it answered.
   */
  reportAction: (report: ActionReport) => void;
  /** Records a `failRequests()` fault as how the request ended. */
  fault: (fault: MockFault) => void;
  /**
   * Records how the request ended, its answer or what it threw, and logs it
   * when `debug` is on. A request the mock couldn't answer is also added to
   * `unhandled`. A `debug` function that throws is a setup error, thrown
   * once it's recorded.
   */
  settle: (ended: { rpc: unknown } | { error: unknown }) => void;
};

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

  /** The recording of `request`, whose history entry is `entry`. */
  function recordingOf(request: RpcRequest, entry: MockHistoryEntry): Recording {
    let actionOutcome: ActionReport["outcome"];

    /** Records `outcome` on the entry, and logs it when `debug` is on. */
    function end(outcome: MockOutcome) {
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
    }

    return {
      entry,
      reporter: reporterFor(entry),
      reportAction({ call, outcome, contract }) {
        if (entry.type !== "action") return;
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the table for entry.action decoded it
        entry.call = call as typeof entry.call;
        if (contract) entry.contract = contract;
        actionOutcome = outcome;
      },
      fault(fault) {
        end({ type: "fault", fault, source: "failRequests" });
      },
      settle(ended) {
        if ("error" in ended) {
          const outcome = outcomeOf(entry, ended.error);
          // Recorded because callers can swallow these: app code with a
          // fallback, or viem's multicall turning a failed batch into
          // per-call failures. First, so a throwing `debug` can't skip it.
          if (outcome.type === "unhandled") unhandled.add({ ...request, error: outcome.error });
          end(outcome);
          return;
        }
        const value = actionOutcome === undefined ? valueOf(entry, ended.rpc) : actionOutcome.value;
        end({ type: "result", value });
      },
    };
  }

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
    /** Requests the mock couldn't answer; added to as they're settled. */
    unhandled,
    /** The history, for formatting: see `HistoryView`. */
    view,
    /**
     * Records a request as received, marked a retry if it repeats one that
     * just faulted, and returns its recording.
     */
    start(request: RpcRequest): Recording {
      const entry = entryFor(request.method, request.params);
      // viem retries only once the attempt before has failed, so its outcome
      // is known by now.
      const fault = last === undefined ? undefined : retriedFault(last, entry);
      if (fault) retries.set(entry, fault);
      last = entry;
      history.add(entry);
      numbers.set(entry, { number: history.total, clears });
      return recordingOf(request, entry);
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
  // Only labels the history, so a rare false match (`[1n]` and `["1n"]` print
  // alike) costs a wrong "(retry)" and nothing else.
  const same =
    previous.method === entry.method && formatValue(previous.params) === formatValue(entry.params);
  return same ? previous.outcome : undefined;
}
