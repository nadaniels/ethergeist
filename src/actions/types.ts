import type { Address, BlockTag, Hash, Hex } from "viem";

import type { LogsCall } from "../logs/filter.js";
import type { MockFault, WithLimits } from "../mocking/types.js";
import type { zeroResult } from "../mocking/zeroResult.js";

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

export type ActionContext<call> = call & {
  /**
   * Fail the whole JSON-RPC request with a transport-level fault, e.g.
   * `fail({ status: 503 })`. See `MockFault` for the kinds.
   */
  fail: (fault: MockFault) => never;
};

/** What an action mock answers with: a value in viem's types, or `zeroResult` for its zero. */
type ActionValue<value> = value | typeof zeroResult;

/** How a mock answers: `.returns()` or `.fails()`. */
export type MockActionAnswers<call, value, context = ActionContext<call>> = {
  /** With no argument, answers with the zero value, like `.returns(zeroResult)`. */
  returns(): void;
  returns(
    value:
      | ActionValue<value>
      | ((context: context) => ActionValue<value> | Promise<ActionValue<value>>),
  ): void;
  /** Fail every matching request at the network level. See `MockFault` for the kinds. */
  fails(fault: MockFault): void;
};

export type MockActionBuilder<call, value, context = ActionContext<call>> = WithLimits<
  MockActionAnswers<call, value, context>
>;

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

export type MockMethodBuilder = MockActionBuilder<MethodCall, RpcValue>;
