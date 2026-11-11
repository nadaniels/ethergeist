import { MockSetupError } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import { formatValue } from "./format.js";
import { type MockFault, type NodeErrorName, nodeErrorNames } from "./types.js";

/**
 * A deliberate fault: a resolver's `fail()`, a mock's `.fails()`, or a
 * `failRequests()` fault. It never reaches the client: an adapter turns it
 * into its client's error, as `toViemError` does for viem.
 */
export class MockFailure extends Error {
  readonly fault: MockFault;

  constructor(fault: MockFault) {
    super("Mock fault");
    this.fault = fault;
  }
}

/**
 * A node's refusal, given on purpose: a resolver's `refuse()` or a mock's
 * `.refuses()`. Like `MockFailure`, an adapter turns it into its client's
 * error, from the request's params.
 */
export class MockRefusal extends Error {
  readonly refusal: NodeErrorName;

  constructor(refusal: NodeErrorName) {
    super("Mock refusal");
    this.refusal = refusal;
  }
}

/** Whether `value` is a node's refusal by name (see `NodeErrorName`). */
const isNodeErrorName = (value: unknown): value is NodeErrorName =>
  nodeErrorNames.some((name) => name === value);

const isOptional = (value: unknown, type: "number" | "string") =>
  value === undefined || typeof value === type;

/**
 * Throws unless `fault` is a fault, so a cast or plain JavaScript can't
 * register what the mock can't answer with. A node's refusal by name is
 * refused with a hint of its own, naming `.refuses()`.
 */
export function checkFault(fault: unknown): asserts fault is MockFault {
  if (fault === "timeout" || fault === "network") return;
  if (isPlainObject(fault)) {
    if ("status" in fault) {
      if (Number.isInteger(fault.status) && isOptional(fault.retryAfter, "number")) return;
    } else if (Number.isInteger(fault.code) && isOptional(fault.message, "string")) return;
  }
  const message = `Expected a fault; got ${formatValue(fault)}.`;
  if (isNodeErrorName(fault))
    throw new MockSetupError(message, {
      metaMessages: [
        `"${fault}" is a node's refusal: use .refuses("${fault}"), or refuse("${fault}") in a resolver.`,
        "A node refuses only simulations, estimates and sends.",
      ],
    });
  throw new MockSetupError(message, {
    metaMessages: [
      "A fault is one of:",
      "- { status, retryAfter? }: an HTTP error response, e.g. { status: 503 };",
      "- { code, message?, data? }: a JSON-RPC error response;",
      '- "timeout" or "network".',
    ],
  });
}

/**
 * Throws unless `refusal` is a node's refusal by name. Names are typed only
 * where a node can refuse with them; any of them passes here.
 */
export function checkRefusal(refusal: unknown): asserts refusal is NodeErrorName {
  if (isNodeErrorName(refusal)) return;
  throw new MockSetupError(`Expected a node's refusal by name; got ${formatValue(refusal)}.`, {
    metaMessages: [
      `A node's refusal is one of: ${nodeErrorNames.map((name) => `"${name}"`).join(", ")}.`,
      "For a fault, use .fails(), or fail() in a resolver.",
    ],
  });
}

/**
 * Fails the request a resolver's call is in with `fault`, checked first.
 * Handed to every resolver, contract or action.
 */
export function fail(fault: MockFault): never {
  checkFault(fault);
  throw new MockFailure(fault);
}

/**
 * Refuses the request a resolver's call is in with `refusal`, checked
 * first. Handed to every resolver, contract or action; the types offer it
 * only where a node can refuse.
 */
export function refuse(refusal: NodeErrorName): never {
  checkRefusal(refusal);
  throw new MockRefusal(refusal);
}
