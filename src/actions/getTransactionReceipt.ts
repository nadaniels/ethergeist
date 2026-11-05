import { type Hash, type TransactionReceipt, formatTransactionReceipt } from "viem";

import { hashParam } from "../chain/params.js";
import { type ReceiptFields, completeReceipt, toRpcReceipt } from "../chain/receipts.js";
import { type MockEventLog, isPlaced } from "../logs/events.js";
import { MockSetupError } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import { refuseNonLogs, refuseRevertedLogs } from "../transactions/writeOutcome.js";
import { pinnedHash, registeredAt, unwrapRegistered } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";
import type { ReceiptCall } from "./types.js";

/**
 * A mocked receipt: any receipt fields, and its logs' content (from
 * `contract.events`, `contractEvents()` or `testLog()`), which the receipt
 * places in its block and transaction, in place of any its transaction has
 * on the chain. They answer this receipt only: `getLogs` and watchers don't
 * see them. To have them seen, put the transaction on the chain:
 * `mock.addTransaction({ hash, logs })`.
 */
export type MockReceipt = ReceiptFields & { logs?: readonly MockEventLog[] };

/**
 * A receipt for a hash not on the chain, with `receipt`'s fields over zeros
 * and its logs' content placed in it: logs that aren't content, already
 * placed, or on a reverted receipt are refused.
 */
export function placedReceipt(
  receipt: MockReceipt,
  context: {
    hash: Hash | undefined;
    blockNumber: bigint;
    timestampAt: (number: bigint) => bigint;
    logsBefore: (blockNumber: bigint, transactionIndex: number) => number;
  },
): TransactionReceipt {
  const { logs = [], ...fields } = receipt;
  checkContentLogs(logs);
  refuseRevertedLogs(fields.status, logs);
  return completeReceipt(fields, { ...context, logs });
}

/** Refuses `logs` unless they're content a receipt can place: logs, not placed yet. */
function checkContentLogs(logs: unknown): asserts logs is readonly MockEventLog[] {
  refuseNonLogs(logs, "A receipt's");
  if (logs.some((log) => isPlaced(log)))
    throw new MockSetupError(
      "A receipt places its logs, but one already has a position (e.g. from mock.buildLog()).",
      {
        metaMessages: [
          "Pass a log's content, from contract.events, or contractEvents({ abi, address }) " +
            "for a contract you don't mock.",
        ],
      },
    );
}

/**
 * `eth_getTransactionReceipt`: a mock's fields over what the chain would
 * answer: the receipt of its transaction once it's mined, and otherwise a
 * successful receipt with zeros and the mock's logs, in the block current
 * when it's registered for a static one (a node never moves it), and when
 * it answers for a resolver's. Unmocked, the receipt of a transaction on the
 * chain: `null` while it's placed in a block not mined yet, as for a
 * pending one.
 */
export const getTransactionReceipt = ({
  state,
  transactions,
}: ActionsContext): Definition<ReceiptCall, ReturnType<typeof toRpcReceipt> | null> => ({
  name: "getTransactionReceipt",
  hint: "mock.actions.getTransactionReceipt({ hash }).returns(…)",
  decode: ([hash]) => ({ hash: hashParam(hash) }),
  // A reverted status over a pinned hash mined with logs is refused at registration.
  pinnedCall: pinnedHash,
  zero: {},
  fixAtRegistration: registeredAt(state),
  encode(answer, call) {
    const { value, blockNumber } = unwrapRegistered(answer);
    if (value === null) return null;
    if (!isPlainObject(value))
      throw new MockSetupError(`A receipt must be an object or null; got ${typeof value}.`);
    const record = call && transactions.minedRecord(call.hash);
    if (record === undefined)
      return toRpcReceipt(
        placedReceipt(value, {
          hash: call?.hash,
          blockNumber: blockNumber ?? state.blockNumber,
          timestampAt: state.timestampAt,
          logsBefore: transactions.logsBefore,
        }),
      );
    const { logs, ...fields } = value;
    if (logs !== undefined) checkContentLogs(logs);
    refuseRevertedLogs(fields.status, logs ?? record.logs, [
      `Transaction ${record.hash} on the chain has ${record.logs.length} log(s): answer this ` +
        'receipt without them, { status: "reverted", logs: [] }, or add it reverted, ' +
        'mock.addTransaction({ …, status: "reverted" }), so every method agrees.',
    ]);
    // Mined, so it has one.
    return transactions.receiptFor(record.hash, fields, logs)!;
  },
  fallback: (call) => transactions.receiptFor(call.hash),
  view: (rpc) => (rpc === null ? null : formatTransactionReceipt(rpc)),
});
