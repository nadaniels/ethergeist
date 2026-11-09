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

import { fail } from "../mocking/faults.js";
import {
  type FoundMock,
  type Handler as MockHandler,
  createHandlers,
  foundMock,
} from "../mocking/handlers.js";
import { checkNoRunnerMatchers, firstMismatch, specificity } from "../mocking/matching.js";
import { failureOutcome, type MockOutcome } from "../mocking/outcomes.js";
import { MockNotFoundError, MockSetupError } from "../shared/errors.js";
import type { PartSnapshot } from "../shared/parts.js";
import { type RecordLimit, type RecordList, createRecordList } from "../shared/records.js";
import {
  type MockWriteOutcome,
  encodeWriteOutcome,
  extendWriteBuilder,
  minedReverted,
} from "../transactions/writeOutcome.js";
import { encodeAnswer, createRevertError } from "./answers.js";
import { type AddTransaction, createContractApi } from "./createContractApi.js";
import { type Pins, createFunctions, firstPinMismatch, pinArgs, pinCall } from "./functions.js";
import { formatContract, missError, unusedLine } from "./messages.js";
import type {
  MockCallRecord,
  CallContext,
  CreateMockContractParameters,
  MockCall,
  MockContract,
  MockNamespace,
  ResolverContext,
  RevertFn,
  RevertSpec,
  MockTaggedCall,
} from "./types.js";

type Context = ResolverContext<Abi, readonly unknown[]>;

/**
 * What a contract's mock adds to the engine's: which function it's for, in
 * which namespace, and the `from` and `value` it pins beside its args.
 */
type ContractFunction = {
  namespace: MockNamespace;
  abiItem: AbiFunction;
  selector: Hex;
  pins: Pins | undefined;
};
type Handler = MockHandler<Context, ContractFunction>;

/**
 * A contract's turn at an action's call (an estimate or a send of one of its
 * functions), ahead of the action's own mocks, prepared when the call
 * arrives: the call is decoded and recorded then, and answered only if it
 * gets its turn.
 */
export type ContractTurn<answer = unknown> = {
  /** Answers with the best matching mock; `undefined` when none matches. */
  answer(): Promise<answer> | undefined;
  /**
   * The error for the call when nothing else answers it either; built only
   * then.
   */
  miss(): MockNotFoundError;
  /**
   * Records `error` as the contract's outcome, a revert decoded by its ABI,
   * when another answer comes before its turn (see `Definition.preempt`).
   */
  preempted(error: unknown): void;
  /**
   * The call, in its namespace, for history: its outcome is the contract's
   * when the call is preempted, its mock fails, or it answers with a `view`,
   * and otherwise the request's.
   */
  record: MockCallRecord;
};

/**
 * A mocked contract as the mock holds it: its public API, and the hooks that
 * `eth_call` dispatch, the actions and the registry call.
 */
export type InternalMockContract<abi extends Abi = Abi> = {
  /** Its public API, as `mock.contract()` returns it. */
  contract: MockContract<abi>;
  /** The contract for messages: its name and address, or just the address. */
  label: string;
  /**
   * Whether this contract is registered at `address`, which must be
   * checksummed.
   */
  matches(address: Address): boolean;
  /**
   * Answers an `eth_call` of `data`; `report` hears the decoded call and its
   * outcome, however it ends.
   */
  resolve(data: Hex, context: CallContext, report: (record: MockCallRecord) => void): Promise<Hex>;
  /**
   * Prepares the contract's turn at an estimate of `data`: see
   * `ContractTurn`.
   */
  estimate(data: Hex, context: CallContext): ContractTurn<Hex>;
  /**
   * Prepares the contract's turn at a send of `data`, answering what the
   * chain did.
   */
  write(data: Hex, context: CallContext): ContractTurn<MockWriteOutcome>;
  /**
   * The `write` mock that would answer a send of `data` now, if any, found
   * without answering or recording it: nothing runs, and no use is counted
   * until `spend` counts one.
   */
  writeMock(data: Hex, context: CallContext): FoundMock | undefined;
  /** Clears its calls, every function's, and its mocks' use counts. */
  clearCalls(): void;
  /**
   * Mocks other than defaults that haven't answered a call, formatted for
   * messages.
   */
  unusedMocks(): string[];
  /**
   * Saves the registered mocks and their answers, to put back or compare
   * against.
   */
  snapshot(): Required<PartSnapshot>;
  /**
   * Marks the contract removed: registering on it, or answering its mocks,
   * throws.
   */
  detach(): void;
};

