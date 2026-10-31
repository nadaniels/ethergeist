import { isHex } from "viem";
import type { CodeCall } from "./types.js";
import { decodeAddressAtBlock, pinAddress } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";

/** `eth_getCode`: unmocked, what the registry knows, contracts' placeholder code and empty addresses'. */
export const getCode = ({ state, registry }: ActionsContext): Definition => ({
  name: "getCode",
  hint: "mock.actions.getCode({ address }).returns(…), or mock.empty(address)",
  decode: (params) => decodeAddressAtBlock(params, state.resolveBlock),
  pin: pinAddress,
  zero: "0x",
  encode(value) {
    if (!isHex(value)) throw new TypeError(`Code must be hex; got ${String(value)}.`);
    return value;
  },
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoded by decodeAddressAtBlock
  fallback: (call) => registry.codeAt((call as CodeCall).address),
});
