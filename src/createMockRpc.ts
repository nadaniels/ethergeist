import {
  type Abi,
  type Address,
  type BlockTag,
  type CustomTransportConfig,
  type Hex,
  custom,
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
import { MockNotFoundError } from "./errors.js";
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

export type MockRpc = ReturnType<typeof createMockRpc>;

export function createMockRpc(parameters: CreateMockRpcParameters = {}) {
  const chainId = parameters.chainId ?? 1;
  const initialBlockNumber = parameters.blockNumber ?? 1n;
  let blockNumber = initialBlockNumber;
  const multicallAddress = parameters.multicallAddress ?? multicall3Address;
  const contracts: InternalMockContract<any>[] = [];
  const calls: MockCall[] = [];
  const requests: RpcRequest[] = [];
  let batchCount = 0;

  async function request({ method, params }: RpcRequest): Promise<unknown> {
    requests.push(params === undefined ? { method } : { method, params });

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
    if (!target)
      throw new MockNotFoundError(`No mocked contract at ${to}.`, {
        details: `Call data: ${data}`,
      });
    return target.resolve(data, context);
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
      const { address } = contractParameters;
      if (contracts.some((c) => c.matches(address)))
        throw new Error(
          `A contract is already registered at ${address}. Register it once with a ` +
            "combined ABI (abi: [...a, ...b]), or call reset() between tests.",
        );
      const internal = createMockContract(contractParameters, (call) => {
        calls.push(call);
      });
      contracts.push(internal);
      return internal.contract;
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
    /** Clears call and request history; registrations and the block number stay. */
    clearCalls() {
      calls.length = 0;
      requests.length = 0;
      for (const contract of contracts) contract.clearCalls();
    },
    /**
     * Returns the mock to its initial state: no contracts, no history, and the
     * starting block number. Handles from before the reset no longer answer calls.
     */
    reset() {
      contracts.length = 0;
      calls.length = 0;
      requests.length = 0;
      batchCount = 0;
      blockNumber = initialBlockNumber;
    },
  };
}
