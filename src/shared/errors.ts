import { Errors } from "ox";
import { BaseError, type Hex } from "viem";

/** What the mock's errors take besides their short message. */
type MockErrorOptions = {
  /** Lines under the short message: how to fix it, what's registered. */
  metaMessages?: readonly string[] | undefined;
  cause?: Error | undefined;
};

/**
 * The base of every error the mock raises itself, as opposed to viem's errors
 * for its answers (reverts, faults, a node's refusals), which it imitates.
 *
 * Each carries a numeric JSON-RPC `code` viem doesn't retry (without one,
 * viem retries the request with backoff, so a broken test fails slowly), and
 * the codes are stable: across a wire they're all a client gets.
 *
 * The message is the short message, then the `metaMessages` lines, with no
 * viem version line. `details` is always empty and `docsPath` unset, though
 * `BaseError` copies both from a cause: viem matches `details` against node
 * errors (a resolver's `Error("nonce too low")` would become
 * `NonceTooLowError`), and its wrappers prefer a cause's `docsPath` to their
 * own. Hints go in `metaMessages`, which viem's wrappers carry into theirs.
 */
export abstract class MockError extends BaseError {
  override name = "MockError";
  abstract readonly code: number;

  constructor(shortMessage: string, { metaMessages, cause }: MockErrorOptions = {}) {
    const lines = metaMessages === undefined ? [] : [...metaMessages];
    super(shortMessage, {
      ...(lines.length > 0 && { metaMessages: lines }),
      ...(cause && { cause }),
    });
    this.message = lines.length > 0 ? [shortMessage, "", ...lines].join("\n") : shortMessage;
    this.details = "";
    this.docsPath = undefined;
  }
}

/** The mock's API was called wrong: a bad value or option, or a mock that's been removed. */
export class MockSetupError extends MockError {
  override name = "MockSetupError";
  readonly code = -32097;
}

/** A check failed: `assertNoUnhandled()`, `assertAllUsed()`, `checkpoint()` or `restore()`. */
export class MockCheckError extends MockError {
  override name = "MockCheckError";
  readonly code = -32096;
}

/** The usual cause of setup a restore removed under a test: for metaMessages. */
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
/** After `removedContractNote` on a call: the layout that often causes it, as a condition. */
export const removedContractLayoutHint =
  "If this test is in a nested describe, an afterEach in a parent describe that restores per " +
  "test wipes its setup; keep the two describes siblings.";
export const removedTransactionNote =
  "This transaction was on the chain until the last restore() or reset() removed it: " +
  "a receipt wait from an earlier test may still be polling.";

/** For a builder whose mock a `restore()` or `reset()` removed. */
export const removedMockError = () =>
  new MockSetupError("This mock was removed by restore() or reset(); register a new one.");

/** Thrown when a request reaches the mock with nothing registered to answer it. */
export class MockNotFoundError extends MockError {
  override name = "MockNotFoundError";
  readonly code = -32099;
}

/**
 * `encode()`, where what it throws that isn't ours, viem's or ox's (the
 * engine's own `SyntaxError` from `BigInt("soon")` inside an encoder) is
 * refused as a setup error: `given` was given a value it can't encode. The
 * original is kept as the cause.
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

/** What was thrown, as an `Error` for a cause: a thrown non-Error becomes one with its text. */
const asError = (thrown: unknown) => (thrown instanceof Error ? thrown : new Error(String(thrown)));

/** An error's one-line summary: a viem or ox error's short message, or its message. */
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
 * Thrown when a resolver throws anything other than a revert, or when a
 * `match.where()` predicate throws while matching. The cause's hints carry
 * over, so a mock's own error thrown inside a resolver keeps them.
 */
export class MockResolverError extends MockError {
  override name = "MockResolverError";
  readonly code = -32098;
  /** The matcher that threw, e.g. `where(isLarge)`; `undefined` when it was the resolver. */
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
 * Something the mock didn't anticipate went wrong while answering: a bug in
 * the mock. The cause is what was thrown, with its stack.
 */
export class MockInternalError extends MockError {
  override name = "MockInternalError";
  readonly code = -32095;

  constructor(cause: unknown) {
    const error = asError(cause);
    super(`The mock failed unexpectedly: ${summaryOf(error)}`, {
      cause: error,
      metaMessages: ["This is a bug in viem-transport-mock; please report it, with the request."],
    });
  }
}

/**
 * Internal: a mock's revert while answering: code 3 with the revert data. It doesn't
 * reach viem as is: the rpc converts it to the `RpcRequestError` a reth
 * node causes through viem's `http` transport, which viem decodes into a
 * `ContractFunctionRevertedError`.
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
 * Internal: a node's JSON-RPC error answer, e.g. reth's `-32602 "invalid
 * block range params"`. It's an answer, not a missing mock: the rpc converts
 * it to the `RpcRequestError` viem's `http` transport would throw.
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
 * A request's params a node can't parse, refused as invalid params (`-32602`).
 * The wording is the mock's own: no node's was captured for these.
 */
export const invalidParams = (message: string) =>
  new MockRpcError(-32602, `invalid params: ${message}`);
