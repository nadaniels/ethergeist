import { AbiParameters } from "ox";
import { type AbiFunction, type AbiParameter, getAddress, isAddress, isHex } from "viem";

import { type Path, formatPath, formatValue } from "../mocking/format.js";
import { isMatcher, partialMatcher } from "../mocking/matchers.js";
import { arrayElement, arraySize, decodesAsObject, isNamed } from "../shared/abiValues.js";
import { MockSetupError } from "../shared/errors.js";
import { isNonArrayObject } from "../shared/values.js";

/**
 * `parameter`'s type for messages, after "must be", e.g. "an address",
 * "bytes" and "bytes[]", or "a tuple (address tokenIn, uint256 amountIn)"
 * and "a list of tuples (…)" for structs.
 */
function describeType(parameter: AbiParameter): string {
  if (parameter.type.startsWith("tuple")) return `a ${describeStruct(parameter, "one")}`;
  if (/^bytes(\[\d*\])*$/u.test(parameter.type)) return parameter.type;
  return /^[ai]/u.test(parameter.type) ? `an ${parameter.type}` : `a ${parameter.type}`;
}

/**
 * A struct's type, or the type of a list of structs, for messages, without an
 * article: "tuple (…)", "list of 2 tuples (…)", "list of lists of tuples
 * (…)". Its fields are written as a signature writes them, each named where
 * it has a name.
 */
function describeStruct(parameter: AbiParameter, count: "one" | "several"): string {
  const noun = (word: string) => (count === "one" ? word : `${word}s`);
  const element = arrayElement(parameter);
  if (!element) return `${noun("tuple")} ${AbiParameters.format([{ ...parameter, name: "" }])}`;
  const size = arraySize(parameter);
  const sized = size === undefined ? "" : `${size} `;
  return `${noun("list")} of ${sized}${describeStruct(element, "several")}`;
}

/**
 * Which fields a struct written as an object gives, for `findMisfit`:
 * `"some"` as a mock pins it, `"whole"` for a complete value, as the app's
 * call gives it.
 */
export type StructFields = "some" | "whole";

/**
 * Where a value doesn't fit its type, for messages: the path to the part
 * that doesn't (empty for the value itself) and that part's type, with its
 * value, or with a key that isn't a field of the struct there.
 */
type Misfit =
  | { path: Path; parameter: AbiParameter; value: unknown }
  | { path: Path; parameter: AbiParameter; field: string };

/**
 * A hint for `misfit`, if it has one: the struct's own fields for a key that
 * isn't one, and the list form for an object given for a struct viem
 * decodes as a list.
 */
function misfitHint(misfit: Misfit): string | undefined {
  const { parameter } = misfit;
  if (parameter.type !== "tuple" || !("components" in parameter)) return undefined;
  const fields = parameter.components.map((component) => AbiParameters.format([component]));
  if ("field" in misfit) return `Its fields are ${andList(fields)}.`;
  if (!isNonArrayObject(misfit.value) || decodesAsObject(parameter.components)) return undefined;
  return (
    `Write it as a list, [${fields.join(", ")}]: viem decodes a struct as an object only ` +
    "when every field has a name."
  );
}

