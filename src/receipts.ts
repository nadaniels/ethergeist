import { TransactionReceipt as OxTransactionReceipt } from "ox";
import {
  type Hex,
  type Hash,
  type Log,
  type TransactionReceipt,
  getAddress,
  zeroAddress,
} from "viem";
import { blockHash } from "./blocks.js";

/**
 * A log in a mocked receipt. Fields left out come from the receipt, or are
 * zero. `topics` takes any list of hashes, not only viem's non-empty tuple.
 */
export type MockLog = Partial<Omit<Log<bigint, number, false>, "topics">> & {
  topics?: readonly Hex[];
};

/** A mocked receipt: any receipt fields, with logs that may be partial too. */
export type MockReceipt = Partial<Omit<TransactionReceipt, "logs">> & { logs?: MockLog[] };

const zeroBloom = `0x${"00".repeat(256)}` as const;

/**
 * A receipt for `hash` with `receipt`'s fields over useful defaults: `status`
 * is `"success"` (zero would mean reverted), the block is `blockNumber` unless
 * given, and each log's position, block, and transaction come from the receipt.
 * Everything else is zero. Addresses are checksummed, which also validates them.
 */
export function completeReceipt(
  receipt: MockReceipt,
  { hash, blockNumber }: { hash: Hash; blockNumber: bigint },
): TransactionReceipt {
  const { logs = [], ...fields } = receipt;
  const number = fields.blockNumber ?? blockNumber;
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
    transactionHash: hash,
    transactionIndex: 0,
    type: "eip1559",
    ...fields,
  };
  complete.from = getAddress(complete.from);
  if (complete.to) complete.to = getAddress(complete.to);
  if (complete.contractAddress) complete.contractAddress = getAddress(complete.contractAddress);
  return {
    ...complete,
    logs: logs.map((log, logIndex) =>
      Object.assign(
        {
          address: zeroAddress,
          topics: [],
          data: "0x",
          blockHash: complete.blockHash,
          blockNumber: complete.blockNumber,
          transactionHash: complete.transactionHash,
          transactionIndex: complete.transactionIndex,
          logIndex,
          removed: false,
        } satisfies Log<bigint, number, false>,
        log,
        log.address === undefined ? {} : { address: getAddress(log.address) },
        // viem's tuple type only says "empty or not"; the hashes are the same.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same values, viem's narrower type
        log.topics === undefined ? {} : { topics: [...log.topics] as Log["topics"] },
      ),
    ),
  };
}

/** A receipt in its JSON-RPC form, logs included. */
export function toRpcReceipt(receipt: TransactionReceipt) {
  // ox types a log's topics as non-empty, but a LOG0 log has none, as viem
  // allows; ox passes topics through as they are.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ox's type is narrower than its runtime
  return OxTransactionReceipt.toRpc(receipt as OxTransactionReceipt.TransactionReceipt);
}
