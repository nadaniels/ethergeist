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
import { createRecorder } from "./history/recorder.js";
import type { EmittedLog } from "./logs/events.js";
import { createLogStore } from "./logs/store.js";
import type { MockFault } from "./mocking/types.js";
import { createCheckpoints } from "./rpc/checkpoints.js";
import { createChecks } from "./rpc/checks.js";
import { type FailRequestsOptions, type MockFaultHandle, createFaults } from "./rpc/faults.js";
import { createRequestHandler } from "./rpc/requestHandler.js";
import type { CreateMockRpcParameters, MockRpc } from "./types.js";
import { createViemAdapter } from "./viem/adapter.js";

/**
 * A mock JSON-RPC node: contracts, actions, and raw methods answer its
 * requests, in viem's types. See `MockRpc` for what it does.
 */
export function createMockRpc(parameters: CreateMockRpcParameters = {}): MockRpc {
  const state = createChainState(parameters);
  const registry = createRegistry(state);
  const logStore = createLogStore({ state, registry });
  const faults = createFaults();

  const actions = createActions({ state, registry, logStore });
  // History names a getLogs filter's events with the registered contracts' ABIs.
  const formatContext: FormatContext = {
    describeLogs: (call) =>
      logStore.describe(
        call,
        registry.contracts.map(({ contract }) => contract),
      ),
  };
  const recorder = createRecorder({
    multicallAddress: state.multicallAddress,
    actionFor: actions.actionFor,
    debug: parameters.debug,
    formatContext,
  });
  const dispatcher = createDispatch({ state, registry });
  // Saved first, before anything is registered: reset() restores it.
  const checkpoints = createCheckpoints([
    state,
    registry,
    actions,
    logStore,
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
  const handler = createRequestHandler({ state, recorder, faults, actions, dispatcher });
  const builders = createBuilders(state);
  const viem = createViemAdapter({ handle: handler.handle, chain: state.chain });

  return {
    request: viem.request,
    transport: viem.transport,
    publicClient: viem.publicClient,
    contract<const abi extends Abi>(
      contractParameters: CreateMockContractParameters<abi>,
    ): MockContract<abi> {
      registry.assertUnregistered(contractParameters.address);
      const internal = createMockContract(contractParameters, {
        onCall: recorder.onCall,
        emit: logStore.emit,
      });
      registry.add(internal);
      return internal.contract;
    },
    actions: actions.actions,
    buildTransaction: builders.buildTransaction,
    buildReceipt: builders.buildReceipt,
    buildLog: builders.buildLog,
    emit: logStore.emit,
    get logs(): EmittedLog[] {
      return logStore.logs;
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
      state.mine(blocks);
    },
    setFees(fees: MockFees) {
      state.setFees(fees);
    },
    get calls() {
      return [...recorder.calls];
    },
    get history() {
      return [...recorder.history];
    },
    formatHistory(options?: FormatHistoryOptions) {
      return formatHistory(recorder.history, options, formatContext);
    },
    get requests() {
      return [...recorder.requests];
    },
    get unhandled() {
      return [...recorder.unhandled];
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