/**
 * A mocked contract at `parameters.address`, with its `defaults` registered:
 * see `InternalMockContract`. Throws for a malformed address, or a default
 * that doesn't fit its namespace's functions.
 */
export function createMockContract<const abi extends Abi>(
  parameters: CreateMockContractParameters<abi>,
  hooks: {
    /**
     * Called with every decoded call, tagged, so `mock.calls` lists them
     * across contracts.
     */
    onCall: (call: MockTaggedCall) => void;
    /** Places a transaction: `mock.addTransaction()`. */
    addTransaction: AddTransaction;
    /** How many calls each list keeps: the contract's, and each function's. */
    recordLimit: RecordLimit;
    /**
     * Runs a `write` mock's resolver, refusing `mock.addTransaction()` in
     * it.
     */
    whileSending: <result>(run: () => result) => result;
  },
): InternalMockContract<abi> {
  const { onCall, addTransaction, recordLimit, whileSending } = hooks;
  const { abi, name, defaults = {} } = parameters;
  const address = getAddress(parameters.address);
  const label = formatContract(address, name);
  const mocks = createHandlers<Context, ContractFunction>();
  /**
   * Every namespace's calls, tagged, as `contract.calls` and `mock.calls`
   * hold them.
   */
  const calls = createRecordList<MockTaggedCall>(recordLimit);
  /**
   * Each function's calls in a list of its own, by namespace and selector,
   * so a busy function can't push a quiet one's out. Unused mocks find
   * theirs by selector; a function's `.calls` merges its overloads' in the
   * order received.
   */
  const callsBySelector = new Map<
    `${MockNamespace}:${Hex}`,
    { functionName: string; list: RecordList<MockCall> }
  >();
  /** Each call's place in the order received, for merging overloads' lists. */
  const order = new WeakMap<MockCall, number>();
  let received = 0;
  let detached = false;
  /** Throws if `restore()` or `reset()` removed this contract. */
  function assertAttached() {
    if (detached)
      throw new MockSetupError(
        `The contract at ${label} was removed by restore() or reset(); register it again.`,
      );
  }
  /** What `.reverts(spec)` and a resolver's `revert(spec)` revert with. */
  const revertError = (spec?: RevertSpec) => createRevertError(abi, spec);
  /** Handed to every resolver. */
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the generic only narrows what callers pass; createRevertError takes any RevertSpec
  const revert = ((spec?: RevertSpec) => {
    throw revertError(spec);
  }) as RevertFn<Abi>;

  const { functionsIn, functionsBySelector, notInNamespaceError, findFunction } =
    createFunctions(abi);

  /**
   * Registers a mock of `functionName` in `namespace`, pinning `args` and
   * `given`'s `from` and `value`, and returns its builder.
   */
  function register(
    namespace: MockNamespace,
    functionName: string,
    args: readonly unknown[] | undefined,
    given?: unknown,
    /**
     * For defaults: registered on a given overload, and exempt from
     * `assertAllUsed()`.
     */
    asDefault?: { abiItem: AbiFunction },
  ) {
    assertAttached();
    const abiItem = asDefault?.abiItem ?? findFunction(namespace, functionName, args);
    const isDefault = asDefault !== undefined;

    const pinned = pinArgs(abiItem, args);
    checkNoRunnerMatchers(given);
    const pins = pinCall(abiItem, given);
    const handler = mocks.register(
      pinned,
      { namespace, abiItem, selector: toFunctionSelector(abiItem), pins },
      // Pins count like args: `transfer([bob, 5n], { from })` beats
      // `transfer([bob, 5n])`.
      { isDefault, ranked: specificity(pins === undefined ? pinned : [pinned ?? [], pins]) },
    );
    const builder = mocks.createBuilder(
      handler,
      abiItem.name,
      (value) => {
        if (namespace === "write") encodeWriteOutcome(value, false);
        else encodeAnswer(handler, value);
        return value;
      },
      { revertError },
    );
    if (namespace === "write") extendWriteBuilder(builder, whileSending);
    return builder;
  }

  for (const namespace of ["read", "simulate", "estimateGas", "write"] as const)
    for (const [functionName, resolver] of Object.entries(defaults[namespace] ?? {})) {
      if (resolver === undefined) continue;
      const overloads = functionsIn[namespace].filter((abiItem) => abiItem.name === functionName);
      if (overloads.length === 0) throw notInNamespaceError(namespace, functionName);
      for (const abiItem of overloads)
        register(namespace, functionName, undefined, undefined, { abiItem }).returns(resolver);
    }

  const contract = createContractApi({
    abi,
    address,
    name,
    functions: { functionsIn, notInNamespaceError },
    register,
    calls: () => calls.kept,
    callsTo,
    addTransaction,
    assertAttached,
  });

  async function resolve(
    data: Hex,
    context: CallContext,
    report: (record: MockCallRecord) => void,
  ): Promise<Hex> {
    let decoded: Decoded | undefined;
    const record = (outcome: MockOutcome): MockCallRecord => ({
      address,
      name,
      namespace: decoded?.namespace,
      abiItem: decoded?.abiItem,
      call: decoded?.call,
      outcome,
    });
    try {
      const found = decode(data, context);
      if (found instanceof MockNotFoundError) throw found;
      const { selector, abiItem, call } = found;
      const namespace = functionsIn.read.includes(abiItem) ? "read" : "simulate";
      decoded = { namespace, selector, abiItem, call };
      receive(decoded);
      const { handler, missed } = match(decoded);
      if (!handler)
        throw missError(call, namespace, label, { registered: candidates(decoded), missed });
      const hex = await run(handler, call, encodeAnswer);
      const value = decodeFunctionResult({ abi: [abiItem], functionName: abiItem.name, data: hex });
      report(record({ type: "result", value }));
      return hex;
    } catch (error) {
      report(record(failureOutcome(error, abi)));
      throw error;
    }
  }

  /**
   * Prepares the contract's turn at an action's call of `data` in
   * `namespace`: see `ContractTurn`. `encode` checks a mock's answer, and
   * `view` makes it the record's value. Without `view`, the record takes the
   * request's answer, as a `write` record takes its send's hash.
   */
  function turn<answer>(
    namespace: "estimateGas" | "write",
    data: Hex,
    context: CallContext,
    encode: (handler: Handler, value: unknown) => answer,
    view?: (answered: answer) => unknown,
  ): ContractTurn<answer> {
    const record: MockCallRecord = {
      address,
      name,
      namespace,
      abiItem: undefined,
      call: undefined,
      outcome: { type: "pending" },
    };
    const decoded = decodeIn(namespace, data, context);
    if (decoded instanceof MockNotFoundError)
      return { answer: () => undefined, miss: () => decoded, preempted() {}, record };
    receive(decoded);
    const { abiItem, call } = decoded;
    record.abiItem = abiItem;
    record.call = call;
    // Matched when the turn comes, once: an estimate preempted first (see
    // `Definition.preempt`) runs none of these mocks' predicates.
    let matched: ReturnType<typeof match> | undefined;
    const matchOnce = () => (matched ??= match(decoded));
    return {
      answer() {
        const { handler } = matchOnce();
        if (!handler) return undefined;
        return run(handler, call, encode).then(
          (answered) => {
            if (view) record.outcome = { type: "result", value: view(answered) };
            return answered;
          },
          (error: unknown) => {
            record.outcome = failureOutcome(error, abi);
            throw error;
          },
        );
      },
      preempted(error) {
        record.outcome = failureOutcome(error, abi);
      },
      miss() {
        const registered = { registered: candidates(decoded), missed: matchOnce().missed };
        // Only an estimate with `from` is a send's, which `write` mocks imply.
        if (namespace !== "estimateGas" || call.from === undefined)
          return missError(call, namespace, label, registered);
        // The `write` mocks that would have implied the estimate, had one
        // matched: matched again for their reasons, so their predicates run a
        // second time.
        const writes = { ...decoded, namespace: "write" as const };
        const { missed: writesMissed } = match(writes);
        return missError(call, namespace, label, registered, {
          registered: candidates(writes),
          missed: writesMissed,
        });
      },
      record,
    };
  }

  /** See `InternalMockContract.writeMock`. */
  function writeMock(data: Hex, context: CallContext) {
    const decoded = decodeIn("write", data, context);
    return decoded instanceof MockNotFoundError ? undefined : foundMock(match(decoded).handler);
  }

  /**
   * A call of `data` in `namespace`, or why none of the contract's functions
   * takes it.
   */
  function decodeIn(
    namespace: MockNamespace,
    data: Hex,
    context: CallContext,
  ): Decoded | MockNotFoundError {
    const found = decode(data, context);
    return found instanceof MockNotFoundError ? found : { ...found, namespace };
  }

  /**
   * A call to one of the contract's functions, decoded, and the namespace
   * it's answered in.
   */
  type Decoded = { namespace: MockNamespace; selector: Hex; abiItem: AbiFunction; call: MockCall };

  /**
   * Decodes a call to one of the contract's functions, or says why it can't:
   * none has its selector, or its function can't decode it.
   */
  function decode(data: Hex, context: CallContext): Omit<Decoded, "namespace"> | MockNotFoundError {
    const selector = slice(data, 0, 4);
    const abiItem = functionsBySelector.get(selector);
    if (abiItem)
      try {
        const { args = [] } = decodeFunctionData<Abi>({ abi: [abiItem], data });
        return {
          selector,
          abiItem,
          call: { ...context, address, functionName: abiItem.name, args },
        };
      } catch {}
    return new MockNotFoundError(
      `No function with selector ${selector} on mocked contract ${label}.`,
    );
  }

  /**
   * Records a call: in its function's list, and tagged in the contract's and
   * `mock.calls`.
   */
  function receive({ namespace, selector, call }: Decoded) {
    received += 1;
    order.set(call, received);
    functionCalls(namespace, selector, call.functionName).add(call);
    const tagged = { namespace, ...call };
    calls.add(tagged);
    onCall(tagged);
  }

  /**
   * The list of calls in `namespace` to the function with `selector`, made on
   * its first.
   */
  function functionCalls(
    namespace: MockNamespace,
    selector: Hex,
    functionName: string,
  ): RecordList<MockCall> {
    const key = `${namespace}:${selector}` as const;
    const existing = callsBySelector.get(key);
    if (existing) return existing.list;
    const list = createRecordList<MockCall>(recordLimit);
    callsBySelector.set(key, { functionName, list });
    return list;
  }

  /**
   * The calls a namespace's function received, every overload's, in the
   * order received.
   */
  function callsTo(namespace: MockNamespace, functionName: string): MockCall[] {
    const lists = [...callsBySelector]
      .filter(
        ([key, each]) => key.startsWith(`${namespace}:`) && each.functionName === functionName,
      )
      .map(([, each]) => each.list.kept);
    if (lists.length === 1) return [...lists[0]!];
    return lists.flat().toSorted((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }

  /** The handlers in the call's namespace for its function. */
  const candidates = ({ namespace, selector }: Decoded) =>
    mocks.handlers.filter(
      (handler) => handler.namespace === namespace && handler.selector === selector,
    );

  /**
   * The handler that answers `decoded`, matched on its args, then its `from`
   * and `value` (see `findAnswering`), and what each candidate missed on.
   */
  function match(decoded: Decoded) {
    const { call } = decoded;
    return mocks.findAnswering(
      candidates(decoded),
      (handler, options) => {
        const arg = firstMismatch(handler.pinned, call.args, options);
        return arg === undefined ? firstPinMismatch(handler.pins, call, options) : arg;
      },
      call.functionName,
    );
  }

  /**
   * Answers `call` with `handler`, its answer checked by `encode`. A `write`
   * mock's revert is mined reverted.
   */
  const run = <answer>(
    handler: Handler,
    call: MockCall,
    encode: (handler: Handler, value: unknown) => answer,
  ): Promise<answer> =>
    mocks.answerWith(
      handler,
      { ...call, revert, fail },
      (value) => encode(handler, value),
      call.functionName,
      handler.namespace === "write" ? minedReverted : undefined,
    );

  /**
   * Unused mocks, each with its contract and the calls its function received
   * instead.
   */
  const describeUnused = (list: Handler[]) =>
    list.map((handler) => {
      const functionList = callsBySelector.get(`${handler.namespace}:${handler.selector}`)?.list;
      return unusedLine(handler, label, functionList?.kept ?? [], functionList?.total ?? 0);
    });

  return {
    contract,
    label,
    matches: (other) => other === address,
    resolve,
    estimate: (data, context) =>
      turn("estimateGas", data, context, encodeAnswer, (hex) => hexToBigInt(hex)),
    write: (data, context) =>
      turn("write", data, context, (_, value) => encodeWriteOutcome(value, false)),
    writeMock,
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
