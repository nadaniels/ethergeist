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
  MockLogContent,
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
import type { MockWriteAnswers, MockWriteOutcome } from "../transactions/writes.js";

/**
 * A contract's events by name, each placing its log as a transaction of its
 * own: `mock.addTransaction()`'s shorthand, with its `blockNumber` and
 * `hash` options (see `AddTransactionParameters`); the log's
 * `transactionHash` is that `hash`. Each call is one transaction, in a newly
 * mined block unless `blockNumber` names one. For two logs in one
 * transaction, use `mock.addTransaction({ logs: [a, b] })`.
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
/**
 * What a namespace's mocks can fail with: a node refuses only transactions by
 * name.
 */
type FaultOf<mutability> = [mutability] extends [ReadMutability]
  ? MockFault
  : MockNodeFault<SimulateErrorName>;

/** The Multicall3 `aggregate3` batch a call arrived in, and its place in it. */
export type MockBatch = {
  /** The batch's id, shared by every call in the same `aggregate3` request. */
  id: number;
  /** The call's position in the batch, from `0`. */
  index: number;
  /**
   * The batch's sender, the account that sent the `aggregate3` call;
   * `undefined` without one. The call's own `from` is the Multicall3
   * address.
   */
  from: Address | undefined;
};

/**
 * The EVM call's context, as a contract's mock sees it: who sent it, the
 * value, the block and the batch. A resolver gets it in `ResolverContext`.
 */
export type CallContext = {
  /**
   * The sender, checksummed; `undefined` for a call without one, as viem's
   * `readContract()` without an `account` sends. A multicall's sub-call is
   * from the Multicall3 address.
   */
  from: Address | undefined;
  /** Wei sent with the call; `0n` when none, as for a multicall's sub-call. */
  value: bigint;
  /**
   * The block the call runs at, as a number: the request's for a call or an
   * estimate. For a send, it's the block current when the send arrives, and
   * the send is mined in the next.
   */
  blockNumber: bigint;
  /** The Multicall3 batch the call arrived in; `undefined` outside one. */
  batch: MockBatch | undefined;
};

/**
 * A decoded contract call: the contract, the function and its args, with
 * the call's context (see `CallContext`).
 */
export type MockCall<
  args = readonly unknown[],
  functionName extends string = string,
> = CallContext & {
  /** The contract's address, checksummed. */
  address: Address;
  /** The function called, by name. */
  functionName: functionName;
  /** The call's args, decoded into viem's types. */
  args: args;
};

/**
 * Where a contract's call is answered, as its mocks are registered: an
 * `eth_call` in its function's `read` or `simulate`, an `eth_estimateGas` in
 * `estimateGas`, and a send in `write`.
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
 *
 * One form at a time: a spec with the fields of two, e.g.
 * `{ panic, data }`, is a type error, and refused.
 */
export type RevertSpec<
  abi extends Abi = Abi,
  errorName extends ContractErrorName<abi> = ContractErrorName<abi>,
> =
  | string
  | (CustomRevert<abi, errorName> & { panic?: never; data?: never })
  | { panic: number | bigint; errorName?: never; args?: never; data?: never }
  | { data: Hex; errorName?: never; args?: never; panic?: never };

/**
 * The `revert` a contract's resolver gets: it reverts the call with `spec`,
 * typed by the contract's ABI (see `RevertSpec`), and never returns.
 */
export type RevertFn<abi extends Abi> = <
  errorName extends ContractErrorName<abi> = ContractErrorName<abi>,
>(
  spec?: RevertSpec<abi, errorName>,
) => never;

/**
 * What a contract function's resolver gets: the call's fields (see
 * `MockCall`), `revert` and `fail`. The `fault` parameter is what `fail`
 * takes, a `MockFault`, or also a node's refusal by name (`MockNodeFault`)
 * where a node can refuse.
 */
