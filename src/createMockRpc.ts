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
  type CreateMockContractParameters,
  type InternalMockContract,
  type MockContract,
  createMockContract,
} from "./contract.js";
import { MockNotFoundError } from "./errors.js";

export type CreateMockRpcParameters = {
  /** Defaults to 1 (mainnet). */
  chainId?: number;
  /** Block number the mock starts at. Defaults to 1n. */
  blockNumber?: bigint;
};

export type RpcRequest = { method: string; params?: unknown };

export function createMockRpc(parameters: CreateMockRpcParameters = {}) {
  const chainId = parameters.chainId ?? 1;
  let blockNumber = parameters.blockNumber ?? 1n;
  const contracts: InternalMockContract<any>[] = [];
  const requests: RpcRequest[] = [];

  async function request({ method, params }: RpcRequest): Promise<unknown> {
    requests.push(params === undefined ? { method } : { method, params });

    switch (method) {
      case "eth_chainId":
        return numberToHex(chainId);
      case "eth_blockNumber":
        return numberToHex(blockNumber);
      case "eth_call": {
        const [tx, block] = params as [
          { to?: Address; from?: Address; data?: Hex; input?: Hex },
          BlockTag | Hex | undefined,
        ];
        const data = tx.data ?? tx.input;
        if (!tx.to || !data)
          throw new MockNotFoundError("eth_call without `to` and `data` is not supported.");

        const target = contracts.findLast((c) => c.matches(tx.to!));
        if (!target)
          throw new MockNotFoundError(`No mocked contract at ${tx.to}.`, {
            details: `Call data: ${data}`,
          });

        return target.resolve(data, {
          from: tx.from,
          blockNumber: resolveBlock(block),
        });
      }
      default:
        throw new MockNotFoundError(`RPC method "${method}" is not mocked.`);
    }
  }

  function resolveBlock(block: BlockTag | Hex | undefined): bigint {
    if (block === undefined || !isHex(block)) return blockNumber;
    return hexToBigInt(block);
  }

  return {
    request,
    /** A viem transport backed by this mock. */
    transport: (config?: CustomTransportConfig) => custom({ request }, config),
    contract<const abi extends Abi>(
      parameters: CreateMockContractParameters<abi>,
    ): MockContract<abi> {
      const internal = createMockContract(parameters);
      contracts.push(internal);
      return internal.contract;
    },
    get blockNumber() {
      return blockNumber;
    },
    mine(blocks = 1n) {
      blockNumber += blocks;
    },
    /** Every raw JSON-RPC request the mock has received, in order. */
    requests,
  };
}
