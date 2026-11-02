import {
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
  decodeFunctionData,
  decodeFunctionResult,
  getAddress,
  hexToBigInt,
  slice,
  toFunctionSelector,
} from "viem";

import { type EmitOptions, type MockEventLog } from "../logs/events.js";
import { fail } from "../mocking/faults.js";
import { type Handler as MockHandler, createHandlers } from "../mocking/handlers.js";
import { failureOutcome, type MockOutcome } from "../mocking/outcomes.js";
import { MockNotFoundError, MockSetupError } from "../shared/errors.js";
import type { PartSnapshot } from "../shared/parts.js";
import {
  type RecordLimit,
  type RecordList,
  createRecordList,
  unlimited,
} from "../shared/records.js";
import { encodeAnswer, createRevertError } from "./answers.js";
import { createContractApi } from "./createContractApi.js";
import { type Namespace, createFunctions, type Kind, pinArgs } from "./functions.js";
import { formatContract, missError, unusedLine } from "./messages.js";
import type {
  MockCallRecord,
  CallContext,
  CreateMockContractParameters,
  MockCall,
  MockContract,
  ResolverContext,
  RevertFn,
  RevertSpec,
} from "./types.js";

type Context = ResolverContext<Abi, readonly unknown[]>;
/** What a contract's mock adds to the engine's: which function it's for, and in which namespace. */
type ContractFunction = { namespace: Namespace; abiItem: AbiFunction; selector: Hex };
type Handler = MockHandler<Context, ContractFunction>;

/**
 * An estimate's turn at a contract, prepared when the estimate arrives: the
 * call is decoded and recorded then, and answered only if it gets its turn.
 */
export type ContractEstimate = {
  /** Answers with the best matching mock; `undefined` when none matches. */
  answer(): Promise<Hex> | undefined;
  /** The error for the estimate when nothing else answers it either; built only then. */
  miss(): MockNotFoundError;
  /** The estimated call, for history; its outcome is the contract's, once it answers. */
  record: MockCallRecord;
};

/** Internal: the public contract API plus the hooks the rpc calls. */
export type InternalMockContract<abi extends Abi = Abi> = {
  contract: MockContract<abi>;
  /** The contract for messages: its name and address, or just the address. */
  label: string;
  /** Whether this contract is registered at `address`, which must be checksummed. */
  matches(address: Address): boolean;
  /** Answers a call; `report` hears the decoded call and its outcome, however it ends. */
  resolve(data: Hex, context: CallContext, report?: (record: MockCallRecord) => void): Promise<Hex>;
  /** Prepares an estimate of `data`: see `ContractEstimate`. */
  estimate(data: Hex, context: CallContext): ContractEstimate;
  clearCalls(): void;
  /** Mocks other than defaults that haven't answered a call, formatted for messages. */
  unusedMocks(): string[];
  /** Saves the registered mocks and their answers, to put back or compare against. */
  snapshot(): Required<PartSnapshot>;
  /** Marks the contract removed: registering on it, or answering its mocks, throws. */
  detach(): void;
};

