import { type Address, type Chain, getAddress, hexToBigInt, isHex } from "viem";
import { mainnet } from "viem/chains";
import { MockNotFoundError } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import { type BlockClock, type MockBlock, generateBlock, numberOfBlockHash } from "./blocks.js";
import { type Fees, type MockFees, resolveFees } from "./fees.js";

/** The canonical Multicall3 deployment, which viem's built-in chains point at. */
export const multicall3Address: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** The chain a mock stands in for, with a Multicall3 address: its own, or the canonical one. */
export type MockChain = Chain & { contracts: { multicall3: { address: Address } } };

/** What the mock knows about its chain without any mocks: see `createChainState`. */
export type ChainState = ReturnType<typeof createChainState>;

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
  const given = parameters.chain ?? mainnet;
  // Without a Multicall3 address, viem's multicall falls back to deployless calls.
  const chain: MockChain = {
    ...given,
    contracts: {
      ...given.contracts,
      multicall3: given.contracts?.multicall3 ?? { address: multicall3Address },
    },
  };
  const initialBlockNumber = parameters.blockNumber ?? 1n;
  let blockNumber = initialBlockNumber;
  const clock: BlockClock = {
    startBlock: initialBlockNumber,
    startTimestamp: parameters.timestamp ?? 1_700_000_000n,
    blockTime: chain.blockTime ?? 12_000,
  };
  const initialFees = resolveFees(parameters.fees);
  /** `setFees()` changes, oldest first; each applies from its block on. */
  let feeChanges: readonly { fromBlock: bigint; fees: Fees }[] = [];
  const feesAt = (number: bigint) =>
    feeChanges.findLast((change) => change.fromBlock <= number)?.fees ?? initialFees;
  const generate = (number: bigint): MockBlock => generateBlock(number, clock, feesAt(number));

  /**
   * A block parameter as a block number: a hex number, a tag (`earliest` is 0;
   * every other tag is the current block, as there are no reorgs), or an
   * EIP-1898 `{ blockNumber }` or `{ blockHash }` of a generated block.
   */
  function resolveBlock(block: unknown): bigint {
    if (isHex(block)) return hexToBigInt(block);
    if (block === "earliest") return 0n;
    if (isPlainObject(block)) {
      if (isHex(block.blockNumber)) return hexToBigInt(block.blockNumber);
      if (isHex(block.blockHash)) {
        const number = numberOfBlockHash(block.blockHash);
        if (number === undefined)
          throw new MockNotFoundError(`No block with hash ${block.blockHash}.`, {
            details: "Only generated blocks' hashes resolve to a block number.",
          });
        return number;
      }
    }
    return blockNumber;
  }

  return {
    chain,
    chainId: chain.id,
    /** Multicall3's address on this chain, checksummed. */
    multicallAddress: getAddress(chain.contracts.multicall3.address),
    get blockNumber() {
      return blockNumber;
    },
    mine(blocks = 1n) {
      blockNumber += blocks;
    },
    /** Block `number`'s fees. */
    feesAt,
    /** The fees of the current block on become `fees`, over the ones they replace. */
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
    checkpoint() {
      const saved = { blockNumber, feeChanges };
      return {
        restore() {
          ({ blockNumber, feeChanges } = saved);
        },
      };
    },
  };
}
