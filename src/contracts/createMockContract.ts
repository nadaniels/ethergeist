import {
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
  decodeFunctionData,
  decodeFunctionResult,
  getAddress,
  slice,
  toFunctionSelector,
} from "viem";

import { fail, refuse } from "../mocking/faults.js";
import {
  type FoundMock,
  type Handler as MockHandler,
  createHandlers,
  foundMock,
} from "../mocking/handlers.js";
import { checkNoRunnerMatchers, firstMismatch, specificity } from "../mocking/matching.js";
import { failureOutcome, type MockOutcome } from "../mocking/outcomes.js";
import type { FaultContext, NodeErrorName, RefusalContext } from "../mocking/types.js";
import { MockNotFoundError, MockSetupError } from "../shared/errors.js";
import type { PartSnapshot } from "../shared/parts.js";
import { type RecordLimit, type RecordList, createRecordList } from "../shared/records.js";
import { createRevertError } from "./answers.js";
import { type Pins, pinCall } from "./callPins.js";
import { type AddTransaction, createContractApi } from "./createContractApi.js";
import { createFunctions } from "./functions.js";
import { formatContract, missError, mockName, unusedLine } from "./messages.js";
import { type AnswerIn, answersIn } from "./namespaces.js";
import type {
  MockCallRecord,
  CallContext,
  CallReading,
  CreateMockContractParameters,
  MockCall,
  MockContract,
  MockNamespace,
  RevertFn,
  RevertSpec,
  MockTaggedCall,
} from "./types.js";

/**
 * What every resolver gets: the types offer `refuse` only where a node can
 * refuse.
 */
type Context = MockCall & FaultContext & RefusalContext<NodeErrorName> & { revert?: RevertFn<Abi> };

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
 * Only the contract's mocks answer a call to one of its functions in the
 * turn's namespace, and only action mocks answer any other data sent to it.
 */
export type ContractTurn<answer = unknown> = {
  /** Still pending: history fills in its outcome. */
  record: MockCallRecord;
  /** A no-op for a call that doesn't decode. Only the answer calls it. */
  receive(): void;
  /**
   * The mocks of the function the call is to, which alone answer it.
   * `undefined` when the call is to none of the contract's functions in the
   * turn's namespace: a selector not on its ABI, data that doesn't decode,
   * or a view function.
   */
  functionMocks:
    | {
        /**
         * Answers with the best matching mock; `undefined` when none
         * matches.
         */
        answer(): Promise<answer> | undefined;
        /**
         * The error for the call when nothing answers it; built only then.
         * It ends with the `after` lines of the turn's caller.
         */
        miss(after: readonly string[]): MockNotFoundError;
      }
    | undefined;
  /** A revert is decoded against the contract's ABI, whatever raised it. */
  outcomeOf(ended: { outcome: MockOutcome } | { error: unknown }): MockOutcome;
};

/**
 * A mocked contract as the mock holds it: its public API, and the hooks that
 * `eth_call` dispatch, the actions, and the registry call.
 */
