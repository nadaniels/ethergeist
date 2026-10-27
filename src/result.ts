import { type Abi, type AbiParameter, type AbiParameterToPrimitiveType, zeroAddress } from "viem";

/**
 * Struct objects at any depth may omit fields; omitted fields are filled with
 * Solidity zero values, as unset storage would read. Tuples (positional
 * multi-output returns, unnamed components) stay complete.
 */
export type PartialStructs<value> = value extends readonly unknown[]
  ? { [index in keyof value]: PartialStructs<value[index]> }
  : value extends object
    ? { [key in keyof value]?: PartialStructs<value[key]> }
    : value;

type AllNamed<parameters extends readonly AbiParameter[]> = false extends (
  parameters[number] extends { name: infer name extends string }
    ? name extends ""
      ? false
      : true
    : false
)
  ? false
  : true;

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
  | NamedOutputs<Extract<abi[number], { type: "function"; name: functionName }>>;

/**
 * Turns what a resolver returned into the value viem's encoder expects: named
 * outputs become a tuple in ABI order, and omitted struct fields get zero values.
 */
export function normalizeResult(outputs: readonly AbiParameter[], value: unknown): unknown {
  if (outputs.length === 0) return value;
  if (outputs.length === 1) return fill(outputs[0]!, value);
  if (Array.isArray(value)) return outputs.map((output, i) => fill(output, value[i]));
  if (isPlainObject(value) && outputs.every((output) => output.name))
    return outputs.map((output) => fill(output, value[output.name!]));
  return value;
}

function fill(parameter: AbiParameter, value: unknown): unknown {
  if (value === undefined) return zeroValue(parameter);

  const element = arrayElement(parameter);
  if (element) return Array.isArray(value) ? value.map((v) => fill(element, v)) : value;

  if (parameter.type === "tuple" && "components" in parameter) {
    const { components } = parameter;
    if (Array.isArray(value)) return components.map((c, i) => fill(c, value[i]));
    if (isPlainObject(value))
      return Object.fromEntries(components.map((c) => [c.name, fill(c, value[c.name!])]));
  }
  return value;
}

function zeroValue(parameter: AbiParameter): unknown {
  const element = arrayElement(parameter);
  if (element) {
    const size = /\[(\d+)\]$/.exec(parameter.type)?.[1];
    return size ? Array.from({ length: Number(size) }, () => zeroValue(element)) : [];
  }

  if (parameter.type === "tuple" && "components" in parameter) {
    const { components } = parameter;
    return components.every((c) => c.name)
      ? Object.fromEntries(components.map((c) => [c.name, zeroValue(c)]))
      : components.map(zeroValue);
  }

  if (parameter.type === "address") return zeroAddress;
  if (parameter.type === "bool") return false;
  if (parameter.type === "string") return "";
  if (parameter.type === "bytes") return "0x";
  const bytesSize = /^bytes(\d+)$/.exec(parameter.type)?.[1];
  if (bytesSize) return `0x${"00".repeat(Number(bytesSize))}`;
  // int<N> / uint<N>: the encoder takes bigint for every size.
  return 0n;
}

/** The element parameter of an array type (`T[]`, `T[n]`), or undefined. */
function arrayElement(parameter: AbiParameter): AbiParameter | undefined {
  const match = /^(.*)\[\d*\]$/.exec(parameter.type);
  return match ? { ...parameter, type: match[1]! } : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
