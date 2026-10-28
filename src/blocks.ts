import { Block as OxBlock } from "ox";
import {
  type Block,
  type Hash,
  concat,
  hexToBigInt,
  numberToHex,
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
 * its parent, and a timestamp `blockTime` apart from its neighbors. Everything
 * else is zero or empty; the mock doesn't execute, so there's nothing to fill
 * it with.
 */
export function generateBlock(number: bigint, clock: BlockClock): MockBlock {
  const elapsed = ((number - clock.startBlock) * BigInt(clock.blockTime)) / 1000n;
  const timestamp = clock.startTimestamp + elapsed;
  return {
    number,
    hash: blockHash(number),
    parentHash: number === 0n ? zeroHash : blockHash(number - 1n),
    timestamp: timestamp < 0n ? 0n : timestamp,
    baseFeePerGas: 0n,
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
      baseFeePerGas: block.baseFeePerGas ?? undefined,
      totalDifficulty: block.totalDifficulty ?? undefined,
    }),
    withdrawals,
  };
}
