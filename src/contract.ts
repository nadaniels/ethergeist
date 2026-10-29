import {
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type Address,
  type ContractErrorName,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type ContractFunctionReturnType,
  type Hex,
  decodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionResult,
  getAbiItem,
  getAddress,
  slice,
  toFunctionSelector,
  toFunctionSignature,
} from "viem";
import {
  MockNotFoundError,
  MockResolverError,
  MockRevertError,
  removedMockError,
} from "./errors.js";
import {
  type EmitOptions,
  type MockContractEmit,
  type MockContractEvents,
  type MockEventLog,
  encodeEventLog,
} from "./events.js";
import type { PartCheckpoint } from "./checkpoint.js";
import { MockFailure, type MockFault, fail } from "./faults.js";
import {
  type ReceivedCall,
  formatCall,
  formatContract,
  formatLimit,
  formatMismatch,
  formatReceived,
} from "./format.js";
import { type MockCallRecord, type MockOutcome, errorOutcome } from "./history.js";
import type { MockBatch } from "./multicall.js";
import {
  type Specificity,
  assertNoMatchers,
  bestMatch,
  findMatcher,
  isMatch,
  mismatches,
  setLimit,
  specificity,
} from "./match.js";
import { type MockReturnType, checksumAddresses, normalizeResult, zeroResult } from "./result.js";
import { type RevertFn, type RevertSpec, createRevertError, revertOutcome } from "./revert.js";

type ReadMutability = "pure" | "view";
type Namespace = "read" | "simulate";
type WriteMutability = "nonpayable" | "payable";

export type CallContext = {
  from: Address | undefined;
  /** Wei sent with the call; `0n` when none. */
  value: bigint;
  blockNumber: bigint;
  /** Set when the call arrived inside a Multicall3 `aggregate3`. */
  batch: MockBatch | undefined;
};

export type MockCall<
  args = readonly unknown[],
  functionName extends string = string,
> = CallContext & {
  /** The contract's address, checksummed. */
  address: Address;
  functionName: functionName;
  args: args;
};

export type ResolverContext<abi extends Abi, args> = MockCall<args> & {
  /** Revert this call, e.g. `revert('paused')` or `revert({ errorName, args })`. */
  revert: RevertFn<abi>;
  /**
   * Fail the whole JSON-RPC request with a transport-level fault, e.g.
   * `fail({ status: 503 })`. See `MockFault` for the kinds.
   */
  fail: (fault: MockFault) => never;
};

/** A static value, or a function answering each call; it may be async. */
type Resolver<abi extends Abi, args, result> =
  | result
  | ((context: ResolverContext<abi, args>) => result | Promise<result>);

type Handler = {
  abiItem: AbiFunction;
  selector: Hex;
  args: readonly unknown[] | undefined;
  specificity: Specificity;
  /** Static values are wrapped at registration; `undefined` until `.returns()`/`.reverts()`. */
  resolver: ((context: ResolverContext<Abi, readonly unknown[]>) => unknown) | undefined;
  /** Calls this handler answered since registration or the last `clearCalls()`. */
  usedCount: number;
  /** Registered from `defaults`: shared setup, which `assertAllUsed()` doesn't hold to any one test. */
  isDefault: boolean;
  /** Set by `.once()`/`.times(n)`: answers in all, and how many are left. Kept by `clearCalls()`. */
  limit: number | undefined;
  remaining: number | undefined;
  /** Set when a `restore()` or `reset()` removes it, so its builder can't answer again. */
  removed: boolean;
};

/** How a mock answers: `.returns()`, `.reverts()`, or `.fails()`. */
export type MockFunctionAnswers<abi extends Abi, args, result> = {
  /** With no argument, answers with zero values, like `.returns(zeroResult)`. */
  returns(): void;
  returns(value: Resolver<abi, args, result>): void;
  /** Revert every matching call. See `RevertSpec` for the accepted forms. */
  reverts<errorName extends ContractErrorName<abi> = ContractErrorName<abi>>(
    spec?: RevertSpec<abi, errorName>,
  ): void;
  /**
   * Fail every matching call at the network level: the whole JSON-RPC request,
   * including a multicall batch it's in, throws the error viem's `http`
   * transport would, so viem's retries apply. See `MockFault` for the kinds.
   */
  fails(fault: MockFault): void;
};

