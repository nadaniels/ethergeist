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
import { createRevertError } from "./answers.js";
import { type AddTransaction, createContractApi } from "./createContractApi.js";
import { type Pins, createFunctions, firstPinMismatch, pinArgs, pinCall } from "./functions.js";
import { formatContract, missError, unusedLine } from "./messages.js";
import { type AnswerIn, answersIn } from "./namespaces.js";
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
 * A contract's turn at an estimate or a send to it with data, prepared when
 * the call arrives: a call that decodes is added to the contract's calls
 * then. Only the contract's mocks answer a call to one of its functions in
 * the turn's namespace, and only action mocks answer any other data sent to
 * it.
 */
export type ContractTurn<answer = unknown> = {
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
  /**
   * The call's record in its namespace, for history, with how its request
   * ended: `ended` is the request's outcome, or what it threw. A revert is
   * decoded against the contract's ABI, whichever mock raised it.
   */
  record(ended: { outcome: MockOutcome } | { error: unknown }): MockCallRecord;
};

/**
 * A mocked contract as the mock holds it: its public API, and the hooks that
 * `eth_call` dispatch, the actions and the registry call.
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
  /**
   * Answers an `eth_call` of `data`; `report` hears the decoded call and its
   * outcome, however it ends.
   */
  resolve(data: Hex, context: CallContext, report: (record: MockCallRecord) => void): Promise<Hex>;
  /**
   * Prepares the contract's turn at an estimate of `data`, in
   * `"estimateGas"`, or at a send of it, in `"write"`: see `ContractTurn`.
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
  function checkAttached() {
    if (detached)
      throw new MockSetupError(
        `The contract at ${label} was removed by restore() or reset(); register it again.`,
      );
  }
  /** What `.reverts(spec)` and a resolver's `revert(spec)` revert with. */
  const revertError = (spec?: RevertSpec) => createRevertError(abi, spec);
  /** Handed to every resolver. */
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- createRevertError takes any RevertSpec, which the generic only narrows
  const revert = ((spec?: RevertSpec) => {
    throw revertError(spec);
  }) as RevertFn<Abi>;

  const functions = createFunctions(abi);
  const { reads, functionsIn, functionsBySelector, notInNamespaceError, findFunction } = functions;

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
    checkAttached();
    const abiItem = asDefault?.abiItem ?? findFunction(namespace, functionName, args);
    const isDefault = asDefault !== undefined;

    const pinned = pinArgs(abiItem, args);
    checkNoRunnerMatchers(given);
    const pins = pinCall(abiItem, given);
    const handler = mocks.register(
      pinned,
      { namespace, abiItem, selector: toFunctionSelector(abiItem), pins },
      { isDefault, ranked: specificity(pins === undefined ? pinned : [pinned ?? [], pins]) },
    );
    const answers = answersIn[namespace];
    const builder = mocks.createBuilder(
      handler,
      abiItem.name,
      (value) => {
        answers.encode(abiItem, value);
        return value;
      },
      { revertError },
    );
    answers.extendBuilder?.(builder, whileSending);
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
    functions,
    register,
    calls: () => calls.kept,
    callsTo,
    addTransaction,
    checkAttached,
  });

  /**
   * The record of a call in `namespace` that ended with `outcome`; `decoded`
   * is the call, `undefined` when it didn't decode.
   */
  const recordOf = (
    namespace: MockNamespace | undefined,
    decoded: Pick<Decoded, "abiItem" | "call"> | undefined,
    outcome: MockOutcome,
  ): MockCallRecord => ({
    address,
    name,
    namespace,
    abiItem: decoded?.abiItem,
    call: decoded?.call,
    outcome,
  });

  async function resolve(
    data: Hex,
    context: CallContext,
    report: (record: MockCallRecord) => void,
  ): Promise<Hex> {
    let decoded: Decoded | undefined;
    const record = (outcome: MockOutcome) => recordOf(decoded?.namespace, decoded, outcome);
    try {
      const found = decode(data, context);
      if (found === undefined)
        throw new MockNotFoundError(
          `No function with selector ${slice(data, 0, 4)} on mocked contract ${label}.`,
        );
      const { selector, abiItem, call } = found;
      const namespace = reads.includes(abiItem) ? "read" : "simulate";
      decoded = { namespace, selector, abiItem, call };
      receive(decoded);
      const { handler, missed, removed } = match(decoded);
      if (!handler)
        throw missError(call, namespace, label, {
          registered: candidates(decoded),
          missed,
          removed,
        });
      const hex = await run(handler, call, namespace);
      const value = decodeFunctionResult({ abi: [abiItem], functionName: abiItem.name, data: hex });
      report(record({ type: "result", value }));
      return hex;
    } catch (error) {
      report(record(failureOutcome(error, abi)));
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
    const record: ContractTurn["record"] = (ended) =>
      recordOf(
        namespace,
        decoded,
        "error" in ended ? failureOutcome(ended.error, abi) : ended.outcome,
      );
    if (decoded === undefined) return { functionMocks: undefined, record };
    receive(decoded);
    if (!functionsIn[namespace].includes(decoded.abiItem))
      return { functionMocks: undefined, record };
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
          return missError(call, namespace, label, registered, { after });
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
          after,
        });
      },
    };
    return { functionMocks, record };
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
  type Decoded = { namespace: MockNamespace; selector: Hex; abiItem: AbiFunction; call: MockCall };

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
   * The handler that answers `decoded`, matched on its args, then its `from`
   * and `value` (see `findAnswering`), and what each candidate missed on.
   */
  function match(decoded: Decoded) {
    const { call } = decoded;
    return mocks.findAnswering(
      (handler) => isFor(decoded, handler),
      (handler, options) => {
        const arg = firstMismatch(handler.pinned, call.args, options);
        return arg === undefined ? firstPinMismatch(handler.pins, call, options) : arg;
      },
      call.functionName,
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
    return mocks.answerWith(
      handler,
      { ...call, revert, fail },
      (value) => answers.encode(handler.abiItem, value),
      call.functionName,
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
    resolve,
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
