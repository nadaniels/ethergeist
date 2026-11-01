import type {
  Abi,
  Address,
  Chain,
  ContractEventName,
  CustomTransport,
  CustomTransportConfig,
  Log,
  PublicClient,
  TransactionReceipt,
} from "viem";

import type { MockActions } from "./actions/typedActions.js";
import type { MockMethodBuilder } from "./actions/types.js";
import type { MockFees } from "./chain/fees.js";
import type { MockReceipt } from "./chain/receipts.js";
import type { MockChain } from "./chain/state.js";
import type { BuiltTransaction, MockTransaction } from "./chain/transactions.js";
import type { CreateMockContractParameters, MockCall, MockContract } from "./contracts/types.js";
import type { FormatHistoryOptions } from "./history/format.js";
import type { MockHistoryEntry, RpcRequest, UnhandledRequest } from "./history/types.js";
import type { BuildLogParameters, EmitOptions, EmittedLog, MockEventLog } from "./logs/events.js";
import type { MockFault } from "./mocking/types.js";
import type { FailRequestsOptions, MockFaultHandle } from "./rpc/faults.js";
import type { MockPublicClientParameters } from "./viem/adapter.js";

export type CreateMockRpcParameters = {
  /**
   * The chain the mock stands in for: its id answers `eth_chainId`, and
   * `aggregate3` calls to its Multicall3 (the canonical address if it has none)
   * are decoded. `publicClient()` uses it. Defaults to viem's `mainnet`; for any
   * other id or Multicall3 address, use a viem chain or `defineChain`.
   */
  chain?: Chain;
  /** Block number the mock starts at. Defaults to 1n. */
  blockNumber?: bigint;
  /**
   * Unix timestamp, in seconds, of the starting block. Later and earlier blocks
   * are `chain.blockTime` apart (12s if the chain doesn't say). Defaults to
   * 1_700_000_000n, so runs are deterministic.
   */
  timestamp?: bigint;
  /**
   * The fees generated blocks and fee requests answer with: `baseFeePerGas`
   * is every block's, `maxPriorityFeePerGas` answers `eth_maxPriorityFeePerGas`,
   * and their sum `eth_gasPrice`, as reth suggests. Defaults to 10 gwei and
   * 1 gwei, so viem's `estimateFeesPerGas()` gives a `maxFeePerGas` of 13 gwei.
   * `mock.actions` mocks answer over them.
   */
  fees?: MockFees;
  /**
   * Log each request as it's answered, one line per request (see
   * `formatHistory()`). `true` logs with `console.log`; a function receives
   * the line and the history entry, to send to any logger, e.g.
   * `(line) => logger.debug(line)`. Useful when a test times out before it
   * could print the history. Entries hold bigints, which `JSON.stringify`
   * rejects, so pass loggers the line or chosen fields.
   */
  debug?: boolean | ((line: string, entry: MockHistoryEntry) => void);
  /**
   * How many of the most recent requests to append to the errors of the
   * mock's own checks (`assertNoUnhandled()`, `assertAllUsed()`, `restore()`'s
   * checks, `checkpoint()`), formatted like `formatHistory()` without
   * built-ins. `false` (or `0`) leaves them out. Defaults to 10.
   */
  historyOnFailure?: number | false;
};

