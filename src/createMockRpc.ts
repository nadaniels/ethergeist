import {
  type Abi,
  type Address,
  type BlockTag,
  type CustomTransportConfig,
  type Hex,
  custom,
  getAddress,
  hexToBigInt,
  isHex,
  numberToHex,
} from "viem";
import {
  type CallContext,
  type CreateMockContractParameters,
  type InternalMockContract,
  type MockCall,
  type MockContract,
  createMockContract,
} from "./contract.js";
import { MockNotFoundError, MockResolverError } from "./errors.js";
import { multicall3Address, resolveMulticall } from "./multicall.js";

export type CreateMockRpcParameters = {
  /** Defaults to 1 (mainnet). */
  chainId?: number;
  /** Block number the mock starts at. Defaults to 1n. */
  blockNumber?: bigint;
  /**
   * Where Multicall3 `aggregate3` calls are answered. Defaults to the canonical
   * deployment, `0xcA11bde05977b3631167028862bE2a173976CA11`.
   */
  multicallAddress?: Address;
};

export type RpcRequest = { method: string; params?: unknown };

/** A request the mock couldn't answer: nothing was mocked for it, or a resolver threw. */
export type UnhandledRequest = RpcRequest & { error: MockNotFoundError | MockResolverError };

export type MockRpc = ReturnType<typeof createMockRpc>;

export function createMockRpc(parameters: CreateMockRpcParameters = {}) {
  const chainId = parameters.chainId ?? 1;
  const initialBlockNumber = parameters.blockNumber ?? 1n;
  let blockNumber = initialBlockNumber;
  const multicallAddress = parameters.multicallAddress ?? multicall3Address;
  const contracts: InternalMockContract<any>[] = [];
  const emptyAddresses = new Set<Address>();
  const calls: MockCall[] = [];
  const requests: RpcRequest[] = [];
  const unhandled: UnhandledRequest[] = [];
  let batchCount = 0;

  async function request(rpcRequest: RpcRequest): Promise<unknown> {
    const { method, params } = rpcRequest;
    const entry: RpcRequest = params === undefined ? { method } : { method, params };
    requests.push(entry);
    try {
      return await answer(rpcRequest);
    } catch (error) {
      // Recorded because callers can swallow these: app code with a fallback,
      // or viem's multicall turning a failed batch into per-call failures.
      if (error instanceof MockNotFoundError || error instanceof MockResolverError)
        unhandled.push({ ...entry, error });
      throw error;
    }
  }

  async function answer({ method, params }: RpcRequest): Promise<unknown> {
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
          BlockTag | Hex | undefined,
        ];
        const data = tx.data ?? tx.input;
        if (!data) throw new MockNotFoundError("eth_call without `data` is not supported.");
        if (!tx.to)
          throw new MockNotFoundError("eth_call without `to` is not supported.", {
            details:
              "Deployless calls (including deployless multicall) need bytecode execution. " +
              "Use a chain with a Multicall3 address, or set `multicallAddress`.",
          });

        return await dispatch(tx.to, data, {
          from: tx.from,
          value: tx.value ? hexToBigInt(tx.value) : 0n,
          blockNumber: resolveBlock(block),
          batch: undefined,
        });
      }
      default:
        throw new MockNotFoundError(`RPC method "${method}" is not mocked.`);
    }
  }

  function dispatch(to: Address, data: Hex, context: CallContext): Promise<Hex> {
    if (to.toLowerCase() === multicallAddress.toLowerCase())
      return resolveMulticall(data, {
        address: multicallAddress,
        batchId: ++batchCount,
        context,
        dispatch,
      });

    const target = contracts.find((c) => c.matches(to));
    if (target) return target.resolve(data, context);
    // A real node answers a call to an address without code with empty data.
    if (emptyAddresses.has(getAddress(to))) return Promise.resolve("0x");
    throw new MockNotFoundError(`No mocked contract at ${to}.`, {
      details:
        `Call data: ${data}\n` +
        "Register it with contract(), or mark it empty() for an address without code.",
    });
  }

  function assertUnregistered(address: Address) {
    if (contracts.some((c) => c.matches(address)))
      throw new Error(
        `A contract is already registered at ${address}. Register it once with a ` +
          "combined ABI (abi: [...a, ...b]), or call reset() between tests.",
      );
    if (emptyAddresses.has(getAddress(address)))
      throw new Error(`${address} is already registered as empty. Call reset() between tests.`);
  }

  function onCall(call: MockCall) {
    calls.push(call);
  }

  function resolveBlock(block: BlockTag | Hex | undefined): bigint {
    if (block === undefined || !isHex(block)) return blockNumber;
    return hexToBigInt(block);
  }

  return {
    request,
    /** A viem transport backed by this mock. */
    transport: (config?: CustomTransportConfig) => custom({ request }, config),
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
     * Marks an address as having no code: calls to it succeed with empty data,
     * as on a real node, which viem reports as `ContractFunctionZeroDataError`.
     */
    empty(address: Address) {
      assertUnregistered(address);
      emptyAddresses.add(getAddress(address));
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
      if (unhandled.length === 0) return;
      const lines = unhandled.map(({ error }) => `  - ${error.shortMessage}`);
      throw new Error(
        `The mock couldn't answer ${unhandled.length} request(s):\n${lines.join("\n")}`,
      );
    },
    /**
     * Throws if a mock registered with args never answered a call, which usually
     * means the args are wrong and a broader mock answered instead. Args-less
     * mocks and defaults are meant as fallbacks, so they're not checked.
     */
    assertAllUsed() {
      const unused = contracts.flatMap((c) => c.unusedMocks());
      if (unused.length === 0) return;
      const lines = unused.map((mock) => `  - ${mock}`);
      throw new Error(`${unused.length} mock(s) never answered a call:\n${lines.join("\n")}`);
    },
    /** Clears call and request history and usage; registrations and the block number stay. */
    clearCalls() {
      calls.length = 0;
      requests.length = 0;
      unhandled.length = 0;
      for (const contract of contracts) contract.clearCalls();
    },
    /**
     * Returns the mock to its initial state: no contracts, no history, and the
     * starting block number. Handles from before the reset no longer answer calls.
     */
    reset() {
      contracts.length = 0;
      emptyAddresses.clear();
      calls.length = 0;
      requests.length = 0;
      unhandled.length = 0;
      batchCount = 0;
      blockNumber = initialBlockNumber;
    },
  };
}
