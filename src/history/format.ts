import { type AbiFunction, type Hash, isHex } from "viem";

import type { MockCallRecord } from "../contracts/types.js";
import type { LogsCall } from "../logs/filter.js";
import { formatCall, formatValue } from "../mocking/format.js";
import type { FaultOutcome, MockOutcome } from "../mocking/outcomes.js";
import type { MockFault } from "../mocking/types.js";
import {
  MockInternalError,
  MockNotFoundError,
  MockResolverError,
  summaryOf,
} from "../shared/errors.js";
import { isNonArrayObject } from "../shared/values.js";
import type { TransactionRecord } from "../transactions/store.js";
import type { MockHistoryEntry } from "./types.js";

/** What `mock.formatHistory()` takes. */
export type FormatHistoryOptions = {
  /**
   * Whether to include `eth_chainId` and `eth_blockNumber`. Defaults to
   * `true`.
   */
  builtIns?: boolean;
};

/**
 * What formatting needs from the rest of the mock: the registered contracts,
 * to name a filter's events, and the chain's transactions, to show where a
 * send's went.
 */
export type FormatContext = {
  /** A `getLogs` call, its events named by the registered contracts' ABIs. */
  describeLogs?: (call: LogsCall) => string;
  /**
   * The transaction with `hash` once it's mined, to show where a send's
   * went.
   */
  minedTransaction?: (hash: Hash) => TransactionRecord | undefined;
};

/**
 * What formatting needs from the recorder: the history it kept, how many
 * older entries it dropped, and what it knows about each entry. An entry's
 * number counts from 1 since the last clear, the dropped ones included: its
 * place in `entries`, after `dropped`.
 */
export type HistoryView = {
  entries: readonly MockHistoryEntry[];
  dropped: number;
  /**
   * The fault `entry` retries, if it's a retry: the same request, right
   * after a fault.
   */
  faultRetried(entry: MockHistoryEntry): FaultOutcome | undefined;
};

/**
 * The history as text: one line per entry, plus one per multicall sub-call,
 * numbered from 1 since the last clear. A first line says how many older
 * entries were dropped, if any.
 */
export function formatHistory(
  view: HistoryView,
  { builtIns = true }: FormatHistoryOptions = {},
  context: FormatContext = {},
): string {
  const lines = numbered(view)
    .filter(({ entry }) => builtIns || entry.type !== "builtIn")
    .map(({ entry, number }) => formatEntry(view, entry, number, context));
  if (view.dropped > 0) lines.unshift(`(${droppedNote(view.dropped)})`);
  return lines.join("\n");
}

/**
 * The last `count` requests, built-ins left out, for a failed check's message.
 * Numbered as in `formatHistory()`; `undefined` with no requests to show.
 */
export function formatRecent(
  view: HistoryView,
  count: number,
  context: FormatContext = {},
): string | undefined {
  const requests = numbered(view).filter(({ entry }) => entry.type !== "builtIn");
  const shown = requests.slice(-count);
  if (shown.length === 0)
    return view.dropped === 0
      ? undefined
      : `Requests so far: only built-ins kept (${droppedNote(view.dropped)}).`;
  const earlier = requests.length - shown.length;
  const notes = [
    ...(earlier === 0 ? [] : [`${earlier} earlier; see mock.formatHistory()`]),
    ...(view.dropped === 0
      ? []
      : [
          earlier === 0
            ? droppedNote(view.dropped)
            : `${view.dropped} before those dropped, past historyLimit`,
        ]),
  ];
  const heading =
    notes.length === 0
      ? "Requests so far:"
      : `${shown.length === 1 ? "Last request" : `Last ${shown.length} requests`} ` +
        `(${notes.join("; ")}):`;
  return [
    heading,
    ...shown.map(({ entry, number }) => formatEntry(view, entry, number, context)),
  ].join("\n");
}

/** The kept entries, each with its number. */
const numbered = (view: HistoryView) =>
  view.entries.map((entry, index) => ({ entry, number: view.dropped + index + 1 }));

const droppedNote = (dropped: number) =>
  `${dropped} older ${dropped === 1 ? "request" : "requests"} dropped, past historyLimit`;

/**
 * The hint for a request no mock answered that retries `fault`: it's viem
 * retrying after a limited mock's fault used up its answers.
 * `retryCount` is the transport's, when known. A `fallback()` transport does
 * the retrying itself and gives its transports `retryCount: 0`, so a retry
 * through one of those shows the default.
 */
