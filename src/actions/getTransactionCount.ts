import { hexToNumber, isHex, numberToHex } from "viem";
import { formatValue } from "../mocking/format.js";
import { decodeAddressAtBlock, pinAddress } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";

/** `eth_getTransactionCount`, an account's nonce: unmocked addresses aren't answered. */
export const getTransactionCount = ({ state }: ActionsContext): Definition => ({
  name: "getTransactionCount",
  hint: "mock.actions.getTransactionCount({ address }).returns(…)",
  decode: (params) => decodeAddressAtBlock(params, state.resolveBlock),
  pin: pinAddress,
  zero: 0,
  encode(value) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new TypeError(
        `A transaction count must be a whole number, zero or more; got ${formatValue(value)}.`,
      );
    return numberToHex(value);
  },
  view: (rpc) => (isHex(rpc) ? hexToNumber(rpc) : rpc),
});
