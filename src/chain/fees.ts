import { type FeeHistory, numberToHex, parseGwei } from "viem";

import { MockSetupError } from "../shared/errors.js";
import { withoutUndefined } from "../shared/values.js";

/**
 * The fees generated blocks and fee requests answer with, as
 * `createMockRpc()`'s `fees` and `mock.setFees()` take them. `eth_gasPrice`
 * answers their sum, as reth suggests it.
 */
export type MockFees = {
  /** The blocks' base fee. Defaults to 10 gwei. */
  baseFeePerGas?: bigint;
  /**
   * The tip a node suggests, as `eth_maxPriorityFeePerGas` answers it.
   * Defaults to 1 gwei.
   */
  maxPriorityFeePerGas?: bigint;
};

/** `MockFees` with every fee set. */
export type Fees = Required<MockFees>;

const defaults: Fees = { baseFeePerGas: parseGwei("10"), maxPriorityFeePerGas: parseGwei("1") };

/** A bigint option, checked: zero or more; `name` names it in the error. */
export function bigintOption(value: bigint, name: string): bigint {
  if (typeof value !== "bigint")
    throw new MockSetupError(`${name} must be a bigint; got ${typeof value}.`);
  if (value < 0n) throw new MockSetupError(`${name} can't be negative; got ${value}.`);
  return value;
}

/**
 * `fees` over `base`, checked: each is a bigint, zero or more. A fee left
 * out, or `undefined`, keeps `base`'s.
 */
export function resolveFees(fees: MockFees = {}, base: Fees = defaults): Fees {
  const resolved = { ...base, ...withoutUndefined(fees) };
  for (const [name, value] of Object.entries(resolved)) bigintOption(value, `fees.${name}`);
  return resolved;
}

/**
 * The blob base fee generated blocks have: 1 wei, the protocol's minimum, as
 * their excess blob gas is zero.
 */
export const blobBaseFee = 1n;

/**
 * A fee history: `eth_feeHistory`'s answer in viem's types, with the blob
 * fields reth adds. A `getFeeHistory` mock's fields go over the generated
 * history.
 */
export type MockFeeHistory = Partial<FeeHistory> & {
  /** Each block's blob base fee, and the next block's after them. */
  baseFeePerBlobGas?: bigint[];
  /** Each block's blob gas used, as a ratio of its blob gas limit. */
  blobGasUsedRatio?: number[];
};

/** The most blocks reth answers for; it caps larger counts without an error. */
const maxFeeHistoryBlocks = 1024;

/**
 * The fee history of generated blocks, as reth answers it: `blockCount`
 * blocks up to `newest` (capped at 1024, and at block 0), each block's base
 * fee plus the next one's, and gas used ratios of zero (generated blocks use
 * no gas). Rewards are zero at every percentile, as a node reports them for
 * empty blocks. No `rewardPercentiles`, no `reward`; a count of zero has only
 * two fields.
 */
export function feeHistory(
  {
    blockCount,
    newest,
    rewardPercentiles,
  }: { blockCount: number; newest: bigint; rewardPercentiles?: readonly number[] },
  feesAt: (number: bigint) => Fees,
): MockFeeHistory {
  if (blockCount === 0) return { gasUsedRatio: [], oldestBlock: 0n };
  const count = BigInt(Math.min(blockCount, maxFeeHistoryBlocks));
  const oldestBlock = newest - count + 1n < 0n ? 0n : newest - count + 1n;
  const numbers = Array.from(
    { length: Number(newest - oldestBlock + 1n) },
    (_, i) => oldestBlock + BigInt(i),
  );
  const withNext = [...numbers, newest + 1n];
  return {
    baseFeePerGas: withNext.map((number) => feesAt(number).baseFeePerGas),
    gasUsedRatio: numbers.map(() => 0),
    baseFeePerBlobGas: withNext.map(() => blobBaseFee),
    blobGasUsedRatio: numbers.map(() => 0),
    oldestBlock,
    ...(rewardPercentiles && {
      reward: numbers.map(() => rewardPercentiles.map(() => 0n)),
    }),
  };
}

const hexList = (list: readonly bigint[] | undefined) => list?.map((value) => numberToHex(value));

/** A fee history in its JSON-RPC form, with reth's fields in reth's order. */
export function toRpcFeeHistory(history: MockFeeHistory) {
  const fields = {
    baseFeePerGas: hexList(history.baseFeePerGas),
    gasUsedRatio: history.gasUsedRatio,
    baseFeePerBlobGas: hexList(history.baseFeePerBlobGas),
    blobGasUsedRatio: history.blobGasUsedRatio,
    oldestBlock: history.oldestBlock === undefined ? undefined : numberToHex(history.oldestBlock),
    reward: history.reward?.map(hexList),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
