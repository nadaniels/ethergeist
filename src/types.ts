import type {
  Abi,
  Address,
  Chain,
  CustomTransport,
  CustomTransportConfig,
  Log,
  PublicClient,
  TransactionReceipt,
} from "viem";

import type { MockReceipt } from "./actions/getTransactionReceipt.js";
import type { MockActions } from "./actions/typedActions.js";
import type { MockMethodBuilder } from "./actions/types.js";
import type { MockFees } from "./chain/fees.js";
import type { BuiltTransaction, MockTransaction } from "./chain/transactions.js";
import type {
  CreateMockContractParameters,
  MockContract,
  MockTaggedCall,
} from "./contracts/types.js";
import type { FormatHistoryOptions } from "./history/format.js";
import type { MockHistoryEntry, RpcRequest, UnhandledRequest } from "./history/types.js";
import type { EmittedLog, LogPlacement, MockEventLog } from "./logs/events.js";
import type { MockFault } from "./mocking/types.js";
import type { MockCheckpoint } from "./rpc/checks.js";
import type { FailRequestsOptions, MockFaultHandle } from "./rpc/faults.js";
import type { AddTransactionParameters } from "./transactions/addTransaction.js";
import type { TransactionRecord } from "./transactions/store.js";
import type { MockPublicClientParameters } from "./viem/adapter.js";

/** What `createMockRpc()` takes. Every option is optional. */
export type CreateMockRpcParameters = {
  /**
   * The chain the mock stands in for: its id answers `eth_chainId`, and
   * `aggregate3` calls to its Multicall3 (`contracts.multicall3`) are
   * decoded. Without a Multicall3 address, viem can't multicall on it, as
   * without a mock. `mock.publicClient()` uses it. Defaults to viem's
   * `mainnet`; for any other id or Multicall3 address, use a viem chain or
   * `defineChain()`.
   */
  chain?: Chain;
  /** The block number the mock starts at. Defaults to `1n`. */
  blockNumber?: bigint;
  /**
   * The starting block's Unix timestamp, in seconds. Other blocks are
   * `chain.blockTime` apart, or 12 seconds if the chain doesn't say.
   * Defaults to `1_700_000_000n`, so runs are deterministic.
   */
  timestamp?: bigint;
  /**
   * The fees generated blocks and fee requests answer with. `baseFeePerGas`
   * is every block's, `maxPriorityFeePerGas` answers
   * `eth_maxPriorityFeePerGas`, and their sum answers `eth_gasPrice`, as reth
   * suggests. Defaults to 10 gwei and 1 gwei, so viem's
   * `estimateFeesPerGas()` gives a `maxFeePerGas` of 13 gwei. `mock.actions`
   * mocks answer over them, and `mock.setFees()` changes them.
   */
  fees?: MockFees;
  /**
   * Logs each request as it's answered, one line each, as `formatHistory()`
   * formats it. `true` logs with `console.log`; a function gets the line and
   * the history entry, e.g. `(line) => logger.debug(line)`. For a test that
   * times out before it can print the history. Entries hold bigints, which
   * `JSON.stringify` rejects: pass a logger the line or chosen fields.
   */
  debug?: boolean | ((line: string, entry: MockHistoryEntry) => void);
  /**
   * How many of the most recent requests a failed check's error shows, as
   * `formatHistory()` formats them without built-ins. The checks are
   * `assertNoUnhandled()`, `assertAllUsed()`, `checkpoint()` and
   * `restore()`'s. `false` or `0` leaves them out. Defaults to `10`.
   */
  historyOnFailure?: number | false;
  /**
   * How many entries each list of requests keeps: `history`, `calls`,
   * `unhandled`, and each action's, contract's and function's `.calls`, each
   * on its own. Past it, the oldest are dropped; `history` keeps its
   * numbering and says how many were dropped, and checks count every
   * request. Defaults to `1000`, warning the first time an entry is dropped;
   * a number set here doesn't warn, and `Infinity` keeps everything.
   *
   * A long-running page needs a limit: polling every 50ms makes about 68,000
   * requests an hour. A read keeps about 3 KB across the lists, and a 10-call
   * multicall about 21 KB. Registered mocks and the chain (`mock.transactions`,
   * `mock.logs`) aren't lists of requests, and aren't limited.
   */
  historyLimit?: number;
};

