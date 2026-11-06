import {
  type Chain,
  type CustomTransport,
  type CustomTransportConfig,
  type PublicClient,
  type PublicClientConfig,
  createPublicClient,
  custom,
} from "viem";

import type { RpcRequest } from "../history/types.js";
import type { RequestHandler } from "../rpc/requestHandler.js";
import { toViemError } from "./errors.js";

/**
 * What `mock.publicClient()` takes: viem's public client options, without
 * `chain` and `transport`, which come from the mock, and with the
 * transport's `retryCount` and `retryDelay`.
 */
export type MockPublicClientParameters = Omit<
  PublicClientConfig<CustomTransport, Chain>,
  "chain" | "transport"
> &
  Pick<CustomTransportConfig, "retryCount" | "retryDelay">;

/**
 * The mock's adapter for viem: `request`, which throws the mock's answers as
 * viem's errors (see `toViemError`), a transport over it, and a public
 * client on `chain`. `handle` throws the mock's own errors.
 */
export function createViemAdapter({ handle, chain }: { handle: RequestHandler; chain: Chain }) {
  /**
   * Answers a request, throwing viem's errors (see `toViemError`).
   * `retryCount` is the transport's, for the retry hint.
   */
  async function request(rpcRequest: RpcRequest, retryCount?: number): Promise<unknown> {
    try {
      return await handle(rpcRequest, retryCount);
    } catch (error) {
      throw toViemError(error, rpcRequest);
    }
  }

  function transport(config?: CustomTransportConfig): CustomTransport {
    // Each transport tells its requests its resolved `retryCount` (its own,
    // a fallback transport's, or viem's default), for the retry hint.
    return (params) => {
      let retryCount: number | undefined;
      const created = custom(
        { request: (args: RpcRequest) => request(args, retryCount) },
        { ...config, retryDelay: config?.retryDelay ?? 0 },
      )(params);
      retryCount = created.config.retryCount;
      return created;
    };
  }

  function publicClient({
    retryCount,
    retryDelay,
    ...options
  }: MockPublicClientParameters = {}): PublicClient<CustomTransport, Chain> {
    return createPublicClient({
      ...options,
      cacheTime: options.cacheTime ?? 0,
      pollingInterval: options.pollingInterval ?? 50,
      chain,
      transport: transport({ retryCount, retryDelay }),
    });
  }

  return {
    request: (rpcRequest: RpcRequest) => request(rpcRequest),
    transport,
    publicClient,
  };
}
