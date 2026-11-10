import { type Address, type Hash, type Hex, formatTransactionReceipt, numberToHex } from "viem";

import type { ContractTurn } from "../contracts/createMockContract.js";
import type { CallContext } from "../contracts/types.js";
import { impliedGas } from "../mocking/gas.js";
import type { RecordLimit } from "../shared/records.js";
import type { MockWriteOutcome } from "../transactions/writes.js";
import { isPlainTransfer, viewQuantity } from "./codec.js";
import { decodeEstimateGas, estimateGas } from "./estimateGas.js";
import { decodeSend, sendTransaction } from "./sendTransaction.js";
import {
  type ActionReport,
  type ActionsContext,
  type MockSetOptions,
  createMockSet,
  reportAnswer,
} from "./table.js";
import type { SendTransactionCall } from "./types.js";

/**
 * Sends and their estimates: `eth_estimateGas`, and `eth_sendTransaction`,
 * `eth_sendRawTransaction` and its Sync form. It holds
 * `mock.actions.estimateGas`'s and `mock.actions.sendTransaction`'s mocks,
 * and answers their requests: `answerEstimate` and `answerSend` are the
 * order of answers, read top to bottom.
 *
 * Each action is returned in a table's shape (see `createTable`), so its
 * mocks, calls and requests are handled as a table's are.
 */
