import {
  type Abi,
  type Address,
  type Chain,
  type CustomTransport,
  type CustomTransportConfig,
  type Hex,
  type PublicClient,
  type PublicClientConfig,
  createPublicClient,
  custom,
  getAddress,
  hexToBigInt,
  isAddress,
  isHex,
  numberToHex,
} from "viem";
import { mainnet } from "viem/chains";
import { createActions } from "./actions.js";
import { type BlockClock, generateBlock, numberOfBlockHash } from "./blocks.js";
import type { MockCheckpoint } from "./checkpoint.js";
import {
  type CallContext,
  type CreateMockContractParameters,
  type InternalMockContract,
  type MockCall,
  type MockContract,
  createMockContract,
} from "./contract.js";
import { MockNotFoundError, MockResolverError } from "./errors.js";
import {
  type ActiveFault,
  type FailRequestsOptions,
  type MockFault,
  type MockFaultHandle,
  MockFailure,
  appliesTo,
  createActiveFault,
  createFaultError,
} from "./faults.js";
import {
  type FormatHistoryOptions,
  type MockHistoryEntry,
  type MockOutcome,
  type Reporter,
  errorOutcome,
  formatEntry,
  formatHistory,
  outcomeOf,
  reporterFor,
  retryHint,
  valueOf,
} from "./history.js";
import { multicall3Address, resolveMulticall } from "./multicall.js";
import { isPlainObject } from "./result.js";

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
   * Log each request as it's answered, one line per request (see
   * `formatHistory()`). `true` logs with `console.log`; a function receives
   * the line and the history entry, to send to any logger, e.g.
   * `(line) => logger.debug(line)`. Useful when a test times out before it
   * could print the history. Entries hold bigints, which `JSON.stringify`
   * rejects, so pass loggers the line or chosen fields.
   */
  debug?: boolean | ((line: string, entry: MockHistoryEntry) => void);
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
  const given = parameters.chain ?? mainnet;
  // Without a Multicall3 address, viem's multicall falls back to deployless calls.
  const chain = {
    ...given,
    contracts: {
      ...given.contracts,
      multicall3: given.contracts?.multicall3 ?? { address: multicall3Address },
    },
  };
  const chainId = chain.id;
  const multicallAddress = getAddress(chain.contracts.multicall3.address);
  const initialBlockNumber = parameters.blockNumber ?? 1n;
  let blockNumber = initialBlockNumber;
  const contracts: InternalMockContract<any>[] = [];
  const emptyAddresses = new Set<Address>();
  const calls: MockCall[] = [];
  const requests: RpcRequest[] = [];
  const unhandled: UnhandledRequest[] = [];
  const faults: ActiveFault[] = [];
  let batchCount = 0;
  const clock: BlockClock = {
    startBlock: initialBlockNumber,
    startTimestamp: parameters.timestamp ?? 1_700_000_000n,
    blockTime: chain.blockTime ?? 12_000,
  };
  const checkpoints: { valid: boolean }[] = [];
  const history: MockHistoryEntry[] = [];
  const log =
    parameters.debug === true
      ? (line: string) => {
          console.log(line);
        }
      : parameters.debug === false
        ? undefined
        : parameters.debug;
  const actions = createActions({
    resolveBlock,
    codeAt,
    blockNumber: () => blockNumber,
    generateBlock: (number) => generateBlock(number, clock),
  });

  /** `retryCount` is the transport's, when the request came through `transport()`. */
  async function request(rpcRequest: RpcRequest, retryCount?: number): Promise<unknown> {
    const { method, params } = rpcRequest;
    const entry: RpcRequest = params === undefined ? { method } : { method, params };
    requests.push(entry);
    const record = startEntry(method, params);
    history.push(record);

    // The most recent fault wins, like mocks. A fault is a deliberate answer, so
    // it isn't recorded as unhandled.
    const fault = faults.findLast((f) => appliesTo(f, method));
    if (fault) {
      fault.remaining -= 1;
      fault.count += 1;
      settle(record, { type: "fault", fault: fault.fault, source: "failRequests" });
      throw createFaultError(fault.fault, entry);
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
      return target === multicallAddress
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
    log(index === -1 ? formatEntry([entry], 0) : formatEntry(history, index), entry);
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
        return numberToHex(chainId);
      case "eth_blockNumber":
        return numberToHex(blockNumber);
      case "eth_call": {
        // JSON-RPC params arrive untyped; this is the shape viem sends for eth_call.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- untyped JSON-RPC boundary
        const [tx, block] = params as [
          { to?: Address; from?: Address; value?: Hex; data?: Hex; input?: Hex },
          unknown,
        ];
        const data = tx.data ?? tx.input;
        if (!data) throw new MockNotFoundError("eth_call without `data` is not supported.");
        if (!tx.to)
          throw new MockNotFoundError("eth_call without `to` is not supported.", {
            details:
              "Deployless calls (including deployless multicall) need bytecode execution. " +
              "Give the client's chain a Multicall3 address, or use `mock.publicClient()`.",
          });

        return await dispatch(
          tx.to,
          data,
          {
            from: tx.from,
            value: tx.value ? hexToBigInt(tx.value) : 0n,
            blockNumber: resolveBlock(block),
            batch: undefined,
          },
          reporterFor(entry),
        );
      }
      default: {
        const answered = actions.answer(method, params, (report) => {
          if (entry.type !== "action") return;
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the table for entry.action decoded it
          entry.call = report.call as typeof entry.call;
          onAction(report.outcome);
        });
        if (answered) return await answered;
        throw new MockNotFoundError(`RPC method "${method}" is not mocked.`, {
          details: `Mock it with mock.method("${method}", …).returns(…).`,
        });
      }
    }
  }

  function dispatch(
    to: Address,
    data: Hex,
    context: CallContext,
    report: Reporter = {},
  ): Promise<Hex> {
    // Checksummed once here; lookups below compare checksummed addresses.
    const target = getAddress(to);
    if (target === multicallAddress) {
      const batchId = ++batchCount;
      report.batch?.(batchId);
      return resolveMulticall(data, {
        address: multicallAddress,
        batchId,
        context,
        dispatch: (subTarget, subData, subContext) =>
          dispatch(subTarget, subData, subContext, report),
      });
    }

    const contract = contracts.find((c) => c.matches(target));
    if (contract)
      return contract.resolve(data, context, (record) => report.call?.(record, context));
    const unknown = { address: target, name: undefined, call: undefined };
    // A real node answers a call to an address without code with empty data.
    if (emptyAddresses.has(target)) {
      report.call?.({ ...unknown, outcome: { type: "result", value: "0x" } }, context);
      return Promise.resolve("0x");
    }
    const error = new MockNotFoundError(`No mocked contract at ${to}.`, {
      details:
        `Call data: ${data}\n` +
        "Register it with contract(), or mark it empty() for an address without code.",
    });
    report.call?.({ ...unknown, outcome: errorOutcome(error) }, context);
    throw error;
  }

  function assertUnregistered(address: Address) {
    const checksummed = getAddress(address);
    const existing = contracts.find((c) => c.matches(checksummed));
    if (existing)
      throw new Error(
        `A contract is already registered at ${existing.label}. ` +
          "Register it once with a " +
          "combined ABI (abi: [...a, ...b]). If an earlier test registered it, restore " +
          "a checkpoint after each test, or call reset().",
      );
    if (emptyAddresses.has(checksummed))
      throw new Error(
        `${checksummed} is already registered as empty. If an earlier test registered it, ` +
          "restore a checkpoint after each test, or call reset().",
      );
  }

  function onCall(call: MockCall) {
    calls.push(call);
  }

  function clearCalls() {
    calls.length = 0;
    history.length = 0;
    requests.length = 0;
    unhandled.length = 0;
    for (const contract of contracts) contract.clearCalls();
    actions.clearCalls();
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

  /**
   * A block parameter as a block number: a hex number, a tag (`earliest` is 0;
   * every other tag is the current block, as there are no reorgs), or an
   * EIP-1898 `{ blockNumber }` or `{ blockHash }` of a generated block.
   */
  function resolveBlock(block: unknown): bigint {
    if (isHex(block)) return hexToBigInt(block);
    if (block === "earliest") return 0n;
    if (isPlainObject(block)) {
      if (isHex(block.blockNumber)) return hexToBigInt(block.blockNumber);
      if (isHex(block.blockHash)) {
        const number = numberOfBlockHash(block.blockHash);
        if (number === undefined)
          throw new MockNotFoundError(`No block with hash ${block.blockHash}.`, {
            details: "Only generated blocks' hashes resolve to a block number.",
          });
        return number;
      }
    }
    return blockNumber;
  }

  /** Code at an address the mock knows without a mock: placeholder code for contracts, none for empty. */
  function codeAt(address: Address): Hex | undefined {
    if (address === multicallAddress || contracts.some((c) => c.matches(address))) return "0xfe";
    if (emptyAddresses.has(address)) return "0x";
    return undefined;
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
     * chain and `cacheTime: 0`, so `mine()` shows up immediately. Options
     * override the defaults.
     */
    publicClient(options: MockPublicClientParameters = {}): PublicClient<CustomTransport, Chain> {
      return createPublicClient({ cacheTime: 0, ...options, chain, transport: transport() });
    },
    /**
     * Registers a mocked contract. Each address takes one registration; for a
     * proxy or extended contract, combine the ABIs (`abi: [...a, ...b]`).
     */
    contract<const abi extends Abi>(
      contractParameters: CreateMockContractParameters<abi>,
    ): MockContract<abi> {
      assertUnregistered(contractParameters.address);
      const internal = createMockContract(contractParameters, onCall);
      contracts.push(internal);
      return internal.contract;
    },
    /**
     * Mocks for viem's public actions beyond contract calls, e.g.
     * `mock.actions.getBalance({ address }).returns(parseEther("1"))`. Values
     * are in viem's own types; the mock encodes them for JSON-RPC.
     */
    actions: actions.actions,
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
      const active = createActiveFault(fault, options);
      faults.push(active);
      return {
        get count() {
          return active.count;
        },
        clear() {
          active.remaining = 0;
        },
      };
    },
    /**
     * Marks an address as having no code: calls to it succeed with empty data,
     * as on a real node. viem's `readContract` and `multicall` then fail with a
     * `ContractFunctionExecutionError` caused by `ContractFunctionZeroDataError`.
     */
    empty(address: Address) {
      assertUnregistered(address);
      emptyAddresses.add(getAddress(address));
    },
    /** The chain clients should use: as given, with Multicall3 added if it had none. */
    get chain() {
      return chain;
    },
    get chainId() {
      return chainId;
    },
    get blockNumber() {
      return blockNumber;
    },
    mine(blocks = 1n) {
      blockNumber += blocks;
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
      return formatHistory(history, options);
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
    assertNoUnhandled() {
      const [failure] = unhandledFailure(unhandled);
      if (failure !== undefined) throw new Error(failure);
    },
    /**
     * Throws if a mock never answered a call: its args are wrong and a broader
     * mock answered instead, or the app no longer makes the call it stands for.
     * Contract `defaults` aren't checked: they're shared setup, answers for
     * the whole suite that any one test may not use. For other shared setup
     * (actions, `method`, narrowed mocks), take a checkpoint after registering
     * it and use `restore({ assertAllUsed: true })`, which checks only what
     * was registered since.
     */
    assertAllUsed() {
      const [failure] = unusedFailure([
        ...contracts.flatMap((c) => c.unusedMocks()),
        ...actions.unusedMocks(),
      ]);
      if (failure !== undefined) throw new Error(failure);
    },
    /** Clears call and request history and usage; registrations and the block number stay. */
    clearCalls,
    /**
     * Saves what's registered now as a baseline to `restore()` to, e.g. after
     * each test, so shared setup can be registered once. Throws if requests
     * since the last clear went unanswered: a broken setup isn't a baseline. See `MockCheckpoint` for nesting and caveats.
     */
    checkpoint(): MockCheckpoint {
      if (unhandled.length > 0)
        throw new Error(
          `Can't checkpoint: ${unhandled.length} request(s) since the last clear ` +
            "went unanswered. Fix the setup, or call clearCalls() first if they were " +
            `intentional:\n${unhandled.map(({ error }) => `  - ${error.shortMessage}`).join("\n")}`,
        );

      const contractCount = contracts.length;
      const savedContracts = contracts.map((contract) => contract.checkpoint());
      const savedActions = actions.checkpoint();
      const savedEmpty = new Set(emptyAddresses);
      const savedFaults = faults.map((fault) => [fault, fault.remaining, fault.count] as const);
      const savedBlockNumber = blockNumber;
      const savedBatchCount = batchCount;
      const entry = { valid: true };
      checkpoints.push(entry);

      /** Mocks with args registered since this checkpoint that never answered. */
      const unusedSince = () => [
        ...savedContracts.flatMap((saved) => saved.unusedSince()),
        ...contracts.slice(contractCount).flatMap((contract) => contract.unusedMocks()),
        ...savedActions.unusedSince(),
      ];

      return {
        restore(options = {}) {
          if (!entry.valid)
            throw new Error(
              "This checkpoint is no longer valid: an earlier checkpoint was restored, " +
                "or reset() was called, after it was taken.",
            );
          // Checked first, because restoring clears what they look at; thrown
          // last, so a failed check can't leave the next test unrestored.
          const failures = [
            ...(options.assertNoUnhandled === true ? unhandledFailure(unhandled) : []),
            ...(options.assertAllUsed === true ? unusedFailure(unusedSince()) : []),
          ];

          // Checkpoints taken after this one describe state that's about to go away.
          for (const later of checkpoints.splice(checkpoints.indexOf(entry) + 1))
            later.valid = false;

          for (const contract of contracts.slice(contractCount)) contract.detach();
          contracts.length = contractCount;
          for (const saved of savedContracts) saved.restore();
          savedActions.restore();
          emptyAddresses.clear();
          for (const address of savedEmpty) emptyAddresses.add(address);
          faults.length = savedFaults.length;
          for (const [fault, remaining, count] of savedFaults) {
            fault.remaining = remaining;
            fault.count = count;
          }
          blockNumber = savedBlockNumber;
          batchCount = savedBatchCount;
          clearCalls();

          if (failures.length > 0) throw new Error(failures.join("\n\n"));
        },
      };
    },
    /**
     * Returns the mock to its initial state: no contracts, no history, and the
     * starting block number. Handles from before the reset throw if used to
     * register, and every checkpoint becomes invalid.
     */
    reset() {
      for (const entry of checkpoints.splice(0)) entry.valid = false;
      for (const contract of contracts) contract.detach();
      contracts.length = 0;
      actions.reset();
      emptyAddresses.clear();
      faults.length = 0;
      calls.length = 0;
      history.length = 0;
      requests.length = 0;
      unhandled.length = 0;
      batchCount = 0;
      blockNumber = initialBlockNumber;
    },
  };
}