/** A mock JSON-RPC node, answering viem through `transport()`; see `createMockRpc`. */
export type MockRpc = {
  /** Answers a JSON-RPC request directly, as `transport()` does for viem. */
  request(rpcRequest: RpcRequest): Promise<unknown>;
  /**
   * A viem transport backed by this mock. Retries keep viem's `retryCount` but
   * default to `retryDelay: 0`, so faulted requests retry without waiting.
   */
  transport(config?: CustomTransportConfig): CustomTransport;
  /**
   * A viem public client on this mock, with test-friendly defaults: the mock's
   * chain, `cacheTime: 0` so `mine()` shows up immediately, and
   * `pollingInterval: 50` so watchers and `waitForTransactionReceipt` notice
   * new blocks quickly (viem's default is up to 4s). Options override them.
   */
  publicClient(options?: MockPublicClientParameters): PublicClient<CustomTransport, Chain>;
  /**
   * Registers a mocked contract. Each address takes one registration; for a
   * proxy or extended contract, combine the ABIs (`abi: [...a, ...b]`).
   */
  contract<const abi extends Abi>(parameters: CreateMockContractParameters<abi>): MockContract<abi>;
  /**
   * Mocks for viem's public actions beyond contract calls, e.g.
   * `mock.actions.getBalance({ address }).returns(parseEther("1"))`. Values
   * are in viem's own types; the mock encodes them for JSON-RPC.
   */
  readonly actions: MockActions;
  /**
   * The transaction `mock.actions.getTransaction()` answers when mocked with
   * `.returns(transaction)`, in viem's types, with the same defaults: the
   * current block and fees, and the mock's chain. Its hash is zero unless
   * given. For `toEqual` against what the app got, and for props.
   */
  buildTransaction<const transaction extends MockTransaction = { type?: "eip1559" }>(
    transaction?: transaction,
  ): BuiltTransaction<transaction>;
  /**
   * The receipt `mock.actions.getTransactionReceipt()` answers when mocked
   * with `.returns(receipt)`: the same defaults, logs placed the same way,
   * in the current block unless given. Its hash is zero unless given
   * (`transactionHash`). For `toEqual` against what the app got, and for props.
   */
  buildReceipt(receipt?: MockReceipt): TransactionReceipt;
  /**
   * The log `address` emits for `eventName` with `args`, as a complete viem
   * log, for where no mock places it: `toEqual`, props, a function that
   * parses logs. The same encoding as a contract's `events`, in the current
   * block unless given, with other position fields zero.
   */
  buildLog<const abi extends Abi, eventName extends ContractEventName<abi>>(
    parameters: BuildLogParameters<abi, eventName>,
  ): Log<bigint, number, false>;
  /**
   * Emits logs as one transaction, for `getLogs` and watchers to find:
   * values from a contract's `events`, in the current block, or in a newly
   * mined one with `{ mine: true }`. Returns the placed logs, e.g. for a
   * mocked receipt. See `EmitOptions` for choosing the block and transaction.
   */
  emit(log: MockEventLog, options?: EmitOptions): EmittedLog;
  emit(logs: readonly MockEventLog[], options?: EmitOptions): EmittedLog[];
  /** Every emitted log, by block and log index, as `getLogs` would answer them. */
  readonly logs: EmittedLog[];
  /**
   * Mocks a JSON-RPC method that has no typed mock, answering with raw JSON-RPC
   * values. Pinned `params` match a prefix of the request's params.
   */
  method(name: string, params?: readonly unknown[]): MockMethodBuilder;
  /**
   * Fails requests at the transport, with the error viem's `http` transport
   * would throw, until cleared or `times` runs out. See `MockFault` for kinds.
   * To fail calls to one contract function instead, use `.fails()` on its mock.
   */
  failRequests(fault: MockFault, options?: FailRequestsOptions): MockFaultHandle;
  /**
   * Marks an address as having no code: calls to it succeed with empty data,
   * as on a real node. viem's `readContract` and `multicall` then fail with a
   * `ContractFunctionExecutionError` caused by `ContractFunctionZeroDataError`.
   */
  empty(address: Address): void;
  /** The chain clients should use: as given, with Multicall3 added if it had none. */
  readonly chain: MockChain;
  readonly chainId: number;
  readonly blockNumber: bigint;
  mine(blocks?: bigint): void;
  /**
   * Changes the fees from the current block on, e.g. for a fee spike:
   * blocks, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, and fee histories
   * follow. Earlier blocks keep the fees they had. Fees left out stay as
   * they are. `restore()` and `reset()` undo it.
   */
  setFees(fees: MockFees): void;
  /** Every decoded contract call, across all contracts, in the order received. */
  readonly calls: MockCall[];
  /**
   * Every request the mock received, in order, with how it was answered:
   * decoded contract calls (each multicall sub-call too), actions, and raw
   * methods, each with a result in viem's types, a revert, a fault, or
   * "unhandled". Retries are separate entries; in-flight ones are "pending".
   */
  readonly history: MockHistoryEntry[];
  /**
   * The history as text, one line per request (and per multicall sub-call),
   * for `console.log` while debugging. `builtIns: false` leaves out
   * `eth_chainId` and `eth_blockNumber`.
   */
  formatHistory(options?: FormatHistoryOptions): string;
  /** Every raw JSON-RPC request the mock has received, in order. */
  readonly requests: RpcRequest[];
  /** Requests the mock couldn't answer, even if the code under test swallowed the error. */
  readonly unhandled: UnhandledRequest[];
  /**
   * Throws if any request went unanswered: a missing mock or a resolver that
   * threw. Catches errors the code under test swallowed. Reverts are answers.
   */
  assertNoUnhandled(): void;
  /**
   * Throws if a mock never answered a call: its args are wrong and a broader
   * mock answered instead, or the app no longer makes the call it stands for.
   * Contract `defaults` aren't checked: they're shared setup, answers for
   * the whole suite that any one test may not use. For other shared setup
   * (actions, `method`, narrowed mocks), take a checkpoint after registering
   * it and use `restore({ assertAllUsed: true })`, which checks only what
   * was registered since.
   */
  assertAllUsed(): void;
  /** Clears call and request history and usage; registrations and the block number stay. */
  clearCalls(): void;
  /**
   * Saves what's registered now as a baseline to `restore()` to, e.g. after
   * each test, so shared setup can be registered once. Throws if requests
   * since the last clear went unanswered: a broken setup isn't a baseline.
   * See `MockCheckpoint` for nesting and caveats.
   */
  checkpoint(): MockCheckpoint;
  /**
   * Returns the mock to its initial state: no contracts, no history, and the
   * starting block number. Handles from before the reset throw if used to
   * register, and every checkpoint becomes invalid.
   */
  reset(): void;
};

