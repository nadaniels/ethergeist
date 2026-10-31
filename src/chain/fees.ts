import { type FeeHistory, numberToHex, parseGwei } from "viem";

/**
 * The fees generated blocks and fee requests answer with: every block's
 * `baseFeePerGas`, and the tip a node suggests (`eth_maxPriorityFeePerGas`).
 * `eth_gasPrice` is their sum, as reth suggests it.
 */
export type MockFees = {
  /** Defaults to 10 gwei. */
  baseFeePerGas?: bigint;
  /** Defaults to 1 gwei. */
  maxPriorityFeePerGas?: bigint;
};

export type Fees = Required<MockFees>;

// Whole gwei, and different, so a swapped or ignored fee shows: viem's
// estimateFeesPerGas() gives 13 gwei (base × 1.2 + tip), eth_gasPrice 11.
const defaults: Fees = { baseFeePerGas: parseGwei("10"), maxPriorityFeePerGas: parseGwei("1") };

/** `fees` over the defaults, checked: each is a bigint, zero or more. */
export function resolveFees(fees: MockFees = {}): Fees {
  const resolved = { ...defaults, ...fees };
  for (const [name, value] of Object.entries(resolved)) {
    if (typeof value !== "bigint")
      throw new TypeError(`fees.${name} must be a bigint; got ${typeof value}.`);
    if (value < 0n) throw new RangeError(`fees.${name} can't be negative; got ${value}.`);
  }
  return resolved;
}

/**
 * The blob base fee generated blocks have: 1 wei, the protocol's minimum, as
 * their excess blob gas is zero.
 */
export const blobBaseFee = 1n;

/** `eth_feeHistory`'s answer in viem's types, with the blob fields reth adds. */
export type MockFeeHistory = Partial<FeeHistory> & {
  baseFeePerBlobGas?: bigint[];
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
