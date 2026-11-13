import {
  type Abi,
  type AbiFunction,
  getAbiItem,
  toFunctionSelector,
  toFunctionSignature,
} from "viem";

import { formatCall } from "../mocking/format.js";
import { checkNoRunnerMatchers, findMatcher, pinWithoutUndefined } from "../mocking/matching.js";
import { checkList } from "../mocking/setupChecks.js";
import { withoutRepeats } from "../shared/abiValues.js";
import { MockSetupError } from "../shared/errors.js";
import { type StructFields, checkArgTypes, findMisfit, inputName, pinArgs } from "./argTypes.js";
import type { MockNamespace } from "./types.js";

/**
 * A contract's functions by kind (`reads`, view and pure; `writes`,
 * nonpayable and payable) and by namespace, as its mocks find them: reads
 * under `read`, writes under `simulate`, `estimateGas` and `write`, by name
 * and overload, or by selector.
 */
export function createFunctions(abi: Abi) {
  const functionsOf = (mutabilities: readonly string[]) =>
    withoutRepeats(
      abi.filter(
        (item): item is AbiFunction =>
          item.type === "function" && mutabilities.includes(item.stateMutability),
      ),
    );
  const reads = functionsOf(["view", "pure"]);
  const writes = functionsOf(["nonpayable", "payable"]);
  const functionsIn = {
    read: reads,
    simulate: writes,
    estimateGas: writes,
    write: writes,
  };
  const functionsBySelector = new Map(
    [...reads, ...writes].map((abiItem) => [toFunctionSelector(abiItem), abiItem]),
  );

  /** The functions named `functionName` in `namespace`: its overloads. */
  const overloadsOf = (namespace: MockNamespace, functionName: string) =>
    functionsIn[namespace].filter((abiItem) => abiItem.name === functionName);

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
   * The function a mock of `functionName` calls with `args`, looked up only
   * within `namespace` so an overload never binds across namespaces, and the
   * args it pins. A decoded call has every arg, each of its input's type, so
   * args that can't be one are refused: their mock could never match.
   *
   * First, the args must be a list, of the count the name's only function
   * takes, and an `undefined` or a test runner's matcher in it is refused.
   * Then, when only one function takes as many args (`onlyFunction`),
   * they're pinned as its args, and their types checked. Otherwise an
   * overload is chosen by which the args fit (`chooseOverload`). Args left
   * out match any call to the name's only function.
   */
  function pinFunctionArgs(
    namespace: MockNamespace,
    functionName: string,
    args: readonly unknown[] | undefined,
  ): { abiItem: AbiFunction; args: readonly unknown[] | undefined } {
    const overloads = overloadsOf(namespace, functionName);
    const only = onlyFunction(overloads, args);
    const subject = `${namespace}.${functionName}`;
    if (args === undefined) {
      if (only) return { abiItem: only, args };
      throw new MockSetupError(
        `Ambiguous overload for ${subject}(*): pin args to choose one, e.g. [match.any()].`,
        { metaMessages: ["Overloads:", ...listSignatures(overloads)] },
      );
    }
    checkList(
      args,
      `${subject}'s args`,
      only
        ? "Wrap them in a list, or leave them out to match any args."
        : "Wrap them in a list, e.g. [match.any()], to choose an overload.",
    );
    // Before the `undefined`s, whose hint can't fix a list too long.
    if (only) checkArgCount(subject, only, args);
    // Before an overload is chosen, so an `undefined` is refused by its slot,
    // not as args no overload takes.
    const stripped = pinWithoutUndefined(args, {
      name: (index) => `${subject}'s ${inputName(only, Number(index))}`,
      reason: "an arg can't be left out",
    });
    // Before the types are checked, so a test runner's matcher gets its own
    // refusal, not one for a type it doesn't fit.
    checkNoRunnerMatchers(stripped);

    if (only) {
      // Before the types are checked, so a malformed address gets viem's own
      // error, and a named struct written as a list is an object, its misfit
      // named `params.amountIn` rather than `params[1]`.
      const pinned = pinArgs(only, stripped);
      checkArgTypes(subject, only, pinned);
      return { abiItem: only, args: pinned };
    }
    const chosen = chooseOverload(overloads, subject, stripped);
    return { abiItem: chosen, args: pinArgs(chosen, stripped) };
  }

  return {
    reads,
    writes,
    functionsIn,
    functionsBySelector,
    overloadsOf,
    notInNamespaceError,
    pinFunctionArgs,
  };
}

