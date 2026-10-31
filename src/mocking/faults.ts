import type { MockNodeFault } from "./types.js";

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
