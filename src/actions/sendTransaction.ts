import { type Hash, formatTransactionReceipt, getContractAddress } from "viem";

import { transactionParam } from "../chain/params.js";
import type { toRpcReceipt } from "../chain/receipts.js";
import { decodeRawTransaction, sentType } from "../chain/transactions.js";
import { createRevertError } from "../contracts/answers.js";
import type { CallContext, RevertFn, RevertSpec } from "../contracts/types.js";
import type { MockEventLog } from "../logs/events.js";
import { impliedGas } from "../mocking/gas.js";
import type { MockNodeFault, SendErrorName, WithLimits } from "../mocking/types.js";
import { invalidParams } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import {
  type MockWriteAnswers,
  type MockWriteOutcome,
  encodeWriteOutcome,
  extendWriteBuilder,
} from "../transactions/writeOutcome.js";
import { isPlainTransfer, pinTransaction, sendCall } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";
import type { ActionContext, SendTransactionCall } from "./types.js";

/**
 * What a send's resolver gets: the call; `fail`, which also takes a node's
 * refusal by name, e.g. `fail("insufficientFunds")`; and `emit` and
 * `revert`, which answer the transaction as it's mined. Without an ABI,
 * `revert` takes a reason, a panic code or raw data.
 */
export type SendTransactionContext = ActionContext<
  SendTransactionCall,
  MockNodeFault<SendErrorName>
> & {
  /**
   * Adds a log, or logs, to the transaction, placed when it's mined, as
   * `.emits()` does. Use it rather than `mock.addTransaction()` or
   * `contract.emit`, which would put a transaction of their own on the
   * chain, and are refused in this resolver up to its first `await` (after
   * it, they would still place that separate transaction).
   */
  emit: (logs: MockEventLog | readonly MockEventLog[]) => void;
  /**
   * Mine the transaction reverted, e.g. `revert("paused")`, dropping what
   * it emitted. A resolver runs only at the send, so the estimate doesn't
   * revert: see `.reverts()` for that.
   */
  revert: RevertFn<readonly []>;
};

/**
 * Like `MockActionBuilder`, for a send: it answers with what the chain did
 * (see `MockWriteAnswers`). Without an ABI, `.reverts()` takes a reason,
 * a panic code or raw data.
 */
export type MockSendTransactionBuilder = WithLimits<
  MockWriteAnswers<SendTransactionContext, RevertSpec<readonly []>>
>;

/** `MockAction` for `sendTransaction`. */
export type MockSendTransactionAction = {
  (params?: Partial<SendTransactionCall>): MockSendTransactionBuilder;
  /** Every send the mock has received, in order (the last `historyLimit`). */
  readonly calls: SendTransactionCall[];
};

/** `eth_sendTransaction` takes a transaction, with its sender. */
function decodeSendTransaction([tx]: readonly unknown[]): SendTransactionCall {
  const fields = transactionParam(tx);
  if (fields.from === undefined) throw invalidParams("expected a transaction with a sender (from)");
  return sendCall(fields, fields.from, sentType(tx, fields));
}

/**
 * `eth_sendTransaction`, `eth_sendRawTransaction` and
 * `eth_sendRawTransactionSync`: a send, answered with its hash once its
 * transaction is on the chain, mined in a new block (see `commit`), or with
 * its receipt for the Sync method, the chain's, as `eth_getTransactionReceipt`
 * answers it unmocked. Every send is mined as it's answered, so the Sync method never
 * times out. Unmocked, a plain transfer to an address without code
 * succeeds, as on a node.
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
   * The contract a send calls one of the functions of, if `to` is a
   * registered contract and it has data, with the call's context: its
   * `write` mocks answer it first.
   */
  const contractCall = ({ from, to, data, value }: SendTransactionCall) => {
    if (to === null || data === undefined) return undefined;
    const contract = registry.contractAt(to);
    const context: CallContext = {
      from,
      value,
      blockNumber: state.blockNumber,
      batch: undefined,
    };
    return contract && { contract, data, context };
  };
  // A raw send's hash is its bytes'; an `eth_sendTransaction`'s is made where it's mined.
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
   * A send's answer: its hash, or the Sync method's receipt, the chain's
   * for its record (not a receipt mock's: the app asked for none). A send
   * is mined as it's answered, so it has one; pending mode (077) adds the
   * wait and EIP-7966's timeout.
   */
  const answerFor = (call: SendTransactionCall, hash: Hash) =>
    // The hash is a mined record's: `sentBefore`'s, or one `add` just mined.
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
    // A pinned `to` settles whether a static outcome may have a contractAddress.
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
    // A registered contract's turn at a send of one of its functions.
    contractTurn(call) {
      const called = contractCall(call);
      return called && called.contract.write(called.data, called.context);
    },
    contractMock(call) {
      const called = contractCall(call);
      return called && called.contract.writeMock(called.data, called.context);
    },
    // A plain transfer to an address without code runs nothing, so it succeeds.
    fallback: (call) => (isPlainTransfer(registry, call) ? {} : undefined),
    /**
     * Places the send's transaction on the chain, mined in a new block, and
     * answers its hash (`answerFor`). The same bytes sent twice at once are
     * one transaction too: the second is answered as the first. A nonce left
     * out is the sender's next on the chain (`nonceOf`), as a wallet fills
     * it, not a `getTransactionCount` mock's; gas left out is `impliedGas`.
     */
    commit(outcome, call) {
      const repeated = sentBefore(call);
      if (repeated !== undefined) return answerFor(call, repeated);
      const hash = rawSends.get(call)?.hash;
      const {
        from,
        to,
        data,
        nonce = transactions.nonceOf(from, "pending"),
        gas = impliedGas,
        ...fees
      } = call;
      const { logs = [], ...receipt } = outcome;
      const placed = transactions.add({
        origin: "sent",
        hash,
        fields: { from, to, ...(data && { input: data }), nonce, gas, ...fees },
        receipt:
          to === null
            ? {
                contractAddress: getContractAddress({ from, nonce: BigInt(nonce) }),
                ...receipt,
              }
            : receipt,
        logs,
      });
      return answerFor(call, placed.hash);
    },
    // The Sync method's receipt as viem returns it.
    view: (rpc) => (typeof rpc === "string" ? rpc : formatTransactionReceipt(rpc)),
  };
}
