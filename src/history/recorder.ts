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
import type { MockCall, Reporter } from "../contracts/types.js";
import { failureOutcome, type MockOutcome } from "../mocking/outcomes.js";
import { MockNotFoundError, MockResolverError, MockRevertError } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import { type FormatContext, formatEntry } from "./format.js";
import type { MockHistoryEntry, RpcRequest, UnhandledRequest } from "./types.js";

export function outcomeOf(entry: MockHistoryEntry, error: unknown): MockOutcome {
  // A contract's record already decoded a revert against the contract's ABI.
  const record =
    entry.type === "call"
      ? entry.call
      : entry.type === "action" && entry.action === "estimateGas"
        ? entry.contract
        : undefined;
  if (error instanceof MockRevertError && record?.outcome.type === "revert") return record.outcome;
  return failureOutcome(error);
}

/** Where contract calls report their records: the entry's call, or its batch's slots. */
export function reporterFor(entry: MockHistoryEntry): Reporter {
  if (entry.type === "call")
    return {
      call(record) {
        entry.call = record;
      },
    };
  if (entry.type === "multicall")
    return {
      batch(id) {
        entry.batchId = id;
      },
      call(record, context) {
        if (context.batch) entry.calls[context.batch.index] = record;
      },
    };
  return {};
}

/** The answer in viem's types, for history. */
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
 * What the mock records about requests: each one as received (`requests`),
 * how it was answered (`history`), every decoded contract call (`calls`),
 * and those it couldn't answer (`unhandled`). As a part, `clearCalls()`
 * clears them; they're never saved.
 */
export function createRecorder({
  multicallAddress,
  actionFor,
  debug,
  formatContext,
}: {
  multicallAddress: Address | undefined;
  /** The typed action answering a JSON-RPC method, if any. */
  actionFor: (method: string) => ActionName | undefined;
  /** `createMockRpc()`'s `debug` option. */
  debug: boolean | ((line: string, entry: MockHistoryEntry) => void) | undefined;
  formatContext: FormatContext;
}) {
  const requests: RpcRequest[] = [];
  const history: MockHistoryEntry[] = [];
  const calls: MockCall[] = [];
  const unhandled: UnhandledRequest[] = [];
  const log =
    debug === true
      ? (line: string) => {
          console.log(line);
        }
      : debug === false
        ? undefined
        : debug;

  /** A history entry for a request, typed by what it asks for; details fill in as it's answered. */
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
    requests,
    history,
    calls,
    /** Requests the mock couldn't answer; added to with `markUnhandled()`. */
    unhandled: unhandled as readonly UnhandledRequest[],
    /** Records a request as received, and returns its history entry. */
    start(request: RpcRequest): MockHistoryEntry {
      requests.push(request);
      const entry = entryFor(request.method, request.params);
      history.push(entry);
      return entry;
    },
    /** Records how a request ended, and logs it when `debug` is on. */
    settle(entry: MockHistoryEntry, outcome: MockOutcome) {
      entry.outcome = outcome;
      if (!log) return;
      const index = history.indexOf(entry);
      // Cleared while it was in flight: still worth a line, just without its number.
      log(
        index === -1
          ? formatEntry([entry], 0, formatContext)
          : formatEntry(history, index, formatContext),
        entry,
      );
    },
    /** Records a request the mock couldn't answer, for `unhandled` and `assertNoUnhandled()`. */
    markUnhandled(request: RpcRequest, error: MockNotFoundError | MockResolverError) {
      unhandled.push({ ...request, error });
    },
    /** Records a decoded contract call, from any contract. */
    onCall: (call: MockCall) => {
      calls.push(call);
    },
    clearCalls() {
      requests.length = 0;
      history.length = 0;
      calls.length = 0;
      unhandled.length = 0;
    },
  };
}
