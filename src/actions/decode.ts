import { type BlockTag, getAddress, hexToBigInt, isHex, numberToHex } from "viem";

import { isPlainObject } from "../shared/values.js";
import type { AddressAtBlockCall } from "./types.js";

/** Encodes a bigint answer as a JSON-RPC quantity; `what` names it in the error. */
export function encodeQuantity(what: string) {
  return (value: unknown) => {
    if (typeof value !== "bigint")
      throw new TypeError(`${what} must be a bigint; got ${typeof value}.`);
    return numberToHex(value);
  };
}

/** A JSON-RPC quantity as viem's action returns it. */
export const viewQuantity = (rpc: unknown) => (isHex(rpc) ? hexToBigInt(rpc) : rpc);

/** A JSON-RPC quantity in a transaction, as a bigint; `undefined` when it's missing. */
export const quantity = (value: unknown) => (isHex(value) ? hexToBigInt(value) : undefined);

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
  resolveBlock: (block: unknown) => bigint,
): { blockNumber: bigint; blockTag?: BlockTag } {
  const tagged = block ?? "latest";
  const isTag = typeof tagged === "string" && !isHex(tagged);
  return {
    blockNumber: resolveBlock(tagged),
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a tag, per JSON-RPC
    ...(isTag && { blockTag: tagged as BlockTag }),
  };
}

/** An address and a block, as `eth_getBalance` and its kind take them; see `AddressAtBlockCall`. */
export function decodeAddressAtBlock(
  [address, block]: readonly unknown[],
  resolveBlock: (block: unknown) => bigint,
): AddressAtBlockCall {
  return {
    // JSON-RPC params arrive untyped; viem sends the address first.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- untyped JSON-RPC boundary
    address: getAddress(address as string),
    ...blockAt(block, resolveBlock),
  };
}
