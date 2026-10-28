import {
  type Abi,
  type AbiFunction,
  type Address,
  type ContractErrorName,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type ContractFunctionReturnType,
  type Hex,
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionResult,
  getAbiItem,
  getAddress,
  slice,
  toFunctionSelector,
} from "viem";
import { MockNotFoundError, MockResolverError, MockRevertError } from "./errors.js";
import { type PartCheckpoint, removedMockError } from "./checkpoint.js";
import { MockFailure, type MockFault, fail } from "./faults.js";
import { formatCall, formatContract } from "./format.js";
import { type MockCallRecord, type MockOutcome, errorOutcome } from "./history.js";
import type { MockBatch } from "./multicall.js";
import { isMatch, specificity } from "./match.js";
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
  specificity: number;
  /** Static values are wrapped at registration; `undefined` until `.returns()`/`.reverts()`. */
  resolver: ((context: ResolverContext<Abi, readonly unknown[]>) => unknown) | undefined;
  /** Calls this handler answered since registration or the last `clearCalls()`. */
  usedCount: number;
  /** Set when a `restore()` or `reset()` removes it, so its builder can't answer again. */
  removed: boolean;
};

export type MockFunction<abi extends Abi, args, result> = {
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
};

type NamespaceDefaults<abi extends Abi, mutability extends ReadMutability | WriteMutability> = {
  [functionName in ContractFunctionName<abi, mutability>]?: Resolver<
    abi,
    ContractFunctionArgs<abi, mutability, functionName>,
    MockReturnType<abi, functionName, ContractFunctionReturnType<abi, mutability, functionName>>
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
  /** Mocks registered with args that haven't answered a call, formatted for messages. */
  unusedMocks(): string[];
  /** Saves the registered mocks and their answers, to put back or compare against. */
  checkpoint(): PartCheckpoint;
  /** Marks the contract removed: registering on it, or answering its mocks, throws. */
  detach(): void;
};

export function createMockContract<const abi extends Abi>(
  parameters: CreateMockContractParameters<abi>,
  /** Called with every decoded call, so the rpc can keep a log across contracts. */
  onCall: (call: MockCall) => void = () => {},
): InternalMockContract<abi> {
  const { abi, name, defaults = {} } = parameters;
  // Also validates the address at registration.
  const address = getAddress(parameters.address);
  const label = formatContract(address, name);
  const handlers: Handler[] = [];
  const history: MockCall[] = [];
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

  /** Looks up only within `namespace`, so an overload never binds across namespaces. */
  function register(
    namespace: Namespace,
    functionName: string,
    args: readonly unknown[] | undefined,
  ) {
    if (detached)
      throw new Error(
        `The contract at ${label} was removed by restore() or reset(); register it again.`,
      );
    const abiItem = getAbiItem({ abi: functionsIn[namespace], name: functionName, args });
    // viem's type assumes a match, but untyped callers can pass any name.
    if (abiItem === undefined) throw notInNamespaceError(namespace, functionName);

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
    };
    return builder;
  }

  for (const [functionName, resolver] of Object.entries(defaults.read ?? {}))
    register("read", functionName, undefined).returns(resolver);
  for (const [functionName, resolver] of Object.entries(defaults.simulate ?? {}))
    register("simulate", functionName, undefined).returns(resolver);

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
  } as unknown as MockContract<abi>;

  async function resolve(
    data: Hex,
    context: CallContext,
    report?: (record: MockCallRecord) => void,
  ): Promise<Hex> {
    const decoded: { call?: MockCall } = {};
    try {
      const { hex, abiItem } = await answer(data, context, decoded);
      const value = decodeFunctionResult({ abi: [abiItem], functionName: abiItem.name, data: hex });
      report?.({ address, name, call: decoded.call, outcome: { type: "result", value } });
      return hex;
    } catch (error) {
      report?.({ address, name, call: decoded.call, outcome: outcomeOf(error) });
      throw error;
    }
  }

  function outcomeOf(error: unknown): MockOutcome {
    if (error instanceof MockRevertError) return revertOutcome(abi, error.data);
    if (error instanceof MockFailure) return { type: "fault", fault: error.fault, source: "mock" };
    return errorOutcome(error);
  }

  /** Decodes and answers a call, leaving the decoded call in `decoded` for reporting. */
  async function answer(
    data: Hex,
    context: CallContext,
    decoded: { call?: MockCall },
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
    history.push(call);
    onCall(call);

    // The most specific matching handler wins; among equally specific ones,
    // the most recently registered wins, so per-test mocks override defaults.
    let handler: Handler | undefined;
    for (const h of handlers) {
      if (h.selector !== selector) continue;
      if (h.args !== undefined && !isMatch(h.args, fn.args)) continue;
      if (!handler || h.specificity >= handler.specificity) handler = h;
    }
    if (!handler?.resolver) {
      const registered = handlers
        .filter((h) => h.selector === selector)
        .map((h) => `  ${formatCall(fn.functionName, h.args)}`);
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

  /** Mocks registered with args that haven't answered a call; args-less ones are fallbacks. */
  function unused(list: Handler[]) {
    return list
      .filter((h) => h.args !== undefined && h.resolver !== undefined && h.usedCount === 0)
      .map((h) => `${formatCall(h.abiItem.name, h.args)} on ${label}`);
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
      const saved = handlers.map((h) => [h, h.resolver] as const);
      return {
        restore() {
          for (const handler of handlers.slice(saved.length)) handler.removed = true;
          handlers.length = saved.length;
          for (const [handler, resolver] of saved) handler.resolver = resolver;
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

function encodeResult(abiItem: AbiFunction, value: unknown): Hex {
  return encodeFunctionResult({
    abi: [abiItem],
    functionName: abiItem.name,
    // viem types `result` as a tuple for a non-literal AbiFunction, but it
    // takes a bare value for single-output functions at runtime.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- viem's type is narrower than its runtime
    result: normalizeResult(abiItem.outputs, value) as readonly unknown[] | undefined,
  });
}
