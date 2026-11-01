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

/** Public client options, minus the chain and transport, which come from the mock. */
export type MockPublicClientParameters = Omit<
  PublicClientConfig<CustomTransport, Chain>,
  "chain" | "transport"
>;

/**
 * The mock for viem: its requests answered as viem's `http` transport would
 * answer them, a transport over them, and a public client on the mock's
 * chain. `handle` answers a request with the mock's own errors.
 */
export function createViemAdapter({ handle, chain }: { handle: RequestHandler; chain: Chain }) {
  /** Answers a request as viem's `http` transport would; `retryCount` is the transport's. */
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
        { retryDelay: 0, ...config },
      )(params);
      retryCount = created.config.retryCount;
      return created;
    };
  }

  function publicClient(
    options: MockPublicClientParameters = {},
  ): PublicClient<CustomTransport, Chain> {
    return createPublicClient({
      cacheTime: 0,
      pollingInterval: 50,
      ...options,
      chain,
      transport: transport(),
    });
  }

  return {
    request: (rpcRequest: RpcRequest) => request(rpcRequest),
    transport,
    publicClient,
  };
}
