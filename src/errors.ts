import { BaseError } from 'viem'

/**
 * Thrown when a request reaches the mock with nothing registered to answer it.
 *
 * `code` must be a numeric JSON-RPC code that viem's `shouldRetry` does not
 * retry. Without one, viem wraps the error in `UnknownRpcError` (code -1) and
 * retries it with backoff, so a missing mock fails slowly and repeatedly.
 */
export class MockNotFoundError extends BaseError {
  override name = 'MockNotFoundError'
  code = -32099

  constructor(shortMessage: string, { details }: { details?: string } = {}) {
    super(shortMessage, details ? { details } : {})
  }
}
