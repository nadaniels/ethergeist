import {
  type Address,
  type BlockTag,
  type Hash,
  type Hex,
  getAddress,
  isAddress,
  isHash,
  isHex,
} from "viem";

import { formatValue } from "../mocking/format.js";
import { invalidParams } from "../shared/errors.js";
import { isPlainObject, lowercase } from "../shared/values.js";

// A request's params, read to the Ethereum JSON-RPC spec (ethereum/execution-apis):
// what it rules out is refused as invalid params, never thrown as is (viem
// retries an error without a code, so it would fail slowly). Hex is
// case-insensitive, and what the spec doesn't define is ignored.

/** An address param, checksummed; refused as invalid params if it isn't one. */
export function addressParam(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false }))
    throw invalidParams(`expected an address; got ${formatValue(value)}`);
  return getAddress(value);
}

/**
 * A 32-byte hash param, lowercase: the form the mock holds hashes in, so a
 * request in any case finds them. Refused as invalid params if it isn't one.
 */
export function hashParam(value: unknown): Hash {
  if (typeof value !== "string" || !isHash(value))
    throw invalidParams(`expected a 32-byte hash; got ${formatValue(value)}`);
  return lowercase(value);
}

/**
 * A quantity param as a bigint; refused as invalid params if it isn't one.
 * The spec's `uint`: `0x`, then hex digits in any case, at least one and no
 * leading zeros; never a JSON number. `what` names it in the error.
 */
export function quantityParam(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u.test(value))
    throw invalidParams(`expected ${what}; got ${formatValue(value)}`);
  return BigInt(value);
}

/** Like `quantityParam`, for a field that may be left out. */
export const optionalQuantity = (value: unknown, what: string) =>
  value === undefined ? undefined : quantityParam(value, what);

/** A field of hex data that may be left out; refused as invalid params if it isn't hex. */
function optionalData(value: unknown, what: string): Hex | undefined {
  if (value === undefined) return undefined;
  if (!isHex(value))
    throw invalidParams(`expected hex data for ${what}; got ${formatValue(value)}`);
  return value;
}

const optionalAddress = (value: unknown) => (value === undefined ? undefined : addressParam(value));

/**
 * A transaction request's fields, as `eth_call`, `eth_estimateGas` and
 * `eth_sendTransaction` take it (the spec's `GenericTransaction`): addresses
 * checksummed, `to: null` (a creation) as left out, the spec's `input` or the
 * `data` clients send, and `value` as `0n` when it has none. Fields it leaves
 * out are `undefined`. A field that's malformed, `null` included (but for
 * `to`), is refused as invalid params, and so is a request that isn't an object.
 */
export function transactionParam(tx: unknown) {
  if (!isPlainObject(tx))
    throw invalidParams(`expected a transaction object; got ${formatValue(tx)}`);
  const { from, to, value, data, input, gas, gasPrice, maxFeePerGas, maxPriorityFeePerGas, nonce } =
    tx;
  // Both are checked, though `data` wins: a malformed field is refused, never skipped.
  const [given, spec] = [optionalData(data, "`data`"), optionalData(input, "`input`")];
  return {
    from: optionalAddress(from),
    to: to === null ? undefined : optionalAddress(to),
    value: optionalQuantity(value, "a value") ?? 0n,
    data: given ?? spec,
    gas: optionalQuantity(gas, "a gas limit"),
    gasPrice: optionalQuantity(gasPrice, "a gas price"),
    maxFeePerGas: optionalQuantity(maxFeePerGas, "a max fee per gas"),
    maxPriorityFeePerGas: optionalQuantity(maxPriorityFeePerGas, "a max priority fee per gas"),
    nonce: nonce === undefined ? undefined : numberParam(nonce, "a nonce"),
  };
}

/**
 * The block params the spec takes, by method: a number or tag
 * (`eth_getBlockByNumber`, `eth_feeHistory`), also a hash or an EIP-1898
 * object (`eth_call`, `eth_getBalance` and the like). A log range's bounds
 * are numbers or tags, but not `pending`: `logs/filter.ts` refuses that.
 */
export type BlockForm = "numberOrTag" | "numberTagOrHash";

/** A block param as a block number: the chain state's `resolveBlock`. */
export type ResolveBlock = (block: unknown, form?: BlockForm) => bigint;

/**
 * A spec method's `params` without the `null`s at its end: JSON writes a
 * param left out as `null` (viem's `[count, block, undefined]` arrives as
 * `[count, block, null]`). Raw methods' params are left as sent.
 */
export function withoutTrailingNulls(params: unknown): unknown {
  if (!Array.isArray(params)) return params;
  let end = params.length;
  while (end > 0 && params[end - 1] === null) end -= 1;
  return params.slice(0, end);
}

const blockTags = new Set<unknown>(["latest", "earliest", "pending", "safe", "finalized"]);

/** Whether `value` is a block tag, like `"latest"`. */
export const isBlockTag = (value: unknown): value is BlockTag => blockTags.has(value);

/**
 * Like `quantityParam`, as a number; refused past `Number.MAX_SAFE_INTEGER`.
 * Nodes take some of these as u64 (a nonce), so the mock refuses a few a node
 * accepts: none a real app sends.
 */
export function numberParam(value: unknown, what: string): number {
  const quantity = quantityParam(value, what);
  if (quantity > BigInt(Number.MAX_SAFE_INTEGER))
    throw invalidParams(`expected ${what} of at most 2^53 - 1; got ${formatValue(value)}`);
  return Number(quantity);
}
