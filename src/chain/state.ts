import { type Chain, type Hash, getAddress, isHash, isHex } from "viem";
import { mainnet } from "viem/chains";

import { formatValue } from "../mocking/format.js";
import { MockNotFoundError, MockSetupError, invalidParams } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import { type BlockClock, type MockBlock, generateBlock, numberOfBlockHash } from "./blocks.js";
import { type Fees, type MockFees, bigintOption, resolveFees } from "./fees.js";
import { type BlockForm, hashParam, isBlockTag, quantityParam } from "./params.js";

/**
 * What the mock knows about its chain without any mocks: see
 * `createChainState`.
 */
export type ChainState = ReturnType<typeof createChainState>;

/** A generated block's number, by its hash. */
function numberOfHash(hash: Hash): bigint {
  const number = numberOfBlockHash(hash);
  if (number === undefined)
    throw new MockNotFoundError(`No block with hash ${hash}.`, {
      metaMessages: ["Only generated blocks' hashes resolve to a block number."],
    });
  return number;
}

/** What each block form takes, for the error. */
const expectedBlock: Record<BlockForm, string> = {
  numberOrTag: "a block number or tag",
  numberTagOrHash: "a block number, tag or hash",
};

/** A chain's block time, in milliseconds: 12s if it doesn't say. */
function blockTimeOf(chain: Chain): number {
  const blockTime: unknown = chain.blockTime ?? 12_000;
  if (typeof blockTime !== "number" || !Number.isInteger(blockTime) || blockTime < 0)
    throw new MockSetupError(
      "chain.blockTime must be a whole number of milliseconds, zero or more; got " +
        `${typeof blockTime === "number" ? blockTime : typeof blockTime}.`,
    );
  return blockTime;
}

/**
 * The chain's own state, which the mock owns: its id, the current block, the
 * clock blocks follow, and the fees they pay. Contracts and actions read it;
 * only `mine()` and `setFees()` change it.
 */
export function createChainState(parameters: {
  chain?: Chain | undefined;
  blockNumber?: bigint | undefined;
  timestamp?: bigint | undefined;
  fees?: MockFees | undefined;
}) {
  const chain = parameters.chain ?? mainnet;
  const multicall3 = chain.contracts?.multicall3?.address;
  const initialBlockNumber = bigintOption(parameters.blockNumber ?? 1n, "blockNumber");
  let blockNumber = initialBlockNumber;
  const clock: BlockClock = {
    startBlock: initialBlockNumber,
    startTimestamp: bigintOption(parameters.timestamp ?? 1_700_000_000n, "timestamp"),
    blockTime: blockTimeOf(chain),
  };
  const initialFees = resolveFees(parameters.fees);
  /** `setFees()` changes, oldest first; each applies from its block on. */
  let feeChanges: readonly { fromBlock: bigint; fees: Fees }[] = [];
  const feesAt = (number: bigint) =>
    feeChanges.findLast((change) => change.fromBlock <= number)?.fees ?? initialFees;
  const generate = (number: bigint): MockBlock => generateBlock(number, clock, feesAt(number));

  /**
   * A block param as a block number, read to the spec's `form` for the
   * method: a number or a tag (`earliest` is 0; every other tag is the
   * current block, as there are no reorgs), and where the form takes them,
   * a block hash or an EIP-1898 `{ blockNumber }` or `{ blockHash }` of a
   * generated block. No block param is the current block; anything else is
   * refused.
   */
  function resolveBlock(block: unknown, form: BlockForm = "numberTagOrHash"): bigint {
    if (block === undefined) return blockNumber;
    if (isBlockTag(block)) return block === "earliest" ? 0n : blockNumber;
    if (form === "numberTagOrHash") {
      if (typeof block === "string" && isHash(block)) return numberOfHash(block);
      if (isPlainObject(block) && block.blockHash !== undefined && block.blockNumber !== undefined)
        throw invalidParams(
          `expected a block number or a block hash, not both; got ${formatValue(block)}`,
        );
      if (isPlainObject(block) && block.blockHash !== undefined)
        return numberOfHash(hashParam(block.blockHash));
      if (isPlainObject(block) && block.blockNumber !== undefined)
        return quantityParam(block.blockNumber, "a block number");
    }
    if (isHex(block)) return quantityParam(block, "a block number");
    throw invalidParams(`expected ${expectedBlock[form]}; got ${formatValue(block)}`);
  }

  return {
    chain,
    chainId: chain.id,
    /** Multicall3's address on this chain, checksummed, if it has one. */
    multicallAddress: multicall3 === undefined ? undefined : getAddress(multicall3),
    get blockNumber() {
      return blockNumber;
    },
    /**
     * Mines `blocks` blocks: a safe integer, 1 or more, so the head only
     * moves forward.
     */
    mine(blocks = 1) {
      const given: unknown = blocks;
      if (!Number.isSafeInteger(given) || blocks < 1)
        throw new MockSetupError(
          `mock.mine() takes a count of blocks, an integer of 1 or more; got ${formatValue(given)}.`,
          typeof given === "bigint"
            ? { metaMessages: [`Counts are numbers: mock.mine(${given}).`] }
            : undefined,
        );
      blockNumber += BigInt(blocks);
    },
    /** Block `number`'s fees. */
    feesAt,
    /**
     * Changes the fees from the current block on to `fees`, over the ones
     * they replace.
     */
    setFees(fees: MockFees) {
      const changed = resolveFees({ ...feesAt(blockNumber), ...fees });
      feeChanges = [
        ...feeChanges.filter((change) => change.fromBlock < blockNumber),
        { fromBlock: blockNumber, fees: changed },
      ];
    },
    /** Block `number` as generated, before any mock's fields. */
    generateBlock: generate,
    /** Block `number`'s generated timestamp. */
    timestampAt: (number: bigint) => generate(number).timestamp,
    resolveBlock,
    /** Saves the block number and fees, to go back to. */
    snapshot() {
      const saved = { blockNumber, feeChanges };
      return {
        restore() {
          ({ blockNumber, feeChanges } = saved);
        },
      };
    },
  };
}