export type InternalMockContract<abi extends Abi = Abi> = {
  /** Its public API, as `mock.contract()` returns it. */
  contract: MockContract<abi>;
  /** The contract for messages: its name and address, or the address alone. */
  label: string;
  /**
   * Whether this contract is registered at `address`, which must be
   * checksummed.
   */
  matches(address: Address): boolean;
  /** Only the answer adds the call to the contract's calls. */
  callOf(data: Hex, context: CallContext): CallReading;
  /**
   * An estimate's turn answers gas, and a send's what the chain did.
   */
  turn<namespace extends "estimateGas" | "write">(
    namespace: namespace,
    data: Hex,
    context: CallContext,
  ): ContractTurn<AnswerIn<namespace>>;
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
  },
): InternalMockContract<abi> {
  const { onCall, addTransaction, recordLimit } = hooks;
  const { abi, name, defaults = {} } = parameters;
  const address = getAddress(parameters.address);
  const label = formatContract(address, name);
  const mocks = createHandlers<Context, ContractFunction>(mockName);
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
  function checkAttached() {
    if (detached)
      throw new MockSetupError(
        `The contract at ${label} was removed by restore() or reset(); register it again.`,
      );
  }
  /** What `.reverts(spec)` and a resolver's `revert(spec)` revert with. */
  const revertError = (spec?: RevertSpec) => createRevertError(abi, spec);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- createRevertError takes any RevertSpec, which the generic only narrows
  const revert = ((spec?: RevertSpec) => {
    throw revertError(spec);
  }) as RevertFn<Abi>;

  const functions = createFunctions(abi);
  const {
    reads,
    functionsIn,
    functionsBySelector,
    overloadsOf,
    notInNamespaceError,
    pinFunctionArgs,
  } = functions;

  /**
   * Registers a mock of `functionName` in `namespace`, pinning `args` and
   * `given`'s `from` and `value`, and returns its builder. `pinFunctionArgs`
   * finds the function and pins the args, and `pinCall` pins `from` and
   * `value`. Throws first if the contract was removed.
   */
  function registerMock(
    namespace: MockNamespace,
    functionName: string,
    args: readonly unknown[] | undefined,
    given?: unknown,
  ) {
    checkAttached();
    const { abiItem, args: pinned } = pinFunctionArgs(namespace, functionName, args);
    checkNoRunnerMatchers(given);
    const pins = pinCall(abiItem, given);
    return registerHandler(namespace, abiItem, { pinned, pins, isDefault: false });
  }

  /**
   * Registers a default on `abiItem`, one overload of a function in
   * `namespace`, and returns its builder. It pins nothing, and
   * `assertAllUsed()` never reports it. It runs only while the contract is
   * created, before it can be removed.
   */
  function registerDefault(namespace: MockNamespace, abiItem: AbiFunction) {
    return registerHandler(namespace, abiItem, {
      pinned: undefined,
      pins: undefined,
      isDefault: true,
    });
  }

  /**
   * Registers a handler for `abiItem` in `namespace`, pinning `pinned` args
   * and `pins`, ranked by both, and returns its builder. With neither, it
   * answers any call to `abiItem`.
   */
  function registerHandler(
    namespace: MockNamespace,
    abiItem: AbiFunction,
    {
      pinned,
      pins,
      isDefault,
    }: {
      pinned: readonly unknown[] | undefined;
      pins: Pins | undefined;
      isDefault: boolean;
    },
  ) {
    const handler = mocks.register(
      pinned,
      { namespace, abiItem, selector: toFunctionSelector(abiItem), pins },
      // Beside the pins, not nested: nested, an empty args list would count as
      // an exact value.
      { isDefault, ranked: specificity(pins === undefined ? pinned : [...(pinned ?? []), pins]) },
    );
    const answers = answersIn[namespace];
    const builder = mocks.createBuilder(
      handler,
      (value) => {
        answers.encode(abiItem, value);
        return value;
      },
      { revertError },
    );
    answers.extendBuilder?.(builder);
    return builder;
  }

  for (const namespace of ["read", "simulate", "estimateGas", "write"] as const)
    for (const [functionName, resolver] of Object.entries(defaults[namespace] ?? {})) {
      if (resolver === undefined) continue;
      const overloads = overloadsOf(namespace, functionName);
      if (overloads.length === 0) throw notInNamespaceError(namespace, functionName);
      for (const abiItem of overloads) registerDefault(namespace, abiItem).returns(resolver);
    }

  const contract = createContractApi({
    abi,
    address,
    name,
    functions,
    register: registerMock,
    calls: () => calls.kept,
    callsTo,
    addTransaction,
    checkAttached,
  });

  const pendingRecord = (
    namespace: MockNamespace | undefined,
    decoded: Pick<Decoded, "abiItem" | "call"> | undefined,
  ): MockCallRecord => ({
    address,
    name,
    namespace,
    abiItem: decoded?.abiItem,
    call: decoded?.call,
    outcome: { type: "pending" },
  });

  /** See `InternalMockContract.callOf`. */
  function callOf(data: Hex, context: CallContext): CallReading {
    const found = decode(data, context);
    const decoded: Decoded<"read" | "simulate"> | undefined = found && {
      ...found,
      namespace: reads.includes(found.abiItem) ? "read" : "simulate",
    };
    return {
      record: pendingRecord(decoded?.namespace, decoded),
      answer: (report) =>
        answerCall(data, decoded, (outcome) => {
          report(outcome, context.batch?.index);
        }),
    };
  }

  /** `report` hears the call's outcome, however it ends. */
  async function answerCall(
    data: Hex,
    decoded: Decoded<"read" | "simulate"> | undefined,
    report: (outcome: MockOutcome) => void,
  ): Promise<Hex> {
    try {
      if (decoded === undefined)
        throw new MockNotFoundError(
          `No function with selector ${slice(data, 0, 4)} on mocked contract ${label}.`,
        );
      const { namespace, abiItem, call } = decoded;
      receive(decoded);
      const { handler, missed, removed } = match(decoded);
      if (!handler)
        throw missError(
          call,
          namespace,
          label,
          { registered: candidates(decoded), missed, removed },
          // An eth_call reaches both: a view overload's miss names the
          // simulate mocks on a nonpayable overload of its name, and back.
          { overloads: otherOverloads(decoded, ["read", "simulate"]) },
        );
      const hex = await run(handler, call, namespace);
      const value = decodeFunctionResult({ abi: [abiItem], functionName: abiItem.name, data: hex });
      report({ type: "result", value });
      return hex;
    } catch (error) {
      report(failureOutcome(error, abi));
      throw error;
    }
  }

  /** See `InternalMockContract.turn`. */
  function turn<namespace extends "estimateGas" | "write">(
    namespace: namespace,
    data: Hex,
    context: CallContext,
  ): ContractTurn<AnswerIn<namespace>> {
    const decoded = decodeIn(namespace, data, context);
    const base = {
      record: pendingRecord(namespace, decoded),
      receive() {
        if (decoded) receive(decoded);
      },
      outcomeOf: (ended: { outcome: MockOutcome } | { error: unknown }) =>
        "error" in ended ? failureOutcome(ended.error, abi) : ended.outcome,
    };
    if (decoded === undefined || !functionsIn[namespace].includes(decoded.abiItem))
      return { ...base, functionMocks: undefined };
    const { call } = decoded;
    // Matched when the turn comes, once: an estimate that its send's
    // `.reverts()` mock reverts first runs none of these mocks' predicates.
    let matched: ReturnType<typeof match> | undefined;
    const matchOnce = () => (matched ??= match(decoded));
    const functionMocks = {
      answer() {
        const { handler } = matchOnce();
        return handler && run(handler, call, namespace);
      },
      miss(after: readonly string[]) {
        const { missed, removed } = matchOnce();
        const registered = { registered: candidates(decoded), missed, removed };
        if (namespace !== "estimateGas" || call.from === undefined)
          return missError(call, namespace, label, registered, {
            overloads: otherOverloads(decoded, [namespace]),
            after,
          });
        // The `write` mocks are matched again for the reasons they missed, so
        // their predicates run a second time.
        const writes = { ...decoded, namespace: "write" as const };
        const writesMatched = match(writes);
        return missError(call, namespace, label, registered, {
          writes: {
            registered: candidates(writes),
            missed: writesMatched.missed,
            removed: writesMatched.removed,
          },
          overloads: otherOverloads(decoded, [namespace, "write"]),
          after,
        });
      },
    };
    return { ...base, functionMocks };
  }

  /** See `InternalMockContract.writeMock`. */
  function writeMock(data: Hex, context: CallContext) {
    const decoded = decodeIn("write", data, context);
    return decoded && foundMock(match(decoded).handler);
  }

  /**
   * A call of `data` in `namespace`; `undefined` when none of the contract's
   * functions takes it.
   */
  function decodeIn(
    namespace: MockNamespace,
    data: Hex,
    context: CallContext,
  ): Decoded | undefined {
    const found = decode(data, context);
    return found && { ...found, namespace };
  }

  /**
   * A call to one of the contract's functions, decoded, and the namespace
   * it's answered in.
   */
  type Decoded<namespace extends MockNamespace = MockNamespace> = {
    namespace: namespace;
    selector: Hex;
    abiItem: AbiFunction;
    call: MockCall;
  };

  /**
   * Decodes a call to one of the contract's functions; `undefined` when none
   * has its selector, or its function can't decode it.
   */
  function decode(data: Hex, context: CallContext): Omit<Decoded, "namespace"> | undefined {
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
    return undefined;
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

  /** Whether `handler` is in the call's namespace, for its function. */
  const isFor = ({ namespace, selector }: Decoded, handler: Handler) =>
    handler.namespace === namespace && handler.selector === selector;

  /** The handlers in the call's namespace for its function. */
  const candidates = (decoded: Decoded) =>
    mocks.handlers.filter((handler) => isFor(decoded, handler));

  /**
   * The call's overload, and the handlers in `namespaces` for its function's
   * other overloads, which can't answer it, for its miss.
   */
  const otherOverloads = (
    { selector, abiItem }: Decoded,
    namespaces: readonly MockNamespace[],
  ) => ({
    called: abiItem,
    others: mocks.handlers.filter(
      (handler) =>
        namespaces.includes(handler.namespace) &&
        handler.abiItem.name === abiItem.name &&
        handler.selector !== selector,
    ),
  });

  /**
   * The handler that answers `decoded`, matched on its args, then its `from`
   * and `value` (see `findAnswering`), and what each candidate missed on.
   */
  function match(decoded: Decoded) {
    const { call } = decoded;
    return mocks.findAnswering(
      (handler) => isFor(decoded, handler),
      (handler, options) => {
        const arg = firstMismatch(handler.pinned, call.args, options);
        return arg === undefined ? firstMismatch(handler.pins, call, options) : arg;
      },
    );
  }

  /**
   * Answers `call` with `handler`, as its namespace answers: see `answersIn`.
   * `namespace` is the handler's, passed so the answer's type comes from the
   * call site.
   */
  function run<namespace extends MockNamespace>(
    handler: Handler,
    call: MockCall,
    namespace: namespace,
  ): Promise<AnswerIn<namespace>> {
    const answers = answersIn[namespace];
    const context: Context = { ...call, fail, refuse };
    if (answers.reverted === undefined) context.revert = revert;
    return mocks.answerWith(
      handler,
      context,
      (value) => answers.encode(handler.abiItem, value),
      answers.reverted,
    );
  }

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
    callOf,
    turn,
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
