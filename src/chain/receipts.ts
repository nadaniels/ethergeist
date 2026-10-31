import { TransactionReceipt as OxTransactionReceipt } from "ox";
import {
  type Hex,
  type Hash,
  type Log,
  type TransactionReceipt,
  zeroAddress,
  zeroHash,
} from "viem";
import { blockHash } from "./blocks.js";
import { formatValue } from "../mocking/format.js";
import { nodeAddress } from "../shared/values.js";

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
 * Everything else is zero. Addresses are validated, and lowercase as nodes send them.
 * `hash` is `undefined` while it isn't known yet, e.g. at registration.
 */
export function completeReceipt(
  receipt: MockReceipt,
  { hash, blockNumber }: { hash: Hash | undefined; blockNumber: bigint },
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
    transactionHash: hash ?? zeroHash,
    transactionIndex: 0,
    type: "eip1559",
    ...fields,
  };
  complete.from = nodeAddress(complete.from);
  if (complete.to) complete.to = nodeAddress(complete.to);
  if (complete.contractAddress) complete.contractAddress = nodeAddress(complete.contractAddress);
  // Only a hash given now can be checked; a pinned request's arrives later.
  const known = receipt.transactionHash ?? hash;
  logs.forEach((log, i) => {
    assertInReceipt(i, "blockNumber", log.blockNumber, complete.blockNumber);
    assertInReceipt(i, "blockHash", log.blockHash, complete.blockHash);
    if (known !== undefined) assertInReceipt(i, "transactionHash", log.transactionHash, known);
    assertInReceipt(i, "transactionIndex", log.transactionIndex, complete.transactionIndex);
  });
  return {
    ...complete,
    logs: logs.map((log, logIndex) => placeLog(log, { ...complete, logIndex })),
  };
}

/** Throws if receipt log `index` names a block or transaction other than the receipt's. */
function assertInReceipt<value extends bigint | number | string>(
  index: number,
  field: string,
  actual: value | null | undefined,
  expected: value,
) {
  if (actual === undefined || actual === null) return;
  const same =
    typeof actual === "string" && typeof expected === "string"
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  if (!same)
    throw new Error(
      `Receipt log ${index} has ${field} ${formatValue(actual)}, but the receipt's is ` +
        `${formatValue(expected)}. A receipt places its logs: pass only their content, e.g. from ` +
        "contract.events.",
    );
}

/** Where a log sits on the chain: its block, transaction, and index in the block. */
export type LogPosition = Pick<
  Log<bigint, number, false>,
  "blockHash" | "blockNumber" | "transactionHash" | "transactionIndex" | "logIndex"
>;

/**
 * A complete log: `log`'s fields over `position`, with zeros for the rest.
 * Fields the log sets win, so a receipt's log can name its own position.
 * The address is validated, and lowercase as nodes send it.
 */
export function placeLog(log: MockLog, position: LogPosition): Log<bigint, number, false> {
  return Object.assign(
    {
      address: zeroAddress,
      topics: [],
      data: "0x",
      blockHash: position.blockHash,
      blockNumber: position.blockNumber,
      transactionHash: position.transactionHash,
      transactionIndex: position.transactionIndex,
      logIndex: position.logIndex,
      removed: false,
    } satisfies Log<bigint, number, false>,
    log,
    log.address === undefined ? {} : { address: nodeAddress(log.address) },
    // viem's tuple type only says "empty or not"; the hashes are the same.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same values, viem's narrower type
    log.topics === undefined ? {} : { topics: [...log.topics] as Log["topics"] },
  );
}

/** A receipt in its JSON-RPC form, logs included. */
export function toRpcReceipt(receipt: TransactionReceipt) {
  // ox types a log's topics as non-empty, but a LOG0 log has none, as viem
  // allows; ox passes topics through as they are.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ox's type is narrower than its runtime
  return OxTransactionReceipt.toRpc(receipt as OxTransactionReceipt.TransactionReceipt);
}
