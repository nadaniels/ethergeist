/**
 * Checks of the generic kinds of value the mock's setup API takes, each a
 * `MockSetupError` when the value is wrong. Domain checks (logs, reverts,
 * faults, hashes) stay in their own layers, and the public assertions
 * (`assertAllUsed` and the rest) are in `rpc/checks.ts`.
 */
import { MockSetupError } from "../shared/errors.js";
import { formatValue } from "./format.js";

/**
 * Throws unless `value` is a non-negative bigint. `what` is its subject in
 * the message, named as the user wrote it: "mock.addTransaction()'s gasUsed".
 */
export function checkAmount(value: unknown, what: string): asserts value is bigint {
  if (typeof value !== "bigint" || value < 0n)
    throw new MockSetupError(`${what} must be a non-negative bigint; got ${formatValue(value)}.`);
}

/**
 * Throws unless `value` is a safe integer, `min` or more: positive for `1`,
 * non-negative for `0`. `what` is its subject in the message; `hint` names
 * what else the site takes, e.g. "Or Infinity to keep them all."
 */
export function checkCount(
  value: unknown,
  what: string,
  min: 0 | 1,
  hint?: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    throw new MockSetupError(
      `${what} must be ${min === 1 ? "a positive" : "a non-negative"} integer; got ${formatValue(value)}.`,
      hint === undefined ? undefined : { metaMessages: [hint] },
    );
}
