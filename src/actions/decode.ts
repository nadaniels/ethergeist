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
  addressParam,
  isBlockTag,
  numberParam,
  optionalData,
  optionalQuantity,
} from "../chain/params.js";
import type { ChainState } from "../chain/state.js";
import type { Registry } from "../contracts/registry.js";
import { MockSetupError } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import type { TransactionStore } from "../transactions/store.js";
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

/** Checksums a pinned `account` and `to`, which also validates them at registration. */
export function pinTransaction(pinned: unknown) {
  if (!isPlainObject(pinned)) return pinned;
  const { account, to } = pinned;
  return {
    ...pinned,
    ...(typeof account === "string" && { account: getAddress(account) }),
    ...(typeof to === "string" && { to: getAddress(to) }),
  };
}

const optionalAddress = (address: unknown) =>
  address === undefined || address === null ? undefined : addressParam(address);

/**
 * A transaction request's fields, as `eth_estimateGas` and
 * `eth_sendTransaction` take it: `from` as `account`, the spec's `input` or
 * the `data` clients send, and `value` as `0n` when it has none. Fields it
 * leaves out are `undefined`, and so are a `from` or `to` sent as `null`;
 * any other field that's malformed, `null` included, is refused.
 */
export function decodeTransactionRequest(tx: unknown) {
  const { from, to, value, data, input, gas, gasPrice, maxFeePerGas, maxPriorityFeePerGas, nonce } =
    isPlainObject(tx) ? tx : {};
  // Both are checked, though `data` wins: a malformed field is refused, never skipped.
  const [given, spec] = [optionalData(data, "`data`"), optionalData(input, "`input`")];
  return {
    account: optionalAddress(from),
    to: optionalAddress(to),
    value: optionalQuantity(value, "a value") ?? 0n,
    data: given ?? spec,
    gas: optionalQuantity(gas, "a gas limit"),
    gasPrice: optionalQuantity(gasPrice, "a gas price"),
    maxFeePerGas: optionalQuantity(maxFeePerGas, "a max fee per gas"),
    maxPriorityFeePerGas: optionalQuantity(maxPriorityFeePerGas, "a max priority fee per gas"),
    nonce: nonce === undefined ? undefined : numberParam(nonce, "a nonce"),
  };
}

/** `fields` without the ones left out (`undefined`), as a call has them. */
export const withoutUndefined = (fields: object) =>
  Object.fromEntries(Object.entries(fields).filter(([, each]) => each !== undefined));

/**
 * Whether a transaction is a plain transfer to an address without code: no
 * data, to an address the mock knows has none, or doesn't know. A node runs
 * nothing for one: it estimates the base 21000 gas, and the transfer succeeds.
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

/** The hash a receipt or transaction mock pins exactly, as its call; `undefined` for a matcher. */
export const pinnedHash = (pinned: unknown): { hash: Hash } | undefined =>
  isPlainObject(pinned) && typeof pinned.hash === "string" && isHash(pinned.hash)
    ? { hash: pinned.hash }
    : undefined;

/**
 * Fixes a static receipt's or transaction's block, which a node never moves,
 * at registration: where its transaction is on the chain, if its pinned hash
 * is one there, and otherwise the current block, as if mined now. A
 * transaction placed in a block not mined yet isn't on the chain, so it's
 * the current block too. Pending (`blockNumber: null`) and a given block
 * stay as they are.
 */
export function minedWhenRegistered(state: ChainState, transactions: TransactionStore) {
  return (value: unknown, call: { hash: Hash } | undefined) => {
    if (!isPlainObject(value) || value.blockNumber !== undefined) return value;
    const mined = call === undefined ? undefined : transactions.minedAt(call.hash);
    return mined === undefined
      ? { ...value, blockNumber: state.blockNumber }
      : {
          ...value,
          blockNumber: mined.blockNumber,
          transactionIndex: value.transactionIndex ?? mined.index,
        };
  };
}
