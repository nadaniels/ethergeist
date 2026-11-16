import { decodeFunctionResult, hexToBigInt, hexToNumber, isHex, multicall3Abi } from "viem";

import type { ActionReport } from "../actions/table.js";
import type { ActionName } from "../actions/typedActions.js";
import type { MockCallRecord, Reporter, MockTaggedCall } from "../contracts/types.js";
import { formatValue } from "../mocking/format.js";
import {
  type FaultOutcome,
  failureOutcome,
  type MockCallOutcome,
  type MockOutcome,
} from "../mocking/outcomes.js";
import type { MockFault } from "../mocking/types.js";
import { MockInternalError, MockRevertError, MockSetupError, summaryOf } from "../shared/errors.js";
import { createRecordList, type RecordLimit } from "../shared/records.js";
import { type FormatContext, type HistoryView, formatEntry } from "./format.js";
import type { Asked, MockHistoryEntry, RpcRequest, UnhandledRequest } from "./types.js";

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

const withOutcome = (record: MockCallRecord, outcome: MockCallOutcome): MockCallRecord => ({
  ...record,
  outcome,
});

const notReached = (record: MockCallRecord) => withOutcome(record, { type: "notReached" });

const reporterFor =
  (entry: MockHistoryEntry): Reporter =>
  (outcome, index) => {
    if (entry.type === "multicall" && index !== undefined && entry.calls[index])
      entry.calls[index] = withOutcome(entry.calls[index], outcome);
    else if (entry.type === "call" && entry.call) entry.call = withOutcome(entry.call, outcome);
    else throw new MockInternalError(`No call record to report to at ${String(index)}`);
  };

/**
 * A request's answer in viem's types, for history: a built-in's number, a
 * contract call's decoded result, or a multicall's decoded results. Any
 * other answer stays as JSON-RPC: an action's value comes with its report
 * (see `ActionReport`).
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
  reporter: Reporter;
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
  actionFor,
  debug,
  formatContext,
  recordLimit,
}: {
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
  /** The fault each retry retries. */
  const retries = new WeakMap<MockHistoryEntry, FaultOutcome>();
  /** The last request received, to tell whether the next one retries it. */
  let last: MockHistoryEntry | undefined;
  /**
   * How many times `clearCalls()` has cleared history, to tell an entry
   * received before the last clear.
   */
  let clears = 0;
  const view: HistoryView = {
    get entries() {
      return history.kept;
    },
    get dropped() {
      return history.dropped;
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
   * The recording of `request`, whose history entry is `entry`, numbered
   * `number` as `HistoryView` numbers it.
   */
  function recordingOf(request: RpcRequest, entry: MockHistoryEntry, number: number): Recording {
    let actionOutcome: ActionReport["outcome"];
    const clearsAtStart = clears;
    /**
     * The entry's number while history keeps it, for `debug`'s line. Once
     * it's no longer kept (received before the last clear, or dropped past
     * `historyLimit` while it was still in flight), `undefined`.
     */
    const numberNow = () =>
      clears === clearsAtStart && number > history.dropped ? number : undefined;

    /** Records `outcome` on the entry, and logs it when `debug` is on. */
    function end(outcome: MockOutcome) {
      entry.outcome = outcome;
      if (log === undefined) return;
      let line: string;
      try {
        line = formatEntry(view, entry, numberNow(), formatContext);
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
      reportAction({ outcome, contractOutcome }) {
        if (entry.type !== "action") return;
        if (contractOutcome && entry.contract)
          entry.contract = withOutcome(entry.contract, contractOutcome);
        actionOutcome = outcome;
      },
      fault(fault) {
        if (entry.type === "call" && entry.call) entry.call = notReached(entry.call);
        if (entry.type === "multicall") entry.calls = entry.calls.map(notReached);
        if (entry.type === "action" && entry.contract) entry.contract = notReached(entry.contract);
        end({ type: "fault", fault, source: "failRequests" });
      },
      settle(ended) {
        if ("error" in ended) {
          const outcome = outcomeOf(entry, ended.error);
          // Added first, so a `debug` function that throws can't skip it.
          if (outcome.type === "unhandled") unhandled.add({ ...request, error: outcome.error });
          end(outcome);
          return;
        }
        const value = actionOutcome === undefined ? valueOf(entry, ended.rpc) : actionOutcome.value;
        end({ type: "result", value });
      },
    };
  }

  function entryFor(method: string, params: unknown, asked: Asked | undefined): MockHistoryEntry {
    const base = { method, params, outcome: { type: "pending" } as const };
    if (method === "eth_chainId" || method === "eth_blockNumber")
      return { ...base, type: "builtIn" };
    if (asked?.type === "call" || asked?.type === "multicall") return { ...base, ...asked };
    // Reading an `eth_call` never throws, so only a bug in the mock gets here.
    if (method === "eth_call") return { ...base, type: "call", to: undefined, call: undefined };
    const action = actionFor(method);
    if (action === undefined) return { ...base, type: "method" };
    const { call, contract } = asked?.type === "action" ? asked : {};
    const entry: MockHistoryEntry = {
      ...base,
      type: "action",
      action,
      call: undefined,
      ...(contract && { contract }),
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the action's decoder made it
    if (entry.type === "action") entry.call = call as typeof entry.call;
    return entry;
  }

  return {
    history,
    calls,
    /** Requests the mock couldn't answer; added to as they're settled. */
    unhandled,
    /** The history, for formatting: see `HistoryView`. */
    view,
    /**
     * Records a request, marked a retry if the request before it faulted and
     * this one repeats it.
     */
    start(request: RpcRequest, asked: Asked | undefined): Recording {
      const entry = entryFor(request.method, request.params, asked);
      // viem retries only once the attempt before has failed, so its outcome
      // is known by now.
      const fault = last === undefined ? undefined : retriedFault(last, entry);
      if (fault) retries.set(entry, fault);
      last = entry;
      history.add(entry);
      // Read as it's added: finding the entry in history later copies the
      // kept list once the ring is full.
      return recordingOf(request, entry, history.total);
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
 * same request, compared as printed.
 */
function retriedFault(
  previous: MockHistoryEntry,
  entry: MockHistoryEntry,
): FaultOutcome | undefined {
  if (previous.outcome.type !== "fault") return undefined;
  const same =
    previous.method === entry.method && formatValue(previous.params) === formatValue(entry.params);
  return same ? previous.outcome : undefined;
}
