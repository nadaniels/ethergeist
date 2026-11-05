import { BaseError, type Hex } from "viem";
import { expect } from "vite-plus/test";

type ErrorClass<error> = new (...args: never[]) => error;

/** Awaits a promise that should reject and returns what it rejected with. */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return expect.unreachable("expected the promise to reject");
}

/**
 * Calls `fn`, which should throw a `type` whose message contains `text` (or matches it), and
 * returns the error. Unlike a message-only `toThrow`, it fails when what's thrown isn't one.
 */
export function expectThrows<error extends Error>(
  type: ErrorClass<error>,
  text: string | RegExp,
  fn: () => unknown,
): error {
  try {
    fn();
  } catch (thrown) {
    return expectError(type, text, thrown);
  }
  return expect.unreachable("expected the function to throw");
}

/** Like `expectThrows`, for a promise that should reject. */
export async function expectRejects<error extends Error>(
  type: ErrorClass<error>,
  text: string | RegExp,
  promise: Promise<unknown>,
): Promise<error> {
  return expectError(type, text, await rejectionOf(promise));
}

function expectError<error extends Error>(
  type: ErrorClass<error>,
  text: string | RegExp,
  thrown: unknown,
): error {
  if (!(thrown instanceof type))
    return expect.unreachable(`expected a ${type.name}; got ${String(thrown)}`);
  expect(thrown.message).toMatch(text);
  return thrown;
}

/** The first `type` in `error`'s cause chain (including `error` itself), if any. */
export function findCause<error>(error: unknown, type: ErrorClass<error>): error | undefined {
  const found = error instanceof BaseError ? error.walk((e) => e instanceof type) : error;
  return found instanceof type ? found : undefined;
}

/** Like `findCause`, but fails the test when the cause chain has no `type`. */
export function expectCause<error>(error: unknown, type: ErrorClass<error>): error {
  const found = findCause(error, type);
  if (found === undefined) return expect.unreachable(`expected a ${type.name} in the cause chain`);
  return found;
}

/** A mock error's hint lines, as its message shows them under the short message. */
export function hintsOf(error: { metaMessages?: string[] | undefined } | undefined): string {
  return (error?.metaMessages ?? []).join("\n");
}

/** The error of a `client.multicall` result that should have failed. */
export function failureOf(
  result: { status: "success" | "failure"; error?: Error | undefined } | undefined,
): Error {
  if (result?.status !== "failure" || !result.error)
    return expect.unreachable("expected a failure result");
  return result.error;
}

/** `value` in lowercase, for tests that check the mock normalizes addresses and hashes. */
export function lowercase<hex extends Hex>(value: hex): hex {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- lowercase hex is still the same kind of hex
  return value.toLowerCase() as hex;
}
