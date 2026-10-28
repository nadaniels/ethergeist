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
  encodeFunctionResult,
  getAbiItem,
  getAddress,
  isHex,
  slice,
  toFunctionSelector,
} from "viem";
import { MockNotFoundError, MockResolverError, MockRevertError } from "./errors.js";
import { MockFailure, type MockFault } from "./faults.js";
import type { MockBatch } from "./multicall.js";
import { type MockReturnType, isPlainObject, normalizeResult, zeroResult } from "./result.js";
import { type RevertFn, type RevertSpec, createRevertError } from "./revert.js";

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

type Resolver<abi extends Abi, args, result> =
  | result
  | ((context: ResolverContext<abi, args>) => result);

type Handler = {
  abiItem: AbiFunction;
  selector: Hex;
  args: readonly unknown[] | undefined;
  specificity: number;
  /** Static values are wrapped at registration; `undefined` until `.returns()`/`.reverts()`. */
  resolver: ((context: ResolverContext<Abi, readonly unknown[]>) => unknown) | undefined;
  /** Calls this handler answered since registration or the last `clearCalls()`. */
  usedCount: number;
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
  defaults?: MockContractDefaults<abi>;
};

/** Internal: the public contract API plus the hooks the rpc calls. */
export type InternalMockContract<abi extends Abi = Abi> = {
  contract: MockContract<abi>;
  /** Whether this contract is registered at `address`, which must be checksummed. */
  matches(address: Address): boolean;
  resolve(data: Hex, context: CallContext): Promise<Hex>;
  clearCalls(): void;
  /** Mocks registered with args that haven't answered a call, formatted for messages. */
  unusedMocks(): string[];
};

