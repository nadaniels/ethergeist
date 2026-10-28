import { HttpRequestError, RpcRequestError, TimeoutError } from "viem";

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
 * Thrown by a resolver's `fail()` and caught by the rpc, which needs the raw
 * request to build viem's error. Internal: it never reaches viem.
 */
export class MockFailure extends Error {
  readonly fault: MockFault;

  constructor(fault: MockFault) {
    super("Mock fault");
    this.fault = fault;
  }
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
    throw new Error(`\`times\` must be a positive integer; got ${times}.`);
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

export function createFaultError(
  fault: MockFault,
  request: { method: string; params?: unknown },
): HttpRequestError | RpcRequestError | TimeoutError {
  const body = { method: request.method, params: request.params };
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
