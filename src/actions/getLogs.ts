import { type RpcLog, formatLog } from "viem";

import { toRpcLog } from "../chain/receipts.js";
import type { EmittedLog } from "../logs/events.js";
import { type LogsCall, decodeLogsCall } from "../logs/filter.js";
import { checkAmount, checkList } from "../mocking/setupChecks.js";
import { MockSetupError } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import { pinAddress } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";
import type { ActionContext } from "./types.js";

/**
 * What a `getLogs` resolver gets: the call's fields (its filter), `fail`,
 * and `logs`.
 */
export type LogsContext = ActionContext<LogsCall> & {
  /**
   * The chain's logs the call asks for, as `getLogs` answers unmocked.
   * Reading it for a filter a node would refuse, e.g. a range past the head,
   * throws that refusal.
   */
  readonly logs: EmittedLog[];
};

/**
 * `eth_getLogs`. Unmocked, the chain's logs the filter matches, at any
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
 * Logs a `getLogs` mock answered with, in JSON-RPC form. They must be placed,
 * e.g. from `mock.logs` or `mock.buildLog()`: content alone has no block or
 * transaction.
 */
function toRpcLogs(value: unknown): RpcLog[] {
  checkList(value, "getLogs's answer");
  return value.map((log: unknown, i) => {
    const placed =
      isPlainObject(log) &&
      Object.entries(placedFields).every(([field, type]) => typeof log[field] === type);
    if (!placed)
      throw new MockSetupError(`log ${i} in getLogs's answer has no position.`, {
        metaMessages: ["Answer placed logs, e.g. from mock.logs or mock.buildLog()."],
      });
    // `toRpcLog` would silently drop a value that isn't a bigint.
    const { blockTimestamp } = log;
    if (blockTimestamp !== undefined)
      checkAmount(blockTimestamp, `blockTimestamp of log ${i} in getLogs's answer`);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- its position is checked above; the rest is the mock's answer as given
    return toRpcLog(log as unknown as EmittedLog);
  });
}
