import { type Abi, type Address, getAddress } from "viem";

import { createActions } from "./actions/createActions.js";
import { createBuilders } from "./builders.js";
import type { MockFees } from "./chain/fees.js";
import { createChainState } from "./chain/state.js";
import { createMockContract } from "./contracts/createMockContract.js";
import { createDispatch } from "./contracts/dispatch.js";
import { createRegistry } from "./contracts/registry.js";
import type { CreateMockContractParameters, MockContract } from "./contracts/types.js";
import { type FormatContext, type FormatHistoryOptions, formatHistory } from "./history/format.js";
import { createRecordLimit } from "./history/historyLimit.js";
import { createRecorder } from "./history/recorder.js";
import type { EmittedLog } from "./logs/events.js";
import { describeLogsCall } from "./logs/filter.js";
import type { MockFault } from "./mocking/types.js";
import { createCheckpoints } from "./rpc/checkpoints.js";
import { createChecks } from "./rpc/checks.js";
import { type FailRequestsOptions, type MockFaultHandle, createFaults } from "./rpc/faults.js";
import { createRequestHandler } from "./rpc/requestHandler.js";
import { type TransactionRecord, createTransactionStore } from "./transactions/store.js";
import type { CreateMockRpcParameters, MockRpc } from "./types.js";
import { createViemAdapter } from "./viem/adapter.js";

/**
 * A mock JSON-RPC node: contracts, actions, and raw methods answer its
 * requests, in viem's types. See `MockRpc` for what it does.
 */
export function createMockRpc(parameters: CreateMockRpcParameters = {}): MockRpc {
  // Checked first, so a bad limit throws before anything is made.
  const recordLimit = createRecordLimit(parameters.historyLimit);
  const state = createChainState(parameters);
  const registry = createRegistry(state);
  const transactions = createTransactionStore({ state, registry });
  const faults = createFaults();

  const actions = createActions({ state, registry, transactions }, recordLimit);
  // History names a getLogs filter's events with the registered contracts' ABIs.
  const formatContext: FormatContext = {
    describeLogs: (call) =>
      describeLogsCall(
        call,
        registry.contracts.map(({ contract }) => contract),
      ),
  };
  const recorder = createRecorder({
    multicallAddress: state.multicallAddress,
    actionFor: actions.actionFor,
    debug: parameters.debug,
    formatContext,
    recordLimit,
  });
  const dispatcher = createDispatch({ state, registry });
  // Saved first, before anything is registered: reset() restores it.
  const checkpoints = createCheckpoints([
    state,
    registry,
    actions,
    transactions,
    faults,
    dispatcher,
    recorder,
  ]);

  const checks = createChecks({
    recorder,
    checkpoints,
    formatContext,
    historyOnFailure: parameters.historyOnFailure,
  });
  const handleRequest = createRequestHandler({ state, recorder, faults, actions, dispatcher });
  const builders = createBuilders(state);
  const viemAdapter = createViemAdapter({ handle: handleRequest, chain: state.chain });

  return {
    request: viemAdapter.request,
    transport: viemAdapter.transport,
    publicClient: viemAdapter.publicClient,
    contract<const abi extends Abi>(
      contractParameters: CreateMockContractParameters<abi>,
    ): MockContract<abi> {
      registry.assertUnregistered(contractParameters.address);
      const internal = createMockContract(contractParameters, {
        onCall: recorder.onCall,
        emit: transactions.emit,
        whileWriting: transactions.whileWriting,
        recordLimit,
      });
      registry.add(internal);
      return internal.contract;
    },
    actions: actions.actions,
    buildTransaction: builders.buildTransaction,
    buildReceipt: builders.buildReceipt,
    buildLog: builders.buildLog,
    emit: transactions.emit,
    get logs(): EmittedLog[] {
      return transactions.logs;
    },
    get transactions(): TransactionRecord[] {
      return transactions.transactions;
    },
    method: actions.method,
    failRequests(fault: MockFault, options: FailRequestsOptions = {}): MockFaultHandle {
      return faults.add(fault, options);
    },
    empty(address: Address) {
      registry.assertUnregistered(address);
      registry.markEmpty(getAddress(address));
    },
    get chain() {
      return state.chain;
    },
    get chainId() {
      return state.chainId;
    },
    get blockNumber() {
      return state.blockNumber;
    },
    mine(blocks = 1n) {
      transactions.mine(blocks);
    },
    setFees(fees: MockFees) {
      state.setFees(fees);
    },
    get calls() {
      return [...recorder.calls.kept];
    },
    get history() {
      return [...recorder.history.kept];
    },
    formatHistory(options?: FormatHistoryOptions) {
      return formatHistory(recorder.view, options, formatContext);
    },
    get requests() {
      return [...recorder.requests.kept];
    },
    get unhandled() {
      return [...recorder.unhandled.kept];
    },
    assertNoUnhandled: checks.assertNoUnhandled,
    assertAllUsed: checks.assertAllUsed,
    clearCalls: checkpoints.clearCalls,
    checkpoint: checks.checkpoint,
    reset() {
      checkpoints.reset();
    },
  };
}
