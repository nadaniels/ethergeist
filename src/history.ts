import {
  type Address,
  type Hex,
  decodeFunctionResult,
  hexToBigInt,
  hexToNumber,
  isHex,
  multicall3Abi,
} from "viem";
import type { ActionCalls } from "./actions.js";
import type { CallContext, MockCall } from "./contract.js";
import { MockNotFoundError, MockResolverError, MockRevertError } from "./errors.js";
import { MockFailure, type MockFault } from "./faults.js";
import { formatCall, formatValue } from "./format.js";
import { isPlainObject } from "./result.js";
import { revertOutcome } from "./revert.js";

/** How the mock answered a request, or a contract call inside one. */
export type MockOutcome =
  /** Still in flight. */
  | { type: "pending" }
  /** Answered. `value` is in viem's types: what the app receives. */
  | { type: "result"; value: unknown }
  /** Reverted, decoded against the contract's ABI where possible. */
  | { type: "revert"; data: Hex; errorName?: string; args?: readonly unknown[]; reason?: string }
  /** Failed at the network level, by `failRequests()` or a mock's `.fails()`/`fail()`. */
  | { type: "fault"; fault: MockFault; source: "failRequests" | "mock" }
  /** Not answered: nothing was mocked, or a resolver threw. */
  | { type: "unhandled"; error: MockNotFoundError | MockResolverError }
  /** The mock itself failed unexpectedly, e.g. on a malformed request. */
  | { type: "error"; error: unknown };

/** A contract call the mock dispatched, directly or inside a multicall. */
export type MockCallRecord = {
  address: Address;
  /** The contract's name, if it was registered with one. */
  name: string | undefined;
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
      };
    }[keyof ActionCalls]
  | EntryBase<"method">
  | EntryBase<"builtIn">;

/** How a request's contract calls report back to its history entry. */
export type Reporter = {
  call?: (record: MockCallRecord, context: CallContext) => void;
  batch?: (id: number) => void;
};

export type FormatHistoryOptions = {
  /** Include `eth_chainId` and `eth_blockNumber`. Defaults to `true`. */
  builtIns?: boolean;
};

/** The outcome of an error thrown while answering, other than reverts and faults. */
export function errorOutcome(error: unknown): MockOutcome {
  if (error instanceof MockNotFoundError || error instanceof MockResolverError)
    return { type: "unhandled", error };
  return { type: "error", error };
}

export function outcomeOf(entry: MockHistoryEntry, error: unknown): MockOutcome {
  if (error instanceof MockFailure) return { type: "fault", fault: error.fault, source: "mock" };
  if (error instanceof MockRevertError)
    // A direct call's record already decoded it against the contract's ABI.
    return entry.type === "call" && entry.call?.outcome.type === "revert"
      ? entry.call.outcome
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
): string {
  return entries
    .map((entry, i) => (builtIns || entry.type !== "builtIn" ? formatEntry(entries, i) : undefined))
    .filter((line) => line !== undefined)
    .join("\n");
}

/** Entry `index` of `entries`, formatted; earlier entries tell retries apart. */
export function formatEntry(entries: readonly MockHistoryEntry[], index: number): string {
  const entry = entries[index]!;
  const previous = entries[index - 1];
  const retry =
    previous?.outcome.type === "fault" &&
    previous.method === entry.method &&
    JSON.stringify(previous.params) === JSON.stringify(entry.params)
      ? "(retry) "
      : "";
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
    return [`${head}multicall${batch} (${entry.calls.length} calls)${outcome}`, ...lines].join(
      "\n",
    );
  }
  if (entry.type === "action")
    return `${head}${formatCall(entry.action, entry.call, { short: true })} ${formatOutcome(
      entry.outcome,
      entry.action,
    )}`;
  // "method" and "builtIn": the raw method and params.
  return `${head.trimEnd()}${formatParams(entry.params)} ${formatOutcome(entry.outcome)}`;
}

function formatRecord({ address, name, call, outcome }: MockCallRecord): string {
  const label = name ?? formatValue(address, { short: true });
  const text = call
    ? `${label}.${formatCall(call.functionName, call.args, { short: true })}`
    : label;
  return `${text} ${formatOutcome(outcome)}`;
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
  if (outcome.type === "error")
    return `✗ error: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`;
  // "unhandled"
  return outcome.error instanceof MockResolverError
    ? `✗ resolver threw: ${outcome.error.cause instanceof Error ? outcome.error.cause.message : ""}`
    : "✗ not mocked";
}

/** Blocks and receipts are long; history shows what identifies them. */
function summarize(value: unknown, action: string | undefined): string {
  if (action === "getBlock" && isPlainObject(value))
    return `block ${formatValue(value.number)}, timestamp ${formatValue(value.timestamp)}`;
  if (action === "getTransactionReceipt" && isPlainObject(value)) {
    const logs = Array.isArray(value.logs) ? value.logs.length : 0;
    return `${String(value.status)}, block ${formatValue(value.blockNumber)}, ${logs} log(s)`;
  }
  return formatValue(value, { short: true });
}

function formatFault(fault: MockFault): string {
  if (fault === "timeout") return "timeout";
  if (fault === "network") return "network error";
  if ("status" in fault) return `HTTP ${fault.status}`;
  return `RPC error ${fault.code}${fault.message === undefined ? "" : ` (${fault.message})`}`;
}
