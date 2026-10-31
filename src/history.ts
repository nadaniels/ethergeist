import {
  type AbiFunction,
  decodeFunctionResult,
  hexToBigInt,
  hexToNumber,
  isHex,
  multicall3Abi,
} from "viem";
import type { CallContext } from "./contracts/types.js";
import {
  MockNotFoundError,
  MockResolverError,
  MockRevertError,
  MockRpcError,
} from "./shared/errors.js";
import { MockFailure } from "./mocking/faults.js";
import type { MockNodeFault } from "./mocking/types.js";
import { formatCall, formatValue } from "./mocking/format.js";
import type { MockCallRecord, MockHistoryEntry, MockOutcome } from "./history/types.js";
import type { LogsCall } from "./logs.js";
import { isPlainObject } from "./shared/values.js";
import { revertOutcome } from "./contracts/revert.js";

/** How a request's contract calls report back to its history entry. */
export type Reporter = {
  call?: (record: MockCallRecord, context: CallContext) => void;
  batch?: (id: number) => void;
};

export type FormatHistoryOptions = {
  /** Include `eth_chainId` and `eth_blockNumber`. Defaults to `true`. */
  builtIns?: boolean;
};

/** Internal: what formatting needs from the rpc, e.g. ABIs to name a filter's events. */
export type FormatContext = {
  describeLogs?: (call: LogsCall) => string;
};

/** The outcome of an error thrown while answering, other than reverts and faults. */
export function errorOutcome(error: unknown): MockOutcome {
  if (error instanceof MockNotFoundError || error instanceof MockResolverError)
    return { type: "unhandled", error };
  if (error instanceof MockRpcError)
    return { type: "rpcError", code: error.code, message: error.shortMessage };
  return { type: "error", error };
}