export type MockFunction<abi extends Abi, args, result> = MockFunctionAnswers<abi, args, result> & {
  /**
   * Answer only the next matching call, then step aside for the next best
   * mock. Limited mocks go ahead of unlimited ones as specific, oldest first,
   * so `fn().once().fails("network")` beside `fn().returns(1n)` fails once
   * whichever is registered first. Retries use up answers too.
   */
  once(): MockFunctionAnswers<abi, args, result>;
  /** Like `.once()`, for the next `count` matching calls. */
  times(count: number): MockFunctionAnswers<abi, args, result>;
};

/** Mirrors `getContract(...).<namespace>.<functionName>(args)`, but registers a mock. */
export type MockContractFunction<
  abi extends Abi,
  mutability extends ReadMutability | WriteMutability,
  functionName extends ContractFunctionName<abi, mutability>,
> = {
  <const args extends ContractFunctionArgs<abi, mutability, functionName>>(
    args?: args,
  ): MockFunction<
    abi,
    args,
    MockReturnType<
      abi,
      functionName,
      ContractFunctionReturnType<abi, mutability, functionName, args>
    >
  >;
  /** Every call to this function the mock has received, in order. */
  readonly calls: MockCall<ContractFunctionArgs<abi, mutability, functionName>, functionName>[];
};

/** A call to any function in a namespace, discriminated by `functionName`. */
type NamespaceCall<abi extends Abi, mutability extends ReadMutability | WriteMutability> = {
  [functionName in ContractFunctionName<abi, mutability>]: MockCall<
    ContractFunctionArgs<abi, mutability, functionName>,
    functionName
  >;
}[ContractFunctionName<abi, mutability>];

export type MockReadFunction<
  abi extends Abi,
  functionName extends ContractFunctionName<abi, ReadMutability>,
> = MockContractFunction<abi, ReadMutability, functionName>;

export type MockSimulateFunction<
  abi extends Abi,
  functionName extends ContractFunctionName<abi, WriteMutability>,
> = MockContractFunction<abi, WriteMutability, functionName>;

export type MockContract<abi extends Abi> = {
  address: Address;
  /** The name given at registration, if any. */
  name: string | undefined;
  abi: abi;
  /** Every call to any of this contract's functions, in order. */
  readonly calls: (NamespaceCall<abi, ReadMutability> | NamespaceCall<abi, WriteMutability>)[];
  /** View and pure functions. */
  read: {
    [functionName in ContractFunctionName<abi, ReadMutability>]: MockReadFunction<
      abi,
      functionName
    >;
  };
  /**
   * Nonpayable and payable functions, answered over `eth_call` as
   * `simulateContract` sends them. Nothing here runs for a sent transaction.
   */
  simulate: {
    [functionName in ContractFunctionName<abi, WriteMutability>]: MockSimulateFunction<
      abi,
      functionName
    >;
  };
  /**
   * The contract's events, each building the log its args would emit at this
   * address, e.g. `events.Transfer({ from, to, value })`, for a mocked
   * receipt's `logs`. Indexed args are required; the rest are zero-filled.
   */
  events: MockContractEvents<abi>;
  /**
   * Emits one of the contract's events, as a transaction of its own, e.g.
   * `emit.Transfer({ from, to, value }, { mine: true })`, for `getLogs` and
   * watchers to find. Returns the placed log. Shorthand for
   * `mock.emit(contract.events.X(args), options)`.
   */
  emit: MockContractEmit<abi>;
};

/**
 * A function's return type across all its overloads, as a default answers
 * them all. viem's is `never` for an overloaded function given no args.
 */
type OverloadsReturnType<
  abi extends Abi,
  mutability extends ReadMutability | WriteMutability,
  functionName extends ContractFunctionName<abi, mutability>,
  args = ContractFunctionArgs<abi, mutability, functionName>,
> =
  args extends ContractFunctionArgs<abi, mutability, functionName>
    ? ContractFunctionReturnType<abi, mutability, functionName, args>
    : never;

type NamespaceDefaults<abi extends Abi, mutability extends ReadMutability | WriteMutability> = {
  [functionName in ContractFunctionName<abi, mutability>]?: Resolver<
    abi,
    ContractFunctionArgs<abi, mutability, functionName>,
    MockReturnType<abi, functionName, OverloadsReturnType<abi, mutability, functionName>>
  >;
};

/**
 * One resolver per function, keyed by namespace like `MockContract`. Defaults
 * are registered before any other mock, so `read`/`simulate` mocks always
 * override them.
 */
export type MockContractDefaults<abi extends Abi> = {
  read?: NamespaceDefaults<abi, ReadMutability>;
  simulate?: NamespaceDefaults<abi, WriteMutability>;
};

