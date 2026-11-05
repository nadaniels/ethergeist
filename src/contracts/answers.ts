import {
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type Hex,
  encodeFunctionResult,
  encodeErrorResult,
  isHex,
} from "viem";

import { formatValue } from "../mocking/format.js";
import { encodeGas } from "../mocking/gas.js";
import { assertNoMatchers } from "../mocking/matching.js";
import { zeroResult } from "../mocking/zeroResult.js";
import { builtinErrors, fillZeros } from "../shared/abiValues.js";
import { MockRevertError, MockSetupError, refuseUnencodable } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import type { MockNamespace, RevertSpec } from "./types.js";

/**
 * Turns what a resolver returned into the value viem's encoder expects: named
 * outputs become a tuple in ABI order, and omitted struct fields get zero values.
 */
function normalizeResult(outputs: readonly AbiParameter[], value: unknown): unknown {
  if (value === zeroResult) return normalizeResult(outputs, outputs.length > 1 ? [] : undefined);
  if (outputs.length === 0) return value;
  if (outputs.length === 1) return fillZeros(outputs[0]!, value);
  if (Array.isArray(value)) return outputs.map((output, i) => fillZeros(output, value[i]));
  if (isPlainObject(value) && outputs.every((output) => output.name))
    return outputs.map((output) => fillZeros(output, value[output.name!]));
  return value;
}

/** Answers a contract call `eth_call`'s way, or an estimate as gas, as a JSON-RPC quantity. */
export function encodeAnswer(
  { namespace, abiItem }: { namespace: MockNamespace; abiItem: AbiFunction },
  value: unknown,
): Hex {
  return namespace === "estimateGas" ? encodeGas(value) : encodeResult(abiItem, value);
}

/** `value` as `abiItem`'s encoded return data, as `eth_call` answers. */
function encodeResult(abiItem: AbiFunction, value: unknown): Hex {
  assertNoMatchers(value);
  return encodeFunctionResult({
    abi: [abiItem],
    functionName: abiItem.name,
    // viem types `result` as a tuple for a non-literal AbiFunction, but it
    // takes a bare value for single-output functions at runtime.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- viem's type is narrower than its runtime
    result: normalizeResult(abiItem.outputs, value) as readonly unknown[] | undefined,
  });
}

/**
 * The revert `spec` gives, its custom errors from `abi`. A spec the types
 * rule out (an untyped caller's `null`, `{}`, data that isn't hex, args or
 * a panic code that don't encode) is the mock's setup error; viem's own
 * refusals, an error not on the ABI or a panic code out of range, pass
 * through.
 */
export function createRevertError(abi: Abi, spec?: RevertSpec): MockRevertError {
  const given: unknown = spec;
  if (given === undefined) return new MockRevertError("0x");
  if (typeof given === "string")
    return new MockRevertError(
      encodeErrorResult({ abi: builtinErrors, errorName: "Error", args: [given] }),
      given,
    );
  if (!isPlainObject(given)) throw notARevert(given);
  if ("data" in given) {
    const { data } = given;
    if (typeof data !== "string" || !isHex(data))
      throw new MockSetupError(`A revert's data must be hex; got ${formatValue(data)}.`);
    return new MockRevertError(data);
  }
  const { panic } = given;
  if ("panic" in given && typeof panic !== "number" && typeof panic !== "bigint")
    throw new MockSetupError(
      `A revert's panic must be a number or bigint; got ${formatValue(panic)}.`,
    );
  const encode = () => {
    if (typeof panic === "number" || typeof panic === "bigint")
      return encodeErrorResult({ abi: builtinErrors, errorName: "Panic", args: [BigInt(panic)] });
    const { errorName, args } = given;
    if (typeof errorName !== "string") throw notARevert(given);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- viem checks the args against the error
    return encodeErrorResult({ abi, errorName, args: args as readonly unknown[] });
  };
  // BigInt() and viem's encoder throw native errors for values they can't take (1.5, bad args).
  return new MockRevertError(refuseUnencodable("A revert", encode));
}

const notARevert = (spec: unknown) =>
  new MockSetupError(
    `A revert spec has no reason, errorName, panic or data; got ${formatValue(spec)}.`,
    {
      metaMessages: ["A revert is a reason, { errorName, args }, { panic } or { data }."],
    },
  );