export function outcomeOf(entry: MockHistoryEntry, error: unknown): MockOutcome {
  if (error instanceof MockFailure) return { type: "fault", fault: error.fault, source: "mock" };
  if (error instanceof MockRevertError)
    // A contract's record already decoded it against the contract's ABI.
    return entry.type === "call" && entry.call?.outcome.type === "revert"
      ? entry.call.outcome
      : entry.type === "action" &&
          entry.action === "estimateGas" &&
          entry.contract?.outcome.type === "revert"
        ? entry.contract.outcome
        : revertOutcome([], error.data);
  return errorOutcome(error);
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

/** One line per entry (plus one per multicall sub-call), numbered from 1. */
export function formatHistory(
  entries: readonly MockHistoryEntry[],
  { builtIns = true }: FormatHistoryOptions = {},
  context: FormatContext = {},
): string {
  return entries
    .map((entry, i) =>
      builtIns || entry.type !== "builtIn" ? formatEntry(entries, i, context) : undefined,
    )
    .filter((line) => line !== undefined)
    .join("\n");
}

/**
 * The last `count` requests, built-ins left out, for a failed check's message.
 * Numbered as in `formatHistory()`; `undefined` with no requests to show.
 */
export function formatRecent(
  entries: readonly MockHistoryEntry[],
  count: number,
  context: FormatContext = {},
): string | undefined {
  const indexes = entries.flatMap((entry, i) => (entry.type === "builtIn" ? [] : [i]));
  const shown = indexes.slice(-count);
  if (shown.length === 0) return undefined;
  const earlier = indexes.length - shown.length;
  const heading =
    earlier === 0
      ? "Requests so far:"
      : `${shown.length === 1 ? "Last request" : `Last ${shown.length} requests`} ` +
        `(${earlier} earlier; see mock.formatHistory()):`;
  return [heading, ...shown.map((i) => formatEntry(entries, i, context))].join("\n");
}

/** The fault that entry `index` retries, if it's a retry: the same request, right after a fault. */
function faultRetried(
  entries: readonly MockHistoryEntry[],
  index: number,
): Extract<MockOutcome, { type: "fault" }> | undefined {
  const entry = entries[index];
  const previous = entries[index - 1];
  if (entry === undefined || previous?.outcome.type !== "fault") return undefined;
  const same =
    previous.method === entry.method &&
    JSON.stringify(previous.params) === JSON.stringify(entry.params);
  return same ? previous.outcome : undefined;
}

/**
 * For a request a mock didn't answer: explains that it's viem retrying after
 * a limited mock's fault used up its answers. `retryCount` is the transport's,
 * when known. A `fallback()` transport does the retrying itself and gives its
 * transports `retryCount: 0`, so a retry through one of those shows the default.
 */
export function retryHint(
  entries: readonly MockHistoryEntry[],
  index: number,
  retryCount: number | undefined,
): string | undefined {
  if (faultRetried(entries, index)?.source !== "mock") return undefined;
  const retries =
    retryCount === undefined || retryCount === 0
      ? "`retryCount` is 3 by default"
      : `this transport's \`retryCount\` is ${retryCount}`;
  return (
    `This is viem retrying after a \`.once()\`/\`.times(n)\` fault (${retries}); each attempt ` +
    "used up an answer. Register a mock to answer after it, or use `.fails()` without a " +
    "limit to fail every attempt."
  );
}

/** Entry `index` of `entries`, formatted; earlier entries tell retries apart. */
export function formatEntry(
  entries: readonly MockHistoryEntry[],
  index: number,
  context: FormatContext = {},
): string {
  const entry = entries[index]!;
  const retry = faultRetried(entries, index) ? "(retry) " : "";
  const head = `#${index + 1} ${entry.method} ${retry}`;

  if (entry.type === "call")
    return entry.call
      ? `${head}${formatRecord(entry.call)}`
      : `${head}${entry.to ?? "(no to)"} ${formatOutcome(entry.outcome)}`;
  if (entry.type === "multicall") {
    const batch = entry.batchId === undefined ? "" : `, batch ${entry.batchId}`;
    const outcome = entry.outcome.type === "result" ? "" : ` ${formatOutcome(entry.outcome)}`;
    const lines = entry.calls.map(
      (record, i) => `   ${i === entry.calls.length - 1 ? "└" : "├"} ${formatRecord(record)}`,
    );
    return [
      `${head}multicall${batch} (${entry.calls.length} ${entry.calls.length === 1 ? "call" : "calls"})${outcome}`,
      ...lines,
    ].join("\n");
  }
  if (entry.type === "action" && entry.action === "getLogs" && entry.call !== undefined)
    return `${head}${context.describeLogs?.(entry.call) ?? formatCall("getLogs", entry.call, { short: true })} ${formatOutcome(entry.outcome, entry.action)}`;
  if (entry.type === "action" && entry.action === "estimateGas" && entry.contract?.call)
    return `${head}estimateGas ${formatLabel(entry.contract)} ${formatOutcome(entry.outcome)}`;
  if (entry.type === "action")
    return `${head}${formatCall(entry.action, entry.call, { short: true })} ${formatOutcome(
      entry.outcome,
      entry.action,
    )}`;
  // "method" and "builtIn": the raw method and params.
  return `${head.trimEnd()}${formatParams(entry.params)} ${formatOutcome(entry.outcome)}`;
}

/** A contract call as `USDC.transfer(…)`, or the contract alone when it didn't decode. */
function formatLabel({ address, name, call }: MockCallRecord): string {
  const label = name ?? formatValue(address, { short: true });
  return call ? `${label}.${formatCall(call.functionName, call.args, { short: true })}` : label;
}

function formatRecord(record: MockCallRecord): string {
  const { abiItem, outcome } = record;
  const text = formatLabel(record);
  if (outcome.type === "result" && abiItem)
    return `${text} → ${formatResult(abiItem, outcome.value)}`;
  return `${text} ${formatOutcome(outcome)}`;
}

/**
 * A contract call's result: `(no outputs)`, or, when two or more outputs are
 * all named, an object keyed by name (the value stays a tuple, as viem returns it).
 */
function formatResult({ outputs }: AbiFunction, value: unknown): string {
  if (outputs.length === 0) return "(no outputs)";
  const named = outputs.length > 1 && outputs.every((output) => output.name);
  if (!named || !Array.isArray(value)) return formatValue(value, { short: true });
  const fields = outputs.map((output, i) => [output.name!, value[i]] as const);
  return formatValue(Object.fromEntries(fields), { short: true });
}

function formatParams(params: unknown): string {
  return Array.isArray(params) && params.length > 0
    ? `(${params.map((p: unknown) => formatValue(p, { short: true })).join(", ")})`
    : "";
}

function formatOutcome(outcome: MockOutcome, action?: string): string {
  if (outcome.type === "pending") return "… pending";
  if (outcome.type === "result") return `→ ${summarize(outcome.value, action)}`;
  if (outcome.type === "revert") {
    if (outcome.reason !== undefined) return `✗ reverted: "${outcome.reason}"`;
    if (outcome.errorName !== undefined)
      return `✗ reverted: ${formatCall(outcome.errorName, outcome.args ?? [], { short: true })}`;
    return `✗ reverted (${formatValue(outcome.data, { short: true })})`;
  }
  if (outcome.type === "fault")
    return `✗ fault: ${formatFault(outcome.fault)}${outcome.source === "failRequests" ? " (failRequests)" : ""}`;
  if (outcome.type === "rpcError") return `✗ rpc error ${outcome.code}: ${outcome.message}`;
  if (outcome.type === "error")
    return `✗ error: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`;
  // "unhandled"
  if (!(outcome.error instanceof MockResolverError)) return "✗ not mocked";
  const { matcher, cause } = outcome.error;
  const thrower = matcher === undefined ? "resolver" : `matcher ${matcher}`;
  return `✗ ${thrower} threw: ${cause instanceof Error ? cause.message : ""}`;
}

/** Blocks and receipts are long; history shows what identifies them. */
function summarize(value: unknown, action: string | undefined): string {
  if (action === "getBlock" && isPlainObject(value))
    return `block ${formatValue(value.number)}, timestamp ${formatValue(value.timestamp)}`;
  if (action === "getTransactionReceipt" && isPlainObject(value)) {
    const logs = Array.isArray(value.logs) ? value.logs.length : 0;
    return `${String(value.status)}, block ${formatValue(value.blockNumber)}, ${logs} log(s)`;
  }
  if (action === "getTransaction" && isPlainObject(value)) {
    const where =
      value.blockNumber === null ? "pending" : `block ${formatValue(value.blockNumber)}`;
    return `${String(value.type)}, ${where}`;
  }
  if (action === "getLogs" && Array.isArray(value))
    return `${value.length} ${value.length === 1 ? "log" : "logs"}`;
  return formatValue(value, { short: true });
}

function formatFault(fault: MockNodeFault): string {
  if (fault === "timeout") return "timeout";
  if (fault === "network") return "network error";
  if (typeof fault === "string") return fault;
  if ("status" in fault) return `HTTP ${fault.status}`;
  return `RPC error ${fault.code}${fault.message === undefined ? "" : ` (${fault.message})`}`;
}
