import { type AbiParameter, zeroAddress } from "viem";
import { isPlainObject } from "./values.js";

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

export type AllNamed<parameters extends readonly AbiParameter[]> = false extends (
  parameters[number] extends { name: infer name extends string }
    ? name extends ""
      ? false
      : true
    : false
)
  ? false
  : true;

export function fillZeros(parameter: AbiParameter, value: unknown): unknown {
  if (value === undefined) return zeroValue(parameter);

  const element = arrayElement(parameter);
  if (element) return Array.isArray(value) ? value.map((v) => fillZeros(element, v)) : value;

  if (parameter.type === "tuple" && "components" in parameter) {
    const { components } = parameter;
    if (Array.isArray(value)) return components.map((c, i) => fillZeros(c, value[i]));
    if (isPlainObject(value))
      return Object.fromEntries(components.map((c) => [c.name, fillZeros(c, value[c.name!])]));
  }
  return value;
}

function zeroValue(parameter: AbiParameter): unknown {
  const element = arrayElement(parameter);
  if (element) {
    const size = /\[(\d+)\]$/u.exec(parameter.type)?.[1];
    return size ? Array.from({ length: Number(size) }, () => zeroValue(element)) : [];
  }

  if (parameter.type === "tuple" && "components" in parameter) {
    const { components } = parameter;
    return components.every((c) => c.name)
      ? Object.fromEntries(components.map((c) => [c.name, zeroValue(c)]))
      : components.map((c) => zeroValue(c));
  }

  if (parameter.type === "address") return zeroAddress;
  if (parameter.type === "bool") return false;
  if (parameter.type === "string") return "";
  if (parameter.type === "bytes") return "0x";
  const bytesSize = /^bytes(\d+)$/u.exec(parameter.type)?.[1];
  if (bytesSize) return `0x${"00".repeat(Number(bytesSize))}`;
  // int<N> / uint<N>: the encoder takes bigint for every size.
  return 0n;
}

/** The element parameter of an array type (`T[]`, `T[n]`), or undefined. */
export function arrayElement(parameter: AbiParameter): AbiParameter | undefined {
  const match = /^(.*)\[\d*\]$/u.exec(parameter.type);
  return match ? { ...parameter, type: match[1]! } : undefined;
}
