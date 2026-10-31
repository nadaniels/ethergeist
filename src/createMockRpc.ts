import {
  type Abi,
  type Address,
  type Chain,
  type CustomTransport,
  type CustomTransportConfig,
  type PublicClient,
  type PublicClientConfig,
  createPublicClient,
  custom,
  getAddress,
  isAddress,
  numberToHex,
} from "viem";

import { createActions } from "./actions/createActions.js";
import type { MockFees } from "./chain/fees.js";
import { createChainState } from "./chain/state.js";
import type { MockCheckpoint, MockRestoreOptions } from "./checkpoint.js";
import { createMockContract } from "./contracts/createMockContract.js";
import { createDispatch } from "./contracts/dispatch.js";
import { createRegistry } from "./contracts/registry.js";
import type { CreateMockContractParameters, MockCall, MockContract } from "./contracts/types.js";
import {
  type FormatContext,
  type FormatHistoryOptions,
  formatEntry,
  formatHistory,
  outcomeOf,
  reporterFor,
  formatRecent,
  retryHint,
  valueOf,
} from "./history.js";
import type { MockHistoryEntry, MockOutcome } from "./history/types.js";
import type { EmittedLog } from "./logs/events.js";
import { createLogStore } from "./logs/store.js";
import { MockFailure } from "./mocking/faults.js";
import type { MockFault } from "./mocking/types.js";
import { createCheckpoints } from "./rpc/checkpoints.js";
import { type FailRequestsOptions, type MockFaultHandle, createFaults } from "./rpc/faults.js";
import {
  MockNotFoundError,
  MockResolverError,
  MockRevertError,
  MockRpcError,
} from "./shared/errors.js";
import type { Part } from "./shared/parts.js";
import { isPlainObject } from "./shared/values.js";
import { createFaultError, createRevertRpcError } from "./viem/errors.js";

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

/** Public client options, minus the chain and transport, which come from the mock. */
export type MockPublicClientParameters = Omit<
  PublicClientConfig<CustomTransport, Chain>,
  "chain" | "transport"
>;

export type RpcRequest = { method: string; params?: unknown };

/** A request the mock couldn't answer: nothing was mocked for it, or a resolver threw. */
export type UnhandledRequest = RpcRequest & { error: MockNotFoundError | MockResolverError };

export type MockRpc = ReturnType<typeof createMockRpc>;

/** `assertNoUnhandled()`'s message, if any request went unanswered. */
function unhandledFailure(list: readonly UnhandledRequest[]): string[] {
  if (list.length === 0) return [];
  const lines = list.map(({ error }) => `  - ${error.shortMessage}`);
  return [`The mock couldn't answer ${list.length} request(s):\n${lines.join("\n")}`];
}

/** `assertAllUsed()`'s message, if any mock never answered. */
function unusedFailure(list: readonly string[]): string[] {
  if (list.length === 0) return [];
  const lines = list.map((mock) => `  - ${mock}`);
  return [`${list.length} mock(s) never answered a call:\n${lines.join("\n")}`];
}

