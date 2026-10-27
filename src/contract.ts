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
  slice,
  toFunctionSelector,
} from "viem";
import { MockNotFoundError, MockResolverError, MockRevertError } from "./errors.js";
import { type RevertFn, type RevertSpec, createRevertError } from "./revert.js";

type ReadMutability = "pure" | "view";
type WriteMutability = "nonpayable" | "payable";

export type CallContext = {
  from: Address | undefined;
  /** Wei sent with the call; `0n` when none. */
  value: bigint;
  blockNumber: bigint;
};

export type MockCall<args = readonly unknown[]> = CallContext & {
  functionName: string;
  args: args;
};

export type ResolverContext<abi extends Abi, args> = MockCall<args> & {
  /** Revert this call, e.g. `revert('paused')` or `revert({ errorName, args })`. */
  revert: RevertFn<abi>;
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
};

export type MockFunction<abi extends Abi, args, result> = {
  returns(value: Resolver<abi, args, result>): void;
  /** Revert every matching call. See `RevertSpec` for the accepted forms. */
  reverts<errorName extends ContractErrorName<abi> = ContractErrorName<abi>>(
    spec?: RevertSpec<abi, errorName>,
  ): void;
};

/** Mirrors `getContract(...).<namespace>.<functionName>(args)`, but registers a mock. */
export type MockContractFunction<
  abi extends Abi,
  mutability extends ReadMutability | WriteMutability,
  functionName extends ContractFunctionName<abi, mutability>,
> = {
  <const args extends ContractFunctionArgs<abi, mutability, functionName>>(
    args?: args,
  ): MockFunction<abi, args, ContractFunctionReturnType<abi, mutability, functionName, args>>;
  /** Every call to this function the mock has received, in order. */
  readonly calls: MockCall<ContractFunctionArgs<abi, mutability, functionName>>[];
};

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
    ContractFunctionReturnType<abi, mutability, functionName>
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

/** Internal: the public contract API plus the hook the dispatcher calls. */
export type InternalMockContract<abi extends Abi = Abi> = {
  contract: MockContract<abi>;
  matches(address: Address): boolean;
  resolve(data: Hex, context: CallContext): Promise<Hex>;
};

export function createMockContract<const abi extends Abi>(
  parameters: CreateMockContractParameters<abi>,
): InternalMockContract<abi> {
  const { abi, address, defaults = {} } = parameters;
  const handlers: Handler[] = [];
  const history: MockCall[] = [];

  const functionsOf = (mutabilities: readonly string[]) =>
    (abi as Abi).filter(
      (item): item is AbiFunction =>
        item.type === "function" && mutabilities.includes(item.stateMutability),
    );
  const readFunctions = functionsOf(["view", "pure"]);
  const simulateFunctions = functionsOf(["nonpayable", "payable"]);

  /** `functions` limits the lookup so an overload never binds across namespaces. */
  function register(
    functions: readonly AbiFunction[],
    functionName: string,
    args: readonly unknown[] | undefined,
  ) {
    const abiItem = getAbiItem({
      abi: functions,
      name: functionName,
      args,
    } as never) as AbiFunction | undefined;
    if (!abiItem) throw new Error(`Function "${functionName}" not found on ABI.`);

    const handler: Handler = {
      abiItem,
      selector: toFunctionSelector(abiItem),
      args,
      specificity: specificity(args),
      resolver: undefined,
    };
    handlers.push(handler);

    const builder = {
      returns(value: unknown) {
        handler.resolver =
          typeof value === "function" ? (value as Handler["resolver"]) : () => value;
      },
      reverts(spec?: RevertSpec) {
        builder.returns(({ revert }: ResolverContext<Abi, unknown>) => revert(spec));
      },
    };
    return builder;
  }

  for (const [functionName, resolver] of Object.entries(defaults.read ?? {}))
    register(readFunctions, functionName, undefined).returns(resolver);
  for (const [functionName, resolver] of Object.entries(defaults.simulate ?? {}))
    register(simulateFunctions, functionName, undefined).returns(resolver);

  // Overloads share one entry, as in viem's `getContract`.
  function namespace(functions: readonly AbiFunction[]) {
    const entries: Record<string, unknown> = {};
    for (const { name: functionName } of functions) {
      if (functionName in entries) continue;
      entries[functionName] = Object.defineProperty(
        (args?: readonly unknown[]) => register(functions, functionName, args),
        "calls",
        { get: () => history.filter((call) => call.functionName === functionName) },
      );
    }
    return entries;
  }

  const contract = {
    address,
    abi,
    read: namespace(readFunctions),
    simulate: namespace(simulateFunctions),
  } as unknown as MockContract<abi>;

  async function resolve(data: Hex, context: CallContext): Promise<Hex> {
    const selector = slice(data, 0, 4);

    let decoded: { functionName: string; args: readonly unknown[] };
    try {
      const result = decodeFunctionData({ abi: abi as Abi, data });
      decoded = { functionName: result.functionName, args: result.args ?? [] };
    } catch {
      throw new MockNotFoundError(
        `No function with selector ${selector} on mocked contract ${address}.`,
      );
    }

    const call: MockCall = { ...context, ...decoded };
    history.push(call);

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
          details: registered.length
            ? `Registered:\n${registered.join("\n")}`
            : `No mocks registered for "${decoded.functionName}".`,
        },
      );
    }

    const revert = ((spec?: RevertSpec) => {
      throw createRevertError(abi as Abi, spec);
    }) as RevertFn<Abi>;
    let result: unknown;
    try {
      result = await handler.resolver({ ...call, revert });
    } catch (error) {
      if (error instanceof MockRevertError) throw error;
      throw new MockResolverError(decoded.functionName, error);
    }

    return encodeFunctionResult({
      abi: [handler.abiItem],
      functionName: handler.abiItem.name,
      result,
    } as never);
  }

  return {
    contract,
    matches: (other) => other.toLowerCase() === address.toLowerCase(),
    resolve,
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
    if (value && typeof value === "object")
      return Object.values(value).reduce((n: number, v) => n + count(v), 0);
    return 1;
  };
  return count(args);
}

/** Deep equality where hex strings (addresses, bytes) compare case-insensitively. */
function isMatch(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "string" && typeof actual === "string")
    return expected.toLowerCase() === actual.toLowerCase();
  if (Array.isArray(expected) && Array.isArray(actual))
    return (
      expected.length === actual.length && expected.every((value, i) => isMatch(value, actual[i]))
    );
  if (expected && actual && typeof expected === "object" && typeof actual === "object")
    return Object.entries(expected).every(([key, value]) =>
      isMatch(value, (actual as Record<string, unknown>)[key]),
    );
  return expected === actual;
}

function formatCall(functionName: string, args: readonly unknown[] | undefined) {
  if (args === undefined) return `${functionName}(*)`;
  return `${functionName}(${args.map((arg) => (typeof arg === "bigint" ? `${arg}n` : String(arg))).join(", ")})`;
}
