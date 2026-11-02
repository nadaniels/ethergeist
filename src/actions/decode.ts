import { type BlockTag, getAddress, hexToBigInt, isHex, numberToHex } from "viem";

import { addressParam, quantityParam } from "../chain/params.js";
import { formatValue } from "../mocking/format.js";
import { invalidParams, MockSetupError } from "../shared/errors.js";
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

/**
 * A JSON-RPC quantity in a transaction, as a bigint; `undefined` when it's
 * missing. `what` names it if it's refused.
 */
export const quantity = (value: unknown, what: string) =>
  isHex(value) ? quantityParam(value, what) : undefined;

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
