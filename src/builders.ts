import { formatTransaction, zeroHash } from "viem";

import { type MockReceipt, placedReceipt } from "./actions/getTransactionReceipt.js";
import type { ChainState } from "./chain/state.js";
import {
  encodeTransaction,
  type BuiltTransaction,
  type MockTransaction,
} from "./chain/transactions.js";
import { type LogPlacement, type MockEventLog, buildLog } from "./logs/events.js";
import { refuseUnencodable } from "./shared/errors.js";
import { withoutUndefined } from "./shared/values.js";
import type { TransactionStore } from "./transactions/store.js";

/**
 * The mock's builders of what it answers, in viem's types, with its answers'
 * defaults: `state`'s current block, fees and chain. A value is in the block
 * current when it's built, as a static answer is in the block current at
 * registration. For `toEqual` against what the app got, and for props; see
 * `MockRpc` for each.
 */
export function createBuilders(
  state: ChainState,
  transactions: Pick<TransactionStore, "logsBefore">,
) {
  return {
    /**
     * The transaction a `getTransaction` mock answers with
     * `.returns(transaction)` for a hash with no placed transaction; its hash
     * is zero unless given.
     */
    buildTransaction: <const transaction extends MockTransaction = { type?: "eip1559" }>(
      transaction?: transaction,
    ): BuiltTransaction<transaction> =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- formatTransaction of the transaction's own type
      formatTransaction(
        refuseUnencodable("buildTransaction()", () =>
          encodeTransaction(
            state,
            withoutUndefined(transaction ?? {}),
            transaction?.hash ?? zeroHash,
          ),
        ),
      ) as BuiltTransaction<transaction>,
    /**
     * The receipt a `getTransactionReceipt` mock answers with
     * `.returns(receipt)` for a hash not on the chain, with `logs` placed in
     * it; its hash is zero unless given.
     */
    buildReceipt: (receipt: MockReceipt = {}) =>
      refuseUnencodable("buildReceipt()", () =>
        placedReceipt(withoutUndefined(receipt), {
          hash: receipt.transactionHash ?? zeroHash,
          blockNumber: state.blockNumber,
          timestampAt: state.timestampAt,
          logsBefore: transactions.logsBefore,
        }),
      ),
    /**
     * `log`'s content placed as a complete viem log, in the current block
     * unless `placement` gives one; see `buildLog`.
     */
    buildLog: (log: MockEventLog, placement: LogPlacement = {}) => buildLog(log, placement, state),
  };
}