export type CreateMockContractParameters<abi extends Abi> = {
  abi: abi;
  address: Address;
  /** A name for messages and history, e.g. `"USDC"`. Defaults to the address alone. */
  name?: string;
  defaults?: MockContractDefaults<abi>;
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
  clearCalls(): void;
  /** Mocks other than defaults that haven't answered a call, formatted for messages. */
  unusedMocks(): string[];
  /** Saves the registered mocks and their answers, to put back or compare against. */
  checkpoint(): PartCheckpoint;
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
  } = {},
): InternalMockContract<abi> {
  const { onCall = () => {}, emit = () => [] } = hooks;
  const { abi, name, defaults = {} } = parameters;
  // Also validates the address at registration.
  const address = getAddress(parameters.address);
  const label = formatContract(address, name);
  const handlers: Handler[] = [];
  const history: MockCall[] = [];
  // Overloads share a name, so unused mocks find their calls by selector.
  const selectorOf = new WeakMap<MockCall, Hex>();
  let detached = false;
  // Handed to every resolver. RevertFn's generic signature only narrows what
  // callers may pass; createRevertError accepts every RevertSpec.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- generic signature, non-generic implementation
  const revert = ((spec?: RevertSpec) => {
    throw createRevertError(abi, spec);
  }) as RevertFn<Abi>;

  const functionsOf = (mutabilities: readonly string[]) =>
    (abi as Abi).filter(
      (item): item is AbiFunction =>
        item.type === "function" && mutabilities.includes(item.stateMutability),
    );
  const functionsIn = {
    read: functionsOf(["view", "pure"]),
    simulate: functionsOf(["nonpayable", "payable"]),
  };
  const functionsBySelector = new Map(
    [...functionsIn.read, ...functionsIn.simulate].map((f) => [toFunctionSelector(f), f]),
  );

  /** For a name that isn't in `namespace`: says where it is instead, if anywhere. */
  function notInNamespaceError(namespace: Namespace, functionName: string) {
    const other = namespace === "read" ? "simulate" : "read";
    const elsewhere = functionsIn[other].find((f) => f.name === functionName);
    return elsewhere
      ? new Error(
          `"${functionName}" is a ${elsewhere.stateMutability} function; ` +
            `register it under ${other}, not ${namespace}.`,
        )
      : new Error(`No function "${functionName}" on this contract's ABI.`);
  }

  /**
   * The function `args` call, looked up only within `namespace`, so an overload
   * never binds across namespaces. viem's `getAbiItem` tells overloads apart by
   * their args' values, and silently picks the first when none fits. Matchers
   * fit no type, so with matchers, overloads are told apart by the exact args
   * alone. Args holding a matcher anywhere are skipped whole: a `match.partial`
   * could rule overloads out field by field, but doesn't yet.
   */
  function findFunction(
    namespace: Namespace,
    functionName: string,
    args: readonly unknown[] | undefined,
  ): AbiFunction {
    const overloads = functionsIn[namespace].filter((f) => f.name === functionName);
    // viem would pick the first overload; "any args" can't say which one.
    if (args === undefined && overloads.length > 1)
      throw new Error(
        `Ambiguous overload for ${functionName}(*): pin args to choose one, e.g. ` +
          `[match.any()]:\n${listSignatures(overloads)}`,
      );
    if (overloads.length < 2 || findMatcher(args) === undefined) {
      const abiItem = getAbiItem({ abi: functionsIn[namespace], name: functionName, args });
      // viem's type assumes a match, but untyped callers can pass any name.
      if (abiItem === undefined) throw notInNamespaceError(namespace, functionName);
      return abiItem;
    }

    const fits = overloads.filter(
      (f) =>
        f.inputs.length === args!.length &&
        args!.every((arg, i) => findMatcher(arg) !== undefined || isOfType(f.inputs[i]!, arg)),
    );
    if (fits.length === 1) return fits[0]!;
    const call = formatCall(functionName, args);
    throw new Error(
      fits.length === 0
        ? `No overload of "${functionName}" takes ${call}. Overloads:\n${listSignatures(overloads)}`
        : `Ambiguous overload for ${call}: pin an arg that tells them apart. It fits:\n${listSignatures(fits)}`,
    );
  }

  function register(
    namespace: Namespace,
    functionName: string,
    args: readonly unknown[] | undefined,
    /** For defaults: registered on a given overload, and exempt from `assertAllUsed()`. */
    asDefault?: { abiItem: AbiFunction },
  ) {
    if (detached)
      throw new Error(
        `The contract at ${label} was removed by restore() or reset(); register it again.`,
      );
    const abiItem = asDefault?.abiItem ?? findFunction(namespace, functionName, args);
    const isDefault = asDefault !== undefined;

    // Checksummed so messages show addresses one way, and a malformed one fails here.
    const pinned = args?.map((arg, i) => {
      const input = abiItem.inputs[i];
      return input ? checksumAddresses(input, arg) : arg;
    });
    const handler: Handler = {
      abiItem,
      selector: toFunctionSelector(abiItem),
      args: pinned,
      specificity: specificity(pinned),
      resolver: undefined,
      usedCount: 0,
      isDefault,
      limit: undefined,
      remaining: undefined,
      removed: false,
    };
    handlers.push(handler);

    const builder = {
      returns(value: unknown = zeroResult) {
        if (handler.removed) throw removedMockError();
        // A static value that can't be encoded fails here, not inside a request.
        if (typeof value !== "function") encodeResult(abiItem, value);
        handler.resolver =
          // The types guarantee a resolver's signature; it can't be checked at runtime.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- user-supplied function
          typeof value === "function" ? (value as Handler["resolver"]) : () => value;
      },
      reverts(spec?: RevertSpec) {
        builder.returns(() => revert(spec));
      },
      fails(fault: MockFault) {
        builder.returns(() => fail(fault));
      },
      once: () => builder.times(1),
      times(count: number) {
        if (handler.removed) throw removedMockError();
        setLimit(handler, count);
        return builder;
      },
    };
    return builder;
  }

  // A default is keyed by name, so it answers every overload of that name.
  for (const namespace of ["read", "simulate"] as const)
    for (const [functionName, resolver] of Object.entries(defaults[namespace] ?? {})) {
      const overloads = functionsIn[namespace].filter((f) => f.name === functionName);
      if (overloads.length === 0) throw notInNamespaceError(namespace, functionName);
      for (const abiItem of overloads)
        register(namespace, functionName, undefined, { abiItem }).returns(resolver);
    }

  // Overloads share one entry, as in viem's `getContract`.
  function buildNamespace(namespace: Namespace) {
    const entries: Record<string, unknown> = {};
    for (const { name: functionName } of functionsIn[namespace]) {
      if (functionName in entries) continue;
      entries[functionName] = Object.defineProperty(
        (args?: readonly unknown[]) => register(namespace, functionName, args),
        "calls",
        { get: () => history.filter((call) => call.functionName === functionName) },
      );
    }
    // Untyped callers reaching for the other namespace's functions get a pointer
    // to the right one instead of "is not a function". Hidden from Object.keys.
    for (const { name: functionName } of functionsIn[namespace === "read" ? "simulate" : "read"]) {
      if (functionName in entries) continue;
      Object.defineProperty(entries, functionName, {
        value: () => {
          throw notInNamespaceError(namespace, functionName);
        },
      });
    }
    return entries;
  }

  // Built from the ABI at runtime; `MockContract<abi>` describes the same shape.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime-built typed facade
  const contract = {
    address,
    name,
    abi,
    get calls() {
      return [...history];
    },
    read: buildNamespace("read"),
    simulate: buildNamespace("simulate"),
    events: Object.fromEntries(
      (abi as Abi).flatMap((item) =>
        item.type === "event"
          ? [[item.name, (args?: unknown) => encodeEventLog(abi, address, item.name, args)]]
          : [],
      ),
    ),
    emit: Object.fromEntries(
      (abi as Abi).flatMap((item) =>
        item.type === "event"
          ? [
              [
                item.name,
                (args?: unknown, options?: EmitOptions) => {
                  if (detached)
                    throw new Error(
                      `The contract at ${label} was removed by restore() or reset(); register it again.`,
                    );
                  return emit([encodeEventLog(abi, address, item.name, args)], options)[0];
                },
              ],
            ]
          : [],
      ),
    ),
  } as unknown as MockContract<abi>;

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
      report?.(record(outcomeOf(error)));
      throw error;
    }
  }

  function outcomeOf(error: unknown): MockOutcome {
    if (error instanceof MockRevertError) return revertOutcome(abi, error.data);
    if (error instanceof MockFailure) return { type: "fault", fault: error.fault, source: "mock" };
    return errorOutcome(error);
  }

  /** What a call decoded to, for reporting however it ends. */
  type Decoded = { abiItem: AbiFunction | undefined; call: MockCall | undefined };

  /** Decodes and answers a call, leaving what it decoded in `decoded` for reporting. */
  async function answer(
    data: Hex,
    context: CallContext,
    decoded: Decoded,
  ): Promise<{ hex: Hex; abiItem: AbiFunction }> {
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
    decoded.call = call;
    decoded.abiItem = functionsBySelector.get(selector);
    history.push(call);
    selectorOf.set(call, selector);
    onCall(call);

    // The most specific matching handler wins; among equally specific ones,
    // the most recently registered wins, so per-test mocks override defaults.
    const handler = bestMatch(
      handlers.filter((h) => h.selector === selector),
      (h, options) => h.args === undefined || isMatch(h.args, fn.args, options),
      fn.functionName,
    );
    if (!handler?.resolver) {
      const registered = handlers
        .filter((h) => h.selector === selector)
        .map((h) => `  ${formatCall(fn.functionName, h.args)}${formatLimit(h.limit, h.remaining)}`);
      throw new MockNotFoundError(
        `No mock for ${formatCall(fn.functionName, fn.args)} on ${label}.`,
        {
          details:
            registered.length > 0
              ? `Registered:\n${registered.join("\n")}`
              : `No mocks registered for "${fn.functionName}".`,
        },
      );
    }

    handler.usedCount += 1;
    if (handler.remaining !== undefined) handler.remaining -= 1;
    const { abiItem } = handler;
    try {
      return {
        hex: encodeResult(abiItem, await handler.resolver({ ...call, revert, fail })),
        abiItem,
      };
    } catch (error) {
      if (error instanceof MockRevertError || error instanceof MockFailure) throw error;
      throw new MockResolverError(fn.functionName, error);
    }
  }

  /**
   * Mocks that haven't answered a call; defaults are shared setup, so they're
   * left out, and so are used-up mocks, which answered every call they had.
   */
  function unused(list: Handler[]) {
    return list
      .filter(
        (h) => !h.isDefault && h.resolver !== undefined && h.usedCount === 0 && h.remaining !== 0,
      )
      .map((h) => {
        const mock = `${formatCall(h.abiItem.name, h.args)}${formatLimit(h.limit, h.remaining)}`;
        return `${mock} on ${label}${formatReceived(h.abiItem.name, received(h))}`;
      });
  }

  /** The calls `handler`'s function received since the last clear, and where each differs. */
  function received(handler: Handler): ReceivedCall[] {
    return history
      .filter((call) => selectorOf.get(call) === handler.selector)
      .map((call) => {
        const mismatched = handler.args === undefined ? [] : mismatches(handler.args, call.args);
        const index = mismatched[0];
        // Inputs may be unnamed (`""`); those are numbered from 1.
        const inputName =
          typeof index === "number" ? handler.abiItem.inputs[index]?.name : undefined;
        const differs =
          index === undefined
            ? undefined
            : inputName === undefined || inputName === ""
              ? `arg ${Number(index) + 1}`
              : inputName;
        return { call: formatMismatch(call.functionName, call.args, mismatched), differs };
      });
  }

  return {
    contract,
    label,
    matches: (other) => other === address,
    resolve,
    clearCalls() {
      history.length = 0;
      for (const handler of handlers) handler.usedCount = 0;
    },
    unusedMocks: () => unused(handlers),
    checkpoint() {
      const saved = handlers.map((h) => [h, h.resolver, h.limit, h.remaining] as const);
      return {
        restore() {
          for (const handler of handlers.slice(saved.length)) handler.removed = true;
          handlers.length = saved.length;
          for (const [handler, resolver, limit, remaining] of saved)
            Object.assign(handler, { resolver, limit, remaining });
        },
        unusedSince: () => unused(handlers.slice(saved.length)),
      };
    },
    detach() {
      detached = true;
      for (const handler of handlers) handler.removed = true;
    },
  };
}

function listSignatures(functions: readonly AbiFunction[]): string {
  return functions.map((f) => `  ${toFunctionSignature(f)}`).join("\n");
}

/** Whether `value` encodes as `parameter`'s type. */
function isOfType(parameter: AbiParameter, value: unknown): boolean {
  try {
    encodeAbiParameters([parameter], [value]);
    return true;
  } catch {
    return false;
  }
}

function encodeResult(abiItem: AbiFunction, value: unknown): Hex {
  assertNoMatchers(value);
  return encodeFunctionResult({
    abi: [abiItem],
    functionName: abiItem.name,
    // viem types `result` as a tuple for a non-literal AbiFunction, but it
    // takes a bare value for single-output functions at runtime.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- viem's type is narrower than its runtime
    result: normalizeResult(abiItem.outputs, value) as readonly unknown[] | undefined,
  });
}