export type ResolverContext<abi extends Abi, args, fault = MockFault> = MockCall<args> & {
  /**
   * Reverts this call, e.g. `revert("paused")` or
   * `revert({ errorName, args })`. See `RevertSpec` for the forms.
   */
  revert: RevertFn<abi>;
  /**
   * Fails the request this call is in with a fault, e.g.
   * `fail({ status: 503 })`: see `MockFault` for the kinds. In `simulate`,
   * `estimateGas` and `write`, it also takes a node's refusal by name, e.g.
   * `fail("insufficientFunds")`.
   */
  fail: (fault: fault) => never;
};

/**
 * A static answer, or a resolver: a function that answers each call, sync or
 * async.
 */
type Resolver<abi extends Abi, args, result, fault = MockFault> =
  | result
  | ((context: ResolverContext<abi, args, fault>) => result | Promise<result>);

/**
 * How a contract function's mock answers: `.returns()`, `.reverts()` or
 * `.fails()`.
 */
export type MockFunctionAnswers<abi extends Abi, args, result, fault = MockFault> = {
  /**
   * Answers every matching call with the function's zero values, as
   * `.returns(zeroResult)` does.
   */
  returns(): void;
  /**
   * Answers every matching call with `value`, in viem's types, or with what
   * a resolver returns for each call, sync or async. A struct may leave
   * fields out, which are zero, and a function whose outputs, two or more,
   * are all named also takes them as an object.
   */
  returns(value: Resolver<abi, args, result, fault>): void;
  /** Reverts every matching call. See `RevertSpec` for the forms. */
  reverts<errorName extends ContractErrorName<abi> = ContractErrorName<abi>>(
    spec?: RevertSpec<abi, errorName>,
  ): void;
  /**
   * Fails every matching call: the request it's in fails with `fault`, a
   * multicall's whole batch included. See `MockFault` for the kinds. In
   * `simulate`, it also takes a node's refusal by name, e.g.
   * `"insufficientFunds"` (see `NodeErrorName`).
   */
  fails(fault: fault): void;
};

/**
 * A contract function's mock, as `read` and `simulate` return it:
 * `.returns()`, `.reverts()` or `.fails()` to answer, and `.once()` or
 * `.times()` to limit it (see `WithLimits`).
 */
export type MockFunctionBuilder<abi extends Abi, args, result, fault = MockFault> = WithLimits<
  MockFunctionAnswers<abi, args, result, fault>
>;

/**
 * What a contract function's mock pins beside its args, matched as they are,
 * matchers included. Each pin makes the mock more specific:
 * `transfer([bob, 5n], { from: alice })` beats `transfer([bob, 5n])`, and
 * `transfer(undefined, { from: alice })` is any args from alice.
 * - `from`: the sender, compared checksummed. It doesn't match a call without
 *   one: viem's `readContract()` without an `account` sends none. A
 *   multicall's sub-call is from the Multicall3 address, its `msg.sender` on
 *   chain; the batch's own sender is its `batch.from`, which no pin matches.
 * - `value`: the wei sent, typed on payable functions only. A call that sends
 *   none has `0n`, so `{ value: 0n }` matches it. On a function that isn't
 *   payable, it's refused at registration. The types don't refuse it on a
 *   nonpayable overload of a name with a payable one, or on any function of
 *   an ABI without literal types (not `as const`).
 */
export type CallPins<abi extends Abi, functionName extends string> = {
  // Without `| undefined`, so a `match.where` predicate isn't given one.
  from?: Address;
  // By name, not the args' overload, so a `match.where` value keeps its type.
} & ("payable" extends Extract<
  abi[number],
  { type: "function"; name: functionName }
>["stateMutability"]
  ? { value?: bigint }
  : unknown);

