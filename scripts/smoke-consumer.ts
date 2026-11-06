/**
 * A consumer the smoke test compiles with `declaration: true` against the
 * built package, importing it by name instead of `../src/index.js`. Each
 * export lets TypeScript infer a type from the package's API and write it
 * out, so a type the package reaches but doesn't export fails to compile
 * here. Not run: only its declarations are emitted.
 */
import type { Abi, ContractEventName, ContractFunctionName } from "viem";
import { parseAbi } from "viem";

import {
  type ContractDefaults,
  type EventArgs,
  type MockActions,
  type MockContract,
  MockCheckError,
  MockError,
  MockInternalError,
  MockNotFoundError,
  MockResolverError,
  MockSetupError,
  contractEvents,
  createMockRpc,
  match,
  testAddress,
  testHash,
  testLog,
  zeroResult,
} from "../src/index.js";

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the type argument is the type under test
declare function typeOf<T>(): T;
type Resolver<T> = Extract<T, (...args: never) => unknown>;
type FirstParameter<T> = T extends (first: infer First, ...rest: never) => unknown ? First : never;
type ContextOf<Builder extends { returns: (...args: never) => unknown }> = FirstParameter<
  Resolver<Parameters<Builder["returns"]>[0]>
>;
type ReadName<a extends Abi> = ContractFunctionName<a, "view" | "pure">;
type WriteName<a extends Abi> = ContractFunctionName<a, "nonpayable" | "payable">;

const abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function pay(address) payable",
  "function info() view returns ((uint256 a, uint256 b) s)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "error Nope(uint256)",
]);

export const mock = createMockRpc();
export const contract = mock.contract({ abi, address: testAddress("contract") });
export const contractParameters = typeOf<Parameters<typeof mock.contract<typeof abi>>[0]>();
export const defaults = typeOf<NonNullable<ContractDefaults<typeof abi>["write"]>>();

export const read = contract.read.balanceOf([testAddress("holder")]);
export const readOnce = read.once();
export const readFunction = contract.read.balanceOf;
export const readCalls = contract.read.balanceOf.calls;
export const readAnswer = typeOf<Parameters<typeof read.returns>>();
export const readContext = typeOf<ContextOf<typeof read>>();
export const structAnswer = typeOf<Parameters<ReturnType<typeof contract.read.info>["returns"]>>();
export const simulate = contract.simulate.pay();
export const simulateContext = typeOf<ContextOf<typeof simulate>>();
export const simulateFault = typeOf<Parameters<typeof simulate.fails>[0]>();
export const estimate = contract.estimateGas.pay();
export const estimateContext = typeOf<ContextOf<typeof estimate>>();
export const write = contract.write.pay();
export const writeOnce = write.once();
export const writeCalls = contract.write.pay.calls;
export const writeAnswer = typeOf<Parameters<typeof write.returns>[0]>();
export const writeContext = typeOf<ContextOf<typeof write>>();
export const pins = typeOf<Parameters<typeof contract.write.pay>[1]>();
export const events = contract.events;
export const eventArgs = typeOf<Parameters<typeof contract.events.Transfer>>();
export const emit = contract.emit;
export const emitArgs = typeOf<Parameters<typeof contract.emit.Transfer>>();
export const contractCalls = contract.calls;
export const standaloneEvents = contractEvents({ abi, address: testAddress("contract") });

export const actions = mock.actions;
export const actionContexts = typeOf<{
  [name in keyof MockActions]: ContextOf<ReturnType<MockActions[name]>>;
}>();
export const logs = mock.actions.getLogs();
export const logsContext = typeOf<ContextOf<typeof logs>>();
export const send = mock.actions.sendTransaction();
export const sendContext = typeOf<ContextOf<typeof send>>();
export const sendCalls = mock.actions.sendTransaction.calls;
export const estimateGas = mock.actions.estimateGas();
export const estimateGasContext = typeOf<ContextOf<typeof estimateGas>>();
export const nonce = mock.actions.getTransactionCount();
export const nonceContext = typeOf<ContextOf<typeof nonce>>();
export const gasPrice = mock.actions.getGasPrice();
export const block = mock.actions.getBlock();
export const blockContext = typeOf<ContextOf<typeof block>>();
export const receiptAnswer =
  typeOf<Parameters<ReturnType<typeof mock.actions.getTransactionReceipt>["returns"]>[0]>();
