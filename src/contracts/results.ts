import type { Abi, AbiParameter, AbiParameterToPrimitiveType } from "viem";
import { type AllNamed, type PartialStructs, fillZeros } from "../shared/abiValues.js";
import { isPlainObject } from "../shared/values.js";
import { zeroResult } from "../mocking/zeroResult.js";

/**
 * A multi-output function's outputs as an object keyed by output name, for
 * functions with two or more outputs that are all named.
 */
type NamedOutputs<abiFunction> = abiFunction extends {
  outputs: infer outputs extends readonly [AbiParameter, AbiParameter, ...AbiParameter[]];
}
  ? AllNamed<outputs> extends true
    ? {
        [output in outputs[number] as output["name"] & string]?: PartialStructs<
          AbiParameterToPrimitiveType<output, "outputs">
        >;
      }
    : never
  : never;

/** What `.returns()` accepts for a function: viem's return type, or named outputs. */
export type MockReturnType<abi extends Abi, functionName extends string, returnType> =
  | PartialStructs<returnType>
  | NamedOutputs<Extract<abi[number], { type: "function"; name: functionName }>>
  | typeof zeroResult;

/**
 * Turns what a resolver returned into the value viem's encoder expects: named
 * outputs become a tuple in ABI order, and omitted struct fields get zero values.
 */
export function normalizeResult(outputs: readonly AbiParameter[], value: unknown): unknown {
  if (value === zeroResult) return normalizeResult(outputs, outputs.length > 1 ? [] : undefined);
  if (outputs.length === 0) return value;
  if (outputs.length === 1) return fillZeros(outputs[0]!, value);
  if (Array.isArray(value)) return outputs.map((output, i) => fillZeros(output, value[i]));
  if (isPlainObject(value) && outputs.every((output) => output.name))
    return outputs.map((output) => fillZeros(output, value[output.name!]));
  return value;
}
