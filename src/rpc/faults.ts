import { checkFault } from "../mocking/faults.js";
import { formatValue } from "../mocking/format.js";
import { checkCount } from "../mocking/setupChecks.js";
import type { MockFault } from "../mocking/types.js";
import { MockSetupError } from "../shared/errors.js";

/** What `mock.failRequests()` takes besides its fault. */
export type FailRequestsOptions = {
  /**
   * The JSON-RPC method, or methods, whose requests it fails, e.g.
   * `"eth_call"`. Defaults to every method, `eth_chainId` and
   * `eth_blockNumber` included.
   */
  method?: string | readonly string[];
  /**
   * How many requests it fails before they're answered again, a positive
   * integer. Defaults to every request until it's cleared.
   */
  times?: number;
};

/** A `mock.failRequests()` fault's handle, to read its count or stop it. */
export type MockFaultHandle = {
  /** How many requests the fault has failed. */
  readonly count: number;
  /** Stops failing requests. */
  clear(): void;
};

/**
 * A `failRequests()` fault as it's held: its methods, how many requests it
 * has left to fail, and how many it failed.
 */
type ActiveFault = {
  fault: MockFault;
  methods: readonly string[] | undefined;
  remaining: number;
  count: number;
};

function createActiveFault(fault: MockFault, options: FailRequestsOptions): ActiveFault {
  checkFault(fault);
  const { method, times = Infinity } = options;
  const methods = typeof method === "string" ? [method] : method;
  if (
    methods !== undefined &&
    !(Array.isArray(methods) && methods.every((each) => typeof each === "string"))
  )
    throw new MockSetupError(
      `failRequests()'s method must be a method name or a list of them; got ${formatValue(method)}.`,
    );
  if (times !== Infinity)
    checkCount(times, "failRequests()'s times", 1, "Or Infinity, the default: every request.");
  return {
    fault,
    methods,
    remaining: times,
    count: 0,
  };
}

function appliesTo(active: ActiveFault, method: string): boolean {
  return active.remaining > 0 && (active.methods?.includes(method) ?? true);
}

/** `failRequests()`' faults: see `createFaults`. */
export type Faults = ReturnType<typeof createFaults>;

/**
 * `failRequests()`' faults. The most recent one that applies fails a
 * request: one for its method, with requests left to fail.
 */
export function createFaults() {
  const faults: ActiveFault[] = [];
  return {
    /** Adds a fault, checked first, and returns its handle. */
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
    /**
     * Applies the fault that fails a request for `method`, if any, counting
     * the use.
     */
    applyTo(method: string): MockFault | undefined {
      const active = faults.findLast((each) => appliesTo(each, method));
      if (!active) return undefined;
      active.remaining -= 1;
      active.count += 1;
      return active.fault;
    },
    /** Saves the faults and their counts; `restore()` removes later ones. */
    snapshot() {
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
