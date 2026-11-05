import type { Hex } from "viem";

import type { MockBlock } from "../chain/blocks.js";
import type { MockFeeHistory } from "../chain/fees.js";
import type { MockTransaction } from "../chain/transactions.js";
import type { EmittedLog } from "../logs/events.js";
import type { LogsCall } from "../logs/filter.js";
import { estimateGas, type MockEstimateGasAction } from "./estimateGas.js";
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
import { type MockReceipt, getTransactionReceipt } from "./getTransactionReceipt.js";
import { type MockSendTransactionAction, sendTransaction } from "./sendTransaction.js";
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
 * Every typed action: its definition, and the JSON-RPC methods it answers.
 * An action is added here, in `MockActions`, and in `ActionCalls`.
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
  estimateGas: { define: estimateGas, methods: ["eth_estimateGas"] },
  sendTransaction: {
    define: sendTransaction,
    methods: ["eth_sendTransaction", "eth_sendRawTransaction", "eth_sendRawTransactionSync"],
  },
} satisfies {
  // Each action decodes to its call type in `ActionCalls`, and every action has one.
  [name in keyof ActionCalls]: {
    define: (context: ActionsContext) => Definition<ActionCalls[name]>;
    methods: readonly string[];
  };
};

/** A typed action's name, e.g. `getBalance`. */
export type ActionName = keyof typeof typedActions;

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
   * follows the chain's `blockTime`, the base fee (see `fees`), and the
   * transactions in it (emitted or sent), with everything else zero. A
   * mock's fields are merged over the generated block, its transactions too
   * unless the mock sets `transactions` (a block past the head, or a hash
   * only the mock knows, lists none); `null` answers "no such block".
   */
  getBlock: MockAction<BlockCall, Partial<MockBlock> | null>;
  /**
   * `eth_getTransactionReceipt`. Unmocked, the hash of a transaction on the
   * chain (added or sent) answers its receipt, `null` while it's placed in a
   * block not mined yet, and other hashes aren't answered. A mock's fields go
   * over what the chain would answer at that request: the receipt of the
   * hash's transaction once it's mined, and otherwise `status: "success"`
   * with zeros, in the block current when a static one is registered (so it
   * stays there as more are mined) or when a resolver's answers. `null`
   * answers "no such transaction". `logs` takes their content
   * (`contract.events`, `contractEvents()`, `testLog()`), placed in the
   * receipt, in place of its logs on the chain; they answer this receipt
   * only, so `getLogs` and watchers don't see them: for that, add the
   * transaction, `mock.addTransaction({ hash, logs })`. The receipt's block
   * and transaction place its logs, the chain's included. A reverted status
   * with logs, its own or the chain's, is refused, as a reverted
   * transaction has none.
   */
  getTransactionReceipt: MockAction<ReceiptCall, MockReceipt | null>;
  /**
   * `eth_getTransactionByHash`. Unmocked, the hash of a transaction on the
   * chain answers it (added or sent; pending while it's placed in a block
   * not mined yet), and other hashes aren't answered. A mock's fields go
   * over what the chain would answer: the hash's transaction on the chain,
   * pending or mined, and for a hash the chain doesn't have, an `"eip1559"` transaction
   * at index 0, that paid the suggested fees (see `fees`), with a zero
   * signature and the rest zero, mined in the block current when a static
   * one is registered or when a resolver's answers. Fields its `type`
   * doesn't have throw, and `blockNumber: null` makes it pending. `null`
   * answers "no such transaction". `mock.buildTransaction()` builds the
   * transaction for a hash not on the chain.
   */
  getTransaction: MockAction<TransactionCall, MockTransaction | null>;
  /**
   * `eth_getLogs`, for `getLogs` and `getContractEvents`. Unmocked, it's
   * answered from the chain's logs (from `mock.addTransaction()`,
   * `contract.emit` and sends), filtered as a node filters them, at any
   * address: `[]` where nothing was emitted. A mock answers
   * first, with placed logs (from `mock.logs` or `mock.buildLog()`), or fails,
   * e.g. for a provider's block range cap; its resolver gets the emitted logs
   * the filter matches as `logs`.
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
   * `eth_getTransactionCount`, an account's nonce: unmocked, the chain's
   * count, one past the highest nonce of the address's transactions (0 if
   * none), over those mined at or before the block (all of them at
   * `"pending"`): its sends, and transactions added with it as `from`.
   * viem asks for `"pending"` when preparing a transaction, and `"latest"`
   * by default. A static
   * `.returns(7)` is the answer, so it doesn't count up; for a starting
   * nonce that does, a resolver reads `count`:
   * `.returns(({ count }) => Math.max(7, count))`. An `eth_sendTransaction`
   * without a nonce takes the chain's count, not these mocks' answer.
   */
  getTransactionCount: MockAction<TransactionCountCall, number, TransactionCountContext>;
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
   * a plain transfer, with no data, to an address without code is 21000
   * gas, as a node estimates it, and a `write` or `sendTransaction` mock
   * that would answer the transaction implies 100,000 gas; anything else
   * isn't answered. `.fails()` takes a node's refusal by name, e.g.
   * `"insufficientFunds"`.
   */
  estimateGas: MockEstimateGasAction;
  /**
   * `eth_sendTransaction` and `eth_sendRawTransaction`, for `sendTransaction`,
   * `writeContract` and `deployContract`, and `eth_sendRawTransactionSync`
   * (EIP-7966), for a local account's `sendTransactionSync` and
   * `writeContractSync`, answered with its receipt from the chain (a
   * `getTransactionReceipt` mock answers only the app's own requests). A
   * registered contract's `write` mocks and defaults answer sends of its functions first; these answer
   * the rest. A send always goes on the chain:
   * answered, it's a transaction mined in a new block, which its receipt,
   * its transaction, its block and `getLogs` answer from (see
   * `mock.transactions`); only a refusal (`.fails()`, or a send nothing
   * answers) leaves the chain as it was.
   *
   * `.returns()` takes what the chain did (`MockWriteOutcome`): its logs, a
   * reverted status, its gas, a deploy's address; `.emits(logs)` is
   * `.returns({ logs })`. `.reverts(spec)` reverts its estimate and mines it
   * reverted if it's sent anyway. `.fails()` takes a node's refusal by name,
   * e.g. `"insufficientFunds"` or `"nonceTooLow"`. A resolver also gets `emit` and `revert`
   * (see `MockWriteContext`). A matching mock also answers the
   * transaction's `eth_estimateGas` (when no estimate mock does) with
   * 100,000 gas, without running it or using it up.
   *
   * A raw send's sender is recovered from its signature, and its hash is
   * its bytes' (`keccak256`); sending the same bytes again answers the same
   * hash (or receipt), without a second transaction. A Sync send is mined as
   * it's answered, so its timeout never passes. An `eth_sendTransaction` without a
   * nonce takes the sender's next one on the chain (see
   * `getTransactionCount`), and without gas is sent with 100,000. Unmocked, a send
   * without data to an address without code succeeds, as on a node;
   * anything else isn't answered.
   */
  sendTransaction: MockSendTransactionAction;
};
