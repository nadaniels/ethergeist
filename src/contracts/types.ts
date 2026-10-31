import type {
  Abi,
  Address,
  ContractErrorArgs,
  ContractErrorName,
  ContractFunctionArgs,
  ContractFunctionName,
  ContractFunctionReturnType,
  Hex,
} from "viem";
import type { MockContractEmit, MockContractEvents } from "../events.js";
import type { MockEstimateAnswers, MockFault, MockNodeFault } from "../mocking/types.js";
import type { MockReturnType } from "../result.js";

type ReadMutability = "pure" | "view";
type WriteMutability = "nonpayable" | "payable";
/** What a namespace's mocks can fail with: a node refuses only transactions by name. */
type FaultOf<mutability> = [mutability] extends [ReadMutability] ? MockFault : MockNodeFault;

/** Where a call came from when it arrived inside a Multicall3 `aggregate3`. */
export type MockBatch = {
  /** Shared by every call in the same `aggregate3` request. */
  id: number;
  /** Position within that request. */
  index: number;
  /** The account that sent the `aggregate3` call; `from` is the Multicall3 address. */
  from: Address | undefined;
};

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

type CustomRevert<abi extends Abi, errorName extends ContractErrorName<abi>> = {
  errorName: errorName;
} & (ContractErrorArgs<abi, errorName> extends readonly []
  ? { args?: readonly [] }
  : { args: ContractErrorArgs<abi, errorName> });

/**
 * What a mocked call reverts with:
 * - a string: `require(cond, "reason")`, encoded as `Error(string)`
 * - `{ errorName, args }`: a custom error from the contract's ABI
 * - `{ panic }`: a `Panic(uint256)` code, e.g. `0x11` for arithmetic overflow
 * - `{ data }`: raw revert data, for errors not on the ABI
 * - nothing: a bare `revert()` with empty data
 */
export type RevertSpec<
  abi extends Abi = Abi,
  errorName extends ContractErrorName<abi> = ContractErrorName<abi>,
> = string | CustomRevert<abi, errorName> | { panic: number | bigint } | { data: Hex };

export type RevertFn<abi extends Abi> = <
  errorName extends ContractErrorName<abi> = ContractErrorName<abi>,
>(
  spec?: RevertSpec<abi, errorName>,
) => never;

export type ResolverContext<abi extends Abi, args, fault = MockFault> = MockCall<args> & {
  /** Revert this call, e.g. `revert('paused')` or `revert({ errorName, args })`. */
  revert: RevertFn<abi>;
  /**
   * Fail the whole JSON-RPC request with a transport-level fault, e.g.
   * `fail({ status: 503 })`. See `MockFault` for the kinds. In `simulate`, it
   * also takes a node's refusal by name, e.g. `fail("insufficientFunds")`.
   */
  fail: (fault: fault) => never;
};

/** A static value, or a function answering each call; it may be async. */
type Resolver<abi extends Abi, args, result, fault = MockFault> =
  | result
  | ((context: ResolverContext<abi, args, fault>) => result | Promise<result>);

/** How a mock answers: `.returns()`, `.reverts()`, or `.fails()`. */
export type MockFunctionAnswers<abi extends Abi, args, result, fault = MockFault> = {
  /** With no argument, answers with zero values, like `.returns(zeroResult)`. */
  returns(): void;
  returns(value: Resolver<abi, args, result, fault>): void;
  /** Revert every matching call. See `RevertSpec` for the accepted forms. */
  reverts<errorName extends ContractErrorName<abi> = ContractErrorName<abi>>(
    spec?: RevertSpec<abi, errorName>,
  ): void;
  /**
   * Fail every matching call at the network level: the whole JSON-RPC request,
   * including a multicall batch it's in, throws the error viem's `http`
   * transport would, so viem's retries apply. See `MockFault` for the kinds.
   * In `simulate`, it also takes a node's refusal by name, e.g.
   * `"insufficientFunds"` (see `NodeErrorName`).
   */
  fails(fault: fault): void;
};

