import { type AbiEvent, type AbiFunction, type AbiParameter, parseAbi, zeroAddress } from "viem";

import { isPlainObject } from "./values.js";

/**
 * `value` with its structs' fields optional, at any depth: a field left out
 * is filled with its Solidity zero value, as unset storage reads. Tuples
 * (positional multi-output returns, unnamed components) stay complete.
 */
export type PartialStructs<value> = value extends readonly unknown[]
  ? { [index in keyof value]: PartialStructs<value[index]> }
  : value extends object
    ? { [key in keyof value]?: PartialStructs<value[key]> }
    : value;

/** Whether every one of `parameters` has a name: `true` or `false`. */
export type AllNamed<parameters extends readonly AbiParameter[]> = false extends (
  parameters[number] extends { name: infer name extends string }
    ? name extends ""
      ? false
      : true
    : false
)
  ? false
  : true;

/**
 * `value` with every struct field it leaves out, at any depth, filled with
 * its Solidity zero value, as `parameter`'s type says. `undefined` is the
 * type's zero.
 */
export function fillZeros(parameter: AbiParameter, value: unknown): unknown {
  if (value === undefined) return zeroValue(parameter);

  const element = arrayElement(parameter);
  if (element) return Array.isArray(value) ? value.map((item) => fillZeros(element, item)) : value;

  if (parameter.type === "tuple" && "components" in parameter) {
    const { components } = parameter;
    if (Array.isArray(value))
      return components.map((component, i) => fillZeros(component, value[i]));
    if (isPlainObject(value))
      return Object.fromEntries(
        components.map((component) => [
          component.name,
          fillZeros(component, value[component.name!]),
        ]),
      );
  }
  return value;
}

/**
 * The Solidity zero value of `parameter`'s type: a fixed-size array of
 * zeros, `[]` for a dynamic one, and a struct as viem decodes it, by name
 * or by position (`decodesAsObject`).
 */
function zeroValue(parameter: AbiParameter): unknown {
  const element = arrayElement(parameter);
  if (element) {
    const size = arraySize(parameter);
    return size === undefined ? [] : Array.from({ length: size }, () => zeroValue(element));
  }

  if (parameter.type === "tuple" && "components" in parameter) {
    const { components } = parameter;
    return decodesAsObject(components)
      ? Object.fromEntries(components.map((component) => [component.name, zeroValue(component)]))
      : components.map((component) => zeroValue(component));
  }

  if (parameter.type === "address") return zeroAddress;
  if (parameter.type === "bool") return false;
  if (parameter.type === "string") return "";
  if (parameter.type === "bytes") return "0x";
  const bytesSize = /^bytes(\d+)$/u.exec(parameter.type)?.[1];
  if (bytesSize) return `0x${"00".repeat(Number(bytesSize))}`;
  // The rest are int<N> and uint<N>: the encoder takes a bigint at every size.
  return 0n;
}

/**
 * Whether `parameter` has a name: an ABI leaves it out or writes `""` for
 * one without.
 */
export function isNamed<parameter extends AbiParameter>(
  parameter: parameter,
): parameter is parameter & { name: string } {
  return parameter.name !== undefined && parameter.name !== "";
}

/**
 * Whether viem decodes a struct of `components` as an object, by its fields'
 * names: when it has fields, and every one has a name. Otherwise it's a list.
 */
export function decodesAsObject(components: readonly AbiParameter[]): boolean {
  return components.length > 0 && components.every((component) => isNamed(component));
}

/** The element parameter of an array type (`T[]`, `T[n]`), or `undefined`. */
export function arrayElement(parameter: AbiParameter): AbiParameter | undefined {
  const match = /^(.*)\[\d*\]$/u.exec(parameter.type);
  return match ? { ...parameter, type: match[1]! } : undefined;
}

/** The size of a fixed-size array type (`T[n]`), or `undefined`. */
export function arraySize(parameter: AbiParameter): number | undefined {
  const size = /\[(\d+)\]$/u.exec(parameter.type)?.[1];
  return size === undefined ? undefined : Number(size);
}

/** Solidity's built-in errors, which any contract can revert with. */
export const builtinErrors = parseAbi(["error Error(string)", "error Panic(uint256)"]);

/**
 * `items` without repeats: a function or event that's the same to the mock
 * as an earlier one, as when two standards' ABIs are spread together
 * (`[...erc4626Abi, ...erc20Abi]`). The same means the same name, types and
 * param names, and a function's mutability or an event's `indexed` and
 * `anonymous`. A function's input names don't count, since its args are
 * positional (`erc20Abi` names `transfer`'s `recipient` where others say
 * `to`). The first is kept; anything else stays an overload.
 */
export function withoutRepeats<item extends AbiFunction | AbiEvent>(
  items: readonly item[],
): item[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = JSON.stringify(
      item.type === "function"
        ? [
            item.name,
            item.inputs.map((input) => ({ ...shapeOf(input), name: "" })),
            item.outputs.map(shapeOf),
            item.stateMutability,
          ]
        : [item.name, item.inputs.map(shapeOf), item.anonymous === true],
    );
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * What the mock reads of a param: its type, name, whether it's indexed, and
 * its fields'.
 */
function shapeOf(parameter: AbiParameter | AbiEvent["inputs"][number]): object {
  return {
    type: parameter.type,
    name: parameter.name ?? "",
    indexed: "indexed" in parameter && parameter.indexed === true,
    ...("components" in parameter &&
      parameter.components !== undefined && { components: parameter.components.map(shapeOf) }),
  };
}
