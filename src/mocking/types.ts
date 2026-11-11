import type { MockRevertError } from "../shared/errors.js";

/**
 * A fault: a request that fails before a node answers it, or with a
 * JSON-RPC error. The client gets the error it would get from a node
 * failing that way, so its retry rules apply as in production:
 * - `{ status }`: an HTTP error response, e.g. `503` or `429`. `retryAfter`
 *   sets a `Retry-After` header, in seconds, which viem waits for between
 *   retries.
 * - `{ code, message, data }`: a JSON-RPC error response. Use viem's error
 *   classes for known codes, e.g. `{ code: LimitExceededRpcError.code }`:
 *   viem sorts the code into that class, so a test can assert on it by name.
 * - `"timeout"`: the request takes too long.
 * - `"network"`: the request gets no response, like a failed fetch.
 *
 * A node declining a transaction by name is a refusal, not a fault: see
 * `NodeErrorName`.
 */
export type MockFault =
  | { status: number; retryAfter?: number }
  | { code: number; message?: string; data?: unknown }
  | "timeout"
  | "network";

/**
 * A node's refusal by name, for `.refuses()` and a resolver's `refuse()`:
 * the node declines the transaction before running it, with a node's code
 * and message. viem tells these apart by the message, as for any node, so
 * the app sees viem's class. Each is available where a node can say it:
 * - `"insufficientFunds"`: the sender can't pay the value sent, viem's
 *   `InsufficientFundsError`. With fee fields in the request, the message
 *   gives the balance as 0.
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
/**
 * The names an `eth_call` (`simulate`) can be refused with: see
 * `NodeErrorName`.
 */
export type SimulateErrorName = EstimateErrorName | "intrinsicGasTooLow";

/**
 * How a mock refuses where a node can: `.refuses()`, beside its other
 * answers. `name` is the names available there.
 */
export type MockRefusalAnswers<name extends NodeErrorName> = {
  /**
   * Refuses every matching call as a node does: the request it's in fails
   * with the node's error for `name`, e.g. `.refuses("insufficientFunds")`.
   * See `NodeErrorName` for the names and where each is available.
   */
  refuses(name: name): void;
};

/**
 * What a resolver gets where a node can refuse: `refuse`. `name` is the
 * names available there.
 */
export type RefusalContext<name extends NodeErrorName> = {
  /**
   * Refuses the request this call is in as a node does, e.g.
   * `refuse("nonceTooLow")`: see `NodeErrorName` for the names.
   */
  refuse: (name: name) => never;
};

/**
 * A mock's answers, with `.once()` and `.times()` to limit how often it gives
 * them.
 */
export type WithLimits<answers> = answers & {
  /**
   * Limits the mock to one answer: once it's given, the next best mock
   * answers. Limited mocks go ahead of unlimited ones as specific, and
   * answer oldest first, so `.once().fails("network")` beside
   * `.returns(…)` fails once whichever is registered first. A retry is a
   * request of its own, so it uses up an answer too.
   */
  once(): answers;
  /**
   * Limits the mock to `count` answers, as `.once()` does to one. `count` is
   * a positive integer.
   */
  times(count: number): answers;
};

/**
 * How an estimate's mock answers: with gas, `.fails()`, or `.refuses()` (see
 * `MockRefusalAnswers`).
 */
export type MockEstimateAnswers<context> = MockRefusalAnswers<EstimateErrorName> & {
  /**
   * Answers every matching call with `value` gas, or with what a resolver
   * returns for each call, sync or async: a non-negative bigint.
   * `.returns()` without a value is refused: an estimate has no zero answer
   * to default to.
   */
  returns(value: bigint | ((context: context) => bigint | Promise<bigint>)): void;
  /**
   * Fails every matching call: the request it's in fails with `fault`. See
   * `MockFault` for the kinds.
   */
  fails(fault: MockFault): void;
};

/**
 * An index or key of what a mock pins: a function's arg, or an action's
 * param. `null` stands for all of them, when one matcher is pinned in place
 * of the whole params, e.g. `getBalance(match.where(…))`.
 */
export type PinnedKey = number | string | null;

/**
 * How a mock answers: `.returns(value)`'s value, as its engine prepared it
 * at registration; `.returns(resolver)`'s resolver; `.reverts()`'s error;
 * `.fails()`'s fault; or `.refuses()`'s name.
 */
export type Answer<context = never> =
  | { kind: "static"; prepared: unknown }
  | { kind: "resolver"; resolve: (context: context) => unknown }
  | { kind: "revert"; error: MockRevertError }
  | { kind: "fault"; fault: MockFault }
  | { kind: "refusal"; name: NodeErrorName };
