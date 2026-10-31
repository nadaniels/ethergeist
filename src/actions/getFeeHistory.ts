import { hexToBigInt, hexToNumber, isHex } from "viem";
import { feeHistory, toRpcFeeHistory } from "../chain/fees.js";
import { MockRpcError } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import type { FeeHistoryCall } from "./types.js";
import { blockAt } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";

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
      throw new TypeError(
        `A fee history has no field "${field}". Its fields: ${Object.keys(kinds).join(", ")}.`,
      );
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
      throw new TypeError(`A fee history's ${field} must be ${expected}.`);
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

/** `eth_feeHistory` takes a count (hex, or a number), the newest block, and maybe percentiles. */
function decodeFeeHistory(
  [count, newest, percentiles]: readonly unknown[],
  resolveBlock: (block: unknown) => bigint,
): FeeHistoryCall {
  return {
    blockCount: isHex(count) ? hexToNumber(count) : Number(count),
    ...blockAt(newest, resolveBlock),
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- percentiles, per JSON-RPC
    ...(Array.isArray(percentiles) && { rewardPercentiles: percentiles as number[] }),
  };
}

/** `eth_feeHistory`: unmocked, the generated blocks' history, as reth answers it for empty blocks. */
export const getFeeHistory = ({ state }: ActionsContext): Definition => {
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
        throw new TypeError(`A fee history must be an object; got ${typeof value}.`);
      assertFeeHistory(value);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoded by decodeFeeHistory
      const derived = call === undefined ? {} : feeHistoryOf(call as FeeHistoryCall);
      return toRpcFeeHistory({ ...derived, ...value });
    },
    view: viewFeeHistory,
    fallback(call) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoded by decodeFeeHistory
      const feeCall = call as FeeHistoryCall;
      const head = state.blockNumber;
      if (feeCall.blockCount > 0 && feeCall.blockNumber > head)
        throw new MockRpcError(
          -32602,
          `request beyond head block: requested ${feeCall.blockNumber}, head ${head}`,
        );
      const percentiles = feeCall.rewardPercentiles ?? [];
      if (percentiles.some((p, i) => p < 0 || p > 100 || p < (percentiles[i - 1] ?? 0)))
        throw new MockRpcError(-32602, "invalid reward percentiles");
      return toRpcFeeHistory(feeHistoryOf(feeCall));
    },
  };
};
