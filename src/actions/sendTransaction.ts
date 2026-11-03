import { type Hash, getContractAddress } from "viem";

import { decodeRawTransaction, sentType } from "../chain/transactions.js";
import { createRevertError } from "../contracts/answers.js";
import type { RevertSpec } from "../contracts/types.js";
import type { MockEventLog } from "../logs/events.js";
import { impliedGas } from "../mocking/gas.js";
import type { MockNodeFault, WithLimits } from "../mocking/types.js";
import { MockSetupError, invalidParams } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import {
  type MockWriteAnswers,
  type MockWriteOutcome,
  encodeWriteOutcome,
  revertedWith,
} from "../transactions/writeOutcome.js";
import {
  decodeTransactionRequest,
  isPlainTransfer,
  pinTransaction,
  withoutUndefined,
} from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";
import type { SendTransactionCall } from "./types.js";

/**
 * What a send's resolver gets: the call, and `fail`, which also takes a
 * node's refusal by name, e.g. `fail("insufficientFunds")`.
 */
export type SendTransactionContext = SendTransactionCall & {
  fail: (fault: MockNodeFault) => never;
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
  const fields = decodeTransactionRequest(tx);
  const { account, to, data, nonce, gas, gasPrice, maxFeePerGas, maxPriorityFeePerGas } = fields;
  if (account === undefined) throw invalidParams("expected a transaction with a sender (from)");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- undefined fields are left out
  return withoutUndefined({
    account,
    to: to ?? null,
    value: fields.value,
    data: data === "0x" ? undefined : data,
    nonce,
    gas,
    gasPrice,
    maxFeePerGas,
    maxPriorityFeePerGas,
    type: sentType(isPlainObject(tx) ? tx.type : undefined, fields),
  }) as SendTransactionCall;
}

/**
 * `eth_sendTransaction` and `eth_sendRawTransaction`: a send, answered with
 * its hash once its transaction is on the chain, mined in a new block (see
 * `commit`). Unmocked, a plain transfer to an address without code succeeds,
 * as on a node.
 */
export function sendTransaction({
  state,
  registry,
  transactions,
}: ActionsContext): Definition<SendTransactionCall, Hash, MockWriteOutcome> {
  // A raw send's hash is its bytes'; an `eth_sendTransaction`'s is made where it's mined.
  const rawHashes = new WeakMap<SendTransactionCall, Hash>();
  /**
   * A raw send's hash, if its transaction is already on the chain. The same
   * bytes sent twice at once both reach the mocks; only one is placed.
   */
  const sentBefore = (call: SendTransactionCall) => {
    const hash = rawHashes.get(call);
    return hash !== undefined && transactions.transactionFor(hash) !== undefined ? hash : undefined;
  };
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
      if (method !== "eth_sendRawTransaction") return decodeSendTransaction(params);
      const { hash, from, fields } = await decodeRawTransaction(params[0]);
      const call: SendTransactionCall = { account: from, ...fields };
      rawHashes.set(call, hash);
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
    encode(value, call) {
      const outcome = encodeWriteOutcome(value);
      if (call !== undefined && call.to !== null && outcome.contractAddress !== undefined)
        throw new MockSetupError("Only a deploy (to: null) has a contractAddress.");
      return outcome;
    },
    // Sending the same bytes again is the same transaction: answered with its
    // hash, without asking the mocks again.
    known: sentBefore,
    extendBuilder(builder) {
      Object.assign(builder, {
        emits(logs: readonly MockEventLog[]) {
          builder.returns({ logs });
        },
        reverts(spec?: RevertSpec) {
          builder.returns(revertedWith(createRevertError([], spec)));
        },
      });
    },
    // A plain transfer to an address without code runs nothing, so it succeeds.
    fallback: (call) => (isPlainTransfer(registry, call) ? {} : undefined),
    /**
     * Places the send's transaction on the chain, mined in a new block, and
     * answers its hash. The same bytes sent twice at once are one
     * transaction too: the second is answered with its hash. A nonce left
     * out is 0 for now (072), and gas left out is `impliedGas`.
     */
    commit(outcome, call) {
      const repeated = sentBefore(call);
      if (repeated !== undefined) return repeated;
      const hash = rawHashes.get(call);
      const { account, to, data, nonce = 0, gas = impliedGas, ...fees } = call;
      const { logs = [], ...receipt } = outcome;
      return transactions.add({
        origin: "write",
        hash,
        fields: { from: account, to, ...(data && { input: data }), nonce, gas, ...fees },
        receipt:
          to === null
            ? {
                contractAddress: getContractAddress({ from: account, nonce: BigInt(nonce) }),
                ...receipt,
              }
            : receipt,
        logs,
      }).hash;
    },
  };
}