export function retryHint(
  fault: FaultOutcome | undefined,
  retryCount: number | undefined,
): string | undefined {
  if (fault?.source !== "mock") return undefined;
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

/**
 * `entry`, formatted with its `number`, and marked if it's a retry. An entry
 * no longer kept has no number, and shows `–`.
 */
export function formatEntry(
  view: HistoryView,
  entry: MockHistoryEntry,
  number: number | undefined,
  context: FormatContext = {},
): string {
  const retry = view.faultRetried(entry) ? "(retry) " : "";
  const head = `#${number ?? "–"} ${entry.method} ${retry}`;

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
  if (entry.type === "action") {
    const what = entry.contract?.call
      ? `${entry.contract.namespace ?? entry.action} ${formatLabel(entry.contract)}`
      : formatCall(entry.action, entry.call, { short: true });
    const mined = entry.action === "sendTransaction" ? minedNote(entry.outcome, context) : "";
    return `${head}${what} ${formatOutcome(entry.outcome, entry.action)}${mined}`;
  }
  return `${head.trimEnd()}${formatParams(entry.params)} ${formatOutcome(entry.outcome)}`;
}

/**
 * After a send's hash, where its transaction was mined: ` (mined in block
 * 11n, 1 log)` or ` (mined in block 11n, reverted)`. A send's transaction
 * is mined as it's answered, and `restore()` and `reset()` clear history as
 * they remove it, so every send in history has one. The Sync method's
 * answer is its receipt, which says the same.
 */
function minedNote(outcome: MockOutcome, { minedTransaction }: FormatContext): string {
  const mined = outcome.type === "result" ? minedAs(outcome.value, minedTransaction) : undefined;
  if (mined === undefined) return "";
  const block = `mined in block ${formatValue(mined.blockNumber)}`;
  if (mined.status === "reverted") return ` (${block}, reverted)`;
  const logs = mined.logs.length;
  return ` (${block}, ${logs} ${logs === 1 ? "log" : "logs"})`;
}

/**
 * How a send's transaction was mined: the receipt the Sync method answered,
 * or its record.
 */
function minedAs(value: unknown, minedTransaction: FormatContext["minedTransaction"]) {
  if (isReceipt(value)) return value;
  const record = isHex(value) ? minedTransaction?.(value) : undefined;
  return (
    record && {
      blockNumber: record.position.blockNumber,
      status: record.receipt.status,
      logs: record.logs,
    }
  );
}

/** A receipt in viem's form, as the Sync send answers one. */
const isReceipt = (
  value: unknown,
): value is { transactionHash: unknown; blockNumber: unknown; status: unknown; logs: unknown[] } =>
  isNonArrayObject(value) && "transactionHash" in value && Array.isArray(value.logs);

/**
 * A contract call as `USDC.transfer(…)`, or the contract alone when it
 * didn't decode.
 */
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
 * all named, an object keyed by name. The value stays a tuple, as viem
 * returns it.
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

/**
 * How a request or call ended, for history: `→` and its value, `✗` and
 * why, or `… pending`.
 * @internal Exported for its unit test.
 */
export function formatOutcome(outcome: MockOutcome, action?: string): string {
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
  if (outcome.type === "refusal") return `✗ refused: ${outcome.name}`;
  if (outcome.type === "rpcError") return `✗ rpc error ${outcome.code}: ${outcome.message}`;
  const { error } = outcome;
  if (error instanceof MockNotFoundError) return "✗ not mocked";
  if (error instanceof MockResolverError) {
    const thrower = error.matcher === undefined ? "resolver" : `matcher ${error.matcher}`;
    return `✗ ${thrower} threw: ${summaryOf(error.cause)}`;
  }
  if (error instanceof MockInternalError) return `✗ mock failed: ${summaryOf(error.cause)}`;
  return `✗ ${error.shortMessage}`;
}

/**
 * An answer for history: what identifies a block, a receipt, a transaction
 * or a list of logs, which are long, and any other value shortened.
 */
function summarize(value: unknown, action: string | undefined): string {
  if (action === "getBlock" && isNonArrayObject(value))
    return `block ${formatValue(value.number)}, timestamp ${formatValue(value.timestamp)}`;
  if (action === "getTransactionReceipt" && isNonArrayObject(value)) {
    const logs = Array.isArray(value.logs) ? value.logs.length : 0;
    return `${String(value.status)}, block ${formatValue(value.blockNumber)}, ${logs} log(s)`;
  }
  if (action === "getTransaction" && isNonArrayObject(value)) {
    const where =
      value.blockNumber === null ? "pending" : `block ${formatValue(value.blockNumber)}`;
    return `${String(value.type)}, ${where}`;
  }
  if (action === "sendTransaction" && isReceipt(value))
    return formatValue(value.transactionHash, { short: true });
  if (action === "getLogs" && Array.isArray(value))
    return `${value.length} ${value.length === 1 ? "log" : "logs"}`;
  return formatValue(value, { short: true });
}

function formatFault(fault: MockFault): string {
  if (fault === "timeout") return "timeout";
  if (fault === "network") return "network error";
  if ("status" in fault) return `HTTP ${fault.status}`;
  return `RPC error ${fault.code}${fault.message === undefined ? "" : ` (${fault.message})`}`;
}
