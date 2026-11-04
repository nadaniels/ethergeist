import { HttpRequestError, RpcRequestError, TimeoutError } from "viem";

import { nodeErrors, nodeRevertMessage } from "../chain/nodeErrors.js";
import { MockFailure, isNodeErrorName } from "../mocking/faults.js";
import type { MockNodeFault } from "../mocking/types.js";
import { MockRevertError, MockRpcError } from "../shared/errors.js";

/** There is no real endpoint; viem's errors require a URL, so faults report this one. */
const url = "mock://viem-transport-mock";

/**
 * A revert as viem's `http` transport reports it from a reth node: an
 * `RpcRequestError` with code 3, the node's message for the revert data, and
 * the data itself, left out when it's empty. Other nodes word the message
 * differently, but viem builds the same classes and decoded revert from them. viem reads the
 * reason and the data from it, as in production.
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
 * `error`, as viem's `http` transport would throw it for `request`: the
 * mock's faults, reverts, and node refusals become viem's errors, so its
 * retry rules and error classes apply as in production. Anything else (what
 * the mock couldn't answer) is thrown as is.
 */
export function toViemError(error: unknown, request: { method: string; params?: unknown }) {
  const body = request.params === undefined ? { method: request.method } : request;
  // A mock's `.fails()` or `fail()`, or a `failRequests()` fault.
  if (error instanceof MockFailure) return createFaultError(error.fault, body);
  // A revert reaches viem the way a node's would, and so does a node's refusal.
  if (error instanceof MockRevertError) return createRevertRpcError(error, body);
  if (error instanceof MockRpcError)
    return createFaultError({ code: error.code, message: error.shortMessage }, body);
  return error;
}
