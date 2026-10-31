import type { Address, BlockTag, Hash, Hex } from "viem";
import type { MockBlock, MockFeeHistory } from "../blocks.js";
import type { EmittedLog } from "../events.js";
import type { LogsCall } from "../logs.js";
import type { MockEstimateAnswers, MockFault, MockNodeFault } from "../mocking/types.js";
import type { MockReceipt, MockTransaction } from "../receipts.js";
import type { zeroResult } from "../result.js";

/**
 * What a call about an address at a block asked for. A tag resolves to the
 * mock's block number and is kept, so `"pending"` can be pinned apart from
 * `"latest"`; no block is `"latest"`, and a block number has no tag.
 */
export type AddressAtBlockCall = { address: Address; blockNumber: bigint; blockTag?: BlockTag };
/** What a call to `getBalance` asked for; see `AddressAtBlockCall`. */
export type BalanceCall = AddressAtBlockCall;
/** What a call to `getCode` asked for; see `AddressAtBlockCall`. */
export type CodeCall = AddressAtBlockCall;
/**
 * What a call to `getBlock` asked for. `blockNumber` is always set: a tag
 * resolves to the mock's block number, and a generated block's hash to its
 * number. An unknown hash (one a mock pins) uses the mock's block number.
 */
export type BlockCall = {
  blockNumber: bigint;
  blockHash?: Hash;
  blockTag?: BlockTag;
  includeTransactions: boolean;
};
/** A JSON value, as JSON-RPC carries it: quantities are hex strings, not bigints. */
export type RpcValue =
  | string
  | number
  | boolean
  | null
  | readonly RpcValue[]
  | { readonly [key: string]: RpcValue };

/**
 * What a call to `getFeeHistory` asked for. `blockNumber` is the newest
 * block: a tag resolves to the mock's block number. `rewardPercentiles` is
 * left out when the request has none.
 */
export type FeeHistoryCall = {
  blockCount: number;
  blockNumber: bigint;
  blockTag?: BlockTag;
  rewardPercentiles?: readonly number[];
};
/**
 * What a call to `getTransactionCount` asked for; see `AddressAtBlockCall`.
 * A node counts transactions waiting to be mined in `"pending"`.
 */
export type TransactionCountCall = AddressAtBlockCall;
/**
 * What a call to `estimateGas` asked for: the transaction, and the block it's
 * estimated at. `account` is the sender, sent as `from`; `value` is `0n` when
 * the request has none. Other fields are left out when the request has none.
 * A tag resolves to the mock's block number and is kept; no block is `"latest"`.
 */
export type EstimateGasCall = {
  account?: Address;
  to?: Address;
  value: bigint;
  data?: Hex;
  gas?: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  nonce?: number;
  blockNumber: bigint;
  blockTag?: BlockTag;
};
/** What a call to an action without params asked for: nothing. */
export type EmptyCall = Record<string, never>;
/**
 * What a call to `getStorageAt` asked for; see `AddressAtBlockCall`. `slot`
 * is 32 bytes, lowercase, however the request wrote it (e.g. `"0x0"`).
 */
export type StorageCall = AddressAtBlockCall & { slot: Hex };
/** What a call to `getTransactionReceipt` asked for. */
export type ReceiptCall = { hash: Hash };
/** What a call to `getTransaction` asked for: a transaction by its hash. */
export type TransactionCall = { hash: Hash };
/** A raw JSON-RPC request answered by `mock.method()`. */
export type MethodCall = { method: string; params: readonly RpcValue[] };

export type ActionContext<call> = call & {
  /**
   * Fail the whole JSON-RPC request with a transport-level fault, e.g.
   * `fail({ status: 503 })`. See `MockFault` for the kinds.
   */
  fail: (fault: MockFault) => never;
};

/**
 * What a `getLogs` resolver gets: the filter, `fail`, and `logs`, what the
 * emitted logs would answer. Reading `logs` for a filter a node would refuse
 * (a range past the head, an address without a contract) throws that refusal.
 */
export type LogsContext = ActionContext<LogsCall> & { readonly logs: EmittedLog[] };

