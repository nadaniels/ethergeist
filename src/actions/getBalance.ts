import { decodeAddressAtBlock, encodeQuantity, pinAddress, viewQuantity } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";
import type { BalanceCall } from "./types.js";

/** `eth_getBalance`: unmocked addresses aren't answered. */
export const getBalance = ({ state }: ActionsContext): Definition<BalanceCall> => ({
  name: "getBalance",
  hint: "mock.actions.getBalance({ address }).returns(…)",
  decode: (params) => decodeAddressAtBlock(params, state.resolveBlock),
  pin: pinAddress,
  zero: 0n,
  encode: encodeQuantity("A balance"),
  view: viewQuantity,
});
