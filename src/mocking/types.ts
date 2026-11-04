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
 * A node's refusal by name, with reth's code and message. viem tells these
 * apart by the message, as for a real node, so the app sees viem's class.
 * Each is available where a node can say it:
 * - `"insufficientFunds"`: the sender can't pay the value sent, viem's
 *   `InsufficientFundsError`. The message says the balance is 0.
 * - `"feeCapTooLow"`: `maxFeePerGas` is below the block's base fee, viem's
 *   `FeeCapTooLowError`.
 * - `"tipAboveFeeCap"`: `maxPriorityFeePerGas` is above `maxFeePerGas`,
 *   viem's `TipAboveFeeCapError`.
 * - `"gasExceedsAllowance"`, on estimates and `simulate`: the call needs
 *   more gas than the request's `gas` (or, without one, the node's cap of
 *   50,000,000), viem's `ExecutionRevertedError`. A send with too little gas
 *   is mined instead, and runs out: `.returns({ status: "reverted",
 *   gasUsed })` with its gas limit.
 * - `"intrinsicGasTooLow"`, on sends and `simulate`: the request's `gas` is
 *   below the transaction's base cost, viem's `IntrinsicGasTooLowError`.
 *   An estimate reports it as `"gasExceedsAllowance"`.
 * - On sends only (`write`, `mock.actions.sendTransaction`), as a node's
 *   transaction pool refuses them; an estimate or a call doesn't check the
 *   nonce:
 *   - `"nonceTooLow"`: the nonce is used, viem's `NonceTooLowError`;
 *   - `"nonceTooHigh"`: the nonce leaves a gap, viem's `NonceTooHighError`;
 *   - `"alreadyKnown"`: the node has this transaction already, a double
 *     submit, viem's `NonceTooLowError`.
 */
export type NodeErrorName = (typeof nodeErrorNames)[number];

/** Every `NodeErrorName`, for a check at runtime. */
export const nodeErrorNames = [
  "insufficientFunds",
  "feeCapTooLow",
  "tipAboveFeeCap",
  "gasExceedsAllowance",
  "intrinsicGasTooLow",
  "nonceTooLow",
  "nonceTooHigh",
  "alreadyKnown",
] as const;

type TransactionErrorName = "insufficientFunds" | "feeCapTooLow" | "tipAboveFeeCap";
/** The names a send can be refused with: see `NodeErrorName`. */
export type SendErrorName =
  | TransactionErrorName
  | "intrinsicGasTooLow"
  | "nonceTooLow"
  | "nonceTooHigh"
  | "alreadyKnown";
/** The names an estimate can be refused with: see `NodeErrorName`. */
export type EstimateErrorName = TransactionErrorName | "gasExceedsAllowance";
/** The names an `eth_call` (`simulate`) can be refused with: see `NodeErrorName`. */
export type CallErrorName = EstimateErrorName | "intrinsicGasTooLow";

/**
 * A `MockFault`, or a node's refusal by name, where a node can refuse: see
 * `NodeErrorName`. `name` is the names available there.
 */
export type MockNodeFault<name extends NodeErrorName = NodeErrorName> = MockFault | name;

/** A mock's answers, and `.once()`/`.times()` to limit how often it gives them. */
export type WithLimits<answers> = answers & {
  /**
   * Answer only the next matching call, then step aside for the next best
   * mock. Limited mocks go ahead of unlimited ones as specific, oldest first,
   * so `.once().fails("network")` beside `.returns(…)` fails once whichever
   * is registered first. Retries use up answers too.
   */
  once(): answers;
  /** Like `.once()`, for the next `count` matching calls. */
  times(count: number): answers;
};

/**
 * How an estimate answers: with gas, or `.fails()`, which also takes a node's
 * refusal by name.
 */
export type MockEstimateAnswers<context> = {
  /**
   * Answer with this much gas. A value is required: a node never estimates
   * zero gas, so there's no zero answer. Unmocked, a plain transfer to an
   * address without code is estimated at the base 21000.
   */
  returns(value: bigint | ((context: context) => bigint | Promise<bigint>)): void;
  /**
   * Fail every matching request: a node's refusal by name, e.g.
   * `"insufficientFunds"` (see `NodeErrorName`), or any `MockFault`.
   */
  fails(fault: MockNodeFault<EstimateErrorName>): void;
};

/**
 * An index or key of what a mock pins: a function's arg, or an action's
 * param. `null` stands for all of them, when one matcher is pinned in place
 * of the whole params, e.g. `getBalance(match.where(…))`.
 */
export type PinnedKey = number | string | null;