export function createMockContract<const abi extends Abi>(
  parameters: CreateMockContractParameters<abi>,
  /** Called with every decoded call, so the rpc can keep a log across contracts. */
  onCall: (call: MockCall) => void = () => {},
): InternalMockContract<abi> {
  const { abi, defaults = {} } = parameters;
  // Also validates the address at registration.
  const address = getAddress(parameters.address);
  const handlers: Handler[] = [];
  const history: MockCall[] = [];
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
    const abiItem = getAbiItem({ abi: functionsIn[namespace], name: functionName, args });
    // viem's type assumes a match, but untyped callers can pass any name.
    if (abiItem === undefined) throw notInNamespaceError(namespace, functionName);

    const handler: Handler = {
      abiItem,
      selector: toFunctionSelector(abiItem),
      args,
      specificity: specificity(args),
      resolver: undefined,
      usedCount: 0,
    };
    handlers.push(handler);

    const builder = {
      returns(value: unknown = zeroResult) {
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
  function buildNamespace(name: Namespace) {
    const entries: Record<string, unknown> = {};
    for (const { name: functionName } of functionsIn[name]) {
      if (functionName in entries) continue;
      entries[functionName] = Object.defineProperty(
        (args?: readonly unknown[]) => register(name, functionName, args),
        "calls",
        { get: () => history.filter((call) => call.functionName === functionName) },
      );
    }
    // Untyped callers reaching for the other namespace's functions get a pointer
    // to the right one instead of "is not a function". Hidden from Object.keys.
    for (const { name: functionName } of functionsIn[name === "read" ? "simulate" : "read"]) {
      if (functionName in entries) continue;
      Object.defineProperty(entries, functionName, {
        value: () => {
          throw notInNamespaceError(name, functionName);
        },
      });
    }
    return entries;
  }

  // Built from the ABI at runtime; `MockContract<abi>` describes the same shape.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime-built typed facade
  const contract = {
    address,
    abi,
    get calls() {
      return [...history];
    },
    read: buildNamespace("read"),
    simulate: buildNamespace("simulate"),
  } as unknown as MockContract<abi>;

  async function resolve(data: Hex, context: CallContext): Promise<Hex> {
    const selector = slice(data, 0, 4);

    let decoded: { functionName: string; args: readonly unknown[] };
    try {
      const result = decodeFunctionData<Abi>({ abi, data });
      decoded = { functionName: result.functionName, args: result.args ?? [] };
    } catch {
      throw new MockNotFoundError(
        `No function with selector ${selector} on mocked contract ${address}.`,
      );
    }

    const call: MockCall = { ...context, address, ...decoded };
    history.push(call);
    onCall(call);

    // The most specific matching handler wins; among equally specific ones,
    // the most recently registered wins, so per-test mocks override defaults.
    let handler: Handler | undefined;
    for (const h of handlers) {
      if (h.selector !== selector) continue;
      if (h.args !== undefined && !isMatch(h.args, decoded.args)) continue;
      if (!handler || h.specificity >= handler.specificity) handler = h;
    }
    if (!handler?.resolver) {
      const registered = handlers
        .filter((h) => h.selector === selector)
        .map((h) => `  ${formatCall(decoded.functionName, h.args)}`);
      throw new MockNotFoundError(
        `No mock for ${formatCall(decoded.functionName, decoded.args)} on ${address}.`,
        {
          details:
            registered.length > 0
              ? `Registered:\n${registered.join("\n")}`
              : `No mocks registered for "${decoded.functionName}".`,
        },
      );
    }

    handler.usedCount += 1;
    try {
      return encodeResult(handler.abiItem, await handler.resolver({ ...call, revert, fail }));
    } catch (error) {
      if (error instanceof MockRevertError || error instanceof MockFailure) throw error;
      throw new MockResolverError(decoded.functionName, error);
    }
  }

  return {
    contract,
    matches: (other) => other === address,
    resolve,
    clearCalls() {
      history.length = 0;
      for (const handler of handlers) handler.usedCount = 0;
    },
    unusedMocks: () =>
      handlers
        .filter((h) => h.args !== undefined && h.resolver !== undefined && h.usedCount === 0)
        .map((h) => `${formatCall(h.abiItem.name, h.args)} on ${address}`),
  };
}

/**
 * How narrowly a handler's args constrain a call: the number of leaf values it
 * pins down. Args-less handlers match anything and rank below all others.
 */
function specificity(args: readonly unknown[] | undefined): number {
  if (args === undefined) return -1;
  const count = (value: unknown): number => {
    if (Array.isArray(value)) return value.reduce((n: number, v) => n + count(v), 0);
    if (isPlainObject(value)) return Object.values(value).reduce((n: number, v) => n + count(v), 0);
    return 1;
  };
  return count(args);
}

/** Handed to every resolver; unlike `revert`, it doesn't depend on the ABI. */
function fail(fault: MockFault): never {
  throw new MockFailure(fault);
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

/**
 * Deep equality where hex strings (addresses, bytes) compare case-insensitively
 * and equal integers match as either `number` or `bigint`.
 */
function isMatch(expected: unknown, actual: unknown): boolean {
  if (isHex(expected) && isHex(actual)) return expected.toLowerCase() === actual.toLowerCase();
  if (Array.isArray(expected) && Array.isArray(actual))
    return (
      expected.length === actual.length && expected.every((value, i) => isMatch(value, actual[i]))
    );
  if (isPlainObject(expected) && isPlainObject(actual))
    return Object.entries(expected).every(([key, value]) => isMatch(value, actual[key]));
  // viem decodes integers up to 48 bits as numbers and wider ones as bigints. A
  // value of the other kind that got past the types still means the same number.
  if (typeof expected === "bigint" && typeof actual === "number")
    return Number.isInteger(actual) && expected === BigInt(actual);
  if (typeof expected === "number" && typeof actual === "bigint")
    return Number.isInteger(expected) && BigInt(expected) === actual;
  return expected === actual;
}

function formatCall(functionName: string, args: readonly unknown[] | undefined) {
  if (args === undefined) return `${functionName}(*)`;
  return `${functionName}(${args.map((arg) => (typeof arg === "bigint" ? `${arg}n` : String(arg))).join(", ")})`;
}