export function createMockContract<const abi extends Abi>(
  parameters: CreateMockContractParameters<abi>,
  hooks: {
    /** Called with every decoded call, so the rpc can keep a log across contracts. */
    onCall?: (call: MockCall) => void;
    /** Places a transaction's logs in the rpc's log store. */
    emit?: (logs: readonly MockEventLog[], options?: EmitOptions) => readonly unknown[];
    /** How many calls each list keeps: the contract's, and each function's. */
    recordLimit?: RecordLimit;
  } = {},
): InternalMockContract<abi> {
  const { onCall = () => {}, emit = () => [], recordLimit = unlimited } = hooks;
  const { abi, name, defaults = {} } = parameters;
  // Also validates the address at registration.
  const address = getAddress(parameters.address);
  const label = formatContract(address, name);
  const mocks = createHandlers<Context, ContractFunction>();
  // Estimates aren't calls: `calls` and `mock.calls` are what `eth_call` asked.
  const calls = createRecordList<MockCall>(recordLimit);
  // Each function's calls in a list of its own, by kind and selector, so a
  // busy function can't push a quiet one's out. Unused mocks find theirs by
  // selector; a function's `.calls` merges its overloads' in the order received.
  const callsBySelector = new Map<
    `${Kind}:${Hex}`,
    { functionName: string; list: RecordList<MockCall> }
  >();
  const order = new WeakMap<MockCall, number>();
  let received = 0;
  const selectorOf = new WeakMap<MockCall, Hex>();
  let detached = false;
  /** Throws if `restore()` or `reset()` removed this contract. */
  function assertAttached() {
    if (detached)
      throw new MockSetupError(
        `The contract at ${label} was removed by restore() or reset(); register it again.`,
      );
  }
  // Handed to every resolver. RevertFn's generic signature only narrows what
  // callers may pass; createRevertError accepts every RevertSpec.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- generic signature, non-generic implementation
  const revert = ((spec?: RevertSpec) => {
    throw createRevertError(abi, spec);
  }) as RevertFn<Abi>;

  const { functionsIn, functionsBySelector, notInNamespaceError, findFunction } =
    createFunctions(abi);

  function register(
    namespace: Namespace,
    functionName: string,
    args: readonly unknown[] | undefined,
    /** For defaults: registered on a given overload, and exempt from `assertAllUsed()`. */
    asDefault?: { abiItem: AbiFunction },
  ) {
    assertAttached();
    const abiItem = asDefault?.abiItem ?? findFunction(namespace, functionName, args);
    const isDefault = asDefault !== undefined;

    const pinned = pinArgs(abiItem, args);
    const handler = mocks.register(
      pinned,
      { namespace, abiItem, selector: toFunctionSelector(abiItem) },
      { isDefault },
    );
    const builder = mocks.createBuilder(handler, (value) => {
      encodeAnswer(handler, value);
    });
    return Object.assign(builder, {
      reverts(spec?: RevertSpec) {
        builder.returns(() => revert(spec));
      },
    });
  }

  // A default is keyed by name, so it answers every overload of that name.
  for (const namespace of ["read", "simulate", "estimateGas"] as const)
    for (const [functionName, resolver] of Object.entries(defaults[namespace] ?? {})) {
      const overloads = functionsIn[namespace].filter((abiItem) => abiItem.name === functionName);
      if (overloads.length === 0) throw notInNamespaceError(namespace, functionName);
      for (const abiItem of overloads)
        register(namespace, functionName, undefined, { abiItem }).returns(resolver);
    }

  const contract = createContractApi({
    abi,
    address,
    name,
    functions: { functionsIn, notInNamespaceError },
    register,
    calls: () => calls.kept,
    callsTo,
    emit,
    assertAttached,
  });

  async function resolve(
    data: Hex,
    context: CallContext,
    report?: (record: MockCallRecord) => void,
  ): Promise<Hex> {
    const decoded: Decoded = { abiItem: undefined, call: undefined };
    const record = (outcome: MockOutcome): MockCallRecord => ({
      address,
      name,
      abiItem: decoded.abiItem,
      call: decoded.call,
      outcome,
    });
    try {
      const { hex, abiItem } = await answer(data, context, decoded);
      const value = decodeFunctionResult({ abi: [abiItem], functionName: abiItem.name, data: hex });
      report?.(record({ type: "result", value }));
      return hex;
    } catch (error) {
      report?.(record(failureOutcome(error, abi)));
      throw error;
    }
  }

  function estimate(data: Hex, context: CallContext): ContractEstimate {
    const record: MockCallRecord = {
      address,
      name,
      abiItem: undefined,
      call: undefined,
      outcome: { type: "pending" },
    };
    let call: MockCall;
    try {
      call = decode(data, context, "estimate");
    } catch (error) {
      if (!(error instanceof MockNotFoundError)) throw error;
      return { answer: () => undefined, miss: () => error, record };
    }
    record.call = call;
    record.abiItem = functionsBySelector.get(slice(data, 0, 4));
    const { handler, missed } = match(call, "estimate");
    return {
      answer() {
        if (!handler) return undefined;
        return run(handler, call).then(
          (hex) => {
            record.outcome = { type: "result", value: hexToBigInt(hex) };
            return hex;
          },
          (error: unknown) => {
            record.outcome = failureOutcome(error, abi);
            throw error;
          },
        );
      },
      miss: () => missError(call, "estimate", label, candidates(call, "estimate"), missed),
      record,
    };
  }

  /** What a call decoded to, for reporting however it ends. */
  type Decoded = { abiItem: AbiFunction | undefined; call: MockCall | undefined };

  /** Decodes and answers a call, leaving what it decoded in `decoded` for reporting. */
  async function answer(
    data: Hex,
    context: CallContext,
    decoded: Decoded,
  ): Promise<{ hex: Hex; abiItem: AbiFunction }> {
    const call = decode(data, context, "call");
    decoded.call = call;
    decoded.abiItem = functionsBySelector.get(slice(data, 0, 4));
    const { handler, missed } = match(call, "call");
    if (!handler) throw missError(call, "call", label, candidates(call, "call"), missed);
    return { hex: await run(handler, call), abiItem: handler.abiItem };
  }

  /** Decodes a call and records it as `kind`: an `eth_call` or an estimate. */
  function decode(data: Hex, context: CallContext, kind: Kind): MockCall {
    const selector = slice(data, 0, 4);
    let fn: { functionName: string; args: readonly unknown[] };
    try {
      const result = decodeFunctionData<Abi>({ abi, data });
      fn = { functionName: result.functionName, args: result.args ?? [] };
    } catch {
      throw new MockNotFoundError(
        `No function with selector ${selector} on mocked contract ${label}.`,
      );
    }

    const call: MockCall = { ...context, address, ...fn };
    selectorOf.set(call, selector);
    received += 1;
    order.set(call, received);
    functionCalls(kind, selector, fn.functionName).add(call);
    if (kind === "call") {
      calls.add(call);
      onCall(call);
    }
    return call;
  }

  /** The calls of `kind` to the function with `selector`, made on its first. */
  function functionCalls(kind: Kind, selector: Hex, functionName: string): RecordList<MockCall> {
    const key = `${kind}:${selector}` as const;
    const existing = callsBySelector.get(key);
    if (existing) return existing.list;
    const list = createRecordList<MockCall>(recordLimit);
    callsBySelector.set(key, { functionName, list });
    return list;
  }

  /** The calls a namespace's function received, every overload's, in the order received. */
  function callsTo(namespace: Namespace, functionName: string): MockCall[] {
    const kind: Kind = namespace === "estimateGas" ? "estimate" : "call";
    const lists = [...callsBySelector]
      .filter(([key, each]) => key.startsWith(`${kind}:`) && each.functionName === functionName)
      .map(([, each]) => each.list.kept);
    if (lists.length === 1) return [...lists[0]!];
    return lists.flat().toSorted((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }

  /** The handlers that answer `kind` for the function `call` decoded to. */
  const candidates = (call: MockCall, kind: Kind) =>
    mocks.handlers.filter(
      (handler) =>
        handler.selector === selectorOf.get(call) &&
        (handler.namespace === "estimateGas") === (kind === "estimate"),
    );

  // The most specific matching handler wins; among equally specific ones,
  // the most recently registered wins, so per-test mocks override defaults.
  function match(call: MockCall, kind: Kind) {
    return mocks.findAnswering(candidates(call, kind), () => call.args, call.functionName);
  }

  /** Answers `call` with `handler`. */
  const run = (handler: Handler, call: MockCall): Promise<Hex> =>
    mocks.answerWith(
      handler,
      { ...call, revert, fail },
      (value) => encodeAnswer(handler, value),
      call.functionName,
    );

  /** Unused mocks, each with its contract and the calls its function received instead. */
  const describeUnused = (list: Handler[]) =>
    list.map((handler) => {
      const kind: Kind = handler.namespace === "estimateGas" ? "estimate" : "call";
      const functionList = callsBySelector.get(`${kind}:${handler.selector}`)?.list;
      return unusedLine(handler, label, functionList?.kept ?? [], functionList?.total ?? 0);
    });

  return {
    contract,
    label,
    matches: (other) => other === address,
    resolve,
    estimate,
    clearCalls() {
      calls.clear();
      callsBySelector.clear();
      received = 0;
      mocks.clearUsage();
    },
    unusedMocks: () => describeUnused(mocks.unused(mocks.handlers)),
    snapshot: () => mocks.snapshot(describeUnused),
    detach() {
      detached = true;
      mocks.removeAll();
    },
  };
}
