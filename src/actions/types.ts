import type { Address, BlockTag, Hash, Hex } from "viem";

import type { MockTransactionType } from "../chain/transactions.js";
import type { LogsCall } from "../logs/filter.js";
import type { MockFault, WithLimits } from "../mocking/types.js";
import type { zeroResult } from "../mocking/zeroResult.js";

/**
 * What a call about an address at a block asked for. A tag resolves to the
 * current block, or `0n` for `"earliest"`, and is kept, so `"pending"` can
 * be pinned apart from `"latest"`. No block is `"latest"`, and a block
 * number or hash has no tag.
 */
export type AddressAtBlockCall = {
  /** The address asked about, checksummed. */
  address: Address;
  /** The block asked about, as a number. */
  blockNumber: bigint;
  /**
   * The block's tag: the request's, or `"latest"` when it gave no block;
   * left out for a block number or hash.
   */
  blockTag?: BlockTag;
};
/** What a call to `getBalance` asked for; see `AddressAtBlockCall`. */
export type BalanceCall = AddressAtBlockCall;
/** What a call to `getCode` asked for; see `AddressAtBlockCall`. */
export type CodeCall = AddressAtBlockCall;
/**
 * What a call to `getBlock` asked for. `blockNumber` is always set: a tag
 * resolves to the current block, or `0n` for `"earliest"`, and a generated
 * block's hash to its number. An unknown hash, one a mock pins, uses the
 * current block.
 */
export type BlockCall = {
  /** The block asked for, as a number. */
  blockNumber: bigint;
  /** The hash asked for, lowercase, however the request wrote it. */
  blockHash?: Hash;
  /**
   * The block's tag: the request's, or `"latest"` when it gave no block;
   * left out for a block number, and for `eth_getBlockByHash`.
   */
  blockTag?: BlockTag;
  /** Whether the request asked for whole transactions, not their hashes. */
  includeTransactions: boolean;
};
/**
 * A JSON value, as JSON-RPC carries it: quantities are hex strings, not
 * bigints.
 */
export type RpcValue =
  | string
  | number
  | boolean
  | null
  | readonly RpcValue[]
  | { readonly [key: string]: RpcValue };

/**
 * What a call to `getFeeHistory` asked for: a number of blocks, up to the
 * newest one.
 */
export type FeeHistoryCall = {
  /** How many blocks the history covers. */
  blockCount: number;
  /**
   * The newest block, as a number: a tag resolves to the current block, or
   * `0n` for `"earliest"`.
   */
  blockNumber: bigint;
  /**
   * The newest block's tag: the request's, or `"latest"` when it gave no
   * block; left out for a block number.
   */
  blockTag?: BlockTag;
  /** The reward percentiles asked for; left out when the request has none. */
  rewardPercentiles?: readonly number[];
};
/**
 * What a call to `getTransactionCount` asked for; see `AddressAtBlockCall`.
 * A node counts transactions waiting to be mined in `"pending"`.
 */
export type TransactionCountCall = AddressAtBlockCall;
/**
 * What a call to `estimateGas` asked for: the transaction, and the block it's
 * estimated at. A field the request has none of is left out.
 */
export type EstimateGasCall = {
  /** The sender. */
  from?: Address;
  /** The recipient; left out for a deploy. */
  to?: Address;
  /** Wei sent; `0n` when the request has none. */
  value: bigint;
  /** The calldata. */
  data?: Hex;
  /** The gas limit asked for. */
  gas?: bigint;
  /** A legacy or EIP-2930 transaction's gas price. */
  gasPrice?: bigint;
  /** An EIP-1559 transaction's fee cap. */
  maxFeePerGas?: bigint;
  /** An EIP-1559 transaction's tip. */
  maxPriorityFeePerGas?: bigint;
  /** The nonce asked for. */
  nonce?: number;
  /** As in `AddressAtBlockCall`. */
  blockNumber: bigint;
  /** As in `AddressAtBlockCall`. */
  blockTag?: BlockTag;
};
/**
 * What a send asked for: the transaction, from `eth_sendTransaction`'s
 * request or a raw send's signed bytes. A raw send has its nonce and gas;
 * other fields the request has none of are left out.
 */