/**
 * Mirrors `readContract` or `simulateContract` for one function, but
 * registers a mock. Its `args` and `pins` pin the call, as values or
 * matchers (see `CallPins`); with none, it answers every call.
 */
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
   * Every call to this function the mock received, in order: the last
   * `historyLimit` of each overload's.
   */
  readonly calls: MockCall<ContractFunctionArgs<abi, mutability, functionName>, functionName>[];
};

/**
 * How a contract function's estimate mock answers: with gas, `.reverts()` or
 * `.fails()`.
 */
export type MockContractEstimateAnswers<abi extends Abi, args> = MockEstimateAnswers<
  ResolverContext<abi, args, MockNodeFault<EstimateErrorName>>
> & {
  /**
   * Reverts every matching call, as a `simulate` mock reverts a call.
   * See `RevertSpec` for the forms.
   */
  reverts<errorName extends ContractErrorName<abi> = ContractErrorName<abi>>(
    spec?: RevertSpec<abi, errorName>,
  ): void;
};

/**
 * Mirrors `estimateContractGas` for one function, but registers a mock. Its
 * `args` and `pins` pin the call (see `CallPins`); with none, it answers
 * every estimate of the function.
 */
export type MockEstimateGasFunction<
  abi extends Abi,
  functionName extends ContractFunctionName<abi, WriteMutability>,
> = {
  <const args extends ContractFunctionArgs<abi, WriteMutability, functionName>>(
    args?: args,
    pins?: CallPins<abi, functionName>,
  ): WithLimits<MockContractEstimateAnswers<abi, args>>;
  /**
   * Every estimate of this function the mock received, in order: the last
   * `historyLimit` of each overload's.
   */
  readonly calls: MockCall<
    ContractFunctionArgs<abi, WriteMutability, functionName>,
    functionName
  >[];
};

/**
 * What a contract function's `write` resolver gets: the call's fields,
 * `fail`, and `emit` and `revert`, which answer the transaction as it's
 * mined.
 */
export type WriteResolverContext<abi extends Abi, args> = ResolverContext<
  abi,
  args,
  MockNodeFault<SendErrorName>
> & {
  /** The sender: a send always has one. */
  from: Address;
  /**
   * Adds a log, or logs, to the transaction, placed when it's mined, as
   * `.emits()` does. `mock.addTransaction()` and `contract.emit` would
   * place a separate transaction: they're refused in this resolver up to its
   * first `await`, and after it they place one.
   */
  emit: (logs: MockLogContent | readonly MockLogContent[]) => void;
  /**
   * Mines the transaction reverted, e.g. `revert("paused")`, dropping what
   * it emitted. A resolver runs only at the send, so the estimate doesn't
   * revert: see `.reverts()` for that.
   */
  revert: RevertFn<abi>;
};

/**
 * How a contract function's `write` mock answers: as `MockWriteAnswers`
 * says, with `.reverts()` taking the contract's errors.
 */
export type MockContractWriteAnswers<abi extends Abi, args> = Omit<
  MockWriteAnswers<WriteResolverContext<abi, args>, never>,
  "reverts"
> & {
  /**
   * Reverts every matching call's transaction. Its estimate reverts with
   * `spec`, before any estimate mock, this contract's own included, so a
   * client that estimates first throws before it sends. That answer uses
   * the mock, spending a `.once()`. A send that reaches the chain anyway is
   * mined reverted. See `RevertSpec` for the forms.
   */
  reverts<errorName extends ContractErrorName<abi> = ContractErrorName<abi>>(
    spec?: RevertSpec<abi, errorName>,
  ): void;
};

/**
 * Mirrors `writeContract` for one function, but registers a mock. Its
 * `args` and `pins` pin the call (see `CallPins`); with none, it answers
 * every send of the function.
 */
export type MockWriteFunction<
  abi extends Abi,
  functionName extends ContractFunctionName<abi, WriteMutability>,
