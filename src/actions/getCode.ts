import { checkHex } from "../mocking/setupChecks.js";
import { decodeAddressAtBlock, pinAddress } from "./codec.js";
import type { ActionsContext, Definition } from "./table.js";
import type { CodeCall } from "./types.js";

/**
 * `eth_getCode`. Unmocked, a registered contract and Multicall3 answer with
 * placeholder code, an `empty()` address with `0x`, and other addresses
 * aren't answered.
 */
export const getCode = ({ state, registry }: ActionsContext): Definition<CodeCall> => ({
  name: "getCode",
  hint: "mock.actions.getCode({ address }).returns(…), or mock.empty(address)",
  decode: (params) => decodeAddressAtBlock(params, state.resolveBlock),
  pin: pinAddress,
  zero: "0x",
  encode(value) {
    checkHex(value, "getCode's answer");
    return value;
  },
  fallback: (call) => registry.codeAt(call.address),
});
