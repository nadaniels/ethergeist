import { HttpRequestError, RpcRequestError, TimeoutError, hexToBigInt, isHex } from "viem";
import type { MockRevertError } from "./errors.js";
import { nodeRevertMessage } from "./revert.js";

/** There is no real endpoint; viem's errors require a URL, so faults report this one. */
const url = "mock://viem-transport-mock";

/**
 * A transport-level failure, thrown as the same error viem's `http` transport
 * would produce, so viem's retry rules apply as in production:
 * - `{ status }`: an HTTP error response, e.g. `503` or `429`. `retryAfter`
 *   sets a `Retry-After` header in seconds, which viem waits for between retries.
 * - `{ code, message, data }`: a JSON-RPC error response. Use viem's error
 *   classes for known codes, e.g. `{ code: LimitExceededRpcError.code }`; viem
 *   maps the code back to that class, so tests can assert on it by name.
 * - `"timeout"`: the request took too long.
 * - `"network"`: the request never got a response, like a failed fetch.
 */
export type MockFault =
  | { status: number; retryAfter?: number }
  | { code: number; message?: string; data?: unknown }
  | "timeout"
  | "network";

/**
 * A node's refusal of a transaction it was asked to estimate or simulate,
 * named, with reth's code and message. viem tells these apart by the
 * message, as for a real node:
 * - `"insufficientFunds"`: the sender can't pay the value sent, viem's
 *   `InsufficientFundsError`. The message says the balance is 0.
 * - `"feeCapTooLow"`: `maxFeePerGas` is below the block's base fee, viem's
 *   `FeeCapTooLowError`.
 * - `"tipAboveFeeCap"`: `maxPriorityFeePerGas` is above `maxFeePerGas`,
 *   viem's `TipAboveFeeCapError`.
 */
export type NodeErrorName = "insufficientFunds" | "feeCapTooLow" | "tipAboveFeeCap";

/** A `MockFault`, or a node's refusal by name, where a node can refuse: see `NodeErrorName`. */
export type MockNodeFault = MockFault | NodeErrorName;

/**
 * Thrown by a resolver's `fail()` and caught by the rpc, which needs the raw
 * request to build viem's error. Internal: it never reaches viem.
 */
export class MockFailure extends Error {
  readonly fault: MockNodeFault;

  constructor(fault: MockNodeFault) {
    super("Mock fault");
    this.fault = fault;
  }
}

/** Handed to every resolver, contract or action, to fail the request it's answering. */
export function fail(fault: MockNodeFault): never {
  throw new MockFailure(fault);
}

export type FailRequestsOptions = {
  /** Only fail requests for these JSON-RPC methods. Defaults to every method. */
  method?: string | readonly string[];
  /** Only fail this many requests, then answer normally. Defaults to every request. */
  times?: number;
};

/** Returned by `failRequests()`, to inspect or stop the fault. */
export type MockFaultHandle = {
  /** How many requests this fault has failed. */
  readonly count: number;
  /** Stops failing requests. */
  clear(): void;
};

export type ActiveFault = {
  fault: MockFault;
  methods: readonly string[] | undefined;
  remaining: number;
  count: number;
};

export function createActiveFault(fault: MockFault, options: FailRequestsOptions): ActiveFault {
  const { method, times = Infinity } = options;
  if (times !== Infinity && !(Number.isInteger(times) && times > 0))
    throw new RangeError(`\`times\` takes a positive integer; got ${times}.`);
  return {
    fault,
    methods: typeof method === "string" ? [method] : method,
    remaining: times,
    count: 0,
  };
}

export function appliesTo(active: ActiveFault, method: string): boolean {
  return active.remaining > 0 && (active.methods?.includes(method) ?? true);
}

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

function isNodeErrorName(fault: MockNodeFault): fault is NodeErrorName {
  return typeof fault === "string" && Object.hasOwn(nodeErrors, fault);
}

/**
 * Reth's errors for each name, from the request's params: a transaction
 * first, as `eth_estimateGas` and `eth_call` take it (captured from reth
 * nodes for Ethereum and Base, 2026-10-29).
 */
const nodeErrors: Record<NodeErrorName, (params: unknown) => { code: number; message: string }> = {
  // Reth checks the balance against the value alone. With fee fields it
  // reports that check; without them, the EVM's.
  insufficientFunds(params) {
    const tx: unknown = Array.isArray(params) ? params[0] : undefined;
    if (typeof tx !== "object" || tx === null || !("gasPrice" in tx || "maxFeePerGas" in tx))
      return { code: -32003, message: "EVM error: OutOfFunds" };
    const value = "value" in tx && isHex(tx.value) ? hexToBigInt(tx.value) : 0n;
    return {
      code: -32003,
      message: `insufficient funds for gas * price + value: have 0 want ${value}`,
    };
  },
  feeCapTooLow: () => ({ code: -32000, message: "max fee per gas less than block base fee" }),
  tipAboveFeeCap: () => ({
    code: -32003,
    message: "max priority fee per gas higher than max fee per gas",
  }),
};
