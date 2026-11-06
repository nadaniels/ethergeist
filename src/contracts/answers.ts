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
 * A function mock's answer as viem's encoder takes it: named outputs become a
 * tuple in ABI order, omitted struct fields get zero values, and
 * `zeroResult` is every output's zero.
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

/**
 * A contract mock's answer as JSON-RPC: a call's return data, as `eth_call`
 * answers it, or an estimate's gas as a quantity.
 */
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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- viem types result as a tuple, but takes a bare value for a single output
    result: normalizeResult(abiItem.outputs, value) as readonly unknown[] | undefined,
  });
}

/**
 * The revert `spec` gives, its custom errors from `abi`. A spec the types
 * rule out is the mock's setup error: an untyped caller's `null` or `{}`,
 * data that isn't hex, a panic that isn't a number or bigint, or args or a
 * panic code that throw a native error as they encode, e.g. `1.5`. viem's
 * own refusals pass through, e.g. an error not on the ABI or a panic code
 * out of range.
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
  return new MockRevertError(refuseUnencodable("A revert", encode));
}

const notARevert = (spec: unknown) =>
  new MockSetupError(
    `A revert spec has no reason, errorName, panic or data; got ${formatValue(spec)}.`,
    {
      metaMessages: ["A revert is a reason, { errorName, args }, { panic } or { data }."],
    },
  );
