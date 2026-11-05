import { type RpcLog, formatLog } from "viem";

import { toRpcLog } from "../chain/receipts.js";
import type { EmittedLog } from "../logs/events.js";
import { type LogsCall, decodeLogsCall } from "../logs/filter.js";
import { MockSetupError } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import { pinAddress } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";
import type { ActionContext } from "./types.js";

/**
 * What a `getLogs` resolver gets: the filter, `fail`, and `logs`, what the
 * chain's logs would answer. Reading `logs` for a filter a node would refuse
 * (a range past the head) throws that refusal.
 */
export type LogsContext = ActionContext<LogsCall> & { readonly logs: EmittedLog[] };

/**
 * `eth_getLogs`: unmocked, the chain's logs the filter matches, at any
 * address, as a node filters them.
 */
export const getLogs = ({
  state,
  transactions,
}: ActionsContext): Definition<LogsCall, RpcLog[]> => ({
  name: "getLogs",
  hint: "mock.actions.getLogs(…).returns(…), or mock.addTransaction({ logs })",
  decode: (params) => decodeLogsCall(params, state.resolveBlock),
  pin: pinAddress,
  zero: [],
  encode: (value) => toRpcLogs(value),
  extendContext(context, call) {
    Object.defineProperty(context, "logs", {
      enumerable: true,
      get: () => transactions.logsFor(call),
    });
  },
  fallback: (call) => transactions.logsFor(call).map((log) => toRpcLog(log)),
  view: (rpc) => rpc.map((log) => formatLog(log)),
});

/** Fields a placed log has, with the types viem gives them. */
const placedFields = {
  blockHash: "string",
  blockNumber: "bigint",
  transactionHash: "string",
  transactionIndex: "number",
  logIndex: "number",
} as const;

/**
 * Logs a `getLogs` mock answered with, in JSON-RPC form. They must be placed
 * (from `mock.logs` or `mock.buildLog()`): content alone has no block or transaction.
 */
function toRpcLogs(value: unknown): RpcLog[] {
  if (!Array.isArray(value))
    throw new MockSetupError(`getLogs answers a list of logs; got ${typeof value}.`);
  return value.map((log: unknown, i) => {
    const placed =
      isPlainObject(log) &&
      Object.entries(placedFields).every(([field, type]) => typeof log[field] === type);
    if (!placed)
      throw new MockSetupError(
        `getLogs answers placed logs, e.g. from mock.logs or mock.buildLog(); log ${i} has no position.`,
      );
    // Left out for a node that doesn't send it; anything else would be dropped.
    const { blockTimestamp } = log;
    if (blockTimestamp !== undefined && typeof blockTimestamp !== "bigint")
      throw new MockSetupError(
        `getLogs log ${i}'s blockTimestamp must be a bigint, or left out; ` +
          `got ${blockTimestamp === null ? "null" : typeof blockTimestamp}.`,
      );
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- its position is checked above; the rest is the mock's answer as given
    return toRpcLog(log as unknown as EmittedLog);
  });
}
