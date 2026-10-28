import type { Address } from "viem";
import { isPlainObject } from "./result.js";

/** A contract for messages: its name and address, or just the address. */
export function formatContract(address: Address, name: string | undefined): string {
  return name === undefined ? address : `${name} (${address})`;
}

/**
 * A call for messages, e.g. `balanceOf(0x…)` or `getBalance({ address: 0x… })`.
 * Positional args are listed; anything else is formatted as one value. With
 * nothing pinned (`undefined`), it's `name(*)`: any args.
 */
export function formatCall(name: string, args: unknown): string {
  if (args === undefined) return `${name}(*)`;
  const list = Array.isArray(args)
    ? args.map((arg: unknown) => formatValue(arg))
    : [formatValue(args)];
  return `${name}(${list.join(", ")})`;
}

/** A value for messages: bigints as `5n`, arrays and structs spelled out. */
export function formatValue(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  if (Array.isArray(value)) return `[${value.map((v: unknown) => formatValue(v)).join(", ")}]`;
  if (isPlainObject(value))
    return `{ ${Object.entries(value)
      .map(([key, v]) => `${key}: ${formatValue(v)}`)
      .join(", ")} }`;
  return typeof value === "string" ? value : JSON.stringify(value);
}
