import { type Hash, formatTransactionReceipt } from "viem";

import { transactionParam } from "../chain/params.js";
import type { toRpcReceipt } from "../chain/receipts.js";
import { decodeRawTransaction, sentType } from "../chain/transactions.js";
import { createRevertError } from "../contracts/answers.js";
import type { CallContext, RevertFn, RevertSpec } from "../contracts/types.js";
import type { MockLogContent } from "../logs/events.js";
import type { FoundMock } from "../mocking/handlers.js";
import type { MockNodeFault, SendErrorName, WithLimits } from "../mocking/types.js";
import { invalidParams } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import {
  type ImpliedEstimate,
  type MockWriteAnswers,
  type MockWriteOutcome,
  encodeWriteOutcome,
  extendWriteBuilder,
  impliedBy,
} from "../transactions/writeOutcome.js";
import { isPlainTransfer, pinTransaction, sendCall } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";
import type { ActionContext, SendTransactionCall } from "./types.js";

/**
 * What a `sendTransaction` resolver gets: the call's fields, `fail`, and
 * `emit` and `revert`, which answer the transaction as it's mined.
 */
export type SendTransactionContext = ActionContext<
  SendTransactionCall,
  MockNodeFault<SendErrorName>
> & {
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
 * answers.
 *
 * An answered send is mined in a new block, which its receipt,
 * transaction, block and logs answer from (see `mock.transactions`); a
 * reverted one is mined too. A send refused with `.fails()` or `fail()`,
 * or not answered, leaves the chain as it was. A mock without `.reverts()`
 * also answers the transaction's estimate when no estimate mock does,
 * without running it or using it up: 100,000 gas, or 21,000 for a plain
 * transfer to an address without code.
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
 * The registered contract at a send's `to`, with the send's data and its
 * call's context, when the send has data: the contract's `write` mocks
 * answer it first.
 */
function contractCall(
  { registry, state }: Pick<ActionsContext, "registry" | "state">,
  { from, to, data, value }: SendTransactionCall,
) {
  if (to === null || data === undefined) return undefined;
  const contract = registry.contractAt(to);
  const context: CallContext = { from, value, blockNumber: state.blockNumber, batch: undefined };
  return contract && { contract, data, context };
}

/**
 * The implied estimate of `sent`: what the send mock that would answer it
 * now implies (see `ImpliedEstimate`), found without answering it, so
 * nothing runs and nothing is recorded. A registered contract's `write` mock
 * comes first, as in its turn; `findMock` finds this action's own.
 */
export function impliedEstimate(
  chain: Pick<ActionsContext, "registry" | "state">,
  findMock: (call: SendTransactionCall) => FoundMock | undefined,
  sent: SendTransactionCall,
): ImpliedEstimate {
  const called = contractCall(chain, sent);
  const contractMock = called && called.contract.writeMock(called.data, called.context);
  return impliedBy(contractMock ?? findMock(sent));
}

/**
 * `eth_sendTransaction`, `eth_sendRawTransaction` and
 * `eth_sendRawTransactionSync`. A send is mined in a new block as it's
 * answered (see `commit`), so the Sync method never times out. It's
 * answered with its hash, or for the Sync method with the chain's receipt,
 * as `eth_getTransactionReceipt` answers it unmocked. Unmocked, a plain
 * transfer to an address without code succeeds, as on a node.
 */
export function sendTransaction({
  state,
  registry,
  transactions,
}: ActionsContext): Definition<
  SendTransactionCall,
  Hash | ReturnType<typeof toRpcReceipt>,
  MockWriteOutcome
> {
  /**
   * Each raw send's hash, from its bytes, and whether it's the Sync method.
   * An `eth_sendTransaction` has none: `add` makes its hash.
   */
  const rawSends = new WeakMap<SendTransactionCall, { hash: Hash; sync: boolean }>();
  /**
   * A raw send's hash, if its transaction is already mined. The same bytes
   * sent twice at once both reach the mocks; only one is placed. A record
   * with its hash that isn't mined (one added to a future block) isn't
   * the send: `add` refuses the hash as taken.
   */
  const sentBefore = (call: SendTransactionCall) => {
    const hash = rawSends.get(call)?.hash;
    return hash !== undefined && transactions.minedAt(hash) !== undefined ? hash : undefined;
  };
  /**
   * A send's answer: its hash, or for the Sync method the chain's receipt for
   * its record, not a receipt mock's (the app asked for none). A send is
   * mined as it's answered, so it has one.
   */
  const answerFor = (call: SendTransactionCall, hash: Hash) =>
    rawSends.get(call)?.sync === true ? transactions.receiptFor(hash)! : hash;
  return {
    name: "sendTransaction",
    hint: "mock.actions.sendTransaction({ to }).returns(…)",
    hintFor({ to }) {
      if (to === null)
        return "mock.actions.sendTransaction({ to: null }).returns(…), which deploys at getContractAddress({ from, nonce })";
      if (to === state.multicallAddress)
        return "mock.actions.sendTransaction({ to }).returns(…): Multicall3's batched writes aren't mocked, so send each call instead";
      if (registry.isEmpty(to))
        return `mock.actions.sendTransaction({ to }).returns(…): ${to} is marked empty(), with no code to run the data`;
      return undefined;
    },
    async decode(params, method) {
      if (method === "eth_sendTransaction") return decodeSendTransaction(params);
      // The Sync method's timeout is ignored: a send is mined as it's
      // answered, and a node waits its default for an invalid one (EIP-7966).
      const sync = method === "eth_sendRawTransactionSync";
      const { hash, from, fields } = await decodeRawTransaction(params[0]);
      const call: SendTransactionCall = { from, ...fields };
      rawSends.set(call, { hash, sync });
      return call;
    },
    pin: pinTransaction,
    pinnedCall: (pinned) =>
      isPlainObject(pinned) && typeof pinned.to === "string"
        ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- encode reads only `to`
          ({ to: pinned.to } as SendTransactionCall)
        : undefined,
    zero: {},
    encode: (value, call) => encodeWriteOutcome(value, call && call.to === null),
    // Sending the same bytes again is the same transaction: answered with its
    // hash (or receipt), without asking the mocks again.
    known(call) {
      const hash = sentBefore(call);
      return hash === undefined ? undefined : answerFor(call, hash);
    },
    extendBuilder(builder) {
      extendWriteBuilder(builder, {
        revertError: (spec?: RevertSpec) => createRevertError([], spec),
        whileSending: transactions.whileSending,
      });
    },
    contractTurn(call) {
      const called = contractCall({ registry, state }, call);
      return called && called.contract.write(called.data, called.context);
    },
    fallback: (call) => (isPlainTransfer(registry, call) ? {} : undefined),
    /**
     * Mines the send's transaction in a new block (`placeSend`) and answers
     * it (`answerFor`). The same bytes sent twice at once are one
     * transaction too: the second is answered as the first.
     */
    commit(outcome, call) {
      const repeated = sentBefore(call);
      if (repeated !== undefined) return answerFor(call, repeated);
      const hash = rawSends.get(call)?.hash;
      return answerFor(call, transactions.placeSend({ hash, sent: call, outcome }).hash);
    },
    view: (rpc) => (typeof rpc === "string" ? rpc : formatTransactionReceipt(rpc)),
  };
}
