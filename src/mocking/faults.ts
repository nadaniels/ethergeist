import { MockSetupError } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import { formatValue } from "./format.js";
import { type MockNodeFault, type NodeErrorName, nodeErrorNames } from "./types.js";

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

export function isNodeErrorName(fault: unknown): fault is NodeErrorName {
  return nodeErrorNames.some((name) => name === fault);
}

const isOptional = (value: unknown, type: "number" | "string") =>
  value === undefined || typeof value === type;

/**
 * Throws unless `fault` is one, so a cast or plain JavaScript can't register
 * what the mock can't answer with. Names are typed only where a node can
 * refuse with them; any of them passes here.
 */
export function checkFault(fault: unknown): asserts fault is MockNodeFault {
  if (fault === "timeout" || fault === "network" || isNodeErrorName(fault)) return;
  if (isPlainObject(fault)) {
    if ("status" in fault) {
      if (Number.isInteger(fault.status) && isOptional(fault.retryAfter, "number")) return;
    } else if (Number.isInteger(fault.code) && isOptional(fault.message, "string")) return;
  }
  throw new MockSetupError(`Expected a fault; got ${formatValue(fault)}.`, {
    metaMessages: [
      "A fault is one of:",
      "- { status, retryAfter? }: an HTTP error response, e.g. { status: 503 };",
      "- { code, message?, data? }: a JSON-RPC error response;",
      '- "timeout" or "network";',
      '- a node\'s refusal by name, where one is typed, e.g. "insufficientFunds".',
    ],
  });
}

/** Handed to every resolver, contract or action, to fail the request it's answering. */
export function fail(fault: MockNodeFault): never {
  checkFault(fault);
  throw new MockFailure(fault);
}
