import { type BlockTag, getAddress, hexToBigInt, isHex, numberToHex } from "viem";

import { type BlockForm, type ResolveBlock, addressParam, isBlockTag } from "../chain/params.js";
import { MockSetupError } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import type { AddressAtBlockCall } from "./types.js";

/** Encodes a bigint answer as a JSON-RPC quantity; `what` names it in the error. */
export function encodeQuantity(what: string) {
  return (value: unknown) => {
    if (typeof value !== "bigint")
      throw new MockSetupError(`${what} must be a bigint; got ${typeof value}.`);
    return numberToHex(value);
  };
}

/** A JSON-RPC quantity as viem's action returns it. */
export const viewQuantity = (rpc: unknown) => (isHex(rpc) ? hexToBigInt(rpc) : rpc);

/** Checksums a pinned `address` (or each of several), which also validates it at registration. */
export function pinAddress(pinned: unknown) {
  if (!isPlainObject(pinned)) return pinned;
  const { address } = pinned;
  if (typeof address === "string") return { ...pinned, address: getAddress(address) };
  if (Array.isArray(address))
    return {
      ...pinned,
      address: address.map((each: unknown) => (typeof each === "string" ? getAddress(each) : each)),
    };
  return pinned;
}

/**
 * A block parameter as a call has it: the block number, and the tag if it's
 * one, kept so `"pending"` can be pinned apart from `"latest"`. No block is
 * `"latest"`; a block number has no tag.
 */
export function blockAt(
  block: unknown,
  resolveBlock: ResolveBlock,
  form?: BlockForm,
): { blockNumber: bigint; blockTag?: BlockTag } {
  const tagged = block === undefined ? "latest" : block;
  return {
    blockNumber: resolveBlock(tagged, form),
    ...(isBlockTag(tagged) && { blockTag: tagged }),
  };
}

/** An address and a block, as `eth_getBalance` and its kind take them; see `AddressAtBlockCall`. */
export function decodeAddressAtBlock(
  [address, block]: readonly unknown[],
  resolveBlock: ResolveBlock,
): AddressAtBlockCall {
  return {
    address: addressParam(address),
    ...blockAt(block, resolveBlock),
  };
}
