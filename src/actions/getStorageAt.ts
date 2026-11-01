import { type Hex, isHex, pad, size } from "viem";

import { formatValue } from "../mocking/format.js";
import { isPlainObject, lowercase } from "../shared/values.js";
import { decodeAddressAtBlock, pinAddress } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";
import type { StorageCall } from "./types.js";

/** A storage slot or value as 32 bytes, lowercase; `what` names it in the error. */
function toWord(value: unknown, what: string): Hex {
  if (!isHex(value))
    throw new TypeError(`${what} must be hex of up to 32 bytes; got ${formatValue(value)}.`);
  if (size(value) > 32)
    throw new TypeError(
      `${what} must be hex of up to 32 bytes; got ${size(value)} bytes: ${value}.`,
    );
  return pad(lowercase(value), { size: 32 });
}

/**
 * Checksums a pinned `address` and pads a pinned `slot` to 32 bytes, as calls
 * have them. Anything else, like a matcher, is left as is.
 */
function pinStorage(pinned: unknown) {
  const pinnedAddress = pinAddress(pinned);
  if (!isPlainObject(pinnedAddress) || typeof pinnedAddress.slot !== "string") return pinnedAddress;
  return { ...pinnedAddress, slot: toWord(pinnedAddress.slot, "A storage slot") };
}

/** `eth_getStorageAt`: slots and values as 32 bytes; unmocked, an `empty()` address's storage is zero. */
export const getStorageAt = ({ state, registry }: ActionsContext): Definition<StorageCall> => ({
  name: "getStorageAt",
  hint: "mock.actions.getStorageAt({ address, slot }).returns(…), or mock.empty(address)",
  decode([address, slot, block]) {
    const { address: checksummed, ...at } = decodeAddressAtBlock(
      [address, block],
      state.resolveBlock,
    );
    return { address: checksummed, slot: toWord(slot, "A storage slot"), ...at };
  },
  pin: pinStorage,
  zero: "0x",
  encode: (value) => toWord(value, "A storage value"),
  // An address without code has no storage: every slot reads as zero.
  fallback: (call) =>
    registry.codeAt(call.address) === "0x" ? pad("0x", { size: 32 }) : undefined,
});