/**
 * The one function of a name's `overloads` that `args` can call: its only
 * function, or else the only overload that takes as many args, since a
 * decoded call has every arg. `undefined` when none or several do, or when
 * an overloaded name's args aren't a list to count.
 */
function onlyFunction(
  overloads: readonly AbiFunction[],
  args: readonly unknown[] | undefined,
): AbiFunction | undefined {
  if (overloads.length === 1) return overloads[0];
  if (!Array.isArray(args)) return undefined;
  const ofCount = overloads.filter((overload) => overload.inputs.length === args.length);
  return ofCount.length === 1 ? ofCount[0] : undefined;
}

/**
 * Throws unless a mock gives as many `args` as `abiItem` takes: a decoded
 * call has every arg. A list too short is pointed to `match.any()`.
 */
function checkArgCount(subject: string, abiItem: AbiFunction, args: readonly unknown[]): void {
  const count = abiItem.inputs.length;
  if (args.length !== count)
    throw new MockSetupError(
      `${subject} takes ${argCount(count)}; got ${args.length}.`,
      args.length < count
        ? { metaMessages: ["Use match.any() for each arg that can be any value."] }
        : undefined,
    );
}

/**
 * The overload that `args` call, of the function `subject` names (e.g.
 * `read.quote`), when no one overload takes as many (`onlyFunction`). An
 * overload fits when each arg fits its input, as `findMisfit` says, matchers
 * included.
 * When several fit, the one the args are whole for is chosen: each struct
 * in them gives every field. When they're whole for several, viem's
 * `getAbiItem` chooses, as for the app's call, and throws when the types
 * can't be told apart (`5n` for `uint8` and `uint256`). Args that fit none,
 * whole for none, or for several with a matcher, are refused.
 */
function chooseOverload(
  overloads: readonly AbiFunction[],
  subject: string,
  args: readonly unknown[],
): AbiFunction {
  const takes = (overload: AbiFunction, fields: StructFields) =>
    overload.inputs.length === args.length &&
    args.every((arg, i) => findMisfit(overload.inputs[i]!, arg, fields) === undefined);
  const fits = overloads.filter((overload) => takes(overload, "some"));
  if (fits.length === 1) return fits[0]!;
  const call = formatCall(subject, args);
  if (fits.length === 0)
    throw new MockSetupError(`No overload takes ${call}.`, {
      metaMessages: ["Overloads:", ...listSignatures(overloads)],
    });

  const whole = fits.filter((overload) => takes(overload, "whole"));
  if (whole.length === 1) return whole[0]!;
  // viem can't tell overloads apart by a matcher.
  if (whole.length > 1 && findMatcher(args) === undefined)
    return getAbiItem({ abi: whole, name: overloads[0]!.name, args });
  throw new MockSetupError(`Ambiguous overload for ${call}: pin an arg that tells them apart.`, {
    metaMessages: ["It fits:", ...listSignatures(fits)],
  });
}

/** `count` args, for messages: "no args", "1 arg", "2 args". */
function argCount(count: number): string {
  if (count === 0) return "no args";
  return count === 1 ? "1 arg" : `${count} args`;
}

/** A hint line for each function: its signature, indented. */
function listSignatures(functions: readonly AbiFunction[]): string[] {
  return functions.map((abiItem) => `  ${toFunctionSignature(abiItem)}`);
}
