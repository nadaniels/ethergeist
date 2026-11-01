import { type Abi, type ContractEventName, formatTransaction, zeroHash } from "viem";

import { type MockReceipt, completeReceipt } from "./chain/receipts.js";
import type { ChainState } from "./chain/state.js";
import {
  encodeTransaction,
  type BuiltTransaction,
  type MockTransaction,
} from "./chain/transactions.js";
import { type BuildLogParameters, buildLog } from "./logs/events.js";

/**
 * Builders of what the mock answers, in viem's types, with the same defaults
 * as its answers: `state`'s current block, fees, and chain. For `toEqual`
 * against what the app got, and for props.
 */
export function createBuilders(state: ChainState) {
  return {
    /** The transaction `getTransaction` answers for `.returns(transaction)`; its hash is zero unless given. */
    buildTransaction: <const transaction extends MockTransaction = { type?: "eip1559" }>(
      transaction?: transaction,
    ): BuiltTransaction<transaction> =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- formatTransaction of the transaction's own type
      formatTransaction(
        encodeTransaction(state, transaction ?? {}, transaction?.hash ?? zeroHash),
      ) as BuiltTransaction<transaction>,
    /** The receipt `getTransactionReceipt` answers for `.returns(receipt)`; its hash is zero unless given. */
    buildReceipt: (receipt: MockReceipt = {}) =>
      completeReceipt(receipt, {
        hash: receipt.transactionHash ?? zeroHash,
        blockNumber: state.blockNumber,
      }),
    /** A finished log, in the current block unless given; see `buildLog`. */
    buildLog: <const abi extends Abi, eventName extends ContractEventName<abi>>(
      parameters: BuildLogParameters<abi, eventName>,
    ) => buildLog(parameters, state.blockNumber),
  };
}
