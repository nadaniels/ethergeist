import type { Hex } from "viem";

import { type ResolveBlock, transactionParam } from "../chain/params.js";
import { sentType } from "../chain/transactions.js";
import { createRevertError } from "../contracts/answers.js";
import type { RevertFn, RevertSpec } from "../contracts/types.js";
import { encodeGas } from "../mocking/gas.js";
import type {
  EstimateErrorName,
  MockEstimateAnswers,
  MockNodeFault,
  WithLimits,
} from "../mocking/types.js";
import { withoutUndefined } from "../shared/values.js";
import { blockAt, pinTransaction, sendCall } from "./codec.js";
import type { MockDefinition } from "./mockSet.js";
import type { ActionContext, EstimateGasCall, SendTransactionCall } from "./types.js";

/**
 * What an `estimateGas` resolver gets: the call's fields, `fail`, and
 * `revert`, which reverts the estimate as `.reverts()` does.
 */
export type EstimateGasContext = ActionContext<
  EstimateGasCall,
  MockNodeFault<EstimateErrorName>
> & {
  /**
   * Reverts the estimate, e.g. `revert("paused")`. Without an ABI, it takes
   * a reason, a panic code, raw data or nothing: see `RevertSpec`.
   */
  revert: RevertFn<readonly []>;
};

/**
 * An estimate's mock, as `mock.actions.estimateGas()` returns it:
 * `.returns()` with gas, `.reverts()` or `.fails()` to answer, and `.once()`
 * or `.times()` to limit it (see `WithLimits`).
 */
export type MockEstimateBuilder<context> = WithLimits<
  MockEstimateAnswers<context> & {
    /**
     * Reverts every matching call, as a node's estimate reverts, so a client
     * that estimates first throws before it sends. Without an ABI, it takes
     * a reason, a panic code, raw data or nothing: see `RevertSpec`.
     */
    reverts(spec?: RevertSpec<readonly []>): void;
  }
>;

/**
 * Like `MockAction`, for `estimateGas`, with `MockEstimateBuilder`'s
 * answers. Its mocks answer estimates of anything but a registered
 * contract's nonpayable and payable functions, which only the contract's
 * own mocks answer.
 */
export type MockEstimateGasAction = {
  (params?: Partial<EstimateGasCall>): MockEstimateBuilder<EstimateGasContext>;
  /**
   * Every call to this action the mock received, in order: the last
   * `historyLimit` of them.
   */
  readonly calls: EstimateGasCall[];
};

/**
 * The call an `eth_estimateGas` asks for: a transaction, and maybe a block.
 * With a sender, it's the estimate of a send: `sent`, which send mocks are
 * matched against.
 *
 * The send's type is its request's, as a send's is. It's worked out for
 * every estimate (see `sentType`), so one a send would refuse is refused
 * however it would be answered, a registered contract's own mocks included.
 * viem's estimate carries no `type`, so an `eip2930` send without an
 * `accessList` looks legacy.
 */
export function decodeEstimateGas(
  [tx, block]: readonly unknown[],
  resolveBlock: ResolveBlock,
): { call: EstimateGasCall; sent: SendTransactionCall | undefined } {
  const fields = transactionParam(tx);
  const type = sentType(tx, fields);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- undefined fields are left out
  const call = withoutUndefined({ ...fields, ...blockAt(block, resolveBlock) }) as EstimateGasCall;
  const sent = fields.from === undefined ? undefined : sendCall(fields, fields.from, type);
  return { call, sent };
}

/**
 * `mock.actions.estimateGas`'s mocks: they answer with gas, or revert the
 * estimate.
 */
export const estimateGas: MockDefinition<EstimateGasCall, Hex> = {
  name: "estimateGas",
  hint: "mock.actions.estimateGas({ to }).returns(…)",
  pin: pinTransaction,
  /** No zero estimate: `encodeGas` refuses `.returns()` without a value. */
  zero: undefined,
  encode: (value) => encodeGas(value, "estimateGas's answer"),
  revertError: (spec?: RevertSpec) => createRevertError([], spec),
};
