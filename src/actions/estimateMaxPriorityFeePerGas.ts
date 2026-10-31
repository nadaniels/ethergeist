import { numberToHex } from "viem";
import { encodeQuantity, viewQuantity } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";

/** `eth_maxPriorityFeePerGas`, the tip a node suggests: unmocked, the current block's. */
export const estimateMaxPriorityFeePerGas = ({ state }: ActionsContext): Definition => ({
  name: "estimateMaxPriorityFeePerGas",
  hint: "mock.actions.estimateMaxPriorityFeePerGas().returns(…), or `fees` in createMockRpc()",
  decode: () => ({}),
  zero: 0n,
  encode: encodeQuantity("A priority fee"),
  view: viewQuantity,
  fallback: () => numberToHex(state.feesAt(state.blockNumber).maxPriorityFeePerGas),
});