/** `items` as a sentence lists them: "a", "a and b", "a, b and c". */
function andList(items: readonly string[]): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)!}`;
}

/**
 * Where `value` doesn't fit `parameter`'s type, or `undefined` when it fits.
 * A list fits a list type when each element fits, and a fixed-size one has
 * its size. A struct written as an object fits where viem decodes it as one
 * (`decodesAsObject`), when every field it gives fits its component, at
 * every depth: a field it leaves out pins nothing. With `"whole"`, it must
 * give every field. A struct written as a list fits when it has an element
 * for each component, each fitting. Anything else fits as `fitsValueType`
 * says.
 *
 * A matcher is checked where it sits. A `match.any()` or `match.where()`
 * fits there, as a whole value. A `match.partial()` fits a struct as an
 * object of its fields would, but is never whole.
 */
export function findMisfit(
  parameter: AbiParameter,
  value: unknown,
  fields: StructFields,
  path: Path = [],
): Misfit | undefined {
  const here = { path, parameter, value };
  if (isMatcher(value)) {
    if (value.type !== "partial") return undefined;
    if (parameter.type !== "tuple" || fields === "whole") return here;
    return findMisfit(parameter, value.fields, fields, path);
  }
  const element = arrayElement(parameter);
  if (element) {
    const size = arraySize(parameter);
    if (!Array.isArray(value) || (size !== undefined && value.length !== size)) return here;
    return firstMisfit(value.map((item, i) => findMisfit(element, item, fields, [...path, i])));
  }

  if (parameter.type === "tuple" && "components" in parameter) {
    const { components } = parameter;
    if (Array.isArray(value)) {
      if (value.length !== components.length) return here;
      return firstMisfit(
        value.map((item, i) => findMisfit(components[i]!, item, fields, [...path, i])),
      );
    }
    if (isNonArrayObject(value)) {
      if (!decodesAsObject(components)) return here;
      const entries = Object.entries(value);
      if (fields === "whole" && entries.length !== components.length) return here;
      return firstMisfit(
        entries.map(([key, item]) => {
          const component = components.find((candidate) => candidate.name === key);
          return component === undefined
            ? { path, parameter, field: key }
            : findMisfit(component, item, fields, [...path, key]);
        }),
      );
    }
  }

  return fitsValueType(parameter, value) ? undefined : here;
}

/** The first of the parts' misfits, or `undefined` when every part fits. */
function firstMisfit(misfits: readonly (Misfit | undefined)[]): Misfit | undefined {
  return misfits.find((misfit) => misfit !== undefined);
}

/**
 * Whether `value` fits a type that isn't a list or a struct, as a decoded
 * call's value could equal it: an int a `bigint` or an integer `number` in
 * its range (a bare `uint` or `int` is 256 bits), a `bool` a boolean, a
 * `string` a string, `bytes` hex of whole bytes, and `bytesN` hex of N
 * bytes, in any case. An address fits in any case, checksummed or not, as
 * `pinArgs` checksums it. No value fits any other type, such as `function`.
 *
 * It's stricter than viem's rules for telling overloads apart, which take
 * any string or a `Uint8Array` for `bytes`: a decoded call holds hex.
 */
function fitsValueType(parameter: AbiParameter, value: unknown): boolean {
  const { type } = parameter;
  if (type === "address") return typeof value === "string" && isAddress(value, { strict: false });
  if (type === "bool") return typeof value === "boolean";
  if (type === "string") return typeof value === "string";
  if (type === "bytes") return isHex(value) && value.length % 2 === 0;

  const bytesSize = /^bytes(\d+)$/u.exec(type)?.[1];
  if (bytesSize !== undefined) return isHex(value) && value.length === 2 + 2 * Number(bytesSize);

  const integer = /^(u?)int(\d*)$/u.exec(type);
  if (integer) {
    if (typeof value !== "bigint" && !(typeof value === "number" && Number.isInteger(value)))
      return false;
    const bits = integer[2] === "" ? 256n : BigInt(integer[2]!);
    const signed = integer[1] === "";
    const max = 2n ** (signed ? bits - 1n : bits) - 1n;
    const min = signed ? -max - 1n : 0n;
    return BigInt(value) >= min && BigInt(value) <= max;
  }
  return false;
}

/**
 * Throws unless each of a mock's `pinned` args fits its input in `abiItem`,
 * as `findMisfit` says, naming the first part that doesn't: a decoded
 * call's args always fit, so its mock could never match.
 */
export function checkArgTypes(
  subject: string,
  abiItem: AbiFunction,
  pinned: readonly unknown[],
): void {
  for (const [index, arg] of pinned.entries()) {
    const misfit = findMisfit(abiItem.inputs[index]!, arg, "some");
    if (misfit === undefined) continue;
    const where = `${subject}'s ${inputName(abiItem, index)}${formatPath(misfit.path)}`;
    const hint = misfitHint(misfit);
    const options = hint === undefined ? undefined : { metaMessages: [hint] };
    if ("field" in misfit)
      throw new MockSetupError(`${misfit.field} isn't a field of ${where}.`, options);
    throw new MockSetupError(
      `${where} must be ${describeType(misfit.parameter)}; got ${formatValue(misfit.value)}.`,
      options,
    );
  }
}

/**
 * Input `index` of `abiItem` by its ABI name, or numbered from 1 when it's
 * unnamed (`""`) or the function isn't known yet: an overload not chosen.
 */
export function inputName(abiItem: AbiFunction | undefined, index: number): string {
  const input = abiItem?.inputs[index];
  return input !== undefined && isNamed(input) ? input.name : `arg ${index + 1}`;
}

/**
 * `value` as a mock pins it for `parameter`: address-typed parts
 * checksummed, which also validates them. A struct written as a list is
 * made an object by its fields' names where viem decodes it as one
 * (`decodesAsObject`). Partial structs keep only the fields they have;
 * anything that isn't a string where an address goes is left for the types
 * (or matching) to judge. A `match.partial()` gets its fields pinned; other
 * matchers are left as they are.
 */
function pinValue(parameter: AbiParameter, value: unknown): unknown {
  if (isMatcher(value))
    return value.type === "partial"
      ? partialMatcher(pinValue(parameter, { ...value.fields }))
      : value;
  if (parameter.type === "address") return typeof value === "string" ? getAddress(value) : value;

  const element = arrayElement(parameter);
  if (element) return Array.isArray(value) ? value.map((item) => pinValue(element, item)) : value;

  if (parameter.type === "tuple" && "components" in parameter) {
    const { components } = parameter;
    if (Array.isArray(value)) {
      const listed = value.map((item: unknown, i) =>
        components[i] ? pinValue(components[i], item) : item,
      );
      // A list of another length is left for the types to refuse.
      return decodesAsObject(components) && listed.length === components.length
        ? Object.fromEntries(components.map((component, i) => [component.name, listed[i]]))
        : listed;
    }
    if (isNonArrayObject(value))
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => {
          const component = components.find((candidate) => candidate.name === key);
          return [key, component ? pinValue(component, item) : item];
        }),
      );
  }
  return value;
}

/**
 * `args` as a mock of `abiItem` pins them, as `pinValue` pins each: so
 * messages show addresses one way, a malformed one fails at registration,
 * and a struct is matched in the form viem decodes. They hold no
 * `undefined`: `pinFunctionArgs` takes those out first.
 */
export function pinArgs(abiItem: AbiFunction, args: readonly unknown[]): readonly unknown[] {
  return args.map((arg, i) => pinValue(abiItem.inputs[i]!, arg));
}
