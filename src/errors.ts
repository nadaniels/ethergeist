import { BaseError, type Hex } from 'viem'

// Every error the mock throws carries a numeric JSON-RPC `code` that viem's
// `shouldRetry` does not retry. Without one, viem wraps the error in
// `UnknownRpcError` (code -1) and retries it with backoff, so a broken test
// fails slowly and repeatedly.

/** Thrown when a request reaches the mock with nothing registered to answer it. */
export class MockNotFoundError extends BaseError {
  override name = 'MockNotFoundError'
  code = -32099

  constructor(shortMessage: string, { details }: { details?: string } = {}) {
    super(shortMessage, details ? { details } : {})
  }
}

/** Thrown when a resolver throws anything other than a revert. */
export class MockResolverError extends BaseError {
  override name = 'MockResolverError'
  code = -32098

  constructor(functionName: string, cause: unknown) {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    super(`Mock resolver for "${functionName}" threw: ${error.message}`, { cause: error })
  }
}

/**
 * A node's "execution reverted" response: code 3 with the revert data, which
 * viem's `getContractError` turns into a decoded `ContractFunctionRevertedError`.
 */
export class MockRevertError extends BaseError {
  override name = 'MockRevertError'
  code = 3
  data: Hex

  constructor(data: Hex, reason?: string) {
    super(reason === undefined ? 'execution reverted' : `execution reverted: ${reason}`)
    this.data = data
  }
}
