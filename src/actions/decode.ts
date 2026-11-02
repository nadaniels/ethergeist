import {
  type Address,
  type BlockTag,
  type Hash,
  getAddress,
  hexToBigInt,
  isAddress,
  isHash,
  isHex,
  numberToHex,
} from "viem";

import { formatValue } from "../mocking/format.js";
import { invalidParams } from "../shared/errors.js";
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
  if (typeof tagged === "string" && !isHex(tagged) && !isBlockTag(tagged))
    throw invalidParams(`expected a block number, tag or hash; got ${formatValue(tagged)}`);
  return {
    blockNumber: resolveBlock(tagged),
    ...(isBlockTag(tagged) && { blockTag: tagged }),
  };
}

const blockTags = new Set<unknown>(["latest", "earliest", "pending", "safe", "finalized"]);

const isBlockTag = (value: unknown): value is BlockTag => blockTags.has(value);

/** An address param, checksummed; refused as invalid params if it isn't one. */
function addressParam(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false }))
    throw invalidParams(`expected an address; got ${formatValue(value)}`);
  return getAddress(value);
}

/** A 32-byte hash param; refused as invalid params if it isn't one. */
export function hashParam(value: unknown): Hash {
  if (typeof value !== "string" || !isHash(value))
    throw invalidParams(`expected a 32-byte hash; got ${formatValue(value)}`);
  return value;
}

/** An address and a block, as `eth_getBalance` and its kind take them; see `AddressAtBlockCall`. */
export function decodeAddressAtBlock(
  [address, block]: readonly unknown[],
  resolveBlock: (block: unknown) => bigint,
): AddressAtBlockCall {
  return {
    address: addressParam(address),
    ...blockAt(block, resolveBlock),
  };
}
