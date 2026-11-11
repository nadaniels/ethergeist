import { numberToHex } from "viem";

import { encodeQuantity, viewQuantity } from "./codec.js";
import type { ActionsContext, Definition } from "./table.js";
import type { EmptyCall } from "./types.js";

/**
 * `eth_maxPriorityFeePerGas`, the tip a node suggests. Unmocked, the current
 * block's.
 */
export const estimateMaxPriorityFeePerGas = ({ state }: ActionsContext): Definition<EmptyCall> => ({
  name: "estimateMaxPriorityFeePerGas",
  hint: "mock.actions.estimateMaxPriorityFeePerGas().returns(…), or `fees` in createMockRpc()",
  decode: () => ({}),
  zero: 0n,
  encode: encodeQuantity("estimateMaxPriorityFeePerGas's answer"),
  view: viewQuantity,
  fallback: () => numberToHex(state.feesAt(state.blockNumber).maxPriorityFeePerGas),
});
