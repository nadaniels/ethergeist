import { type Hex, numberToHex } from "viem";

import { type ResolveBlock, transactionParam } from "../chain/params.js";
import { sentType } from "../chain/transactions.js";
import { createRevertError } from "../contracts/answers.js";
import type { RevertFn, RevertSpec } from "../contracts/types.js";
import { encodeGas, impliedGas } from "../mocking/gas.js";
import type {
  EstimateErrorName,
  MockEstimateAnswers,
  MockNodeFault,
  WithLimits,
} from "../mocking/types.js";
import { withoutUndefined } from "../shared/values.js";
import type { ImpliedEstimate } from "../transactions/writeOutcome.js";
import { blockAt, isPlainTransfer, pinTransaction, sendCall, viewQuantity } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";
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
 * answers.
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
 * The send each estimate with a sender is for, which send mocks are matched
 * against, and its implied estimate once `implied` asked for it. Its type is
 * its request's, as a send's is. viem's estimate carries no `type`, so an
 * `eip2930` send without an `accessList` looks legacy.
 */
const sends = new WeakMap<
  EstimateGasCall,
  { sent: SendTransactionCall; asked?: { implied: ImpliedEstimate } }
>();

/**
 * The implied estimate of the estimate's send, if it has one (see
 * `ActionsContext.impliedEstimate`): asked once per estimate, so predicates
 * run once, though `preempt` and `fallback` both ask.
 */
function implied(
  call: EstimateGasCall,
  impliedEstimate: ActionsContext["impliedEstimate"],
): ImpliedEstimate {
  const send = sends.get(call);
  if (send === undefined) return undefined;
  send.asked ??= { implied: impliedEstimate(send.sent) };
  return send.asked.implied;
}

/**
 * The call an `eth_estimateGas` asks for: a transaction, and maybe a block.
 * Its send's type is worked out here (see `sentType`), so one a send would
 * refuse is refused however it would be answered, a registered contract's
 * own mocks included.
 */
function decodeEstimateGas(
  [tx, block]: readonly unknown[],
  resolveBlock: ResolveBlock,
): EstimateGasCall {
  const fields = transactionParam(tx);
  const type = sentType(tx, fields);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- undefined fields are left out
  const call = withoutUndefined({ ...fields, ...blockAt(block, resolveBlock) }) as EstimateGasCall;
  if (fields.from !== undefined) sends.set(call, { sent: sendCall(fields, fields.from, type) });
  return call;
}

/**
 * `eth_estimateGas`. A `.reverts()` send mock that would answer the
 * transaction reverts its estimate first, before any estimate mock. Then a
 * registered contract's own mocks answer estimates of its functions, and
 * this action's mocks the rest. Unmocked, a plain transfer to an address
 * without code is 21,000 gas, as a node estimates it, even with a send mock.
 * Otherwise, a send mock that would answer the transaction implies its
 * estimate (see `impliedGas`).
 */
export const estimateGas = ({
  state,
  registry,
  impliedEstimate,
}: ActionsContext): Definition<EstimateGasCall, Hex> => ({
  name: "estimateGas",
  hint: "mock.actions.estimateGas({ to }).returns(…)",
  decode: (params) => decodeEstimateGas(params, state.resolveBlock),
  pin: pinTransaction,
  /** No zero estimate: `encodeGas` refuses `.returns()` without a value. */
  zero: undefined,
  encode: (value) => encodeGas(value, "estimateGas's answer"),
  view: viewQuantity,
  extendContext(context) {
    Object.assign(context, {
      revert(spec?: RevertSpec): never {
        throw createRevertError([], spec);
      },
    });
  },
  extendBuilder(builder) {
    Object.assign(builder, {
      // Made at registration, so a spec viem can't encode throws here.
      reverts(spec?: RevertSpec) {
        const error = createRevertError([], spec);
        builder.returns(() => {
          throw error;
        });
      },
    });
  },
  contractTurn(call) {
    const { to, data, from, value, blockNumber } = call;
    if (to === undefined || data === undefined || data === "0x") return undefined;
    return registry.contractAt(to)?.estimate(data, { from, value, blockNumber, batch: undefined });
  },
  /**
   * Reverts the estimate as the `.reverts()` send mock that would answer its
   * send says, which counts as that mock's use.
   */
  preempt(call) {
    const estimate = implied(call, impliedEstimate);
    if (estimate === undefined || estimate === "gas") return;
    estimate.spend();
    throw estimate.reverts;
  },
  /** The send mock implies the estimate without running or being used up. */
  fallback(call) {
    if (isPlainTransfer(registry, call)) return numberToHex(21_000n);
    return implied(call, impliedEstimate) === "gas" ? numberToHex(impliedGas) : undefined;
  },
});
