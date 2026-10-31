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

type ActiveFault = {
  fault: MockFault;
  methods: readonly string[] | undefined;
  remaining: number;
  count: number;
};

function createActiveFault(fault: MockFault, options: FailRequestsOptions): ActiveFault {
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

function appliesTo(active: ActiveFault, method: string): boolean {
  return active.remaining > 0 && (active.methods?.includes(method) ?? true);
}

/**
 * `failRequests()`' faults. The most recent one that applies fails a request,
 * as the most recent mock answers one.
 */
export function createFaults() {
  const faults: ActiveFault[] = [];
  return {
    add(fault: MockFault, options: FailRequestsOptions = {}): MockFaultHandle {
      const active = createActiveFault(fault, options);
      faults.push(active);
      return {
        get count() {
          return active.count;
        },
        clear() {
          active.remaining = 0;
        },
      };
    },
    /** The fault that fails a request for `method`, if any, counting the use. */
    take(method: string): MockFault | undefined {
      const active = faults.findLast((each) => appliesTo(each, method));
      if (!active) return undefined;
      active.remaining -= 1;
      active.count += 1;
      return active.fault;
    },
    /** Saves the faults and their counts; `restore()` removes later ones. */
    checkpoint() {
      const saved = faults.map((fault) => [fault, fault.remaining, fault.count] as const);
      return {
        restore() {
          faults.length = saved.length;
          for (const [fault, remaining, count] of saved) Object.assign(fault, { remaining, count });
        },
      };
    },
  };
}
