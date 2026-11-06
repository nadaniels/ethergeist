import type {
  Abi,
  AbiFunction,
  Address,
  ContractErrorArgs,
  ContractErrorName,
  ContractEventName,
  ContractFunctionArgs,
  ContractFunctionName,
  ContractFunctionReturnType,
  Hex,
  AbiParameter,
  AbiParameterToPrimitiveType,
} from "viem";

import type {
  EmittedLog,
  EventArgsParameter,
  MockContractEvents,
  MockEventLog,
} from "../logs/events.js";
import type { MockOutcome } from "../mocking/outcomes.js";
import type {
  SimulateErrorName,
  EstimateErrorName,
  MockEstimateAnswers,
  MockFault,
  MockNodeFault,
  SendErrorName,
  WithLimits,
} from "../mocking/types.js";
import type { zeroResult } from "../mocking/zeroResult.js";
import type { PartialStructs } from "../shared/abiValues.js";
import type { AddTransactionParameters } from "../transactions/addTransaction.js";
import type { MockWriteAnswers, MockWriteOutcome } from "../transactions/writeOutcome.js";

/**
 * A contract's events by name, each emitting its log as a transaction of
 * its own: `mock.addTransaction()`'s shorthand, placed by its
 * `blockNumber` and `hash`. Each call is one transaction, so two calls are
 * two blocks: add a transaction's logs together, as
 * `mock.addTransaction({ logs: [a, b] })`.
 */
export type MockContractEmit<abi extends Abi> = {
  [eventName in ContractEventName<abi>]: (
    ...params: [
      ...EventArgsParameter<abi, eventName>,
      options?: Pick<AddTransactionParameters, "blockNumber" | "hash">,
    ]
  ) => EmittedLog;
};

type ReadMutability = "pure" | "view";
type WriteMutability = "nonpayable" | "payable";
/** What a namespace's mocks can fail with: a node refuses only transactions by name. */
type FaultOf<mutability> = [mutability] extends [ReadMutability]
  ? MockFault
  : MockNodeFault<SimulateErrorName>;

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

/**
 * Where a contract's call is answered, as its mocks are registered: an
 * `eth_call` in its function's `read` or `simulate`, an `eth_estimateGas` in
 * `estimateGas`, and a sent transaction in `write`.
 */
export type MockNamespace = "read" | "simulate" | "estimateGas" | "write";

/**
 * A call in a list of every namespace's calls (`contract.calls`, `mock.calls`):
 * a copy of the function's own, tagged with its namespace.
 */
export type MockTaggedCall<call = MockCall> = call & { namespace: MockNamespace };

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
   * `fail({ status: 503 })`. See `MockFault` for the kinds. In `simulate`,
   * `estimateGas` and `write`, it also takes a node's refusal by name, e.g.
   * `fail("insufficientFunds")`.
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

/** A contract function's mock, as `read` and `simulate` register it: its answers, with limits. */
export type MockFunctionBuilder<abi extends Abi, args, result, fault = MockFault> = WithLimits<
  MockFunctionAnswers<abi, args, result, fault>
>;

/**
 * What a mock pins beside its args, matched like them (matchers allowed), each
 * counting toward its specificity: `transfer([bob, 5n], { from: alice })`
 * beats `transfer([bob, 5n])`, and `transfer(undefined, { from: alice })` is
 * any args from alice.
 * - `from`: the sender, compared checksummed. It doesn't match a call without
 *   one: viem's `readContract` without an `account` sends none. A multicall's
 *   sub-call is from the Multicall3 address, its `msg.sender` on chain; the
 *   batch's own sender is its `batch.from`, which no pin matches.
 * - `value`: the wei sent, typed on payable functions only. A call that sends
 *   none has `0n`, so `{ value: 0n }` matches it. Pinning it on a nonpayable
 *   function throws at registration, which is all that refuses it on a
 *   nonpayable overload of a name with a payable one, or on any function of
 *   an ABI without literal types (not `as const`).
 */
export type CallPins<abi extends Abi, functionName extends string> = {
  // Without `| undefined`, so a `match.where` predicate isn't given one.
  from?: Address;
  // By name, not by the args' overload: a `match.where` value would lose its type.
} & ("payable" extends Extract<
  abi[number],
  { type: "function"; name: functionName }
>["stateMutability"]
  ? { value?: bigint }
  : unknown);

/** Mirrors `getContract(...).<namespace>.<functionName>(args)`, but registers a mock. */
export type MockContractFunction<
  abi extends Abi,
  mutability extends ReadMutability | WriteMutability,
  functionName extends ContractFunctionName<abi, mutability>,
> = {
  <const args extends ContractFunctionArgs<abi, mutability, functionName>>(
    args?: args,
    pins?: CallPins<abi, functionName>,
  ): MockFunctionBuilder<
    abi,
    args,
    MockReturnType<
      abi,
      functionName,
      ContractFunctionReturnType<abi, mutability, functionName, args>
    >,
    FaultOf<mutability>
  >;
  /**
   * Every call to this function the mock has received, in order (the last
   * `historyLimit` of each overload).
   */
  readonly calls: MockCall<ContractFunctionArgs<abi, mutability, functionName>, functionName>[];
};