/**
 * What an estimate's resolver gets: the call, and `fail`, which also takes a
 * node's refusal by name, e.g. `fail("insufficientFunds")`.
 */
export type EstimateGasContext = EstimateGasCall & { fail: (fault: MockNodeFault) => never };

/** Like `MockActionBuilder`, for an estimate. */
export type MockEstimateBuilder<context> = MockEstimateAnswers<context> & {
  /** See `MockActionBuilder`'s `once()`. */
  once(): MockEstimateAnswers<context>;
  /** Like `.once()`, for the next `count` matching requests. */
  times(count: number): MockEstimateAnswers<context>;
};

/** `MockAction` for `estimateGas`. */
export type MockEstimateGasAction = {
  (params?: Partial<EstimateGasCall>): MockEstimateBuilder<EstimateGasContext>;
  /** Every call to this action the mock has received, in order. */
  readonly calls: EstimateGasCall[];
};

/** How a mock answers: `.returns()` or `.fails()`. */
export type MockActionAnswers<call, value, context = ActionContext<call>> = {
  /** With no argument, answers with the zero value, like `.returns(zeroResult)`. */
  returns(): void;
  returns(value: value | typeof zeroResult | ((context: context) => value | Promise<value>)): void;
  /** Fail every matching request at the network level. See `MockFault` for the kinds. */
  fails(fault: MockFault): void;
};

export type MockActionBuilder<call, value, context = ActionContext<call>> = MockActionAnswers<
  call,
  value,
  context
> & {
  /**
   * Answer only the next matching request, then step aside for the next best
   * mock. Limited mocks go ahead of unlimited ones as specific, oldest first.
   * Retries use up answers too.
   */
  once(): MockActionAnswers<call, value, context>;
  /** Like `.once()`, for the next `count` matching requests. */
  times(count: number): MockActionAnswers<call, value, context>;
};

/**
 * Mirrors the viem action of the same name, but registers a mock. Pin any of
 * the call's fields to narrow it; with none, it answers every call.
 */
export type MockAction<call, value, context = ActionContext<call>> = {
  (params?: Partial<call>): MockActionBuilder<call, value, context>;
  /** Every call to this action the mock has received, in order. */
  readonly calls: call[];
};

/** Like `MockAction`, for an action without params: there's nothing to pin. */
export type MockActionWithoutParams<value> = {
  (): MockActionBuilder<EmptyCall, value, ActionContext<object>>;
  /** Every call to this action the mock has received, in order. */
  readonly calls: EmptyCall[];
};

/** Each typed action's decoded call. */
export type ActionCalls = {
  getBalance: BalanceCall;
  getCode: CodeCall;
  getBlock: BlockCall;
  getTransactionReceipt: ReceiptCall;
  getTransaction: TransactionCall;
  getLogs: LogsCall;
  getGasPrice: EmptyCall;
  estimateMaxPriorityFeePerGas: EmptyCall;
  getBlobBaseFee: EmptyCall;
  getFeeHistory: FeeHistoryCall;
  getTransactionCount: TransactionCountCall;
  getStorageAt: StorageCall;
  estimateGas: EstimateGasCall;
};

