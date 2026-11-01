import {
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type Hex,
  encodeFunctionResult,
  encodeErrorResult,
} from "viem";

import { encodeGas } from "../mocking/gas.js";
import { assertNoMatchers } from "../mocking/matching.js";
import { zeroResult } from "../mocking/zeroResult.js";
import { builtinErrors, fillZeros } from "../shared/abiValues.js";
import { MockRevertError } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import type { Namespace } from "./functions.js";
import type { RevertSpec } from "./types.js";

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
  { namespace, abiItem }: { namespace: Namespace; abiItem: AbiFunction },
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

export function createRevertError(abi: Abi, spec?: RevertSpec): MockRevertError {
  if (spec === undefined) return new MockRevertError("0x");
  if (typeof spec === "string")
    return new MockRevertError(
      encodeErrorResult({ abi: builtinErrors, errorName: "Error", args: [spec] }),
      spec,
    );
  if ("data" in spec) return new MockRevertError(spec.data);
  if ("panic" in spec)
    return new MockRevertError(
      encodeErrorResult({ abi: builtinErrors, errorName: "Panic", args: [BigInt(spec.panic)] }),
    );
  return new MockRevertError(
    encodeErrorResult({ abi, errorName: spec.errorName, args: spec.args }),
  );
}
