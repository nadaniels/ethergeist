import { type Address, type Hash, type Hex, formatTransactionReceipt, numberToHex } from "viem";

import type { ContractTurn } from "../contracts/createMockContract.js";
import type { CallContext } from "../contracts/types.js";
import { impliedGas } from "../mocking/gas.js";
import type { RecordLimit } from "../shared/records.js";
import type { MockWriteOutcome } from "../transactions/writes.js";
import { isPlainTransfer, viewQuantity } from "./codec.js";
import { decodeEstimateGas, estimateGas } from "./estimateGas.js";
import { type MockSetOptions, createMockSet } from "./mockSet.js";
import { decodeSend, sendTransaction } from "./sendTransaction.js";
import { type ActionReport, type ActionsContext, reportAnswer } from "./table.js";
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
   * The registered contract a transaction with data is sent to, with the
   * call's data and its context at `blockNumber`: the contract takes a turn
   * at the transaction (see `ContractTurn`). `undefined` for a deploy, a
   * transaction without data, or one to any other address.
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
   * The line that starts an action's miss on a transaction with data to a
   * registered contract (`called`): it isn't a call to one of the contract's
   * nonpayable or payable functions, which the contract would answer. None
   * for any other transaction.
   */
  const notAFunctionLines = (called: ReturnType<typeof contractCalled>) =>
    called === undefined
      ? []
      : [
          `${called.contract.label} is a registered contract, but this transaction isn't a call to one of its nonpayable or payable functions.`,
        ];

  /**
   * Answers an `eth_estimateGas`. An estimate of a registered contract's
   * nonpayable or payable function (see `ContractTurn`) is the contract's
   * to answer, in order:
   * 1. its `write` mock that would answer the send, if it `.reverts()`: the
   *    estimate reverts as the send would, which counts as that mock's use.
   *    A resolver's `revert()` runs only at the send;
   * 2. its `estimateGas` mocks and `defaults.estimateGas`;
   * 3. the gas its `write` mock implies (see `impliedGas`), without running
   *    it or using it up;
   * 4. the contract's miss, which names the `estimateGas` mocks that match
   *    the estimate and, for an estimate with a sender, the
   *    `sendTransaction` mocks that match its send, though they don't
   *    answer it.
   *
   * Any other estimate is the actions', in order:
   * 1. the `sendTransaction` mock that would answer the send, if it
   *    `.reverts()`, as in step 1 above;
   * 2. `mock.actions.estimateGas` mocks;
   * 3. 21,000 gas for a plain transfer to an address without code, as a node
   *    estimates it, even with a send mock;
   * 4. the gas a `sendTransaction` mock implies, as in step 3 above;
   * 5. the action's miss, which says when the estimate has data and is to
   *    a registered contract.
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
      const functionMocks = turn?.functionMocks;
      if (called && functionMocks) {
        // Found once, for steps 1 and 3, so its predicates run once.
        const writeMock = sent && called.contract.writeMock(called.data, called.context);
        if (writeMock?.answer.kind === "revert") {
          writeMock.spend();
          throw writeMock.answer.error;
        }
        const answered = functionMocks.answer();
        if (answered) return await answered;
        if (writeMock) return numberToHex(impliedGas);
        throw functionMocks.miss(
          matchingActionLines([
            ...estimateGasMocks.matchingLines(call),
            ...(sent === undefined ? [] : sendTransactionMocks.matchingLines(sent)),
          ]),
        );
      }
      // Found once, for steps 1 and 4, so its predicates run once.
      const sendMock = sent && sendTransactionMocks.findMock(sent);
      if (sendMock?.answer.kind === "revert") {
        sendMock.spend();
        throw sendMock.answer.error;
      }
      const found = estimateGasMocks.match(call);
      if (found.handler) return await estimateGasMocks.answerWith(found.handler, call);
      if (isPlainTransfer(registry, call)) return numberToHex(21_000n);
      if (sendMock) return numberToHex(impliedGas);
      throw estimateGasMocks.missError(call, found, { before: notAFunctionLines(called) });
    });
  }

  /**
   * Answers a send. In order:
   * 1. a repeated raw send's answer: the same bytes are the same
   *    transaction, answered as the first without asking a mock again;
   * 2. its outcome (see `outcomeOf`): the registered contract's, for a send
   *    of one of its nonpayable or payable functions, else the actions'.
   *
   * The outcome is placed: the send is mined in a new block as it's
   * answered, so the Sync method never times out.
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
        const outcome = await outcomeOf(call, called, turn);
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
   * A send's outcome, step 2 of `answerSend`. A send of a registered
   * contract's nonpayable or payable function is the contract's to answer:
   * its `write` mocks and `defaults.write`, else the contract's miss, which
   * names the `sendTransaction` mocks that match, though they don't answer
   * it. Any other send is the actions', in order:
   * 1. `mock.actions.sendTransaction` mocks;
   * 2. a success for a plain transfer to an address without code, as on a
   *    node;
   * 3. the action's miss, which says when the send has data and is to a
   *    registered contract.
   *
   * `called` is the registered contract the send is to, as `contractCalled`
   * gives it, and `turn` that contract's turn.
   */
  async function outcomeOf(
    call: SendTransactionCall,
    called: ReturnType<typeof contractCalled>,
    turn: ContractTurn<MockWriteOutcome> | undefined,
  ): Promise<MockWriteOutcome> {
    const functionMocks = turn?.functionMocks;
    if (functionMocks) {
      const answered = functionMocks.answer();
      if (answered) return await answered;
      throw functionMocks.miss(matchingActionLines(sendTransactionMocks.matchingLines(call)));
    }
    const found = sendTransactionMocks.match(call);
    if (found.handler) return await sendTransactionMocks.answerWith(found.handler, call);
    if (isPlainTransfer(registry, call)) return {};
    throw sendTransactionMocks.missError(call, found, {
      hint: sendHint(call.to),
      before: notAFunctionLines(called),
    });
  }

  return {
    estimateGas: { ...estimateGasMocks, answer: answerEstimate },
    sendTransaction: { ...sendTransactionMocks, answer: answerSend },
  };
}

/**
 * The lines that end a registered contract's miss: the action mocks that
 * match its transaction (`matching`, from a mock set's `matchingLines`),
 * which don't answer it. None when none match.
 */
function matchingActionLines(matching: readonly string[]): readonly string[] {
  if (matching.length === 0) return [];
  return [
    "Action mocks that match, which don't answer a registered contract's functions:",
    ...matching,
  ];
}
