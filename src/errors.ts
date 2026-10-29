import { BaseError, type Hex } from "viem";

// Every error the mock throws carries a numeric JSON-RPC `code` that viem's
// `shouldRetry` does not retry. Without one, viem wraps the error in
// `UnknownRpcError` (code -1) and retries it with backoff, so a broken test
// fails slowly and repeatedly.

/** Thrown when a request reaches the mock with nothing registered to answer it. */
export class MockNotFoundError extends BaseError {
  override name = "MockNotFoundError";
  code = -32099;

  constructor(shortMessage: string, { details }: { details?: string } = {}) {
    super(shortMessage, details ? { details } : {});
  }
}

/**
 * Thrown when a resolver throws anything other than a revert, or when a
 * `match.where()` predicate throws while matching.
 */
export class MockResolverError extends BaseError {
  override name = "MockResolverError";
  code = -32098;
  /** The matcher that threw, e.g. `where(isLarge)`; `undefined` when it was the resolver. */
  matcher: string | undefined;

  constructor(functionName: string, cause: unknown, { matcher }: { matcher?: string } = {}) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    const thrower = matcher === undefined ? "Mock resolver" : `Matcher ${matcher}`;
    super(`${thrower} for "${functionName}" threw: ${error.message}`, { cause: error });
    this.matcher = matcher;
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
