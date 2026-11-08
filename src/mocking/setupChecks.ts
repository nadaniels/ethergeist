/**
 * Checks of the generic kinds of value the mock's setup API takes (amounts,
 * counts, and objects of known fields), each a `MockSetupError` when the
 * value is wrong. Domain checks (logs, reverts, faults, hashes) stay in
 * their own layers, and the public assertions (`assertAllUsed` and the rest)
 * are in `rpc/checks.ts`.
 */
import { MockSetupError } from "../shared/errors.js";
import { isPlainObject, withoutUndefined } from "../shared/values.js";
import { formatValue } from "./format.js";
import { checkNoMatchers } from "./matching.js";

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

/**
 * `value` as an object of known fields, with its `undefined` fields left
 * out; throws unless it's an object, it holds no matcher, and every field
 * it has is in `fields`. `what` names it mid-sentence in the message ("a
 * send's outcome"). `hint` gives the hint line: for a field it doesn't take,
 * or, called without one, for a value that isn't an object.
 */
export function checkFields<value>(
  value: value,
  what: string,
  fields: ReadonlySet<string>,
  hint: (field?: string) => string,
): value & Record<string, unknown> {
  if (!isPlainObject(value))
    throw new MockSetupError(`Expected an object for ${what}; got ${formatValue(value)}.`, {
      metaMessages: [hint()],
    });
  checkNoMatchers(value, what);
  const given = withoutUndefined(value);
  const unknown = Object.keys(given).find((field) => !fields.has(field));
  if (unknown !== undefined)
    throw new MockSetupError(`${unknown} isn't a field of ${what}.`, {
      metaMessages: [hint(unknown)],
    });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the same object, less its undefined fields
  return given as value & Record<string, unknown>;
}