/** How a contract's estimate answers: with gas, `.reverts()`, or `.fails()`. */
export type MockContractEstimateAnswers<abi extends Abi, args> = MockEstimateAnswers<
  ResolverContext<abi, args, MockNodeFault<EstimateErrorName>>
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
    pins?: CallPins<abi, functionName>,
  ): WithLimits<MockContractEstimateAnswers<abi, args>>;
  /**
   * Every estimate of this function the mock has received, in order (the
   * last `historyLimit` of each overload).
   */
  readonly calls: MockCall<
    ContractFunctionArgs<abi, WriteMutability, functionName>,
    functionName
  >[];
};

/**
 * What a contract write's resolver gets, whole: the call, whose `from` is
 * the sender; `fail`; and `emit` and `revert`, which answer the
 * transaction as it's mined.
 */
export type WriteResolverContext<abi extends Abi, args> = ResolverContext<
  abi,
  args,
  MockNodeFault<SendErrorName>
> & {
  from: Address;
  /**
   * Adds a log, or logs, to the transaction, placed when it's mined, as
   * `.emits()` does. Use it rather than `mock.addTransaction()` or
   * `contract.emit`, which would put a transaction of their own on the
   * chain, and are refused in this resolver up to its first `await` (after
   * it, they would still place that separate transaction).
   */
  emit: (logs: MockEventLog | readonly MockEventLog[]) => void;
  /**
   * Mine the transaction reverted, e.g. `revert("paused")`, dropping what
   * it emitted. A resolver runs only at the send, so the estimate doesn't
   * revert: see `.reverts()` for that.
   */
  revert: RevertFn<abi>;
};

/**
 * How a contract's write answers: with what the chain did (see
 * `MockWriteAnswers`), its revert spelled with the contract's errors.
 */
export type MockContractWriteAnswers<abi extends Abi, args> = Omit<
  MockWriteAnswers<WriteResolverContext<abi, args>, never>,
  "reverts"
> & {
  /**
   * The transaction reverts: its estimate reverts with `spec`, before any
   * estimate mock (this contract's own included), so a client that
   * estimates first throws before it sends (that's this mock's answer,
   * which uses it, spending a `.once()`); a send that reaches the chain
   * anyway is mined reverted. See `RevertSpec` for the forms.
   */
  reverts<errorName extends ContractErrorName<abi> = ContractErrorName<abi>>(
    spec?: RevertSpec<abi, errorName>,
  ): void;
};

/** Mirrors `writeContract` for one function, but registers a mock. */
export type MockWriteFunction<
  abi extends Abi,
  functionName extends ContractFunctionName<abi, WriteMutability>,
