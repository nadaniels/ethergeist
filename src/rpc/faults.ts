import type { MockFault } from "../mocking/types.js";

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
