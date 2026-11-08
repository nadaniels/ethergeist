/**
 * Checks of the generic kinds of value the mock's setup API takes, each a
 * `MockSetupError` when the value is wrong. Domain checks (logs, reverts,
 * faults, hashes) stay in their own layers, and the public assertions
 * (`assertAllUsed` and the rest) are in `rpc/checks.ts`.
 */
import { MockSetupError } from "../shared/errors.js";
import { formatValue } from "./format.js";

/**
 * Throws unless `value` is a bigint, zero or more. `what` is its subject in
 * the message, named as the user wrote it: "mock.addTransaction()'s gasUsed".
 */
export function checkAmount(value: unknown, what: string): asserts value is bigint {
  if (typeof value !== "bigint" || value < 0n)
    throw new MockSetupError(`${what} must be a bigint, zero or more; got ${formatValue(value)}.`);
}