/**
 * A saved baseline: what was registered when `mock.checkpoint()` was called.
 *
 * Notes for the docs (to expand when writing them):
 * - Typical use: register shared contracts and mocks at module scope, call
 *   `checkpoint()` in `beforeAll`, and in `afterEach` call
 *   `restore({ assertNoUnhandled: true, assertAllUsed: true })`. Passing the
 *   checks to `restore()` matters: it checks, restores, then throws, so a
 *   failing check can't skip the restore. Vitest skips the remaining
 *   `afterEach` hooks when one throws, so a separate assertion hook that
 *   fails would leave every later test running on this test's mocks.
 * - `assertAllUsed` in `restore()` checks only mocks registered since the
 *   checkpoint: shared setup can register more than any one test uses.
 * - Nesting: checkpoints form a stack. Restoring one invalidates every
 *   checkpoint taken after it, and `reset()` invalidates all of them.
 * - Restore at one level only per test. An `afterEach` applies to nested
 *   describes too, and vitest runs them innermost first, so an outer
 *   per-test restore runs after a nested suite's restore, wipes that suite's
 *   setup, and invalidates its checkpoints (its next `restore()` throws).
 *   Keep describes that restore an outer checkpoint per test as siblings of
 *   describes with their own suite setup, not parents of them.
 * - A describe with its own suite setup needs a checkpoint on each side of
 *   it, so later describes don't inherit it: `outer = checkpoint()`, setup,
 *   `suite = checkpoint()`; then `suite.restore()` per test and
 *   `outer.restore()` in `afterAll`.
 * - `checkpoint()` throws if requests since the last clear went unanswered.
 *   A test that deliberately triggers a missing mock, in a file that doesn't
 *   restore per test, needs a `clearCalls()` before a later checkpoint.
 * - Only registrations and the mock's own state are restored, not state a
 *   resolver closes over (counters, prices, external fixtures).
 * - History is cleared, not rolled back: `calls`, `requests`, `unhandled`,
 *   per-function and per-action `.calls`, and usage counts. A checkpoint
 *   taken mid-test therefore also drops that test's earlier history.
 * - Concurrency: one mock shared by concurrent tests is unsafe with or
 *   without checkpoints, since one test's restore (or overrides, `mine()`,
 *   history) affects the others. Use one mock per concurrent test, e.g. a
 *   setup factory or vitest fixtures; checkpoints are for serial suites.
 * - Requests still in flight at restore time (fire-and-forget calls from
 *   the previous test) land in the next test's history and `unhandled`.
 */
export type MockCheckpoint = {
  /**
   * Undoes every registration made since the checkpoint and returns the
   * mock's own state (block number, fees, batch ids, faults' counts) to what it
   * was, then clears history. Can be called repeatedly, e.g. after each test.
   * Throws if the checkpoint is no longer valid, or, after restoring, if a
   * check in `options` fails.
   */
  restore(options?: MockRestoreOptions): void;
};

/**
 * Checks `restore()` runs on the test that's ending. They're checked before
 * restoring (which clears what they look at) and thrown after, so a failing
 * check can't leave the next test running on this one's mocks.
 */
export type MockRestoreOptions = {
  /** Throw, like `assertNoUnhandled()`, if any request went unanswered. */
  assertNoUnhandled?: boolean;
  /**
   * Throw, like `assertAllUsed()`, if a mock registered since the checkpoint
   * never answered a call. Baseline mocks aren't checked: shared setup can
   * register more than any one test uses.
   */
  assertAllUsed?: boolean;
};
