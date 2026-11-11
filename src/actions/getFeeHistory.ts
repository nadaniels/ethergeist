import { type Hex, hexToBigInt } from "viem";

import { feeHistory, toRpcFeeHistory } from "../chain/fees.js";
import { type ResolveBlock, numberParam } from "../chain/params.js";
import { formatValue } from "../mocking/format.js";
import { checkAmount, checkFields, checkList } from "../mocking/setupChecks.js";
import { MockRpcError, MockSetupError } from "../shared/errors.js";
import { blockAt } from "./codec.js";
import type { ActionsContext, Definition } from "./table.js";
import type { FeeHistoryCall } from "./types.js";

const feeHistoryFields = new Set([
  "baseFeePerGas",
  "baseFeePerBlobGas",
  "gasUsedRatio",
  "blobGasUsedRatio",
  "oldestBlock",
  "reward",
]);
const fieldsHint =
  "Its fields are baseFeePerGas, baseFeePerBlobGas, gasUsedRatio, blobGasUsedRatio, " +
  "oldestBlock and reward.";

/** A fee history field's subject in messages. */
const subject = (field: string) => `${field} in getFeeHistory's answer`;

/**
 * `given` as a fee history's fields, checked against viem's types: bigints,
 * non-negative, and numbers for ratios.
 */
function checkFeeHistory(given: unknown) {
  const history = checkFields(given, "getFeeHistory's answer", feeHistoryFields, fieldsHint);
  const { baseFeePerGas, baseFeePerBlobGas, gasUsedRatio, blobGasUsedRatio, oldestBlock, reward } =
    history;
  for (const [field, fees] of Object.entries({ baseFeePerGas, baseFeePerBlobGas })) {
    if (fees === undefined) continue;
    checkList(fees, subject(field));
    for (const fee of fees) checkAmount(fee, subject(field));
  }
  for (const [field, ratios] of Object.entries({ gasUsedRatio, blobGasUsedRatio }))
    if (ratios !== undefined && !isNumberList(ratios))
      throw new MockSetupError(
        `${subject(field)} must be a list of numbers; got ${formatValue(ratios)}.`,
      );
  if (oldestBlock !== undefined) checkAmount(oldestBlock, subject("oldestBlock"));
  if (reward !== undefined) {
    checkList(reward, subject("reward"));
    for (const tips of reward) {
      checkList(tips, subject("reward"));
      for (const tip of tips) checkAmount(tip, subject("reward"));
    }
  }
  return history;
}

/**
 * The fields viem reads of a fee history's JSON-RPC answer: a count of 0 has
 * no base fees, and a call without percentiles no rewards.
 */
type RpcFeeHistoryAnswer = {
  baseFeePerGas?: Hex[];
  gasUsedRatio: number[];
  oldestBlock: Hex;
  reward?: Hex[][];
};

/**
 * A JSON-RPC fee history as viem's `getFeeHistory()` returns it: its four
 * fields as bigints, without the blob fields viem leaves out.
 */
function viewFeeHistory(rpc: unknown) {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the action's own answer, from toRpcFeeHistory()
  const history = rpc as RpcFeeHistoryAnswer;
  return {
    baseFeePerGas: history.baseFeePerGas?.map((fee) => hexToBigInt(fee)),
    gasUsedRatio: history.gasUsedRatio,
    oldestBlock: hexToBigInt(history.oldestBlock),
    reward: history.reward?.map((tips) => tips.map((tip) => hexToBigInt(tip))),
  };
}

const isNumberList = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((each) => typeof each === "number");

/**
 * The call an `eth_feeHistory` asks for: a block count, the newest block,
 * and maybe reward percentiles.
 */
function decodeFeeHistory(
  [count, newest, percentiles]: readonly unknown[],
  resolveBlock: ResolveBlock,
): FeeHistoryCall {
  const blockCount = numberParam(count, "a block count");
  if (percentiles !== undefined && !isNumberList(percentiles))
    throw new MockRpcError(-32602, "invalid reward percentiles");
  return {
    blockCount,
    ...blockAt(newest, resolveBlock, "numberOrTag"),
    ...(percentiles !== undefined && { rewardPercentiles: percentiles }),
  };
}

/**
 * `eth_feeHistory`. Unmocked, the generated blocks' history, as reth answers
 * it for empty blocks, and reth's refusals. A mock's fields go over that
 * history.
 */
export const getFeeHistory = ({ state }: ActionsContext): Definition<FeeHistoryCall> => {
  const feeHistoryOf = ({ blockCount, blockNumber: newest, rewardPercentiles }: FeeHistoryCall) =>
    feeHistory(
      { blockCount, newest, ...(rewardPercentiles && { rewardPercentiles }) },
      state.feesAt,
    );
  return {
    name: "getFeeHistory",
    hint: "mock.actions.getFeeHistory(…).returns(…), or `fees` in createMockRpc()",
    decode: (params) => decodeFeeHistory(params, state.resolveBlock),
    zero: {},
    encode(value, { call }) {
      const history = checkFeeHistory(value);
      const derived = call === undefined ? {} : feeHistoryOf(call);
      return toRpcFeeHistory({ ...derived, ...history });
    },
    view: viewFeeHistory,
    fallback(call) {
      // Reth answers a count of 0 before checking anything.
      if (call.blockCount > 0) {
        // Each percentile from 0 to 100, and none below the one before it (the
        // first is compared with 0).
        const percentiles = call.rewardPercentiles ?? [];
        if (percentiles.some((p, i) => p > 100 || p < (percentiles[i - 1] ?? 0)))
          throw new MockRpcError(-32602, "invalid reward percentiles");
        const head = state.blockNumber;
        if (call.blockNumber > head)
          throw new MockRpcError(
            -32602,
            `request beyond head block: requested ${call.blockNumber}, head ${head}`,
          );
      }
      return toRpcFeeHistory(feeHistoryOf(call));
    },
  };
};