> = {
  <const args extends ContractFunctionArgs<abi, WriteMutability, functionName>>(
    args?: args,
    pins?: CallPins<abi, functionName>,
  ): WithLimits<MockContractWriteAnswers<abi, args>>;
  /**
   * Every send of this function the mock received, in order: the last
   * `historyLimit` of each overload's. A send's nonce, gas and fees are in
   * `mock.actions.sendTransaction.calls`, and its transaction in
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

/**
 * The mock of a view or pure function, as `contract.read` has it: see
 * `MockContractFunction`.
 */
export type MockReadFunction<
  abi extends Abi,
  functionName extends ContractFunctionName<abi, ReadMutability>,
> = MockContractFunction<abi, ReadMutability, functionName>;

/**
 * The mock of a nonpayable or payable function's `eth_call`, as
 * `contract.simulate` has it: see `MockContractFunction`.
 */
export type MockSimulateFunction<
  abi extends Abi,
  functionName extends ContractFunctionName<abi, WriteMutability>,
> = MockContractFunction<abi, WriteMutability, functionName>;

/**
 * A mocked contract, as `mock.contract()` registers it: a mock per function
 * in each namespace, the calls it received, and its events.
 */
export type MockContract<abi extends Abi> = {
  /** The contract's address, checksummed. */
  address: Address;
  /** The name given at registration, if any. */
  name: string | undefined;
  /** The ABI given at registration. */
  abi: abi;
  /**
   * Every call to any of this contract's functions, in every namespace, in
   * order: the last `historyLimit` of them. Each is a copy tagged with its
   * `namespace`; a function's own `.calls` aren't tagged.
   */
  readonly calls: MockTaggedCall<
    NamespaceCall<abi, ReadMutability> | NamespaceCall<abi, WriteMutability>
  >[];
  /**
   * Its view and pure functions, by name, answered over `eth_call` as
   * viem's `readContract()` sends them.
   */
  read: {
    [functionName in ContractFunctionName<abi, ReadMutability>]: MockReadFunction<
      abi,
      functionName
    >;
  };
  /**
   * Its nonpayable and payable functions, by name, answered over `eth_call`
   * as viem's `simulateContract()` sends them. Nothing here answers a send
   * or an estimate.
   */
  simulate: {
    [functionName in ContractFunctionName<abi, WriteMutability>]: MockSimulateFunction<
      abi,
      functionName
    >;
  };
  /**
   * Its nonpayable and payable functions' gas, by name, answered over
   * `eth_estimateGas` as viem's `estimateContractGas()` sends it, and as
   * viem prepares a write. These mocks answer before
   * `mock.actions.estimateGas`, which answers what they don't, and a
   * `write` mock implies the rest. A `.reverts()` `write` mock reverts the
   * estimate of a send it would answer before any of them.
   */
  estimateGas: {
    [functionName in ContractFunctionName<abi, WriteMutability>]: MockEstimateGasFunction<
      abi,
      functionName
    >;
  };
  /**
   * Its nonpayable and payable functions, by name, sent as transactions
   * (`eth_sendTransaction`, `eth_sendRawTransaction` or its Sync form) as
   * viem's `writeContract()` and `writeContractSync()` send them. A mock
   * answers with what the chain did, and the transaction is mined in a new
   * block: see `MockContractWriteAnswers`. Concurrent sends are mined in
   * the order they're answered, which isn't always the order they were
   * sent. These mocks answer before `mock.actions.sendTransaction`, which
   * answers what they don't.
   *
   * A mock without `.reverts()` also answers the transaction's estimate with
   * 100,000 gas when no estimate mock does, without running it or using it
   * up. The function's return value isn't on the chain: a `simulate` mock
   * answers it over `eth_call`, which nothing here answers.
   */
  write: {
    [functionName in ContractFunctionName<abi, WriteMutability>]: MockWriteFunction<
      abi,
      functionName
    >;
  };
  /**
   * The contract's events by name, each building the content of the log its
   * args would emit at this address, for a receipt mock's `logs`, a send's
   * or `mock.addTransaction()`'s, e.g. `events.Transfer({ from, to, value })`.
   * Indexed args are required, and the rest are zero-filled. For a contract
   * the app never calls, `contractEvents({ abi, address })` builds the same
   * content without registering it.
   *
   * A placed log's address is lowercase, as nodes send it: compare it with
   * viem's `isAddressEqual()`, not `toBe(contract.address)`.
   */
  events: MockContractEvents<abi>;
  /**
   * Emits one of the contract's events as a transaction of its own, e.g.
   * `emit.Transfer({ from, to, value })`, for viem's `getLogs()`, watchers
   * and receipts to find, and returns the placed log: see
   * `MockContractEmit`.
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
 * A contract's default answers, keyed by namespace as `MockContract` is,
 * then by function name. Each is a static answer or a resolver, and answers
 * every overload of the name. Any other mock of the function goes ahead of
 * its default, and `mock.assertAllUsed()` doesn't report an unused one.
 */
export type ContractDefaults<abi extends Abi> = {
  /**
   * View and pure functions' answers, as a `read` mock's `.returns()` takes
   * them.
   */
  read?: NamespaceDefaults<abi, ReadMutability>;
  /**
   * Nonpayable and payable functions' `eth_call` answers, as a `simulate`
   * mock's `.returns()` takes them.
   */
  simulate?: NamespaceDefaults<abi, WriteMutability>;
  /**
   * Nonpayable and payable functions' gas, as an `estimateGas` mock's
   * `.returns()` takes it.
   */
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
  /**
   * Nonpayable and payable functions' sends, answered with what the chain
   * did, as a `write` mock's `.returns()` takes it: see `MockWriteOutcome`.
   */
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

/**
 * What `mock.contract()` takes, e.g. for a helper that registers a preset
 * contract.
 */
export type CreateMockContractParameters<abi extends Abi> = {
  /** The contract's ABI, `as const` so args and answers are typed. */
  abi: abi;
  /** The contract's address, in any casing: it's checksummed. */
  address: Address;
  /**
   * A name for messages and history, e.g. `"USDC"`. Without one, they show
   * the address alone.
   */
  name?: string;
  /** Default answers, by namespace and function: see `ContractDefaults`. */
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

/**
 * What `.returns()` takes for a function: viem's return type with structs'
 * fields optional, its named outputs as an object, or `zeroResult`.
 */
type MockReturnType<abi extends Abi, functionName extends string, returnType> =
  | PartialStructs<returnType>
  | NamedOutputs<Extract<abi[number], { type: "function"; name: functionName }>>
  | typeof zeroResult;

/**
 * The record of a contract call the mock received, directly or inside a
 * multicall, and how it was answered.
 */
export type MockCallRecord = {
  /** The address called, checksummed. */
  address: Address;
  /** The contract's name, if it was registered with one. */
  name: string | undefined;
  /**
   * Where the call was answered: see `MockNamespace`. `undefined` for an
   * `eth_call` that wasn't decoded (no contract, unknown selector, an empty
   * address), which has no function to say.
   */
  namespace: MockNamespace | undefined;
  /**
   * The function called, from the contract's ABI; `undefined` when the call
   * couldn't be decoded.
   */
  abiItem: AbiFunction | undefined;
  /**
   * The decoded call; `undefined` when it couldn't be decoded, as for
   * `namespace`.
   */
  call: MockCall | undefined;
  /**
   * How it was answered: see `MockOutcome`. In an estimate or a send, it's
   * how the request ended, whichever mock answered it. A revert is decoded
   * against the contract's ABI.
   */
  outcome: MockOutcome;
};

/** How a request's contract calls report back to its history entry. */
export type Reporter = {
  /** Hears each call's record: the request's own, or a multicall sub-call's. */
  call: (record: MockCallRecord, context: CallContext) => void;
  /** Hears a multicall's batch id, before its sub-calls. */
  batch: (id: number) => void;
};