export const transactionAnswer =
  typeOf<Parameters<ReturnType<typeof mock.actions.getTransaction>["returns"]>[0]>();
export const feeHistoryAnswer =
  typeOf<Parameters<ReturnType<typeof mock.actions.getFeeHistory>["returns"]>[0]>();
export const method = mock.method("custom_method");
export const methodContext = typeOf<ContextOf<typeof method>>();

export const history = mock.history;
export const historyOutcome =
  typeOf<Extract<(typeof mock.history)[number], { outcome: unknown }>["outcome"]>();
export const transactions = mock.transactions;
export const transactionFields = typeOf<(typeof mock.transactions)[number]["fields"]>();
export const emittedLogs = mock.logs;
export const calls = mock.calls;
export const unhandled = mock.unhandled;
export const checkpoint = mock.checkpoint();
export const restoreOptions = typeOf<Parameters<typeof checkpoint.restore>[0]>();
export const fault = mock.failRequests({ status: 500 });
export const builtLog = mock.buildLog(testLog("Transfer"));
export const builtReceipt = mock.buildReceipt();
export const builtTransaction = mock.buildTransaction({ type: "legacy" });
export const addTransaction = typeOf<typeof mock.addTransaction>();
export const addParameters = typeOf<Parameters<typeof mock.addTransaction>[0]>();
export const publicClient = typeOf<typeof mock.publicClient>();
export const transport = typeOf<typeof mock.transport>();
export const formatHistory = typeOf<typeof mock.formatHistory>();
export const request = typeOf<typeof mock.request>();

export const anything = match.any();
export const where = match.where((value: bigint) => value > 1n);
export const partial = typeOf<typeof match.partial>();
export const zero = zeroResult;
export const address = testAddress;
export const hash = testHash("transaction");
export const log = testLog("Transfer");
export const errors = [
  MockError,
  MockCheckError,
  MockSetupError,
  MockNotFoundError,
  MockResolverError,
  MockInternalError,
] as const;

export function mockRead<a extends Abi, name extends ReadName<a>>(
  target: MockContract<a>,
  functionName: name,
) {
  return target.read[functionName]();
}
export function readAnswerOf<a extends Abi, name extends ReadName<a>>(
  target: MockContract<a>,
  functionName: name,
) {
  const builder = target.read[functionName]();
  return typeOf<Parameters<typeof builder.returns>>();
}
export function readCallsOf<a extends Abi, name extends ReadName<a>>(
  target: MockContract<a>,
  functionName: name,
) {
  return target.read[functionName].calls;
}
export function mockSimulate<a extends Abi, name extends WriteName<a>>(
  target: MockContract<a>,
  functionName: name,
) {
  return target.simulate[functionName]();
}
export function mockWrite<a extends Abi, name extends WriteName<a>>(
  target: MockContract<a>,
  functionName: name,
) {
  return target.write[functionName]();
}
export function mockEstimate<a extends Abi, name extends WriteName<a>>(
  target: MockContract<a>,
  functionName: name,
) {
  return target.estimateGas[functionName]();
}
export function eventOf<a extends Abi, name extends ContractEventName<a>>(
  target: MockContract<a>,
  eventName: name,
) {
  return target.events[eventName];
}
export function emitOf<a extends Abi, name extends ContractEventName<a>>(
  target: MockContract<a>,
  eventName: name,
) {
  return target.emit[eventName];
}
export function eventLogOf<a extends Abi, name extends ContractEventName<a>>(
  target: MockContract<a>,
  eventName: name,
  args: EventArgs<a, name>,
) {
  return target.events[eventName](args);
}
export function eventsOf<a extends Abi>(contractAbi: a) {
  return contractEvents({ abi: contractAbi, address: testAddress("contract") });
}
export function readDefaultsOf<a extends Abi>(_abi: a) {
  return typeOf<NonNullable<ContractDefaults<a>["read"]>>();
}
