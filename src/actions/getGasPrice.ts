import { numberToHex } from "viem";
import { encodeQuantity, viewQuantity } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";

/** `eth_gasPrice`: unmocked, the current block's base fee plus the tip, as reth suggests. */
export const getGasPrice = ({ state }: ActionsContext): Definition => ({
  name: "getGasPrice",
  hint: "mock.actions.getGasPrice().returns(…), or `fees` in createMockRpc()",
  decode: () => ({}),
  zero: 0n,
  encode: encodeQuantity("A gas price"),
  view: viewQuantity,
  fallback() {
    const { baseFeePerGas, maxPriorityFeePerGas } = state.feesAt(state.blockNumber);
    return numberToHex(baseFeePerGas + maxPriorityFeePerGas);
  },
});
