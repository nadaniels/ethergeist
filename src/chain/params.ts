import { type Address, type Hash, getAddress, hexToBigInt, isAddress, isHash, isHex } from "viem";

import { formatValue } from "../mocking/format.js";
import { invalidParams } from "../shared/errors.js";

// A request's params, refused as a node refuses them: what can't be parsed is
// refused as invalid params, never thrown as is. viem retries an error
// without a code, so a malformed request would otherwise fail slowly.

/** An address param, checksummed; refused as invalid params if it isn't one. */
export function addressParam(value: unknown): Address {
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

/**
 * A hex quantity param as a bigint; refused as invalid params if it isn't
 * one. `"0x"` isn't: a quantity has at least one digit, and zero is `"0x0"`.
 * Only missing digits are checked; leading zeros (`"0x01"`) are accepted.
 * `what` names it in the error.
 */
export function quantityParam(value: unknown, what: string): bigint {
  if (!isHex(value) || value === "0x")
    throw invalidParams(`expected ${what}; got ${formatValue(value)}`);
  return hexToBigInt(value);
}

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