export type SendTransactionCall = {
  /**
   * The sender: the request's, or the signer a raw send's signature
   * recovers.
   */
  from: Address;
  /** The recipient; `null` for a deploy. */
  to: Address | null;
  /** Wei sent; `0n` when it has none. */
  value: bigint;
  /** The calldata; left out when it's empty. */
  data?: Hex;
  /** The nonce asked for. */
  nonce?: number;
  /** The gas limit asked for. */
  gas?: bigint;
  /** A legacy or EIP-2930 transaction's gas price. */
  gasPrice?: bigint;
  /** An EIP-1559 transaction's fee cap. */
  maxFeePerGas?: bigint;
  /** An EIP-1559 transaction's tip. */
  maxPriorityFeePerGas?: bigint;
  /**
   * The request's type, or else as viem's `getTransactionType()` reads its
   * fields, e.g. `"legacy"` with a `gasPrice`, `"eip2930"` with an
   * `accessList` too, `"eip1559"` without.
   */
  type: MockTransactionType;
};
/** What a call to an action without params asked for: nothing. */
export type EmptyCall = Record<string, never>;
/** What a call to `getStorageAt` asked for; see `AddressAtBlockCall`. */
export type StorageCall = AddressAtBlockCall & {
  /**
   * The slot, as 32 bytes, lowercase, however the request wrote it (e.g.
   * `"0x0"`).
   */
  slot: Hex;
};
/** What a call to `getTransactionReceipt` asked for: a transaction's hash. */
export type ReceiptCall = {
  /** The transaction's hash, lowercase, however the request wrote it. */
  hash: Hash;
};
/** What a call to `getTransaction` asked for: a transaction's hash. */
export type TransactionCall = {
  /** The transaction's hash, lowercase, however the request wrote it. */
  hash: Hash;
};
/** What a raw method's request asked for, as a `mock.method()` mock sees it. */
export type MethodCall = {
  /** The JSON-RPC method. */
  method: string;
  /** The request's params, as sent. */
  params: readonly RpcValue[];
};

/** Each typed action's decoded call, by the action's name. */
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
  sendTransaction: SendTransactionCall;
};

/**
 * What an action's resolver gets: the call's fields, and `fail`. Where a
 * node can refuse (estimates, sends), it also gets `refuse` (see
 * `RefusalContext`).
 */
export type ActionContext<call> = call & {
  /**
   * Fails the request this call is in with a fault, e.g.
   * `fail({ status: 503 })`: see `MockFault` for the kinds.
   */
  fail: (fault: MockFault) => never;
};

/**
 * What an action's mock answers with: a value in viem's types, or
 * `zeroResult` for the action's zero.
 */
type ActionValue<value> = value | typeof zeroResult;

/** How an action's mock answers: `.returns()` or `.fails()`. */
export type MockActionAnswers<call, value, context = ActionContext<call>> = {
  /**
   * Answers every matching call with the action's zero, as
   * `.returns(zeroResult)` does.
   */
  returns(): void;
  /**
   * Answers every matching call with `value`, in viem's types, or with what
   * a resolver returns for each call, sync or async.
   */
  returns(
    value:
      | ActionValue<value>
      | ((context: context) => ActionValue<value> | Promise<ActionValue<value>>),
  ): void;
  /**
   * Fails every matching call: the request it's in fails with `fault`. See
   * `MockFault` for the kinds.
   */
  fails(fault: MockFault): void;
};

/**
 * An action's mock, as registering it returns it: `.returns()` or `.fails()`
 * to answer, and `.once()` or `.times()` to limit it (see `WithLimits`).
 */
export type MockActionBuilder<call, value, context = ActionContext<call>> = WithLimits<
  MockActionAnswers<call, value, context>
>;

/**
 * Mirrors the viem action of the same name, but registers a mock. Its params
 * pin the call's fields, as values or matchers; with none, it answers every
 * call.
 */
export type MockAction<call, value, context = ActionContext<call>> = {
  (params?: Partial<call>): MockActionBuilder<call, value, context>;
  /**
   * Every call to this action the mock received, in order: the last
   * `historyLimit` of them.
   */
  readonly calls: call[];
};

/** Like `MockAction`, for an action without params: there's nothing to pin. */
export type MockActionWithoutParams<value> = {
  (): MockActionBuilder<EmptyCall, value, ActionContext<object>>;
  /**
   * Every call to this action the mock received, in order: the last
   * `historyLimit` of them.
   */
  readonly calls: EmptyCall[];
};

/**
 * A raw method's mock, as `mock.method()` returns it. It answers with a raw
 * JSON-RPC value (`RpcValue`), and `.returns()` without one answers `null`.
 * A resolver gets the request's `method` and `params`.
 */
export type MockMethodBuilder = MockActionBuilder<MethodCall, RpcValue>;
