import { Errors } from "ox";
import { BaseError, type Hex } from "viem";

/** What the mock's errors take besides their short message. */
type MockErrorOptions = {
  /** Lines under the short message: how to fix it, what's registered. */
  metaMessages?: readonly string[] | undefined;
  /** The error that caused it. */
  cause?: Error | undefined;
};

/**
 * The base of every error the mock raises itself, as opposed to viem's
 * errors for its answers (reverts, faults, a node's refusals), which it
 * imitates.
 *
 * Each has a stable numeric JSON-RPC `code` that viem doesn't retry, so a
 * broken test fails at once instead of after retries. Its message is the
 * short message, then the `metaMessages` lines, with no viem version line;
 * `details` is empty and `docsPath` unset. viem's wrappers carry
 * `metaMessages` into theirs.
 */
export abstract class MockError extends BaseError {
  override name = "MockError";
  /** The error's JSON-RPC code, one per class. */
  abstract readonly code: number;

  constructor(shortMessage: string, { metaMessages, cause }: MockErrorOptions = {}) {
    const lines = metaMessages === undefined ? [] : [...metaMessages];
    super(shortMessage, {
      ...(lines.length > 0 && { metaMessages: lines }),
      ...(cause && { cause }),
    });
    this.message = lines.length > 0 ? [shortMessage, "", ...lines].join("\n") : shortMessage;
    // BaseError copies both from a cause. viem matches `details` against node
    // errors, so a resolver's `Error("nonce too low")` would become
    // `NonceTooLowError`: see "Clients and errors" in docs/architecture.md.
    this.details = "";
    this.docsPath = undefined;
  }
}

/**
 * Thrown when the mock's API is called wrong: a bad value or option, a
 * removed mock, or a static answer that doesn't fit its request.
 */
export class MockSetupError extends MockError {
  override name = "MockSetupError";
  readonly code = -32097;
}

/**
 * Thrown when a check fails: `assertNoUnhandled()`, `assertAllUsed()`,
 * `checkpoint()`, or `restore()`'s checks.
 */
export class MockCheckError extends MockError {
  override name = "MockCheckError";
  readonly code = -32096;
}

/**
 * The usual cause of setup a restore removed under a test: for metaMessages.
 */
export const nestedRestoreHint =
  "The usual cause: an afterEach in a parent describe also runs after each test of a nested " +
  "one, and one that restores or resets per test wipes the nested describe's setup. Keep the " +
  "two describes siblings.";

/**
 * Not-found hints for what the last `restore()` or `reset()` removed; the
 * unhandled check looks for them, to say a request may be an earlier test's.
 */
export const removedContractNote =
  "A contract was registered at this address until the last restore() or reset() removed it.";
/**
 * After `removedContractNote` on a call: the layout that often causes it, as a
 * condition.
 */
export const removedContractLayoutHint =
  "If this test is in a nested describe, an afterEach in a parent describe that restores per " +
  "test wipes its setup; keep the two describes siblings.";
export const removedTransactionNote =
  "This transaction was on the chain until the last restore() or reset() removed it: " +
  "a receipt wait from an earlier test may still be polling.";

/** For a builder whose mock a `restore()` or `reset()` removed. */
export const removedMockError = () =>
  new MockSetupError("This mock was removed by restore() or reset(); register a new one.");

/** Thrown when a request reaches the mock and nothing answers it. */
export class MockNotFoundError extends MockError {
  override name = "MockNotFoundError";
  readonly code = -32099;
}

/**
 * What `encode()` returns, with anything it throws that isn't the mock's,
 * viem's or ox's refused as a setup error: `given` was given a value it
 * can't encode, e.g. the engine's `SyntaxError` from `BigInt("soon")` inside
 * an encoder. The original is kept as the cause.
 */
export function refuseUnencodable<value>(given: string, encode: () => value): value {
  try {
    return encode();
  } catch (error) {
    if (error instanceof BaseError || error instanceof Errors.BaseError) throw error;
    const cause = asError(error);
    throw new MockSetupError(`${given} was given a value it can't encode: ${summaryOf(cause)}`, {
      cause,
    });
  }
}

/**
 * What was thrown, as an `Error` for a cause: a thrown non-Error becomes one
 * with its text.
 */
const asError = (thrown: unknown) => (thrown instanceof Error ? thrown : new Error(String(thrown)));

/**
 * An error's one-line summary: a viem or ox error's short message, or its
 * message.
 */
export const summaryOf = (error: unknown) =>
  error instanceof Error
    ? "shortMessage" in error && typeof error.shortMessage === "string"
      ? error.shortMessage
      : error.message
    : String(error);

/** An error's hint lines, if it's a viem or ox error that has them. */
const metaMessagesOf = (error: Error) =>
  "metaMessages" in error && Array.isArray(error.metaMessages)
    ? error.metaMessages.filter((line): line is string => typeof line === "string")
    : undefined;

/**
 * Thrown when a resolver throws, other than by `revert()` or `fail()`, or
 * returns an answer that doesn't fit, or when a `match.where()` predicate
 * throws while matching. The cause's hints carry over, so a mock's own error
 * thrown inside a resolver keeps them.
 */
export class MockResolverError extends MockError {
  override name = "MockResolverError";
  readonly code = -32098;
  /**
   * The matcher that threw, e.g. `where(isLarge)`; `undefined` when it was the
   * resolver.
   */
  matcher: string | undefined;

  constructor(functionName: string, cause: unknown, { matcher }: { matcher?: string } = {}) {
    const error = asError(cause);
    const thrower = matcher === undefined ? "Mock resolver" : `Matcher ${matcher}`;
    super(`${thrower} for "${functionName}" threw: ${summaryOf(error)}`, {
      cause: error,
      metaMessages: metaMessagesOf(error),
    });
    this.matcher = matcher;
  }
}

/**
 * Thrown when the mock fails unexpectedly while answering: a bug in the
 * mock, or a value its types don't allow that no check caught. Its cause is
 * what was thrown, with its stack.
 */
export class MockInternalError extends MockError {
  override name = "MockInternalError";
  readonly code = -32095;

  constructor(cause: unknown) {
    const error = asError(cause);
    super(`The mock failed unexpectedly: ${summaryOf(error)}`, {
      cause: error,
      metaMessages: [
        "This is a bug in ethergeist, unless the mock was given a value its types don't allow " +
          "(through a cast or plain JavaScript); if not, please report it at " +
          "https://github.com/nadaniels/ethergeist/issues, with the request.",
      ],
    });
  }
}

/**
 * A mock's revert while answering, with code 3 and the revert data. It never
 * reaches a client as is: an adapter turns it into its client's error, as
 * `toViemError` makes the `RpcRequestError` a reth node's revert causes,
 * which viem decodes into a `ContractFunctionRevertedError`.
 */
export class MockRevertError extends BaseError {
  override name = "MockRevertError";
  code = 3;
  data: Hex;

  constructor(data: Hex, reason?: string) {
    super(reason === undefined ? "execution reverted" : `execution reverted: ${reason}`);
    this.data = data;
  }
}

/**
 * A node's JSON-RPC error answer, e.g. reth's `-32602 "invalid block range
 * params"`. It's an answer, not a missing mock: an adapter turns it into its
 * client's error, as `toViemError` makes an `RpcRequestError` of it.
 */
export class MockRpcError extends BaseError {
  override name = "MockRpcError";
  code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The refusal of a request's params a node can't parse: invalid params
 * (`-32602`). The wording is the mock's own, as viem classifies these by
 * code.
 */
export const invalidParams = (message: string) =>
  new MockRpcError(-32602, `invalid params: ${message}`);
