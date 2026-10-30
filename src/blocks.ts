import { Block as OxBlock } from "ox";
import { nodeAddress } from "./result.js";
import {
  type Block,
  type FeeHistory,
  type Hash,
  concat,
  hexToBigInt,
  numberToHex,
  parseGwei,
  size,
  slice,
  zeroAddress,
  zeroHash,
} from "viem";

/** A block as `getBlock` returns it, with transaction hashes rather than objects. */
export type MockBlock = Block<bigint, false, "latest">;

export type BlockClock = {
  /** The block `startTimestamp` belongs to: the mock's starting block number. */
  startBlock: bigint;
  /** Unix timestamp of `startBlock`, in seconds. */
  startTimestamp: bigint;
  /** Milliseconds between blocks. */
  blockTime: number;
};

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

// Generated hashes are a marker plus the block number, so a hash maps back to
// its block without a lookup table. They aren't keccak hashes, but nothing
// reads a block hash as anything other than an identifier.
const hashMarker = "0xb10c";

/** The hash of generated block `number`. */
export function blockHash(number: bigint): Hash {
  return concat([hashMarker, numberToHex(number, { size: 30 })]);
}

/** The block number of a generated block hash, or `undefined` for any other hash. */
export function numberOfBlockHash(hash: Hash): bigint | undefined {
  if (size(hash) !== 32 || slice(hash, 0, 2).toLowerCase() !== hashMarker) return undefined;
  return hexToBigInt(slice(hash, 2));
}

/**
 * Block `number` as the mock generates it: the number, a hash that links to
 * its parent, a timestamp `blockTime` apart from its neighbors, and the base
 * fee. Everything else is zero or empty; the mock doesn't execute, so there's
 * nothing to fill it with.
 */
export function generateBlock(number: bigint, clock: BlockClock, fees: Fees): MockBlock {
  const elapsed = ((number - clock.startBlock) * BigInt(clock.blockTime)) / 1000n;
  const timestamp = clock.startTimestamp + elapsed;
  return {
    number,
    hash: blockHash(number),
    parentHash: number === 0n ? zeroHash : blockHash(number - 1n),
    timestamp: timestamp < 0n ? 0n : timestamp,
    baseFeePerGas: fees.baseFeePerGas,
    blobGasUsed: 0n,
    difficulty: 0n,
    excessBlobGas: 0n,
    extraData: "0x",
    gasLimit: 0n,
    gasUsed: 0n,
    logsBloom: `0x${"00".repeat(256)}`,
    miner: zeroAddress,
    mixHash: zeroHash,
    nonce: "0x0000000000000000",
    receiptsRoot: zeroHash,
    sealFields: [],
    sha3Uncles: zeroHash,
    size: 0n,
    stateRoot: zeroHash,
    totalDifficulty: 0n,
    transactions: [],
    transactionsRoot: zeroHash,
    uncles: [],
  };
}

/**
 * A block in its JSON-RPC form. ox's `Block.toRpc` uses `undefined` where viem
 * uses `null`, and viem leaves withdrawals in their JSON-RPC form already.
 */
export function toRpcBlock({ withdrawals, ...block }: MockBlock) {
  return {
    ...OxBlock.toRpc({
      ...block,
      miner: nodeAddress(block.miner),
      baseFeePerGas: block.baseFeePerGas ?? undefined,
      totalDifficulty: block.totalDifficulty ?? undefined,
    }),
    withdrawals,
  };
}