/** Mocks for viem's public actions, answered with values in viem's own types. */
export type MockActions = {
  /** `eth_getBalance`. Unmocked addresses aren't answered. */
  getBalance: MockAction<BalanceCall, bigint>;
  /**
   * `eth_getCode`. Unmocked, a registered contract (and Multicall3) answers
   * with placeholder code, `0xfe`, and an `empty()` address with `0x`.
   */
  getCode: MockAction<CodeCall, Hex>;
  /**
   * `eth_getBlockByNumber` and `eth_getBlockByHash`. Unmocked, blocks up to the
   * current one are generated: number, hash, parent hash, a timestamp that
   * follows the chain's `blockTime`, and the base fee (see `fees`), with
   * everything else zero. A mock's fields
   * are merged over the generated block; `null` answers "no such block".
   */
  getBlock: MockAction<BlockCall, Partial<MockBlock> | null>;
  /**
   * `eth_getTransactionReceipt`. A mock's fields go over defaults: `status` is
   * `"success"`, the block is the current one, and logs get their index, block,
   * and transaction from the receipt; the rest is zero. `null` answers "no
   * such transaction". Unmocked hashes aren't answered.
   */
  getTransactionReceipt: MockAction<ReceiptCall, MockReceipt | null>;
  /**
   * `eth_getTransactionByHash`. A mock's fields go over defaults: an
   * `"eip1559"` transaction mined in the current block, at index 0, that paid
   * the suggested fees (see `fees`), with a zero signature; the rest is zero.
   * Fields its `type` doesn't have throw, and `blockNumber: null` makes it
   * pending. `null` answers "no such transaction". Unmocked hashes aren't
   * answered. `mock.buildTransaction()` builds the same transaction.
   */
  getTransaction: MockAction<TransactionCall, MockTransaction | null>;
  /**
   * `eth_getLogs`, for `getLogs` and `getContractEvents`. Unmocked, it's
   * answered from emitted logs (`mock.emit()`), filtered as a node filters
   * them. A mock answers first, with placed logs (from `emit()` or
   * `mock.buildLog()`), or fails, e.g. for a provider's block range cap; its
   * resolver gets the emitted logs the filter matches as `logs`.
   */
  getLogs: MockAction<LogsCall, readonly EmittedLog[], LogsContext>;
  /**
   * `eth_gasPrice`. Unmocked, the current block's base fee plus the tip, as
   * reth suggests (see `fees` in `createMockRpc()`).
   */
  getGasPrice: MockActionWithoutParams<bigint>;
  /**
   * `eth_maxPriorityFeePerGas`, the tip a node suggests. Unmocked, `fees`'
   * `maxPriorityFeePerGas`. viem's `estimateMaxPriorityFeePerGas()` and
   * `estimateFeesPerGas()` don't fail when it fails: they fall back to
   * `eth_gasPrice` minus the base fee.
   */
  estimateMaxPriorityFeePerGas: MockActionWithoutParams<bigint>;
  /**
   * `eth_blobBaseFee`. Unmocked, 1 wei, the protocol's minimum: generated
   * blocks have no excess blob gas.
   */
  getBlobBaseFee: MockActionWithoutParams<bigint>;
  /**
   * `eth_feeHistory`. Unmocked, the generated blocks' history, as reth
   * answers it for empty blocks: their base fees from `fees`, no gas used,
   * and zero rewards. A mock's fields are merged over it. Unmocked, a newest
   * block past the current one and unordered percentiles are refused, as
   * reth refuses them.
   */
  getFeeHistory: MockAction<FeeHistoryCall, MockFeeHistory>;
  /**
   * `eth_getTransactionCount`, an account's nonce: the transactions it has
   * sent. Unmocked addresses aren't answered. viem asks for `"pending"`
   * when preparing a transaction, and `"latest"` by default.
   */
  getTransactionCount: MockAction<TransactionCountCall, number>;
  /**
   * `eth_getStorageAt`, one storage slot of an address. Slots in pins and
   * requests are compared as 32 bytes, so `"0x0"` matches a request for slot
   * zero written in full. Answers are up to 32 bytes, padded to 32 as a node
   * sends them, so `.returns("0x1")` works. Unmocked, an `empty()` address's
   * storage is all zero, as for any address without code; other addresses
   * aren't answered.
   */
  getStorageAt: MockAction<StorageCall, Hex>;
  /**
   * `eth_estimateGas`, for `estimateGas` and the gas a transaction is
   * prepared with. A registered contract's `estimateGas` mocks and defaults
   * answer estimates of its functions first; these answer the rest. Unmocked,
   * a plain transfer, with no data, to an
   * address without code is 21000 gas, as a node estimates it; anything else
   * isn't answered. `.fails()` takes a node's refusal by name, e.g.
   * `"insufficientFunds"`.
   */
  estimateGas: MockEstimateGasAction;
};

export type MockMethodBuilder = MockActionBuilder<MethodCall, RpcValue>;
