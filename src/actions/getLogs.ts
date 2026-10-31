import { type RpcLog, formatLog } from "viem";
import type { EmittedLog } from "../logs/events.js";
import type { LogsCall } from "../logs/filter.js";
import { pinAddress } from "./decode.js";
import type { ActionContext } from "./types.js";
import type { ActionsContext, Definition } from "./table.js";

/**
 * What a `getLogs` resolver gets: the filter, `fail`, and `logs`, what the
 * emitted logs would answer. Reading `logs` for a filter a node would refuse
 * (a range past the head, an address without a contract) throws that refusal.
 */
export type LogsContext = ActionContext<LogsCall> & { readonly logs: EmittedLog[] };

/** `eth_getLogs`: unmocked, the emitted logs the filter matches, as a node filters them. */
export const getLogs = ({ logStore }: ActionsContext): Definition => ({
  name: "getLogs",
  hint: "mock.actions.getLogs(…).returns(…), or mock.emit(…)",
  decode: (params) => logStore.decode(params),
  pin: pinAddress,
  zero: [],
  encode: (value) => logStore.toRpc(value),
  extendContext(context, call) {
    Object.defineProperty(context, "logs", {
      enumerable: true,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoded by logStore.decode
      get: () => logStore.find(call as LogsCall),
    });
  },
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoded by logStore.decode
  fallback: (call) => logStore.toRpc(logStore.find(call as LogsCall)),
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- encoded by logStore.toRpc
  view: (rpc) => (rpc as RpcLog[]).map((log) => formatLog(log)),
});
