import {
  type Abi,
  type AbiFunction,
  type AbiParameter,
  encodeAbiParameters,
  getAbiItem,
  toFunctionSelector,
  toFunctionSignature,
  getAddress,
} from "viem";

import { formatCall, formatValue } from "../mocking/format.js";
import { isMatcher, partialMatcher } from "../mocking/matchers.js";
import { type MatchOptions, findMatcher, firstMismatch, mismatches } from "../mocking/matching.js";
import type { PinnedKey } from "../mocking/types.js";
import { arrayElement, withoutRepeats } from "../shared/abiValues.js";
import { MockSetupError } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import type { MockCall, MockNamespace } from "./types.js";

/**
 * A contract's functions by namespace, as its mocks find them: view and pure
 * functions under `read`, nonpayable and payable ones under `simulate`,
 * `estimateGas` and `write`, by name and overload, or by selector.
 */
export function createFunctions(abi: Abi) {
  const functionsOf = (mutabilities: readonly string[]) =>
    withoutRepeats(
      abi.filter(
        (item): item is AbiFunction =>
          item.type === "function" && mutabilities.includes(item.stateMutability),
      ),
    );
  const writes = functionsOf(["nonpayable", "payable"]);
  const functionsIn = {
    read: functionsOf(["view", "pure"]),
    simulate: writes,
    estimateGas: writes,
    write: writes,
  };
  const functionsBySelector = new Map(
    [...functionsIn.read, ...functionsIn.simulate].map((abiItem) => [
      toFunctionSelector(abiItem),
      abiItem,
    ]),
  );

  /**
   * The error for a name that isn't in `namespace`, saying where it is
   * instead, if anywhere.
   */
  function notInNamespaceError(namespace: MockNamespace, functionName: string) {
    const other = namespace === "read" ? "simulate" : "read";
    const elsewhere = functionsIn[other].find((abiItem) => abiItem.name === functionName);
    if (!elsewhere)
      return new MockSetupError(`No function "${functionName}" on this contract's ABI.`);
    const kind = `"${functionName}" is a ${elsewhere.stateMutability} function`;
    return namespace === "estimateGas"
      ? new MockSetupError(`${kind}; viem estimates gas only for nonpayable and payable functions.`)
      : new MockSetupError(`${kind}; register it under ${other}, not ${namespace}.`);
  }

  /**
   * The function `args` call, looked up only within `namespace`, so an overload
   * never binds across namespaces. viem's `getAbiItem` tells overloads apart by
   * their args' values, and silently picks the first when none fits. Matchers
   * fit no type, so with matchers, overloads are told apart by the exact args
   * alone. Args holding a matcher anywhere are skipped whole: a
   * `match.partial()` could rule overloads out field by field, but doesn't.
   */
  function findFunction(
    namespace: MockNamespace,
    functionName: string,
    args: readonly unknown[] | undefined,
  ): AbiFunction {
    const overloads = functionsIn[namespace].filter((abiItem) => abiItem.name === functionName);
    if (args === undefined && overloads.length > 1)
      throw new MockSetupError(
        `Ambiguous overload for ${functionName}(*): pin args to choose one, e.g. [match.any()].`,
        { metaMessages: ["Overloads:", listSignatures(overloads)] },
      );
    if (overloads.length < 2 || findMatcher(args) === undefined) {
      const abiItem = getAbiItem({ abi: functionsIn[namespace], name: functionName, args });
      // viem's type assumes a match, but untyped callers can pass any name.
      if (abiItem === undefined) throw notInNamespaceError(namespace, functionName);
      return abiItem;
    }

    const fits = overloads.filter(
      (overload) =>
        overload.inputs.length === args!.length &&
        args!.every(
          (arg, i) => findMatcher(arg) !== undefined || isOfType(overload.inputs[i]!, arg),
        ),
    );
    if (fits.length === 1) return fits[0]!;
    const call = formatCall(functionName, args);
    throw new MockSetupError(
      fits.length === 0
        ? `No overload of "${functionName}" takes ${call}.`
        : `Ambiguous overload for ${call}: pin an arg that tells them apart.`,
      {
        metaMessages:
          fits.length === 0
            ? ["Overloads:", listSignatures(overloads)]
            : ["It fits:", listSignatures(fits)],
      },
    );
  }

  return { functionsIn, functionsBySelector, notInNamespaceError, findFunction };
}

function listSignatures(functions: readonly AbiFunction[]): string {
  return functions.map((abiItem) => `  ${toFunctionSignature(abiItem)}`).join("\n");
}

