import { type Address, type Hex, numberToHex } from "viem";

import type { ResolveBlock } from "../chain/params.js";
import { encodeGas, impliedGas } from "../mocking/gas.js";
import type { MockEstimateAnswers, MockNodeFault, WithLimits } from "../mocking/types.js";
import { registeredRevert } from "../transactions/writeOutcome.js";
import {
  blockAt,
  decodeTransactionRequest,
  isPlainTransfer,
  pinTransaction,
  viewQuantity,
  withoutUndefined,
} from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";
import type { ActionContext, EstimateGasCall, SendTransactionCall } from "./types.js";

/**
 * What an estimate's resolver gets: the call, and `fail`, which also takes a
 * node's refusal by name, e.g. `fail("insufficientFunds")`.
 */
export type EstimateGasContext = ActionContext<EstimateGasCall, MockNodeFault>;

/** Like `MockActionBuilder`, for an estimate. */
export type MockEstimateBuilder<context> = WithLimits<MockEstimateAnswers<context>>;

/** `MockAction` for `estimateGas`. */
export type MockEstimateGasAction = {
  (params?: Partial<EstimateGasCall>): MockEstimateBuilder<EstimateGasContext>;
  /** Every call to this action the mock has received, in order. */
  readonly calls: EstimateGasCall[];
};

/** `eth_estimateGas` takes a transaction and maybe a block. */
function decodeEstimateGas(
  [tx, block]: readonly unknown[],
  resolveBlock: ResolveBlock,
): EstimateGasCall {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- undefined fields are left out
  return withoutUndefined({
    ...decodeTransactionRequest(tx),
    ...blockAt(block, resolveBlock),
  }) as EstimateGasCall;
}

/**
 * The send an estimate is for, as send mocks are matched against it. Its
 * type follows its fees, as an estimate's call has none.
 */
function sendOf(call: EstimateGasCall, account: Address): SendTransactionCall {
  const { to, value, data, gas, gasPrice, maxFeePerGas, maxPriorityFeePerGas, nonce } = call;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- undefined fields are left out
  return withoutUndefined({
    account,
    to: to ?? null,
    value,
    data: data === "0x" ? undefined : data,
    nonce,
    gas,
    gasPrice,
    maxFeePerGas,
    maxPriorityFeePerGas,
    type: gasPrice === undefined ? "eip1559" : "legacy",
  }) as SendTransactionCall;
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
  // A registered contract's turn at an estimate of one of its functions.
  contractTurn(call) {
    const { to, data, account, value, blockNumber } = call;
    if (to === undefined || data === undefined || data === "0x") return undefined;
    return registry
      .contractAt(to)
      ?.estimate(data, { from: account, value, blockNumber, batch: undefined });
  },
  // The mock that would answer the send (a contract's write mock, or else a
  // send mock) implies its estimate, without running: a `.reverts()` one
  // reverts it. A plain transfer to an address without code is the base
  // 21000 gas, mocked or not.
  fallback(call) {
    const send = call.account && mockFor("sendTransaction", sendOf(call, call.account));
    const revert = send && registeredRevert(send.resolver);
    if (revert) throw revert;
    if (isPlainTransfer(registry, call)) return numberToHex(21_000n);
    return send ? numberToHex(impliedGas) : undefined;
  },
});
