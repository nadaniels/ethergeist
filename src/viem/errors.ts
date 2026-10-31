import { HttpRequestError, RpcRequestError, TimeoutError } from "viem";
import type { MockRevertError } from "../shared/errors.js";
import type { MockNodeFault } from "../mocking/types.js";
import { isNodeErrorName, nodeErrors, nodeRevertMessage } from "../chain/nodeErrors.js";

/** There is no real endpoint; viem's errors require a URL, so faults report this one. */
const url = "mock://viem-transport-mock";

/**
 * A revert as viem's `http` transport reports it from a reth node: an
 * `RpcRequestError` with code 3, the node's message for the revert data, and
 * the data itself, left out when it's empty. Other nodes word the message
 * differently, but viem builds the same classes and decoded revert from them. viem reads the
 * reason and the data from it, as in production.
 */
export function createRevertRpcError(
  revert: MockRevertError,
  request: { method: string; params?: unknown },
): RpcRequestError {
  const message = nodeRevertMessage(revert.data);
  return new RpcRequestError({
    body: { method: request.method, params: request.params },
    url,
    error:
      revert.data === "0x"
        ? { code: revert.code, message }
        : { code: revert.code, message, data: revert.data },
  });
}

export function createFaultError(
  fault: MockNodeFault,
  request: { method: string; params?: unknown },
): HttpRequestError | RpcRequestError | TimeoutError {
  const body = { method: request.method, params: request.params };
  if (isNodeErrorName(fault))
    return new RpcRequestError({ body, url, error: nodeErrors[fault](request.params) });
  if (fault === "timeout") return new TimeoutError({ body, url });
  if (fault === "network")
    return new HttpRequestError({ body, url, details: "The request got no response." });
  if ("status" in fault)
    return new HttpRequestError({
      body,
      url,
      status: fault.status,
      ...(fault.retryAfter === undefined
        ? {}
        : { headers: new Headers({ "Retry-After": String(fault.retryAfter) }) }),
    });
  return new RpcRequestError({
    body,
    url,
    error: {
      code: fault.code,
      message: fault.message ?? "Mock RPC error.",
      ...(fault.data === undefined ? {} : { data: fault.data }),
    },
  });
}
