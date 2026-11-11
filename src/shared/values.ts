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

/**
 * `fields` without the ones left out: an explicit `undefined` is a field
 * left out, as consumers' types allow it in any optional field.
 */
export const withoutUndefined = (fields: object) =>
  Object.fromEntries(Object.entries(fields).filter(([, each]) => each !== undefined));

/**
 * `value` with its `undefined` fields left out when it's an object literal;
 * anything else is as given. It returns a copy, so an answer held as given
 * is stripped on each read.
 */
export const leftOut = (value: unknown): unknown =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
    ? withoutUndefined(value)
    : value;
