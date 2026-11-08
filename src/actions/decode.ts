import {
  type Address,
  type BlockTag,
  type Hash,
  type Hex,
  getAddress,
  hexToBigInt,
  isHash,
  isHex,
  numberToHex,
} from "viem";

import {
  type BlockForm,
  type ResolveBlock,
  type transactionParam,
  addressParam,
  isBlockTag,
} from "../chain/params.js";
import type { MockTransactionType } from "../chain/transactions.js";
import type { Registry } from "../contracts/registry.js";
import { checkAmount } from "../mocking/setupChecks.js";
import { isPlainObject, lowercase, withoutUndefined } from "../shared/values.js";
import type { AddressAtBlockCall, SendTransactionCall } from "./types.js";

/**
 * Encodes a non-negative bigint answer as a JSON-RPC quantity; `what` is its
 * subject in the message.
 */
export function encodeQuantity(what: string) {
  return (value: unknown) => {
    checkAmount(value, what);
    return numberToHex(value);
  };
}

/** A JSON-RPC quantity as viem's action returns it. */
export const viewQuantity = (rpc: unknown) => (isHex(rpc) ? hexToBigInt(rpc) : rpc);

/**
 * Checksums a pinned `address`, or each of several, which also validates it
 * at registration.
 */
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
 * Checksums a pinned `from` and `to`, which also validates them at
 * registration.
 */
export function pinTransaction(pinned: unknown) {
  if (!isPlainObject(pinned)) return pinned;
  const { from, to } = pinned;
  return {
    ...pinned,
    ...(typeof from === "string" && { from: getAddress(from) }),
    ...(typeof to === "string" && { to: getAddress(to) }),
  };
}

/**
 * An `eth_sendTransaction`'s call, from its request's fields
 * (`transactionParam`), its sender and its type: `to` is `null` for a
 * deploy, and empty `data` is left out. An estimate's send is one too, since
 * send mocks are matched against it.
 */
export function sendCall(
  fields: ReturnType<typeof transactionParam>,
  from: Address,
  type: MockTransactionType,
): SendTransactionCall {
  const { to, value, data, nonce, gas, gasPrice, maxFeePerGas, maxPriorityFeePerGas } = fields;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- undefined fields are left out
  return withoutUndefined({
    from,
    to: to ?? null,
    value,
    data: data === "0x" ? undefined : data,
    nonce,
    gas,
    gasPrice,
    maxFeePerGas,
    maxPriorityFeePerGas,
    type,
  }) as SendTransactionCall;
}

/**
 * Whether a transaction is a plain transfer to an address without code: no
 * data, to an address the mock knows has none, or doesn't know. A node runs
 * nothing for one. It estimates the base 21,000 gas, and the transfer
 * succeeds.
 */
export function isPlainTransfer(
  registry: Registry,
  { to, data }: { to?: Address | null; data?: Hex },
) {
  if (to === undefined || to === null || (data !== undefined && data !== "0x")) return false;
  const code = registry.codeAt(to);
  return code === undefined || code === "0x";
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

/**
 * The call for an address and a block, as `eth_getBalance` and its kind take
 * them: see `AddressAtBlockCall`.
 */
export function decodeAddressAtBlock(
  [address, block]: readonly unknown[],
  resolveBlock: ResolveBlock,
): AddressAtBlockCall {
  return {
    address: addressParam(address),
    ...blockAt(block, resolveBlock),
  };
}

/**
 * The hash a receipt or transaction mock pins exactly, as its call, lowercase
 * as a request's is decoded; `{}` for a matcher.
 */
export const pinnedHash = (pinned: unknown): { hash?: Hash } =>
  isPlainObject(pinned) && typeof pinned.hash === "string" && isHash(pinned.hash)
    ? { hash: lowercase(pinned.hash) }
    : {};
