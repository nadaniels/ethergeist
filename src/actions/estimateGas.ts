import { getAddress, hexToNumber, isHex, numberToHex } from "viem";

import { encodeGas } from "../mocking/gas.js";
import type { MockEstimateAnswers, MockNodeFault } from "../mocking/types.js";
import { isPlainObject } from "../shared/values.js";
import { blockAt, quantity, viewQuantity } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";
import type { EstimateGasCall } from "./types.js";

/**
 * What an estimate's resolver gets: the call, and `fail`, which also takes a
 * node's refusal by name, e.g. `fail("insufficientFunds")`.
 */
export type EstimateGasContext = EstimateGasCall & { fail: (fault: MockNodeFault) => never };

/** Like `MockActionBuilder`, for an estimate. */
export type MockEstimateBuilder<context> = MockEstimateAnswers<context> & {
  /** See `MockActionBuilder`'s `once()`. */
  once(): MockEstimateAnswers<context>;
  /** Like `.once()`, for the next `count` matching requests. */
  times(count: number): MockEstimateAnswers<context>;
};

/** `MockAction` for `estimateGas`. */
export type MockEstimateGasAction = {
  (params?: Partial<EstimateGasCall>): MockEstimateBuilder<EstimateGasContext>;
  /** Every call to this action the mock has received, in order. */
  readonly calls: EstimateGasCall[];
};

/** Checksums a pinned `account` and `to`, which also validates them at registration. */
function pinTransaction(pinned: unknown) {
  if (!isPlainObject(pinned)) return pinned;
  const { account, to } = pinned;
  return {
    ...pinned,
    ...(typeof account === "string" && { account: getAddress(account) }),
    ...(typeof to === "string" && { to: getAddress(to) }),
  };
}

/** `eth_estimateGas` takes a transaction and maybe a block. */
function decodeEstimateGas(
  [tx, block]: readonly unknown[],
  resolveBlock: (block: unknown) => bigint,
): EstimateGasCall {
  const { from, to, value, data, input, gas, gasPrice, maxFeePerGas, maxPriorityFeePerGas, nonce } =
    isPlainObject(tx) ? tx : {};
  const fields = {
    account: typeof from === "string" ? getAddress(from) : undefined,
    to: typeof to === "string" ? getAddress(to) : undefined,
    value: quantity(value) ?? 0n,
    data: isHex(data) ? data : isHex(input) ? input : undefined,
    gas: quantity(gas),
    gasPrice: quantity(gasPrice),
    maxFeePerGas: quantity(maxFeePerGas),
    maxPriorityFeePerGas: quantity(maxPriorityFeePerGas),
    nonce: isHex(nonce) ? hexToNumber(nonce) : undefined,
    ...blockAt(block, resolveBlock),
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- undefined fields are left out
  return Object.fromEntries(
    Object.entries(fields).filter(([, each]) => each !== undefined),
  ) as EstimateGasCall;
}

/**
 * `eth_estimateGas`. A registered contract's own mocks answer estimates of
 * its functions first; unmocked, a plain transfer to an address without code
 * is 21000 gas, as a node estimates it.
 */
export const estimateGas = ({ state, registry }: ActionsContext): Definition => ({
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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoded by decodeEstimateGas
    const { to, data, account, value, blockNumber } = call as EstimateGasCall;
    if (to === undefined || data === undefined || data === "0x") return undefined;
    return registry
      .contractAt(to)
      ?.estimate(data, { from: account, value, blockNumber, batch: undefined });
  },
  // A plain transfer to an address without code costs the base 21000 gas.
  fallback(call) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoded by decodeEstimateGas
    const { to, data = "0x" } = call as EstimateGasCall;
    if (to === undefined || data !== "0x") return undefined;
    const code = registry.codeAt(to);
    return code === undefined || code === "0x" ? numberToHex(21_000n) : undefined;
  },
});