export function createMockRpc(parameters: CreateMockRpcParameters = {}) {
  const state = createChainState(parameters);
  const registry = createRegistry(state);
  const logStore = createLogStore({ state, registry });
  const calls: MockCall[] = [];
  const requests: RpcRequest[] = [];
  const unhandled: UnhandledRequest[] = [];
  const faults = createFaults();
  const history: MockHistoryEntry[] = [];
  const historyOnFailure = parameters.historyOnFailure ?? 10;
  if (historyOnFailure !== false && (!Number.isInteger(historyOnFailure) || historyOnFailure < 0))
    throw new RangeError(
      `historyOnFailure takes a count of requests or false; got ${String(historyOnFailure)}.`,
    );

  /**
   * A failed check's error, with the most recent requests after the message.
   * Its stack starts where `check`, the public method, was called, so a test
   * runner points at the test, not into the mock.
   */
  function checkFailed(check: (...args: never[]) => unknown, message: string): Error {
    const recent =
      historyOnFailure === false
        ? undefined
        : formatRecent(history, historyOnFailure, formatContext);
    const error = new Error(recent === undefined ? message : `${message}\n\n${recent}`);
    // Not every engine has it (Node's types say it's always there).
    if ("captureStackTrace" in Error) Error.captureStackTrace(error, check);
    return error;
  }
  const log =
    parameters.debug === true
      ? (line: string) => {
          console.log(line);
        }
      : parameters.debug === false
        ? undefined
        : parameters.debug;
  const actions = createActions({ state, registry, logStore });
  const dispatcher = createDispatch({ state, registry });
  /** What the mock records about requests; cleared, never saved. */
  const records: Part = {
    clearCalls() {
      calls.length = 0;
      history.length = 0;
      requests.length = 0;
      unhandled.length = 0;
    },
  };
  // Saved first, before anything is registered: reset() restores it.
  const checkpoints = createCheckpoints([
    state,
    registry,
    actions,
    logStore,
    faults,
    dispatcher,
    records,
  ]);
  // History names a getLogs filter's events with the registered contracts' ABIs.
  const formatContext: FormatContext = {
    describeLogs: (call) =>
      logStore.describe(
        call,
        registry.contracts.map(({ contract }) => contract),
      ),
  };

  /** `retryCount` is the transport's, when the request came through `transport()`. */
  async function request(rpcRequest: RpcRequest, retryCount?: number): Promise<unknown> {
    const { method, params } = rpcRequest;
    const entry: RpcRequest = params === undefined ? { method } : { method, params };
    requests.push(entry);
    const record = startEntry(method, params);
    history.push(record);

    // The most recent fault wins, like mocks. A fault is a deliberate answer, so
    // it isn't recorded as unhandled.
    const fault = faults.take(method);
    if (fault !== undefined) {
      settle(record, { type: "fault", fault, source: "failRequests" });
      throw createFaultError(fault, entry);
    }

    try {
      const answered = await answer(rpcRequest, record);
      settle(record, { type: "result", value: answered.value });
      return answered.rpc;
    } catch (caught) {
      const error = withRetryHint(caught, record, retryCount);
      settle(record, outcomeOf(record, error));
      // A mock's `.fails()` or `fail()`: deliberate, like `failRequests`.
      if (error instanceof MockFailure) throw createFaultError(error.fault, entry);
      // A revert reaches viem the way a node's would, and so does a node's refusal.
      if (error instanceof MockRevertError) throw createRevertRpcError(error, entry);
      if (error instanceof MockRpcError)
        throw createFaultError({ code: error.code, message: error.shortMessage }, entry);
      // Recorded because callers can swallow these: app code with a fallback,
      // or viem's multicall turning a failed batch into per-call failures.
      if (error instanceof MockNotFoundError || error instanceof MockResolverError)
        unhandled.push({ ...entry, error });
      throw error;
    }
  }

  /** A history entry for a request, typed by what it asks for; details fill in as it's answered. */
  function startEntry(method: string, params: unknown): MockHistoryEntry {
    const base = { method, params, outcome: { type: "pending" } as const };
    if (method === "eth_chainId" || method === "eth_blockNumber")
      return { ...base, type: "builtIn" };
    if (method === "eth_call") {
      const to = Array.isArray(params) && isPlainObject(params[0]) ? params[0].to : undefined;
      const target =
        typeof to === "string" && isAddress(to, { strict: false }) ? getAddress(to) : undefined;
      return target === state.multicallAddress
        ? { ...base, type: "multicall", batchId: undefined, calls: [] }
        : { ...base, type: "call", to: target, call: undefined };
    }
    const action = actions.actionFor(method);
    if (action !== undefined) return { ...base, type: "action", action, call: undefined };
    return { ...base, type: "method" };
  }

  /** Records how a request ended, and logs it when `debug` is on. */
  function settle(entry: MockHistoryEntry, outcome: MockOutcome) {
    entry.outcome = outcome;
    if (!log) return;
    const index = history.indexOf(entry);
    // Cleared while it was in flight: still worth a line, just without its number.
    log(
      index === -1
        ? formatEntry([entry], 0, formatContext)
        : formatEntry(history, index, formatContext),
      entry,
    );
  }

  async function answer(
    rpcRequest: RpcRequest,
    entry: MockHistoryEntry,
  ): Promise<{ rpc: unknown; value: unknown }> {
    let actionOutcome: MockOutcome | undefined;
    const rpc = await answerRpc(rpcRequest, entry, (outcome) => {
      actionOutcome = outcome;
    });
    // An action's table knows its value in viem's types; for the rest, decode the answer.
    const value = actionOutcome?.type === "result" ? actionOutcome.value : valueOf(entry, rpc);
    return { rpc, value };
  }

  async function answerRpc(
    { method, params }: RpcRequest,
    entry: MockHistoryEntry,
    onAction: (outcome: MockOutcome) => void,
  ): Promise<unknown> {
    switch (method) {
      case "eth_chainId":
        return numberToHex(state.chainId);
      case "eth_blockNumber":
        return numberToHex(state.blockNumber);
      case "eth_call":
        return await dispatcher.call(params, reporterFor(entry));
      default: {
        const answered = actions.answer(method, params, (report) => {
          if (entry.type !== "action") return;
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the table for entry.action decoded it
          entry.call = report.call as typeof entry.call;
          if (entry.action === "estimateGas" && report.contract) entry.contract = report.contract;
          onAction(report.outcome);
        });
        if (answered) return await answered;
        throw new MockNotFoundError(`RPC method "${method}" is not mocked.`, {
          details: `Mock it with mock.method("${method}", …).returns(…).`,
        });
      }
    }
  }

  function onCall(call: MockCall) {
    calls.push(call);
  }

  /** A "not mocked" error, explained when it's viem retrying past a limited mock's fault. */
  function withRetryHint(error: unknown, record: MockHistoryEntry, retryCount: number | undefined) {
    if (!(error instanceof MockNotFoundError)) return error;
    const hint = retryHint(history, history.indexOf(record), retryCount);
    if (hint === undefined) return error;
    return new MockNotFoundError(error.shortMessage, {
      details: error.details === "" ? hint : `${error.details}\n${hint}`,
    });
  }

  function transport(config?: CustomTransportConfig): CustomTransport {
    // Each transport tells its requests its resolved `retryCount` (its own,
    // a fallback transport's, or viem's default), for the retry hint.
    return (params) => {
      let retryCount: number | undefined;
      const created = custom(
        { request: (args: RpcRequest) => request(args, retryCount) },
        { retryDelay: 0, ...config },
      )(params);
      retryCount = created.config.retryCount;
      return created;
    };
  }

  function assertNoUnhandled() {
    const [failure] = unhandledFailure(unhandled);
    if (failure !== undefined) throw checkFailed(assertNoUnhandled, failure);
  }

  function assertAllUsed() {
    const [failure] = unusedFailure(checkpoints.unusedMocks());
    if (failure !== undefined) throw checkFailed(assertAllUsed, failure);
  }

  function checkpoint(): MockCheckpoint {
    if (unhandled.length > 0)
      throw checkFailed(
        checkpoint,
        `Can't checkpoint: ${unhandled.length} request(s) since the last clear ` +
          "went unanswered. Fix the setup, or call clearCalls() first if they were " +
          `intentional:\n${unhandled.map(({ error }) => `  - ${error.shortMessage}`).join("\n")}`,
      );

    const saved = checkpoints.take();

    function restore(options: MockRestoreOptions = {}) {
      if (!saved.valid)
        throw new Error(
          "This checkpoint is no longer valid: an earlier checkpoint was restored, " +
            "or reset() was called, after it was taken.",
        );
      // Checked first, because restoring clears what they look at; thrown
      // last, so a failed check can't leave the next test unrestored.
      const failures = [
        ...(options.assertNoUnhandled === true ? unhandledFailure(unhandled) : []),
        ...(options.assertAllUsed === true ? unusedFailure(saved.unusedSince()) : []),
      ];
      // Built now: restoring clears the history it shows.
      const failed = failures.length > 0 ? checkFailed(restore, failures.join("\n\n")) : undefined;

      saved.restore();

      if (failed) throw failed;
    }
    return { restore };
  }

  return {
    /** Answers a JSON-RPC request directly, as `transport()` does for viem. */
    request: (rpcRequest: RpcRequest) => request(rpcRequest),
    /**
     * A viem transport backed by this mock. Retries keep viem's `retryCount` but
     * default to `retryDelay: 0`, so faulted requests retry without waiting.
     */
    transport,
    /**
     * A viem public client on this mock, with test-friendly defaults: the mock's
     * chain, `cacheTime: 0` so `mine()` shows up immediately, and
     * `pollingInterval: 50` so watchers and `waitForTransactionReceipt` notice
     * new blocks quickly (viem's default is up to 4s). Options override them.
     */
    publicClient(options: MockPublicClientParameters = {}): PublicClient<CustomTransport, Chain> {
      return createPublicClient({
        cacheTime: 0,
        pollingInterval: 50,
        ...options,
        chain: state.chain,
        transport: transport(),
      });
    },
    /**
     * Registers a mocked contract. Each address takes one registration; for a
     * proxy or extended contract, combine the ABIs (`abi: [...a, ...b]`).
     */
    contract<const abi extends Abi>(
      contractParameters: CreateMockContractParameters<abi>,
    ): MockContract<abi> {
      registry.assertUnregistered(contractParameters.address);
      const internal = createMockContract(contractParameters, { onCall, emit: logStore.emit });
      registry.add(internal);
      return internal.contract;
    },
    /**
     * Mocks for viem's public actions beyond contract calls, e.g.
     * `mock.actions.getBalance({ address }).returns(parseEther("1"))`. Values
     * are in viem's own types; the mock encodes them for JSON-RPC.
     */
    actions: actions.actions,
    /**
     * The transaction `mock.actions.getTransaction()` answers when mocked with
     * `.returns(transaction)`, in viem's types, with the same defaults: the
     * current block and fees, and the mock's chain. Its hash is zero unless
     * given. For `toEqual` against what the app got, and for props.
     */
    buildTransaction: actions.buildTransaction,
    /**
     * The receipt `mock.actions.getTransactionReceipt()` answers when mocked
     * with `.returns(receipt)`: the same defaults, logs placed the same way,
     * in the current block unless given. Its hash is zero unless given
     * (`transactionHash`). For `toEqual` against what the app got, and for props.
     */
    buildReceipt: actions.buildReceipt,
    /**
     * The log `address` emits for `eventName` with `args`, as a complete viem
     * log, for where no mock places it: `toEqual`, props, a function that
     * parses logs. The same encoding as a contract's `events`, in the current
     * block unless given, with other position fields zero.
     */
    buildLog: logStore.buildLog,
    /**
     * Emits logs as one transaction, for `getLogs` and watchers to find:
     * values from a contract's `events`, in the current block, or in a newly
     * mined one with `{ mine: true }`. Returns the placed logs, e.g. for a
     * mocked receipt. See `EmitOptions` for choosing the block and transaction.
     */
    emit: logStore.emit,
    /** Every emitted log, by block and log index, as `getLogs` would answer them. */
    get logs(): EmittedLog[] {
      return logStore.logs;
    },
    /**
     * Mocks a JSON-RPC method that has no typed mock, answering with raw JSON-RPC
     * values. Pinned `params` match a prefix of the request's params.
     */
    method: actions.method,
    /**
     * Fails requests at the transport, with the error viem's `http` transport
     * would throw, until cleared or `times` runs out. See `MockFault` for kinds.
     * To fail calls to one contract function instead, use `.fails()` on its mock.
     */
    failRequests(fault: MockFault, options: FailRequestsOptions = {}): MockFaultHandle {
      return faults.add(fault, options);
    },
    /**
     * Marks an address as having no code: calls to it succeed with empty data,
     * as on a real node. viem's `readContract` and `multicall` then fail with a
     * `ContractFunctionExecutionError` caused by `ContractFunctionZeroDataError`.
     */
    empty(address: Address) {
      registry.assertUnregistered(address);
      registry.markEmpty(getAddress(address));
    },
    /** The chain clients should use: as given, with Multicall3 added if it had none. */
    get chain() {
      return state.chain;
    },
    get chainId() {
      return state.chainId;
    },
    get blockNumber() {
      return state.blockNumber;
    },
    mine(blocks = 1n) {
      state.mine(blocks);
    },
    /**
     * Changes the fees from the current block on, e.g. for a fee spike:
     * blocks, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, and fee histories
     * follow. Earlier blocks keep the fees they had. Fees left out stay as
     * they are. `restore()` and `reset()` undo it.
     */
    setFees(fees: MockFees) {
      state.setFees(fees);
    },
    /** Every decoded contract call, across all contracts, in the order received. */
    get calls() {
      return [...calls];
    },
    /**
     * Every request the mock received, in order, with how it was answered:
     * decoded contract calls (each multicall sub-call too), actions, and raw
     * methods, each with a result in viem's types, a revert, a fault, or
     * "unhandled". Retries are separate entries; in-flight ones are "pending".
     */
    get history() {
      return [...history];
    },
    /**
     * The history as text, one line per request (and per multicall sub-call),
     * for `console.log` while debugging. `builtIns: false` leaves out
     * `eth_chainId` and `eth_blockNumber`.
     */
    formatHistory(options?: FormatHistoryOptions) {
      return formatHistory(history, options, formatContext);
    },
    /** Every raw JSON-RPC request the mock has received, in order. */
    get requests() {
      return [...requests];
    },
    /** Requests the mock couldn't answer, even if the code under test swallowed the error. */
    get unhandled() {
      return [...unhandled];
    },
    /**
     * Throws if any request went unanswered: a missing mock or a resolver that
     * threw. Catches errors the code under test swallowed. Reverts are answers.
     */
    assertNoUnhandled,
    /**
     * Throws if a mock never answered a call: its args are wrong and a broader
     * mock answered instead, or the app no longer makes the call it stands for.
     * Contract `defaults` aren't checked: they're shared setup, answers for
     * the whole suite that any one test may not use. For other shared setup
     * (actions, `method`, narrowed mocks), take a checkpoint after registering
     * it and use `restore({ assertAllUsed: true })`, which checks only what
     * was registered since.
     */
    assertAllUsed,
    /** Clears call and request history and usage; registrations and the block number stay. */
    clearCalls: checkpoints.clearCalls,
    /**
     * Saves what's registered now as a baseline to `restore()` to, e.g. after
     * each test, so shared setup can be registered once. Throws if requests
     * since the last clear went unanswered: a broken setup isn't a baseline. See `MockCheckpoint` for nesting and caveats.
     */
    checkpoint,
    /**
     * Returns the mock to its initial state: no contracts, no history, and the
     * starting block number. Handles from before the reset throw if used to
     * register, and every checkpoint becomes invalid.
     */
    reset() {
      checkpoints.reset();
    },
  };
}
