import type { Hex } from "viem";

import type { MockBlock } from "../chain/blocks.js";
import type { MockFeeHistory } from "../chain/fees.js";
import type { MockTransaction } from "../chain/transactions.js";
import type { EmittedLog } from "../logs/events.js";
import type { LogsCall } from "../logs/filter.js";
import type { MockReceipt } from "../transactions/store.js";
import type { MockEstimateGasAction } from "./estimateGas.js";
import { estimateMaxPriorityFeePerGas } from "./estimateMaxPriorityFeePerGas.js";
import { getBalance } from "./getBalance.js";
import { getBlobBaseFee } from "./getBlobBaseFee.js";
import { getBlock } from "./getBlock.js";
import { getCode } from "./getCode.js";
import { getFeeHistory } from "./getFeeHistory.js";
import { getGasPrice } from "./getGasPrice.js";
import { getLogs, type LogsContext } from "./getLogs.js";
import { getStorageAt } from "./getStorageAt.js";
import { getTransaction } from "./getTransaction.js";
import { getTransactionCount, type TransactionCountContext } from "./getTransactionCount.js";
import { getTransactionReceipt } from "./getTransactionReceipt.js";
import type { MockSendTransactionAction } from "./sendTransaction.js";
import type { ActionsContext, Definition } from "./table.js";
import type {
  ActionCalls,
  BalanceCall,
  BlockCall,
  CodeCall,
  FeeHistoryCall,
  ReceiptCall,
  StorageCall,
  TransactionCall,
  TransactionCountCall,
  MockAction,
  MockActionWithoutParams,
} from "./types.js";

/**
 * Every typed action a table answers: its definition, and the JSON-RPC
 * methods it answers. An action is added here, in `MockActions`, and in
 * `ActionCalls`.
 */
export const typedActions = {
  getBalance: { define: getBalance, methods: ["eth_getBalance"] },
  getCode: { define: getCode, methods: ["eth_getCode"] },
  getBlock: { define: getBlock, methods: ["eth_getBlockByNumber", "eth_getBlockByHash"] },
  getTransactionReceipt: {
    define: getTransactionReceipt,
    methods: ["eth_getTransactionReceipt"],
  },
  getTransaction: { define: getTransaction, methods: ["eth_getTransactionByHash"] },
  getLogs: { define: getLogs, methods: ["eth_getLogs"] },
  getGasPrice: { define: getGasPrice, methods: ["eth_gasPrice"] },
  estimateMaxPriorityFeePerGas: {
    define: estimateMaxPriorityFeePerGas,
    methods: ["eth_maxPriorityFeePerGas"],
  },
  getBlobBaseFee: { define: getBlobBaseFee, methods: ["eth_blobBaseFee"] },
  getFeeHistory: { define: getFeeHistory, methods: ["eth_feeHistory"] },
  getTransactionCount: { define: getTransactionCount, methods: ["eth_getTransactionCount"] },
  getStorageAt: { define: getStorageAt, methods: ["eth_getStorageAt"] },
} satisfies {
  [name in Exclude<keyof ActionCalls, keyof typeof sendsMethods>]: {
    define: (context: ActionsContext) => Definition<ActionCalls[name]>;
    methods: readonly string[];
  };
};

/**
 * The JSON-RPC methods of the two typed actions no table answers: sends and
 * their estimates, which `createSends` answers.
 */
export const sendsMethods = {
  estimateGas: ["eth_estimateGas"],
  sendTransaction: ["eth_sendTransaction", "eth_sendRawTransaction", "eth_sendRawTransactionSync"],
} as const;

/** A typed action's name, e.g. `"getBalance"`. */
export type ActionName = keyof ActionCalls;