/**
 * The mock: a stand-in JSON-RPC node, which answers viem through
 * `mock.transport()` and `mock.publicClient()`. `createMockRpc()` makes one.
 */
export type MockRpc = {
  /**
   * Answers a JSON-RPC request directly, without a client or its retries.
   * It throws viem's errors, the ones `mock.transport()` hands a client: a
   * fault, a revert or a node's refusal is an `HttpRequestError`,
   * `RpcRequestError` or `TimeoutError`, not yet sorted into viem's classes
   * by code. A request the mock can't answer throws a `MockError`.
   */
  request(rpcRequest: RpcRequest): Promise<unknown>;
  /**
   * A viem transport backed by the mock. `config` is viem's `custom()`
   * transport's: `retryCount` keeps viem's default, and `retryDelay`
   * defaults to `0`, so a faulted request retries without waiting.
   */
  transport(config?: CustomTransportConfig): CustomTransport;
  /**
   * A viem public client on the mock, with defaults for tests: `mock.chain`,
   * `cacheTime: 0` so `mine()` shows at once, and `pollingInterval: 50` so
   * watchers and `waitForTransactionReceipt()` see new blocks quickly (viem's
   * default is up to 4s). Options override them. `retryCount` and
   * `retryDelay` go to the transport, e.g. `publicClient({ retryCount: 0 })`
   * so a fault reaches the app without retries. For any other transport
   * option, create the client on `mock.transport(config)` with
   * `cacheTime: 0`, so a cached block number doesn't hide `mine()` or
   * `restore()`.
   */
  publicClient(options?: MockPublicClientParameters): PublicClient<CustomTransport, Chain>;
  /**
   * Registers a mocked contract. Each address takes one registration; for a
   * proxy or extended contract, combine the ABIs, e.g. `abi: [...a, ...b]`.
   */
  contract<const abi extends Abi>(parameters: CreateMockContractParameters<abi>): MockContract<abi>;
  /**
   * Mocks for viem's public actions beyond contract calls, e.g.
   * `mock.actions.getBalance({ address }).returns(parseEther("1"))`. Values
   * are in viem's own types; the mock encodes them for JSON-RPC.
   */
  readonly actions: MockActions;
  /**
   * The transaction a `mock.actions.getTransaction()` mock answers with
   * `.returns(transaction)` for a hash with no placed transaction, in viem's
   * types. It takes the same defaults: the fees, `mock.chain`, and the
   * current block as of this call, as `.returns()` fixes a static answer's
   * at registration. Its hash is zero unless given. For `toEqual` against
   * what the app got, and for props. For a placed transaction, compare with
   * what the client returns.
   */
  buildTransaction<const transaction extends MockTransaction = { type?: "eip1559" }>(
    transaction?: transaction,
  ): BuiltTransaction<transaction>;
  /**
   * The receipt a `mock.actions.getTransactionReceipt()` mock answers with
   * `.returns(receipt)` for a hash not on the chain. It takes the same
   * defaults: the fees, `mock.chain`, and the current block as of this call
   * unless given, as `.returns()` fixes a static answer's at registration.
   * Its hash is zero unless given (`transactionHash`). `logs` takes their
   * content, e.g. from `contract.events`, which the receipt places; a placed
   * log is refused. For `toEqual` against what the app got, and for props.
   *
   * Its addresses are lowercase, as nodes send them: compare them with
   * viem's `isAddressEqual()`, not `toBe(contract.address)`. A built receipt
   * is a whole receipt, so returned over a transaction on the chain, it
   * answers its own fields and logs. For a transaction on the chain, compare
   * with what the client returns.
   */
  buildReceipt(receipt?: MockReceipt): TransactionReceipt;
  /**
   * A log's content placed as a complete viem log, for where no mock places
   * it: `toEqual`, props, a function that parses logs, or a `getLogs` mock's
   * answer. The content is from a contract's `events`, `contractEvents()` or
   * `testLog()`. It's in the current block unless `placement` says
   * otherwise (see `LogPlacement`), with other position fields zero. The
   * chain doesn't count it, so give `logIndex` to match a block with other
   * logs. Placed content is refused.
   *
   * Its address is lowercase, as nodes send it: compare with
   * `isAddressEqual()`, not `toBe()`. A transaction's logs aren't built
   * here: a transaction places its logs' content itself.
   */
  buildLog(log: MockEventLog, placement?: LogPlacement): Log<bigint, number, false>;
  /**
   * Places a transaction the app didn't send, in a newly mined block unless
   * `blockNumber` names one. Its fields are a send's, all optional (see
   * `AddTransactionParameters`): `mock.addTransaction()` is a success from
   * and to the zero address, with no input, value, gas or logs. Its logs are
   * content from a contract's `events`, or `contractEvents()` or `testLog()`
   * for another address not marked `empty()`. A swap's logs from several
   * contracts go in one transaction, `{ logs: [a, b] }`. For one event,
   * `contract.emit.X(args)` is shorter.
   *
   * Its receipt, transaction and block answer from it, unless a mock for its
   * hash answers first. The block it mines moves the clock on, and watchers
   * and a waiting `waitForTransactionReceipt({ confirmations })` see it.
   * Returns its record, as `mock.transactions` lists it, with `data` as
   * `fields.input`. Its logs' addresses are lowercase, as nodes send them:
   * compare with `isAddressEqual()`, not `toBe()`.
   */
  addTransaction(fields?: AddTransactionParameters): TransactionRecord;
  /**
   * Every placed log, by block and log index, with lowercase addresses:
   * compare with `isAddressEqual()`, not `toBe()`. Logs placed in a block
   * not mined yet are listed too, though `eth_getLogs` doesn't find them
   * until it's mined.
   */
  readonly logs: EmittedLog[];
  /**
   * The chain's transactions, by block and index: what
   * `mock.addTransaction()` and sends placed, waiting ones included. They're
   * state, like registered mocks: `restore()` and `reset()` put them back,
   * and `clearCalls()` and `historyLimit` leave them.
   */
  readonly transactions: TransactionRecord[];
  /**
   * Mocks a JSON-RPC method that has no typed mock, answering with raw
   * JSON-RPC values. Pinned `params` match a prefix of the request's params.
   * `eth_chainId`, `eth_blockNumber` and `eth_call` are refused. A method
   * with a typed mock is refused, naming its action, as a method that gets
   * a typed mock in a later version will be. The likely ones are
   * `eth_simulateV1`, the wallet methods and
   * `eth_getTransactionByBlock*AndIndex`.
   */
  method(name: string, params?: readonly unknown[]): MockMethodBuilder;
  /**
   * Fails requests with `fault` until it's cleared or `times` runs out: see
   * `MockFault` for the kinds. To fail calls to one contract function, use
   * `.fails()` on its mock.
   */
  failRequests(fault: MockFault, options?: FailRequestsOptions): MockFaultHandle;
  /**
   * Marks an address as having no code: calls to it succeed with empty data,
   * as on a node. viem's `readContract()` and `multicall()` then fail with a
   * `ContractFunctionExecutionError` caused by `ContractFunctionZeroDataError`.
   */
  empty(address: Address): void;
  /**
   * The viem `Chain` every client on the mock should use: `createMockRpc()`'s
   * `chain`, or `mainnet`.
   */
  readonly chain: Chain;
  /**
   * The current block, the chain's head. It starts at `createMockRpc()`'s
   * `blockNumber`, moves on when `mine()`, a send, or `mock.addTransaction()`
   * without a `blockNumber` mines a block, and moves back on `restore()` and
   * `reset()`. `eth_blockNumber` answers it, and a transaction placed in a
   * later block is waiting until it's mined.
   */
  readonly blockNumber: bigint;
  /**
   * Mines `blocks` blocks (one if left out), moving the head and the clock
   * on: transactions placed in them are mined, and watchers and
   * `waitForTransactionReceipt()` see them. A count is an integer, `1` or
   * more: the head never moves back.
   */
  mine(blocks?: number): void;
  /**
   * Changes the fees from the current block on, e.g. for a fee spike:
   * blocks, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, and fee histories
   * follow. Earlier blocks keep the fees they had. Fees left out stay as
   * they are. `restore()` and `reset()` undo it.
   */
  setFees(fees: MockFees): void;
  /**
   * Every decoded contract call, across all contracts and namespaces, in the
   * order received, multicall sub-calls included: the last `historyLimit` of
   * them. Each is a copy tagged with its `namespace`, e.g.
   * `mock.calls.filter((call) => call.namespace === "estimateGas")`.
   */
  readonly calls: MockTaggedCall[];
  /**
   * Every request the mock received, in order, with how it was answered:
   * the last `historyLimit` of them. Each is a contract call, a multicall
   * with its sub-calls, an action, a raw method or a built-in, and its
   * outcome is a result in viem's types, a revert, a fault, a node's
   * refusal, or unhandled (see `MockOutcome`). Retries are separate entries,
   * and one still in flight is pending.
   */
  readonly history: MockHistoryEntry[];
  /**
   * The history as text, one line per request and per multicall sub-call,
   * for `console.log` while debugging. `builtIns: false` leaves out
   * `eth_chainId` and `eth_blockNumber`.
   */
  formatHistory(options?: FormatHistoryOptions): string;
  /**
   * Requests the mock couldn't answer, even those whose error the app
   * swallowed: the last `historyLimit` of them.
   */
  readonly unhandled: UnhandledRequest[];
  /**
   * Throws if any request went unanswered, e.g. for a missing mock or a
   * resolver that threw (see `UnhandledRequest`). It catches errors the app
   * swallowed. Reverts, faults and a node's refusals are answers.
   */
  assertNoUnhandled(): void;
  /**
   * Throws if a mock never answered a call: its pins are wrong and a broader
   * mock answered instead, the app doesn't make the call it stands for, or
   * it was registered without an answer (`.returns()`, `.reverts()` or
   * `.fails()`), so it never could. A contract's `defaults` aren't checked:
   * they're shared setup for the whole suite, which one test may not use.
   *
   * For other shared setup (actions, `mock.method()`, pinned mocks), take a
   * checkpoint after registering it and use `restore({ assertAllUsed: true })`,
   * which checks only what was registered since.
   */
  assertAllUsed(): void;
  /**
   * Clears the lists of requests and calls, and usage (what
   * `assertAllUsed()` reads), like Vitest's `mockClear()`. Registrations and
   * the chain (blocks, transactions, nonces) stay, so it isn't a per-test
   * reset: for that, use `checkpoint()` and `restore()`.
   */
  clearCalls(): void;
  /**
   * Saves the mock's registrations, chain and faults, as a baseline to
   * `restore()` to, e.g. after each test, so shared setup is registered
   * once. Throws if requests since the last clear went unanswered: a broken
   * setup isn't a baseline. See `MockCheckpoint` for nesting and caveats.
   */
  checkpoint(): MockCheckpoint;
  /**
   * Returns the mock to the state it was created in: no registrations, no
   * history, no transactions or faults, and the starting block and fees.
   * Handles from before the reset throw if used to register, and every
   * checkpoint becomes invalid.
   */
  reset(): void;
};
