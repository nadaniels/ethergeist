import { HttpRequestError, RpcRequestError, TimeoutError } from "viem";

import { nodeErrors, nodeRevertMessage } from "../chain/nodeErrors.js";
import { MockFailure, isNodeErrorName } from "../mocking/faults.js";
import type { MockNodeFault } from "../mocking/types.js";
import { MockRevertError, MockRpcError } from "../shared/errors.js";

/**
 * The URL viem's errors name, since they require one: the mock has no
 * endpoint.
 */
const url = "mock://viem-transport-mock";

/**
 * A revert as viem's `http` transport reports it from a reth node: an
 * `RpcRequestError` with code 3, the node's message for the revert data, and
 * the data itself, left out when it's empty. viem reads the reason and the
 * data from it, as in production. Other nodes word the message differently,
 * but viem builds the same classes and decoded revert from them.
 */
function createRevertRpcError(
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

/**
 * A fault as viem's `http` transport reports it: a node's refusal or a
 * JSON-RPC error as an `RpcRequestError`, a timeout as a `TimeoutError`, and
 * an HTTP status or no response as an `HttpRequestError`.
 */
function createFaultError(
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

/**
 * `error`, thrown while answering `request`, as viem's error: a fault
 * (`MockFailure`), a revert or a node's refusal becomes what viem's `http`
 * transport throws for a node failing that way, so viem's retry rules and
 * error classes apply as in production. Anything else, what the mock
 * couldn't answer, is returned as is.
 */
export function toViemError(error: unknown, request: { method: string; params?: unknown }) {
  const body = request.params === undefined ? { method: request.method } : request;
  if (error instanceof MockFailure) return createFaultError(error.fault, body);
  if (error instanceof MockRevertError) return createRevertRpcError(error, body);
  if (error instanceof MockRpcError)
    return createFaultError({ code: error.code, message: error.shortMessage }, body);
  return error;
}
