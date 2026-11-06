import { type Address, type Hex, getAddress } from "viem";

/**
 * `address` as nodes send it in their answers: lowercase. Validated first,
 * so a malformed one fails where it's given. viem passes these through as
 * they are, so answers keep the case an app gets from a node.
 */
export function nodeAddress(address: string): Address {
  return lowercase(getAddress(address));
}

/**
 * `value` in lowercase, keeping its hex type: an address stays an address, a
 * hash a hash.
 */
export function lowercase<hex extends Hex>(value: hex): hex {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- lowercase hex is still the same kind of hex
  return value.toLowerCase() as hex;
}

/** Whether `value` is an object other than an array or `null`. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
