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

import { nodeAddress } from "../shared/values.js";
import { blockHash } from "./blocks.js";

/**
 * A log a receipt places: its content. `topics` takes any list of hashes,
 * not only viem's non-empty tuple.
 */
type ReceiptLog = Partial<Pick<Log<bigint, number, false>, "address" | "data">> & {
  topics?: readonly Hex[];
};

/** Any receipt fields but its logs, which go to `completeReceipt` to be placed. */
export type ReceiptFields = Partial<Omit<TransactionReceipt, "logs">>;

const zeroBloom = `0x${"00".repeat(256)}` as const;

/**
 * A receipt for `hash` with `receipt`'s fields over useful defaults: `status`
 * is `"success"` (zero would mean reverted), the block is `blockNumber`
 * unless given, and each of `logs` is placed by the receipt: its block (with
 * its timestamp, as reth sends it), transaction and index, its index in the
 * block counted after the logs of the block's earlier transactions
 * (`logsBefore`), as a node counts them. Everything else is zero. Addresses are validated, and lowercase
 * as nodes send them. `hash` is `undefined` while it isn't known yet, e.g.
 * at registration.
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
    /** How many logs the chain's transactions before an index in a block have. */
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
 * Where a log sits on the chain: its block (with the block's timestamp, as
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
    // viem's tuple type only says "empty or not"; the hashes are the same.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same values, viem's narrower type
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
 * reth sends it (ox's encoder drops it). The address is lowercase, as nodes send it.
 */
export function toRpcLog(log: Log<bigint, number, false>): Log<Hex, Hex, false> {
  const { blockTimestamp } = log;
  return {
    // ox types a log's topics as non-empty, but a LOG0 log has none; it passes them through.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ox's type is narrower than its runtime
    ...OxLog.toRpc({ ...log, address: nodeAddress(log.address) } as OxLog.Log),
    ...(typeof blockTimestamp === "bigint" ? { blockTimestamp: numberToHex(blockTimestamp) } : {}),
  };
}
