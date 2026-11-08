import { type Hash, type TransactionReceipt, formatTransactionReceipt } from "viem";

import { hashParam } from "../chain/params.js";
import {
  type ReceiptFields,
  checkStatus,
  completeReceipt,
  toRpcReceipt,
} from "../chain/receipts.js";
import { type MockLogContent, checkLogs } from "../logs/events.js";
import { checkObject } from "../mocking/setupChecks.js";
import { pinnedHash, registeredAt, unwrapRegistered } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";
import type { ReceiptCall } from "./types.js";

/**
 * A mocked receipt: any receipt fields, in viem's types, and its logs'
 * content (see `logs`).
 */
export type MockReceipt = ReceiptFields & {
  /**
   * Its logs' content, from `contract.events`, `contractEvents()` or
   * `testLog()`, in place of any its transaction has. The receipt places
   * them in its block and transaction. They answer this receipt only:
   * viem's `getLogs()` and watchers don't see them. To have them seen, place
   * the transaction with `mock.addTransaction({ hash, logs })`. A reverted
   * receipt with logs is refused: its own, or its mined transaction's.
   */
  logs?: readonly MockLogContent[];
};

/**
 * A receipt for a hash with no mined transaction, with `receipt`'s fields
 * over zeros and its logs' content placed in it. Logs that aren't content,
 * are already placed, or are on a reverted receipt are refused.
 */
export function placedReceipt(
  receipt: MockReceipt,
  /** Names a part of the receipt for messages, as the user wrote it. */
  named: (field: string) => string,
  context: {
    hash: Hash | undefined;
    blockNumber: bigint;
    timestampAt: (number: bigint) => bigint;
    logsBefore: (blockNumber: bigint, transactionIndex: number) => number;
  },
): TransactionReceipt {
  const { logs = [], ...fields } = receipt;
  checkLogs(logs, named);
  checkStatus(fields.status, logs, named("status"));
  return completeReceipt(fields, { ...context, logs });
}

const inAnswer = (field: string) => `${field} in getTransactionReceipt's answer`;

/**
 * `eth_getTransactionReceipt`. Unmocked, it answers with a placed
 * transaction's receipt, or `null` while it's waiting, as for a pending one,
 * and other hashes aren't answered. A mock's fields go over what the chain
 * would answer: the transaction's receipt once it's mined, and otherwise a
 * successful receipt with zeros and the mock's logs. That one is in a block
 * a node never moves: the block current at registration for a static
 * answer, or at the request for a resolver.
 */
export const getTransactionReceipt = ({
  state,
  transactions,
}: ActionsContext): Definition<ReceiptCall, ReturnType<typeof toRpcReceipt> | null> => ({
  name: "getTransactionReceipt",
  hint: "mock.actions.getTransactionReceipt({ hash }).returns(…)",
  decode: ([hash]) => ({ hash: hashParam(hash) }),
  pinnedCall: pinnedHash,
  zero: {},
  fixAtRegistration: registeredAt(state),
  encode(answer, call) {
    const { value, blockNumber } = unwrapRegistered(answer);
    if (value === null) return null;
    checkObject(value, "getTransactionReceipt's answer", "Or null for none.");
    const record = call && transactions.minedRecord(call.hash);
    if (record === undefined)
      return toRpcReceipt(
        placedReceipt(value, inAnswer, {
          hash: call?.hash,
          blockNumber: blockNumber ?? state.blockNumber,
          timestampAt: state.timestampAt,
          logsBefore: transactions.logsBefore,
        }),
      );
    const { logs, ...fields } = value;
    if (logs !== undefined) checkLogs(logs, inAnswer);
    checkStatus(fields.status ?? record.receipt.status, logs ?? record.logs, inAnswer("status"), [
      fields.status === undefined
        ? `Transaction ${record.hash} on the chain reverted: answer this receipt without logs, ` +
          'or add it with them and without status: "reverted", so every method agrees.'
        : `Transaction ${record.hash} on the chain has ${record.logs.length} log(s): answer this ` +
          'receipt without them, { status: "reverted", logs: [] }, or add it reverted, ' +
          'mock.addTransaction({ …, status: "reverted" }), so every method agrees.',
    ]);
    return transactions.receiptFor(record.hash, fields, logs)!;
  },
  fallback: (call) => transactions.receiptFor(call.hash),
  view: (rpc) => (rpc === null ? null : formatTransactionReceipt(rpc)),
});
