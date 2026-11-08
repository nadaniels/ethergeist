import { Log as OxLog, TransactionReceipt as OxTransactionReceipt } from "ox";
import {
  type Hex,
  type Hash,
  type Log,
  type TransactionReceipt,
  numberToHex,
  zeroAddress,
  zeroHash,
} from "viem";

import { formatValue } from "../mocking/format.js";
import { MockSetupError } from "../shared/errors.js";
import { nodeAddress } from "../shared/values.js";
import { blockHash } from "./blocks.js";
import { nodeHash } from "./hashes.js";

/**
 * A log a receipt places: its content. `topics` takes any list of hashes,
 * not only viem's non-empty tuple.
 */
type ReceiptLog = Partial<Pick<Log<bigint, number, false>, "address" | "data">> & {
  topics?: readonly Hex[];
};

/**
 * Any receipt fields but its logs, which go to `completeReceipt` to be
 * placed.
 */
export type ReceiptFields = Partial<Omit<TransactionReceipt, "logs">>;

/**
 * Refuses a status that isn't `"success"` or `"reverted"` (`undefined` is
 * left out), and logs on a reverted transaction, which emits none: for a
 * send's outcome, an added transaction and a receipt alike. `what` names
 * the status for messages; `metaMessages` say where the logs came from.
 */
export function checkStatus(
  status: unknown,
  logs: readonly unknown[],
  what: string,
  metaMessages?: string[],
): asserts status is "success" | "reverted" | undefined {
  if (status !== undefined && status !== "success" && status !== "reverted")
    throw new MockSetupError(
      `${what} must be "success" or "reverted"; got ${formatValue(status)}.`,
    );
  if (status === "reverted" && logs.length > 0)
    throw new MockSetupError("A reverted transaction has no logs.", { metaMessages });
}

const zeroBloom = `0x${"00".repeat(256)}` as const;

/**
 * A receipt for `hash`, `receipt`'s fields over defaults: `status: "success"`
 * (zero would mean reverted), block `blockNumber` with its generated hash,
 * an `"eip1559"` type, and zero or `null` for the rest. Addresses and hashes
 * are validated, and lowercase as nodes send them. `hash` is `undefined`
 * while it isn't known yet, e.g. at registration.
 *
 * Each of `logs` is placed by the receipt: its block (with its timestamp, as
 * reth sends it), transaction and index. Its index in the block counts the
 * logs of the block's earlier transactions (`logsBefore`), as a node counts
 * them.
 */
export function completeReceipt(
  receipt: ReceiptFields,
  {
    hash,
    blockNumber,
    timestampAt,
    logsBefore,
    logs = [],
  }: {
    hash: Hash | undefined;
    blockNumber: bigint;
    timestampAt: (number: bigint) => bigint;
    /**
     * How many logs the chain's transactions before an index in a block
     * have.
     */
    logsBefore: (blockNumber: bigint, transactionIndex: number) => number;
    logs?: readonly ReceiptLog[];
  },
): TransactionReceipt {
  const number = receipt.blockNumber ?? blockNumber;
  const complete: Omit<TransactionReceipt, "logs"> = {
    blockHash: blockHash(number),
    blockNumber: number,
    contractAddress: null,
    cumulativeGasUsed: 0n,
    effectiveGasPrice: 0n,
    from: zeroAddress,
    gasUsed: 0n,
    logsBloom: zeroBloom,
    status: "success",
    to: zeroAddress,
    transactionHash: hash ?? zeroHash,
    transactionIndex: 0,
    type: "eip1559",
    ...receipt,
  };
  complete.blockHash = nodeHash(complete.blockHash, "A receipt's blockHash");
  complete.transactionHash = nodeHash(complete.transactionHash, "A receipt's transactionHash");
  complete.from = nodeAddress(complete.from);
  if (complete.to) complete.to = nodeAddress(complete.to);
  if (complete.contractAddress) complete.contractAddress = nodeAddress(complete.contractAddress);
  const position = {
    blockHash: complete.blockHash,
    blockNumber: complete.blockNumber,
    blockTimestamp: timestampAt(complete.blockNumber),
    transactionHash: complete.transactionHash,
    transactionIndex: complete.transactionIndex,
  };
  return {
    ...complete,
    logs: logs.map((log, i) =>
      placeLog(log, {
        ...position,
        logIndex: logsBefore(complete.blockNumber, complete.transactionIndex) + i,
      }),
    ),
  };
}

/**
 * Where a log is placed: its block (with the block's timestamp, as
 * reth sends it), transaction, and index in the block.
 */
type LogPosition = Pick<
  Log<bigint, number, false>,
  "blockHash" | "blockNumber" | "transactionHash" | "transactionIndex" | "logIndex"
> & { blockTimestamp: bigint };

/**
 * A complete log: `log`'s content at `position`, with zeros for content it
 * leaves out. The address is validated, and lowercase as nodes send it.
 */
export function placeLog(
  log: ReceiptLog,
  position: LogPosition,
): Log<bigint, number, false> & { blockTimestamp: bigint } {
  return {
    address: log.address === undefined ? zeroAddress : nodeAddress(log.address),
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- viem's tuple only types whether it's empty, and the hashes are the same
    topics: [...(log.topics ?? [])] as Log["topics"],
    data: log.data ?? "0x",
    removed: false,
    ...position,
  };
}

/** A receipt in its JSON-RPC form, logs included. */
export function toRpcReceipt(receipt: TransactionReceipt) {
  return {
    ...OxTransactionReceipt.toRpc({ ...receipt, logs: [] }),
    logs: receipt.logs.map(toRpcLog),
  };
}

/**
 * A log in its JSON-RPC form, with its block's timestamp when it has one, as
 * reth sends it (ox's encoder drops it). The address and hashes are
 * validated, and lowercase as nodes send them.
 */
export function toRpcLog(log: Log<bigint, number, false>): Log<Hex, Hex, false> {
  const { blockTimestamp } = log;
  const position = {
    address: nodeAddress(log.address),
    blockHash: nodeHash(log.blockHash, "A log's blockHash"),
    transactionHash: nodeHash(log.transactionHash, "A log's transactionHash"),
  };
  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ox types topics as non-empty, but passes a LOG0 log's empty ones through
    ...OxLog.toRpc({ ...log, ...position } as OxLog.Log),
    ...(typeof blockTimestamp === "bigint" ? { blockTimestamp: numberToHex(blockTimestamp) } : {}),
  };
}
