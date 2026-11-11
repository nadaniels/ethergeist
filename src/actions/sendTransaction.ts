import { type Hash, isAddress } from "viem";

import { transactionParam } from "../chain/params.js";
import { decodeRawTransaction, sentType } from "../chain/transactions.js";
import { createRevertError } from "../contracts/answers.js";
import type { RevertFn, RevertSpec } from "../contracts/types.js";
import type { MockLogContent } from "../logs/events.js";
import type { RefusalContext, SendErrorName, WithLimits } from "../mocking/types.js";
import { invalidParams } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import {
  type MockWriteAnswers,
  type MockWriteOutcome,
  encodeWriteOutcome,
  extendWriteBuilder,
  minedReverted,
} from "../transactions/writes.js";
import { pinTransaction, sendCall } from "./codec.js";
import type { MockDefinition } from "./mockSet.js";
import type { ActionContext, SendTransactionCall } from "./types.js";

/**
 * What a `sendTransaction` resolver gets: the call's fields, `fail`,
 * `refuse`, and `emit` and `revert`, which answer the transaction as it's
 * mined.
 */
export type SendTransactionContext = ActionContext<SendTransactionCall> &
  RefusalContext<SendErrorName> & {
    /**
     * Adds a log, or logs, to the transaction, placed when it's mined, as
     * `.emits()` does. `mock.addTransaction()` and `contract.emit` would
     * place a separate transaction: they're refused in this resolver up to its
     * first `await`, and after it they place one.
     */
    emit: (logs: MockLogContent | readonly MockLogContent[]) => void;
    /**
     * Mines the transaction reverted, e.g. `revert("paused")`, dropping what
     * it emitted. Without an ABI, it takes a reason, a panic code, raw data or
     * nothing: see `RevertSpec`. A resolver runs only at the send, so the
     * estimate doesn't revert: see `.reverts()` for that.
     */
    revert: RevertFn<readonly []>;
  };

/**
 * A send mock, as `mock.actions.sendTransaction()` returns it: it answers
 * with what the chain did, as `MockWriteAnswers` says, and `.once()` or
 * `.times()` limit it (see `WithLimits`). Without an ABI, `.reverts()`
 * takes a reason, a panic code, raw data or nothing.
 */
export type MockSendTransactionBuilder = WithLimits<
  MockWriteAnswers<SendTransactionContext, RevertSpec<readonly []>>
>;

/**
 * Like `MockAction`, for `sendTransaction`, with `MockSendTransactionBuilder`'s
 * answers. Its mocks answer sends of anything but a registered contract's
 * nonpayable and payable functions, which only the contract's `write`
 * mocks and `defaults.write` answer.
 *
 * An answered send is mined in a new block, which its receipt,
 * transaction, block and logs answer from (see `mock.transactions`); a
 * reverted one is mined too. Concurrent sends are mined in the order
 * they're answered, which isn't always the order they were sent. A send
 * failed or refused (`.fails()`, `.refuses()`, or `fail()` or `refuse()` in
 * a resolver), or not answered, leaves the chain as it was. A mock without
 * `.reverts()` also answers the transaction's estimate when no estimate
 * mock does, without running it or using it up: 100,000 gas, or 21,000 for
 * a plain transfer to an address without code.
 *
 * The Sync method answers with the chain's receipt, not a
 * `getTransactionReceipt` mock's; the send is mined at once, so its
 * timeout never passes. A raw send's sender is recovered from its
 * signature, and its hash is its bytes' `keccak256`: the same bytes again
 * answer the same hash or receipt, without a second transaction. An
 * `eth_sendTransaction` without a nonce takes the sender's next, counting
 * waiting transactions, as `getTransactionCount` at `"pending"` does; one
 * without gas is sent with 100,000 gas.
 */
export type MockSendTransactionAction = {
  (params?: Partial<SendTransactionCall>): MockSendTransactionBuilder;
  /**
   * Every call to this action the mock received, in order: the last
   * `historyLimit` of them.
   */
  readonly calls: SendTransactionCall[];
};

/**
 * The call an `eth_sendTransaction` asks for: a transaction with its
 * sender, refused as invalid params without one.
 */
function decodeSendTransaction([tx]: readonly unknown[]): SendTransactionCall {
  const fields = transactionParam(tx);
  if (fields.from === undefined) throw invalidParams("expected a transaction with a sender (from)");
  return sendCall(fields, fields.from, sentType(tx, fields));
}

/**
 * The call a send asks for, from `eth_sendTransaction`'s request or a raw
 * send's signed bytes. A raw send also has `raw`: its hash, from its bytes,
 * and whether it's the Sync method. An `eth_sendTransaction` has none:
 * placing it makes its hash.
 */
export async function decodeSend(
  method: string,
  params: readonly unknown[],
): Promise<{ call: SendTransactionCall; raw: { hash: Hash; sync: boolean } | undefined }> {
  if (method === "eth_sendTransaction")
    return { call: decodeSendTransaction(params), raw: undefined };
  // The Sync method's timeout is ignored: a send is mined as it's answered,
  // and a node waits its default for an invalid one (EIP-7966).
  const sync = method === "eth_sendRawTransactionSync";
  const { hash, from, fields } = await decodeRawTransaction(params[0]);
  return { call: { from, ...fields }, raw: { hash, sync } };
}

/**
 * `mock.actions.sendTransaction`'s mocks: they answer with what the chain
 * did with the send (see `MockWriteOutcome`), and a revert is mined
 * reverted.
 */
export const sendTransaction: MockDefinition<SendTransactionCall, MockWriteOutcome> = {
  name: "sendTransaction",
  hint: "mock.actions.sendTransaction({ to }).returns(…)",
  pin: pinTransaction,
  // `pin` has checksummed a string `to`: `isAddress` narrows its type.
  pinnedCall: (pinned) =>
    isPlainObject(pinned) &&
    (pinned.to === null || (typeof pinned.to === "string" && isAddress(pinned.to)))
      ? { to: pinned.to }
      : {},
  zero: {},
  encode: (value, { pinnedCall: { to } }) =>
    encodeWriteOutcome(value, to === undefined ? undefined : to === null),
  revertError: (spec?: RevertSpec) => createRevertError([], spec),
  reverted: minedReverted,
  extendBuilder: extendWriteBuilder,
};