> = {
  <const args extends ContractFunctionArgs<abi, WriteMutability, functionName>>(
    args?: args,
    pins?: CallPins<abi, functionName>,
  ): WithLimits<MockContractWriteAnswers<abi, args>>;
  /**
   * Every send of this function the mock has received, in order (the last
   * `historyLimit` of each overload). Its nonce, gas and fees are on
   * `mock.actions.sendTransaction.calls`, and what was mined on
   * `mock.transactions`.
   */
  readonly calls: (MockCall<
    ContractFunctionArgs<abi, WriteMutability, functionName>,
    functionName
  > & { from: Address })[];
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
  /**
   * Every call to any of this contract's functions, in every namespace, in
   * order (the last `historyLimit`). Each is a copy tagged with its
   * `namespace`; a function's own `.calls` aren't tagged.
   */
  readonly calls: MockTaggedCall<
    NamespaceCall<abi, ReadMutability> | NamespaceCall<abi, WriteMutability>
  >[];
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
   * `mock.actions.estimateGas`, which answers what they don't; a `write`
   * mock implies the rest. A `.reverts()` `write` mock reverts the estimate
   * of a send it would answer before any of them.
   */
  estimateGas: {
    [functionName in ContractFunctionName<abi, WriteMutability>]: MockEstimateGasFunction<
      abi,
      functionName
    >;
  };
  /**
   * Nonpayable and payable functions, sent as transactions
   * (`eth_sendTransaction`, `eth_sendRawTransaction` or its Sync form), as
   * `writeContract` and `writeContractSync` send them: a mock answers with what the chain did, and the
   * transaction is mined in a new block. These answer before
   * `mock.actions.sendTransaction`, which answers what they don't.
   *
   * `.returns()` takes the outcome (`MockWriteOutcome`): its logs, a
   * reverted status, its gas; `.emits(log)` or `.emits([a, b])` is
   * `.returns({ logs: [a, b] })`. The return value isn't on the chain: it
   * goes on `simulate`. `.reverts(spec)` reverts its estimate, before any
   * estimate mock (an answer, which uses the mock), and mines it reverted if
   * it's sent anyway.
   * `.fails()` takes a node's refusal by name, e.g. `"insufficientFunds"`. Any
   * other matching mock also answers the transaction's `eth_estimateGas` (when no
   * `estimateGas` mock does) with 100,000 gas, without running it or using
   * it up. Nothing here answers an `eth_call`: `simulate` does.
   */
  write: {
    [functionName in ContractFunctionName<abi, WriteMutability>]: MockWriteFunction<
      abi,
      functionName
    >;
  };
  /**
   * The contract's events, each building the log its args would emit at this
   * address, e.g. `events.Transfer({ from, to, value })`, for a mocked
   * receipt's `logs`. Indexed args are required; the rest are zero-filled.
   * For a contract the app never calls, `contractEvents({ abi, address })`
   * builds the same logs without registering it.
   * Once placed (in a receipt, emitted, or as the app gets it), its address
   * is lowercase, as nodes send it: compare with viem's `isAddressEqual`,
   * not `toBe(contract.address)`.
   */
  events: MockContractEvents<abi>;
  /**
   * Emits one of the contract's events, as a transaction of its own in a
   * newly mined block, e.g. `emit.Transfer({ from, to, value })`, for
   * `getLogs`, watchers and receipts to find. Returns the placed log.
   * Shorthand for `mock.addTransaction({ logs: [contract.events.X(args)] })`,
   * placed by `options`, addTransaction's `blockNumber` and `hash` (see
   * `AddTransactionParameters`): the log's `transactionHash` is that `hash`.
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
 * are registered before any other mock, so `read`/`simulate`/`estimateGas`/
 * `write` mocks always override them.
 */
export type ContractDefaults<abi extends Abi> = {
  read?: NamespaceDefaults<abi, ReadMutability>;
  simulate?: NamespaceDefaults<abi, WriteMutability>;
  estimateGas?: {
    [functionName in ContractFunctionName<abi, WriteMutability>]?:
      | bigint
      | ((
          context: ResolverContext<
            abi,
            ContractFunctionArgs<abi, WriteMutability, functionName>,
            MockNodeFault<EstimateErrorName>
          >,
        ) => bigint | Promise<bigint>);
  };
  write?: {
    [functionName in ContractFunctionName<abi, WriteMutability>]?:
      | MockWriteOutcome
      | ((
          context: WriteResolverContext<
            abi,
            ContractFunctionArgs<abi, WriteMutability, functionName>
          >,
        ) => MockWriteOutcome | void | Promise<MockWriteOutcome | void>);
  };
};

/** What `mock.contract()` takes, e.g. for a helper that registers a preset contract. */
export type CreateMockContractParameters<abi extends Abi> = {
  abi: abi;
  address: Address;
  /** A name for messages and history, e.g. `"USDC"`. Defaults to the address alone. */
  name?: string;
  defaults?: ContractDefaults<abi>;
};

/**
 * A multi-output function's outputs as an object keyed by output name, for
 * functions with two or more outputs that are all named. "All named" is
 * spelled out, not a shared alias: TypeScript writes this file-local type
 * out in a consumer's declarations, which can't name an alias `index.ts`
 * doesn't export.
 */
type NamedOutputs<abiFunction> = abiFunction extends {
  outputs: infer outputs extends readonly [AbiParameter, AbiParameter, ...AbiParameter[]];
}
  ? false extends (
      outputs[number] extends { name: infer name extends string }
        ? name extends ""
          ? false
          : true
        : false
    )
    ? never
    : {
        [output in outputs[number] as output["name"] & string]?: PartialStructs<
          AbiParameterToPrimitiveType<output, "outputs">
        >;
      }
  : never;

/** What `.returns()` accepts for a function: viem's return type, or named outputs. */
type MockReturnType<abi extends Abi, functionName extends string, returnType> =
  | PartialStructs<returnType>
  | NamedOutputs<Extract<abi[number], { type: "function"; name: functionName }>>
  | typeof zeroResult;

/** A contract call the mock dispatched, directly or inside a multicall. */
export type MockCallRecord = {
  address: Address;
  /** The contract's name, if it was registered with one. */
  name: string | undefined;
  /**
   * Where the call was answered: see `MockNamespace`. `undefined` for an
   * `eth_call` that wasn't decoded (no contract, unknown selector, an empty
   * address), which has no function to say.
   */
  namespace: MockNamespace | undefined;
  /** The function called, from the contract's ABI; `undefined` when it couldn't be decoded. */
  abiItem: AbiFunction | undefined;
  /** The decoded call, or `undefined` if it couldn't be decoded (no contract, unknown selector, an empty address). */
  call: MockCall | undefined;
  outcome: MockOutcome;
};

/** How a request's contract calls report back to its history entry. */
export type Reporter = {
  /** Hears each call's record: the request's own, or a multicall sub-call's. */
  call: (record: MockCallRecord, context: CallContext) => void;
  /** Hears a multicall's batch id, before its sub-calls. */
  batch: (id: number) => void;
};