/** Mocks for viem's public actions, answering with values in viem's types. */
export type MockActions = {
  /** `eth_getBalance`. Unmocked, it isn't answered. */
  getBalance: MockAction<BalanceCall, bigint>;
  /**
   * `eth_getCode`. Unmocked, a registered contract and Multicall3 answer with
   * placeholder code, `0xfe`, an `empty()` address with `0x`, and other
   * addresses aren't answered.
   */
  getCode: MockAction<CodeCall, Hex>;
  /**
   * `eth_getBlockByNumber` and `eth_getBlockByHash`. Unmocked, blocks up to the
   * current one are generated: number, hash, parent hash, a timestamp that
   * follows the chain's `blockTime`, the base fee (see `fees`), and the
   * transactions placed in it, with everything else zero; others aren't
   * answered. A mock's fields go over the generated block, its transactions
   * too unless the mock sets `transactions`. A block past the head, or a
   * hash only the mock knows, lists none. `null` answers "no such block".
   */
  getBlock: MockAction<BlockCall, Partial<MockBlock> | null>;
  /**
   * `eth_getTransactionReceipt`. Unmocked, a placed transaction's hash
   * answers its receipt, or `null` while it's waiting, and other hashes
   * aren't answered. A mock's fields go over what the chain would answer at
   * that request: the transaction's receipt once it's mined, and otherwise
   * `status: "success"` with zeros, in the block current at registration
   * for a static answer, or at the request for a resolver. `null` answers
   * "no such transaction".
   *
   * `logs` takes their content, e.g. from `contract.events`, in place of the
   * transaction's logs on the chain; the receipt's block and transaction
   * place them, and the chain's logs too. They answer this receipt only: for
   * viem's `getLogs()` and watchers to see them, use
   * `mock.addTransaction({ hash, logs })`. A reverted status with logs, its
   * own or the chain's, is refused, as a reverted transaction has none.
   */
  getTransactionReceipt: MockAction<ReceiptCall, MockReceipt | null>;
  /**
   * `eth_getTransactionByHash`. Unmocked, a placed transaction's hash
   * answers it, pending while it's waiting, and other hashes aren't
   * answered. A mock's fields go over what the chain would answer: the
   * hash's transaction, pending or mined, or for a hash the chain doesn't
   * have, an `"eip1559"` transaction at index 0 that paid the suggested fees
   * (see `fees`), with a zero signature and the rest zero. That one is mined
   * in the block current at registration for a static answer, or at the
   * request for a resolver.
   *
   * Fields its `type` doesn't have throw, and `blockNumber: null` makes it
   * pending. `null` answers "no such transaction". `mock.buildTransaction()`
   * builds the transaction for a hash the chain doesn't have.
   */
  getTransaction: MockAction<TransactionCall, MockTransaction | null>;
  /**
   * `eth_getLogs`, for viem's `getLogs()` and `getContractEvents()`.
   * Unmocked, the chain's logs answer it, from `mock.addTransaction()`,
   * `contract.emit` and sends, filtered as a node filters them, at any
   * address: `[]` where nothing was emitted. A mock answers first, with
   * placed logs (from `mock.logs` or `mock.buildLog()`), or fails, e.g. for
   * a provider's block range cap. Its resolver gets the chain's logs the
   * filter matches as `logs`.
   */
  getLogs: MockAction<LogsCall, readonly EmittedLog[], LogsContext>;
  /**
   * `eth_gasPrice`. Unmocked, the current block's base fee plus the tip, as
   * reth suggests (see `fees` in `createMockRpc()`).
   */
  getGasPrice: MockActionWithoutParams<bigint>;
  /**
   * `eth_maxPriorityFeePerGas`, the tip a node suggests. Unmocked, the
   * current block's `maxPriorityFeePerGas` (see `fees`). viem's
   * `estimateMaxPriorityFeePerGas()` and `estimateFeesPerGas()` don't fail
   * when it fails: they fall back to `eth_gasPrice` minus the base fee.
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
   * and zero rewards; a newest block past the current one, and percentiles
   * out of order or outside 0 to 100, are refused, as reth refuses them. A
   * mock's fields go over that history.
   */
  getFeeHistory: MockAction<FeeHistoryCall, MockFeeHistory>;
  /**
   * `eth_getTransactionCount`, an account's nonce. Unmocked, the chain's
   * count: one past the highest nonce of the address's transactions, or `0`
   * with none. It counts the address's sends and the transactions added
   * with it as `from`, mined at or before the block, or all of them at
   * `"pending"`. viem asks for `"pending"` when preparing a transaction, and
   * `"latest"` by default.
   *
   * A static `.returns(7)` is the answer, so it doesn't count up. For a
   * starting nonce that does, a resolver reads `count`, e.g.
   * `.returns(({ count }) => Math.max(7, count))`. An `eth_sendTransaction`
   * without a nonce takes the chain's count, not these mocks' answer.
   */
  getTransactionCount: MockAction<TransactionCountCall, number, TransactionCountContext>;
  /**
   * `eth_getStorageAt`, one storage slot of an address. Slots in pins and
   * requests are compared as 32 bytes, so `"0x0"` matches a request for slot
   * zero written in full. Answers are up to 32 bytes, padded to 32 as a node
   * sends them, so `.returns("0x1")` works. Unmocked, an `empty()` address's
   * storage is all zero, as for any address without code, and other
   * addresses aren't answered.
   */
  getStorageAt: MockAction<StorageCall, Hex>;
  /**
   * `eth_estimateGas`, for viem's `estimateGas()` and the gas a transaction
   * is prepared with. A `.reverts()` send mock (`write` or
   * `sendTransaction`) that would answer the transaction reverts its
   * estimate first, before any estimate mock. Then a registered contract's
   * `estimateGas` mocks and defaults answer estimates of its functions, and
   * these mocks answer the rest.
   *
   * Unmocked, a plain transfer, with no data, to an address without code is
   * 21,000 gas, as a node estimates it, even with a send mock. Otherwise, a
   * send mock that would answer the transaction implies 100,000 gas, and
   * anything else isn't answered.
   * `.fails()` takes a node's refusal by name, e.g. `"insufficientFunds"`.
   */
  estimateGas: MockEstimateGasAction;
  /**
   * `eth_sendTransaction` and `eth_sendRawTransaction`, for viem's
   * `sendTransaction()`, `writeContract()` and `deployContract()`, and
   * `eth_sendRawTransactionSync` (EIP-7966), for a local account's
   * `sendTransactionSync()` and `writeContractSync()`. A registered
   * contract's `write` mocks and defaults answer sends of its functions
   * first, and these mocks answer the rest. Unmocked, a send without data to
   * an address without code succeeds, as on a node, and anything else isn't
   * answered.
   *
   * A mock answers with what the chain did: see `MockWriteAnswers`.
   * `.fails()` takes a node's refusal by name, e.g. `"nonceTooLow"`, and a
   * resolver also gets `emit` and `revert` (see `SendTransactionContext`).
   * For how a send is mined, its estimate, and raw sends, see
   * `MockSendTransactionAction`.
   */
  sendTransaction: MockSendTransactionAction;
};