export type MockFunction<abi extends Abi, args, result, fault = MockFault> = MockFunctionAnswers<
  abi,
  args,
  result,
  fault
> & {
  /**
   * Answer only the next matching call, then step aside for the next best
   * mock. Limited mocks go ahead of unlimited ones as specific, oldest first,
   * so `fn().once().fails("network")` beside `fn().returns(1n)` fails once
   * whichever is registered first. Retries use up answers too.
   */
  once(): MockFunctionAnswers<abi, args, result, fault>;
  /** Like `.once()`, for the next `count` matching calls. */
  times(count: number): MockFunctionAnswers<abi, args, result, fault>;
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
    >,
    FaultOf<mutability>
  >;
  /** Every call to this function the mock has received, in order. */
  readonly calls: MockCall<ContractFunctionArgs<abi, mutability, functionName>, functionName>[];
};

/** How a contract's estimate answers: with gas, `.reverts()`, or `.fails()`. */
export type MockContractEstimateAnswers<abi extends Abi, args> = MockEstimateAnswers<
  ResolverContext<abi, args, MockNodeFault>
> & {
  /** Revert every matching estimate, as `simulate` reverts. See `RevertSpec` for the forms. */
  reverts<errorName extends ContractErrorName<abi> = ContractErrorName<abi>>(
    spec?: RevertSpec<abi, errorName>,
  ): void;
};

/** Mirrors `estimateContractGas` for one function, but registers a mock. */
export type MockEstimateGasFunction<
  abi extends Abi,
  functionName extends ContractFunctionName<abi, WriteMutability>,
> = {
  <const args extends ContractFunctionArgs<abi, WriteMutability, functionName>>(
    args?: args,
  ): MockContractEstimateAnswers<abi, args> & {
    /** See `MockFunction`'s `once()`. */
    once(): MockContractEstimateAnswers<abi, args>;
    /** Like `.once()`, for the next `count` matching estimates. */
    times(count: number): MockContractEstimateAnswers<abi, args>;
  };
  /** Every estimate of this function the mock has received, in order. */
  readonly calls: MockCall<
    ContractFunctionArgs<abi, WriteMutability, functionName>,
    functionName
  >[];
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
  /** Every call to any of this contract's functions, in order. Estimates aren't calls. */
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
   * Nonpayable and payable functions' gas, answered over `eth_estimateGas`
   * as `estimateContractGas` sends them, and as viem prepares a write. A
   * `simulate` mock doesn't answer estimates. These answer before
   * `mock.actions.estimateGas`, which answers what they don't.
   */
  estimateGas: {
    [functionName in ContractFunctionName<abi, WriteMutability>]: MockEstimateGasFunction<
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
    MockReturnType<abi, functionName, OverloadsReturnType<abi, mutability, functionName>>,
    FaultOf<mutability>
  >;
};

/**
 * One resolver per function, keyed by namespace like `MockContract`. Defaults
 * are registered before any other mock, so `read`/`simulate`/`estimateGas`
 * mocks always override them.
 */
export type MockContractDefaults<abi extends Abi> = {
  read?: NamespaceDefaults<abi, ReadMutability>;
  simulate?: NamespaceDefaults<abi, WriteMutability>;
  estimateGas?: {
    [functionName in ContractFunctionName<abi, WriteMutability>]?:
      | bigint
      | ((
          context: ResolverContext<
            abi,
            ContractFunctionArgs<abi, WriteMutability, functionName>,
            MockNodeFault
          >,
        ) => bigint | Promise<bigint>);
  };
};

export type CreateMockContractParameters<abi extends Abi> = {
  abi: abi;
  address: Address;
  /** A name for messages and history, e.g. `"USDC"`. Defaults to the address alone. */
  name?: string;
  defaults?: MockContractDefaults<abi>;
};
