import { isHex } from "viem";
import { isPlainObject } from "./result.js";

/**
 * How narrowly a mock's pinned args or params constrain a call: the number of
 * leaf values they pin down. Mocks with nothing pinned match anything and rank
 * below all others.
 */
export function specificity(pinned: unknown): number {
  if (pinned === undefined) return -1;
  const count = (value: unknown): number => {
    if (Array.isArray(value)) return value.reduce((n: number, v) => n + count(v), 0);
    if (isPlainObject(value)) return Object.values(value).reduce((n: number, v) => n + count(v), 0);
    return 1;
  };
  return count(pinned);
}

/**
 * Deep equality where hex strings (addresses, bytes) compare case-insensitively
 * and equal integers match as either `number` or `bigint`.
 */
export function isMatch(expected: unknown, actual: unknown): boolean {
  if (isHex(expected) && isHex(actual)) return expected.toLowerCase() === actual.toLowerCase();
  if (Array.isArray(expected) && Array.isArray(actual))
    return (
      expected.length === actual.length && expected.every((value, i) => isMatch(value, actual[i]))
    );
  if (isPlainObject(expected) && isPlainObject(actual))
    return Object.entries(expected).every(([key, value]) => isMatch(value, actual[key]));
  // viem decodes integers up to 48 bits as numbers and wider ones as bigints. A
  // value of the other kind that got past the types still means the same number.
  if (typeof expected === "bigint" && typeof actual === "number")
    return Number.isInteger(actual) && expected === BigInt(actual);
  if (typeof expected === "number" && typeof actual === "bigint")
    return Number.isInteger(expected) && BigInt(expected) === actual;
  return expected === actual;
}
