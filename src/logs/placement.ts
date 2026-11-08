import { type Hash, type Log, zeroHash } from "viem";

import { blockHash } from "../chain/blocks.js";
import { nodeHash } from "../chain/hashes.js";
import { placeLog } from "../chain/receipts.js";
import type { ChainState } from "../chain/state.js";
import { checkAmount, checkCount, checkFields } from "../mocking/setupChecks.js";
import { MockSetupError } from "../shared/errors.js";
import { type MockEventLog, checkLog, isPlaced } from "./events.js";

/**
 * Where `mock.buildLog()` places a log, in a log's own field names: its
 * block, its transaction, and its place in them.
 */
export type LogPlacement = {
  /** Its block. Defaults to the current block. */
  blockNumber?: bigint;
  /** Its transaction's hash. Defaults to the zero hash. */
  transactionHash?: Hash;
  /** Its transaction's index in the block. Defaults to `0`. */
  transactionIndex?: number;
  /**
   * Its index in the block, across every transaction's logs.
   * `mock.buildLog()` doesn't count it: give it to match a block with other
   * logs before it. Defaults to `0`.
   */
  logIndex?: number;
};

const placementFields = new Set(["blockNumber", "transactionHash", "transactionIndex", "logIndex"]);
const placementHint =
  "Its fields are blockNumber, transactionHash, transactionIndex and logIndex; left out, the " +
  "current block and zeros.";

/**
 * `log`'s content as a complete viem log, placed at `placement`: the same
 * placement as a transaction's logs, without the chain counting it. The
 * block is `chain`'s current one unless given, its hash and timestamp are
 * the mock's generated ones, and other position fields left out are zero.
 * Content already placed is refused, as everywhere that places logs.
 */
export function buildLog(
  log: MockEventLog,
  placement: LogPlacement,
  chain: Pick<ChainState, "blockNumber" | "timestampAt">,
): Log<bigint, number, false> {
  checkLog(log, "mock.buildLog()'s content");
  if (isPlaced(log))
    throw new MockSetupError(
      "mock.buildLog() places a log's content, but this log already has a position.",
      {
        metaMessages: [
          "Pass a log from contract.events, contractEvents() or testLog(), and its position " +
            "as buildLog()'s placement.",
        ],
      },
    );
  const {
    blockNumber = chain.blockNumber,
    transactionHash,
    transactionIndex,
    logIndex,
  } = checkFields(placement, "mock.buildLog()'s placement", placementFields, (field) =>
    field === "hash"
      ? "A log's transaction is transactionHash, as on a log; hash is a transaction's."
      : placementHint,
  );
  checkAmount(blockNumber, "mock.buildLog()'s blockNumber");
  const hash =
    transactionHash === undefined ? zeroHash : nodeHash(transactionHash, "A transaction hash");
  for (const [name, index] of Object.entries({ transactionIndex, logIndex }))
    if (index !== undefined) checkCount(index, `mock.buildLog()'s ${name}`, 0);
  return placeLog(log, {
    blockHash: blockHash(blockNumber),
    blockNumber,
    blockTimestamp: chain.timestampAt(blockNumber),
    transactionHash: hash,
    transactionIndex: transactionIndex ?? 0,
    logIndex: logIndex ?? 0,
  });
}
