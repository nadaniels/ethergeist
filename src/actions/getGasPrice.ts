import { numberToHex } from "viem";

import { encodeQuantity, viewQuantity } from "./codec.js";
import type { ActionsContext, Definition } from "./table.js";
import type { EmptyCall } from "./types.js";

/**
 * `eth_gasPrice`. Unmocked, the current block's base fee plus the tip, as
 * reth suggests.
 */
export const getGasPrice = ({ state }: ActionsContext): Definition<EmptyCall> => ({
  name: "getGasPrice",
  hint: "mock.actions.getGasPrice().returns(…), or `fees` in createMockRpc()",
  decode: () => ({}),
  zero: 0n,
  encode: encodeQuantity("getGasPrice's answer"),
  view: viewQuantity,
  fallback() {
    const { baseFeePerGas, maxPriorityFeePerGas } = state.feesAt(state.blockNumber);
    return numberToHex(baseFeePerGas + maxPriorityFeePerGas);
  },
});
