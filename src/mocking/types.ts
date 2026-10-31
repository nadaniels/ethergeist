/**
 * A transport-level failure, thrown as the same error viem's `http` transport
 * would produce, so viem's retry rules apply as in production:
 * - `{ status }`: an HTTP error response, e.g. `503` or `429`. `retryAfter`
 *   sets a `Retry-After` header in seconds, which viem waits for between retries.
 * - `{ code, message, data }`: a JSON-RPC error response. Use viem's error
 *   classes for known codes, e.g. `{ code: LimitExceededRpcError.code }`; viem
 *   maps the code back to that class, so tests can assert on it by name.
 * - `"timeout"`: the request took too long.
 * - `"network"`: the request never got a response, like a failed fetch.
 */
export type MockFault =
  | { status: number; retryAfter?: number }
  | { code: number; message?: string; data?: unknown }
  | "timeout"
  | "network";

/**
 * A node's refusal of a transaction it was asked to estimate or simulate,
 * named, with reth's code and message. viem tells these apart by the
 * message, as for a real node:
 * - `"insufficientFunds"`: the sender can't pay the value sent, viem's
 *   `InsufficientFundsError`. The message says the balance is 0.
 * - `"feeCapTooLow"`: `maxFeePerGas` is below the block's base fee, viem's
 *   `FeeCapTooLowError`.
 * - `"tipAboveFeeCap"`: `maxPriorityFeePerGas` is above `maxFeePerGas`,
 *   viem's `TipAboveFeeCapError`.
 */
export type NodeErrorName = "insufficientFunds" | "feeCapTooLow" | "tipAboveFeeCap";

/** A `MockFault`, or a node's refusal by name, where a node can refuse: see `NodeErrorName`. */
export type MockNodeFault = MockFault | NodeErrorName;

/**
 * How an estimate answers: with gas, or `.fails()`, which also takes a node's
 * refusal by name. There's no zero answer: a node never estimates zero gas.
 */
export type MockEstimateAnswers<context> = {
  returns(value: bigint | ((context: context) => bigint | Promise<bigint>)): void;
  /**
   * Fail every matching request: a node's refusal by name, e.g.
   * `"insufficientFunds"` (see `NodeErrorName`), or any `MockFault`.
   */
  fails(fault: MockNodeFault): void;
};
