import type { Hex } from "viem";
import type { MockBlock } from "../chain/blocks.js";
import type { MockFeeHistory } from "../chain/fees.js";
import type { MockReceipt } from "../chain/receipts.js";
import type { MockTransaction } from "../chain/transactions.js";
import type { EmittedLog } from "../logs/events.js";
import type { LogsCall } from "../logs/filter.js";
import type {
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
import { getTransactionCount } from "./getTransactionCount.js";
import { getTransactionReceipt } from "./getTransactionReceipt.js";
import type { ActionsContext, Definition } from "./table.js";

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
} satisfies Record<
  string,
  { define: (context: ActionsContext) => Definition; methods: readonly string[] }
>;

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
