import { hexToBigInt, isHex } from "viem";

import { feeHistory, toRpcFeeHistory } from "../chain/fees.js";
import { type ResolveBlock, numberParam } from "../chain/params.js";
import { MockRpcError, MockSetupError } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import { blockAt } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";
import type { FeeHistoryCall } from "./types.js";

const isList = (value: unknown, type: string) =>
  Array.isArray(value) && value.every((each) => typeof each === type);

/** Throws unless `history`'s fields have viem's types: bigints, and numbers for ratios. */
function assertFeeHistory(history: Record<string, unknown>) {
  const kinds: Record<string, "bigints" | "numbers" | "bigint" | "rewards"> = {
    baseFeePerGas: "bigints",
    baseFeePerBlobGas: "bigints",
    gasUsedRatio: "numbers",
    blobGasUsedRatio: "numbers",
    oldestBlock: "bigint",
    reward: "rewards",
  };
  for (const [field, value] of Object.entries(history)) {
    const kind = kinds[field];
    if (kind === undefined)
      throw new MockSetupError(`A fee history has no field "${field}".`, {
        metaMessages: [`Its fields: ${Object.keys(kinds).join(", ")}.`],
      });
    const valid =
      kind === "bigint"
        ? typeof value === "bigint"
        : kind === "rewards"
          ? Array.isArray(value) && value.every((block) => isList(block, "bigint"))
          : isList(value, kind === "bigints" ? "bigint" : "number");
    if (!valid) {
      const expected = {
        bigints: "bigints",
        numbers: "numbers",
        bigint: "a bigint",
        rewards: "lists of bigints, one per block",
      }[kind];
      throw new MockSetupError(`A fee history's ${field} must be ${expected}.`);
    }
  }
}

/** JSON-RPC quantities as bigints, leaving anything else as is. */
const bigints = (list: unknown) =>
  Array.isArray(list)
    ? list.map((value: unknown) => (isHex(value) ? hexToBigInt(value) : value))
    : list;

/** A JSON-RPC fee history as viem's `getFeeHistory` returns it. */
function viewFeeHistory(rpc: unknown) {
  if (!isPlainObject(rpc)) return rpc;
  return {
    ...rpc,
    ...("baseFeePerGas" in rpc && { baseFeePerGas: bigints(rpc.baseFeePerGas) }),
    ...("baseFeePerBlobGas" in rpc && { baseFeePerBlobGas: bigints(rpc.baseFeePerBlobGas) }),
    ...(isHex(rpc.oldestBlock) && { oldestBlock: hexToBigInt(rpc.oldestBlock) }),
    ...(Array.isArray(rpc.reward) && { reward: rpc.reward.map(bigints) }),
  };
}

const isNumberList = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((each) => typeof each === "number");

/** `eth_feeHistory` takes a count (hex, or a number), the newest block, and maybe percentiles. */
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

/** `eth_feeHistory`: unmocked, the generated blocks' history, as reth answers it for empty blocks. */
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
    encode(value, call) {
      if (!isPlainObject(value))
        throw new MockSetupError(`A fee history must be an object; got ${typeof value}.`);
      assertFeeHistory(value);
      const derived = call === undefined ? {} : feeHistoryOf(call);
      return toRpcFeeHistory({ ...derived, ...value });
    },
    view: viewFeeHistory,
    fallback(call) {
      const head = state.blockNumber;
      if (call.blockCount > 0 && call.blockNumber > head)
        throw new MockRpcError(
          -32602,
          `request beyond head block: requested ${call.blockNumber}, head ${head}`,
        );
      const percentiles = call.rewardPercentiles ?? [];
      if (percentiles.some((p, i) => p < 0 || p > 100 || p < (percentiles[i - 1] ?? 0)))
        throw new MockRpcError(-32602, "invalid reward percentiles");
      return toRpcFeeHistory(feeHistoryOf(call));
    },
  };
};
