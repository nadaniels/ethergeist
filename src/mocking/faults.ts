import type { MockNodeFault } from "./types.js";

/**
 * A deliberate failure: a resolver's `fail()`, a mock's `.fails()`, or a
 * `failRequests()` fault. Internal: it never reaches viem, whose adapter
 * turns it into the error viem's `http` transport would throw.
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
