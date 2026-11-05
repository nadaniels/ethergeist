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
import { registeredRevert } from "../transactions/writeOutcome.js";
import {
  blockAt,
  isPlainTransfer,
  pinTransaction,
  sendCall,
  viewQuantity,
  withoutUndefined,
} from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";
import type { ActionContext, EstimateGasCall, SendTransactionCall } from "./types.js";

/**
 * What an estimate's resolver gets: the call; `fail`, which also takes a
 * node's refusal by name, e.g. `fail("insufficientFunds")`; and `revert`,
 * which reverts the estimate, as `.reverts()` does. Without an ABI,
 * `revert` takes a reason, a panic code or raw data.
 */
export type EstimateGasContext = ActionContext<
  EstimateGasCall,
  MockNodeFault<EstimateErrorName>
> & {
  /** Revert the estimate, e.g. `revert("paused")`: see `RevertSpec`. */
  revert: RevertFn<readonly []>;
};

/**
 * Like `MockActionBuilder`, for an estimate: it also reverts, as a
 * contract's estimate does.
 */
export type MockEstimateBuilder<context> = WithLimits<
  MockEstimateAnswers<context> & {
    /**
     * Revert every matching estimate, as a node's does, so a client that
     * estimates first throws before it sends. Without an ABI, it takes a
     * reason, a panic code or raw data: see `RevertSpec`.
     */
    reverts(spec?: RevertSpec<readonly []>): void;
  }
>;

/** `MockAction` for `estimateGas`. */
export type MockEstimateGasAction = {
  (params?: Partial<EstimateGasCall>): MockEstimateBuilder<EstimateGasContext>;
  /** Every call to this action the mock has received, in order. */
  readonly calls: EstimateGasCall[];
};

/**
 * The send each estimate is for, if it has a sender, as send mocks are
 * matched against it. Its type is its request's, as a send's is. viem's
 * estimate carries no `type`, so an `eip2930` send without an `accessList`
 * looks legacy.
 */
const sends = new WeakMap<EstimateGasCall, SendTransactionCall>();

/**
 * `eth_estimateGas` takes a transaction and maybe a block. Its send's type is
 * worked out here (see `sentType`), so one a send would refuse is refused
 * however it would be answered, a registered contract's own mocks included.
 */
function decodeEstimateGas(
  [tx, block]: readonly unknown[],
  resolveBlock: ResolveBlock,
): EstimateGasCall {
  const fields = transactionParam(tx);
  const type = sentType(tx, fields);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- undefined fields are left out
  const call = withoutUndefined({ ...fields, ...blockAt(block, resolveBlock) }) as EstimateGasCall;
  if (fields.from !== undefined) sends.set(call, sendCall(fields, fields.from, type));
  return call;
}

/**
 * `eth_estimateGas`. A registered contract's own mocks answer estimates of
 * its functions first. Unmocked, a plain transfer to an address without code
 * is 21000 gas, as a node estimates it, and a write or send mock that would
 * answer the transaction implies its estimate (see `impliedGas`).
 */
export const estimateGas = ({
  state,
  registry,
  mockFor,
}: ActionsContext): Definition<EstimateGasCall, Hex> => ({
  name: "estimateGas",
  hint: "mock.actions.estimateGas({ to }).returns(…)",
  decode: (params) => decodeEstimateGas(params, state.resolveBlock),
  pin: pinTransaction,
  // `.returns()` without a value isn't typed: there's no zero estimate.
  zero: undefined,
  encode: encodeGas,
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
  // A registered contract's turn at an estimate of one of its functions.
  contractTurn(call) {
    const { to, data, from, value, blockNumber } = call;
    if (to === undefined || data === undefined || data === "0x") return undefined;
    return registry.contractAt(to)?.estimate(data, { from, value, blockNumber, batch: undefined });
  },
  // The mock that would answer the send (a contract's write mock, or else a
  // send mock) implies its estimate, without running: a `.reverts()` one
  // reverts it. A plain transfer to an address without code is the base
  // 21000 gas, mocked or not.
  fallback(call) {
    const sent = sends.get(call);
    const send = sent && mockFor("sendTransaction", sent);
    const revert = send && registeredRevert(send.resolver);
    if (revert) throw revert;
    if (isPlainTransfer(registry, call)) return numberToHex(21_000n);
    return send ? numberToHex(impliedGas) : undefined;
  },
});