export function createSends(
  context: ActionsContext,
  recordLimit: RecordLimit,
  options: MockSetOptions,
) {
  const { state, registry, transactions } = context;
  const estimateGasMocks = createMockSet(estimateGas, recordLimit, options);
  const sendTransactionMocks = createMockSet(sendTransaction(context), recordLimit, options);

  /**
   * The registered contract a transaction calls a function of, with the
   * call's data and its context at `blockNumber`: the contract takes a turn
   * at the transaction. `undefined` for a deploy, a transaction without
   * data, or one to any other address.
   */
  function contractCalled(
    { from, to, data, value }: { from?: Address; to?: Address | null; data?: Hex; value: bigint },
    blockNumber: bigint,
  ) {
    if (to === undefined || to === null || data === undefined || data === "0x") return undefined;
    const contract = registry.contractAt(to);
    const callContext: CallContext = { from, value, blockNumber, batch: undefined };
    return contract && { contract, data, context: callContext };
  }

  /**
   * The send mock that would answer `sent` now, found without answering it,
   * so nothing runs and nothing is recorded: a registered contract's `write`
   * mock first, as in its turn at the send, else a `sendTransaction` mock.
   */
  function sendMockFor(sent: SendTransactionCall) {
    const called = contractCalled(sent, state.blockNumber);
    const contractMock = called?.contract.writeMock(called.data, called.context);
    return contractMock ?? sendTransactionMocks.findMock(sent);
  }

  /**
   * Where to mock a send no mock answers, when its `to` says more than the
   * definition's hint: a deploy, Multicall3, or an `empty()` address.
   */
  function sendHint(to: Address | null): string | undefined {
    if (to === null)
      return "mock.actions.sendTransaction({ to: null }).returns(…), which deploys at getContractAddress({ from, nonce })";
    if (to === state.multicallAddress)
      return "mock.actions.sendTransaction({ to }).returns(…): Multicall3's batched writes aren't mocked, so send each call instead";
    if (registry.isEmpty(to))
      return `mock.actions.sendTransaction({ to }).returns(…): ${to} is marked empty(), with no code to run the data`;
    return undefined;
  }

  /**
   * Answers an `eth_estimateGas`. In order:
   * 1. the send mock that would answer the transaction's send, if it
   *    `.reverts()`: the estimate reverts as the send would, which counts as
   *    that mock's use. A resolver's `revert()` runs only at the send;
   * 2. a registered contract's `estimateGas` mocks, for its functions;
   * 3. `mock.actions.estimateGas` mocks;
   * 4. 21,000 gas for a plain transfer to an address without code, as a node
   *    estimates it, even with a send mock;
   * 5. the gas a send mock implies (see `impliedGas`), without running it or
   *    using it up;
   * 6. the miss: the contract's, if it had a turn, else the action's.
   */
  async function answerEstimate(
    _method: string,
    params: readonly unknown[],
    report: (report: ActionReport) => void,
  ): Promise<Hex> {
    const { call, sent } = decodeEstimateGas(params, state.resolveBlock);
    // An estimate waits a microtask before its call is recorded, as a table
    // does and as an `eth_sendTransaction` takes to decode: made at once,
    // they reach their mocks in the order made.
    await Promise.resolve();
    estimateGasMocks.calls.add(call);
    // Prepared before anything answers, the send mock's revert included, so
    // the call is recorded as the contract's however the estimate ends.
    const called = contractCalled(call, call.blockNumber);
    const turn = called?.contract.turn("estimateGas", called.data, called.context);
    return await reportAnswer({ call, turn, report, view: viewQuantity }, async () => {
      // Found once, for steps 1 and 5, so its predicates run once.
      const sendMock = sent && sendMockFor(sent);
      if (sendMock?.answer.kind === "revert") {
        sendMock.spend();
        throw sendMock.answer.error;
      }
      const answered = turn?.answer();
      if (answered) return await answered;
      const found = estimateGasMocks.match(call);
      if (found.handler) return await estimateGasMocks.answerWith(found.handler, call);
      if (isPlainTransfer(registry, call)) return numberToHex(21_000n);
      if (sendMock) return numberToHex(impliedGas);
      throw turn ? turn.miss() : estimateGasMocks.missError(call, found);
    });
  }

  /**
   * Answers a send. In order:
   * 1. a repeated raw send's answer: the same bytes are the same
   *    transaction, answered as the first without asking a mock again;
   * 2. a registered contract's `write` mocks, for its functions;
   * 3. `mock.actions.sendTransaction` mocks;
   * 4. a success for a plain transfer to an address without code, as on a
   *    node;
   * 5. the miss: the contract's, if it had a turn, else the action's.
   *
   * Steps 2 to 5 are `outcomeOf`. Their outcome is placed: the send is mined
   * in a new block as it's answered, so the Sync method never times out.
   */
  async function answerSend(
    method: string,
    params: readonly unknown[],
    report: (report: ActionReport) => void,
  ) {
    const { call, raw } = await decodeSend(method, params);
    sendTransactionMocks.calls.add(call);
    /**
     * The raw send's hash, if its transaction is mined. A record with its
     * hash that isn't mined (one added to a future block) isn't the send:
     * placing the send refuses the hash as taken.
     */
    const minedHash = () =>
      raw !== undefined && transactions.minedAt(raw.hash) !== undefined ? raw.hash : undefined;
    /**
     * The send's answer: its hash, or for the Sync method the chain's
     * receipt, not a receipt mock's (the app asked for none). A send is
     * mined as it's answered, so it has one.
     */
    const answerFor = (hash: Hash) => (raw?.sync === true ? transactions.receiptFor(hash)! : hash);

    const repeated = minedHash();
    // A repeated raw send gives no contract a turn. Otherwise the turn is
    // prepared before anything answers, so the call is recorded first.
    const called = repeated === undefined ? contractCalled(call, state.blockNumber) : undefined;
    const turn = called?.contract.turn("write", called.data, called.context);
    return await reportAnswer(
      {
        call,
        turn,
        report,
        view: (rpc) => (typeof rpc === "string" ? rpc : formatTransactionReceipt(rpc)),
      },
      async () => {
        if (repeated !== undefined) return answerFor(repeated);
        const outcome = await outcomeOf(call, turn);
        // The same bytes sent twice at once both get this far, each awaiting
        // its outcome before either is placed. Only one is placed, and the
        // second is answered as the first.
        const hash =
          minedHash() ?? transactions.placeSend({ hash: raw?.hash, sent: call, outcome }).hash;
        return answerFor(hash);
      },
    );
  }

  /**
   * A send's outcome, steps 2 to 5 of `answerSend`: what a registered
   * contract's `write` mock or a `sendTransaction` mock answers, or a plain
   * transfer's success. Throws the miss when nothing answers.
   */
  async function outcomeOf(
    call: SendTransactionCall,
    turn: ContractTurn<MockWriteOutcome> | undefined,
  ): Promise<MockWriteOutcome> {
    const answered = turn?.answer();
    if (answered) return await answered;
    const found = sendTransactionMocks.match(call);
    if (found.handler) return await sendTransactionMocks.answerWith(found.handler, call);
    if (isPlainTransfer(registry, call)) return {};
    throw turn ? turn.miss() : sendTransactionMocks.missError(call, found, sendHint(call.to));
  }

  return {
    estimateGas: { ...estimateGasMocks, answer: answerEstimate },
    sendTransaction: { ...sendTransactionMocks, answer: answerSend },
  };
}
