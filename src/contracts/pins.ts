import { type AbiParameter, getAddress } from "viem";
import { isMatcher, partialMatcher } from "../mocking/matchers.js";
import { arrayElement } from "../shared/abiValues.js";
import { isPlainObject } from "../shared/values.js";

/**
 * `value` with every address-typed part checksummed, which also validates it.
 * Partial structs keep only the fields they have; anything that isn't a
 * string where an address goes is left for the types (or matching) to judge.
 * A `match.partial()` gets its fields checksummed; other matchers are left as
 * they are.
 */
export function checksumAddresses(parameter: AbiParameter, value: unknown): unknown {
  if (isMatcher(value))
    return value.type === "partial"
      ? partialMatcher(checksumAddresses(parameter, { ...value.fields }))
      : value;
  if (parameter.type === "address") return typeof value === "string" ? getAddress(value) : value;

  const element = arrayElement(parameter);
  if (element)
    return Array.isArray(value) ? value.map((v) => checksumAddresses(element, v)) : value;

  if (parameter.type === "tuple" && "components" in parameter) {
    const { components } = parameter;
    if (Array.isArray(value))
      return value.map((v: unknown, i) =>
        components[i] ? checksumAddresses(components[i], v) : v,
      );
    if (isPlainObject(value))
      return Object.fromEntries(
        Object.entries(value).map(([key, v]) => {
          const component = components.find((c) => c.name === key);
          return [key, component ? checksumAddresses(component, v) : v];
        }),
      );
  }
  return value;
}
