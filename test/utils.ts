import { type Address, BaseError } from "viem";
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

/** The error of a `client.multicall` result that should have failed. */
export function failureOf(
  result: { status: "success" | "failure"; error?: Error | undefined } | undefined,
): Error {
  if (result?.status !== "failure" || !result.error)
    return expect.unreachable("expected a failure result");
  return result.error;
}

/** `address` in lowercase, for tests that check the mock normalizes addresses. */
export function lowercase(address: Address): Address {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- lowercase hex is still an address
  return address.toLowerCase() as Address;
}
