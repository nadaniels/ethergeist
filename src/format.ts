import { type Address, isHex } from "viem";
import { type Matcher, isMatcher } from "./matchers.js";
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
export function formatCall(name: string, args: unknown, options: FormatOptions = {}): string {
  if (args === undefined) return `${name}(*)`;
  const list = Array.isArray(args)
    ? args.map((arg: unknown) => formatValue(arg, options))
    : [formatValue(args, options)];
  return `${name}(${list.join(", ")})`;
}

/**
 * A mock's limit for messages, after its call: ` once`, ` 3 times, 1 left`,
 * or `, used up`. Empty for an unlimited mock.
 */
export function formatLimit(limit: number | undefined, remaining: number | undefined): string {
  if (limit === undefined || remaining === undefined) return "";
  const count = limit === 1 ? "once" : `${limit} times`;
  if (remaining === 0) return ` ${count}, used up`;
  return remaining === limit ? ` ${count}` : ` ${count}, ${remaining} left`;
}

/** A call an unused mock's function received, and where it first differs from the mock. */
export type ReceivedCall = { call: string; differs: string | undefined };

/**
 * Under an unused mock, for messages: the calls its function did receive (up
 * to 3) and where each first differs, or that it received none.
 */
export function formatReceived(name: string, received: readonly ReceivedCall[]): string {
  if (received.length === 0) return `\n    received no calls to ${name}`;
  const lines = received.slice(0, 3).map(({ call, differs }) => {
    const why =
      differs === undefined ? "matches; another mock answered it" : `${differs} didn't match`;
    return `\n      ${call}  ← ${why}`;
  });
  if (received.length > 3) lines.push(`\n      …and ${received.length - 3} more`);
  const count = received.length === 1 ? "1 call" : `${received.length} calls`;
  return `\n    received ${count} to ${name}:${lines.join("")}`;
}

type FormatOptions = {
  /** Shorten long hex (addresses, hashes, data) to `0x1234…abcd`, for overviews. Errors keep it whole. */
  short?: boolean;
};

/** A value for messages: bigints as `5n`, arrays and structs spelled out. */
export function formatValue(value: unknown, options: FormatOptions = {}): string {
  if (isMatcher(value)) return formatMatcher(value, options);
  if (typeof value === "bigint") return `${value}n`;
  if (Array.isArray(value))
    return `[${value.map((v: unknown) => formatValue(v, options)).join(", ")}]`;
  if (isPlainObject(value))
    return `{ ${Object.entries(value)
      .map(([key, v]) => `${key}: ${formatValue(v, options)}`)
      .join(", ")} }`;
  if (typeof value === "string")
    return options.short === true && isHex(value) && value.length > 14
      ? `${value.slice(0, 6)}…${value.slice(-4)}`
      : value;
  return JSON.stringify(value);
}

/**
 * A matcher for messages: `any`, `where(isLarge)` (or the predicate's
 * source, without a name), or a partial's fields followed by `…`.
 */
function formatMatcher(matcher: Matcher, options: FormatOptions): string {
  if (matcher.type === "any") return "any";
  if (matcher.type === "where") return `where(${matcher.label})`;
  const fields = Object.entries(matcher.fields).map(
    ([key, v]) => `${key}: ${formatValue(v, options)}`,
  );
  return `{ ${[...fields, "…"].join(", ")} }`;
}