/** Whether `value` encodes as `parameter`'s type. */
function isOfType(parameter: AbiParameter, value: unknown): boolean {
  try {
    encodeAbiParameters([parameter], [value]);
    return true;
  } catch {
    return false;
  }
}

/**
 * `value` with every address-typed part checksummed, which also validates it.
 * Partial structs keep only the fields they have; anything that isn't a
 * string where an address goes is left for the types (or matching) to judge.
 * A `match.partial()` gets its fields checksummed; other matchers are left as
 * they are.
 */
function checksumAddresses(parameter: AbiParameter, value: unknown): unknown {
  if (isMatcher(value))
    return value.type === "partial"
      ? partialMatcher(checksumAddresses(parameter, { ...value.fields }))
      : value;
  if (parameter.type === "address") return typeof value === "string" ? getAddress(value) : value;

  const element = arrayElement(parameter);
  if (element)
    return Array.isArray(value) ? value.map((item) => checksumAddresses(element, item)) : value;

  if (parameter.type === "tuple" && "components" in parameter) {
    const { components } = parameter;
    if (Array.isArray(value))
      return value.map((v: unknown, i) =>
        components[i] ? checksumAddresses(components[i], v) : v,
      );
    if (isPlainObject(value))
      return Object.fromEntries(
        Object.entries(value).map(([key, v]) => {
          const component = components.find((candidate) => candidate.name === key);
          return [key, component ? checksumAddresses(component, v) : v];
        }),
      );
  }
  return value;
}

/**
 * `args` as a mock of `abiItem` pins them: address-typed parts checksummed,
 * so messages show addresses one way and a malformed one fails at registration.
 */
export function pinArgs(
  abiItem: AbiFunction,
  args: readonly unknown[] | undefined,
): readonly unknown[] | undefined {
  return args?.map((arg, i) => {
    const input = abiItem.inputs[i];
    return input ? checksumAddresses(input, arg) : arg;
  });
}

/** A mock's pinned `from` and `value`, beside its args: only those given. */
export type Pins = { readonly from?: unknown; readonly value?: unknown };

/**
 * `pins` as a mock of `abiItem` pins them, checked: `from` an address
 * (checksummed) or a matcher, and `value` only on a payable function, as
 * no other takes one. `undefined` when nothing is pinned.
 */
export function pinCall(abiItem: AbiFunction, pins: unknown): Pins | undefined {
  if (pins === undefined) return undefined;
  if (!isPlainObject(pins) || isMatcher(pins))
    throw new MockSetupError(`A mock pins from and value as an object; got ${formatValue(pins)}.`);
  const { from, value, ...rest } = pins;
  const [other] = Object.keys(rest);
  if (other !== undefined)
    throw new MockSetupError(`A mock pins from and value, not ${other}.`, {
      metaMessages: ["Pin the sender as from, e.g. { from: alice }."],
    });
  if (value !== undefined && abiItem.stateMutability !== "payable")
    throw new MockSetupError(
      `"${abiItem.name}" is ${abiItem.stateMutability}, so it takes no value; only a payable function's mock pins one.`,
    );
  if (from !== undefined && !isMatcher(from) && typeof from !== "string")
    throw new MockSetupError(`from takes an address or a matcher; got ${formatValue(from)}.`);
  const pinned: Pins = {
    ...(from !== undefined && { from: typeof from === "string" ? getAddress(from) : from }),
    ...(value !== undefined && { value }),
  };
  return Object.keys(pinned).length === 0 ? undefined : pinned;
}

/**
 * Whether `call` lacks the `from` that `pins` pins: then it doesn't match,
 * and no predicate runs.
 */
const lacksFrom = (pins: Pins, call: MockCall) =>
  pins.from !== undefined && call.from === undefined;

/** Where `call` first differs from a mock's `pins`, as `firstMismatch` says. */
export const firstPinMismatch = (
  pins: Pins | undefined,
  call: MockCall,
  options: MatchOptions,
): PinnedKey | undefined =>
  pins === undefined
    ? undefined
    : lacksFrom(pins, call)
      ? "from"
      : firstMismatch(pins, { from: call.from, value: call.value }, options);

/** Every key of a mock's `pins` that `call` doesn't match, for messages. */
export const pinMismatches = (pins: Pins | undefined, call: MockCall): PinnedKey[] =>
  pins === undefined
    ? []
    : lacksFrom(pins, call)
      ? ["from"]
      : mismatches(pins, { from: call.from, value: call.value });
