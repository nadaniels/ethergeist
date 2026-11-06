import { isHex } from "viem";

import { isPlainObject } from "../shared/values.js";
import { type Matcher, isMatcher } from "./matchers.js";
import type { PinnedKey } from "./types.js";

/**
 * A call for messages, e.g. `balanceOf(0x…)` or
 * `getBalance({ address: 0x… })`. Positional args are listed; anything else
 * is formatted as one value. With nothing pinned (`undefined`), it's
 * `name(*)`: any args. A call without params, e.g. `getGasPrice`, is
 * `name()`.
 */
export function formatCall(name: string, args: unknown, options: FormatOptions = {}): string {
  if (args === undefined) return `${name}(*)`;
  if (isPlainObject(args) && Object.keys(args).length === 0) return `${name}()`;
  const list = Array.isArray(args)
    ? args.map((arg: unknown) => formatValue(arg, options))
    : [formatValue(args, options)];
  return `${name}(${list.join(", ")})`;
}

/**
 * A mock as messages name it: its call, what else it pins, its limit, and
 * whether it's still without an answer, e.g. `balanceOf(*) once`,
 * `transfer(*) { from: 0x… }` or `getBalance() without an answer`.
 */
export const describeMock = (
  name: string,
  mock: {
    pinned: unknown;
    /** A contract's mock's `from` and `value`, if it pins them. */
    pins?: object | undefined;
    limit: number | undefined;
    remaining: number | undefined;
    resolver: unknown;
  },
) =>
  `${formatCall(name, mock.pinned)}${mock.pins ? ` ${formatValue(mock.pins)}` : ""}${formatLimit(mock.limit, mock.remaining)}${
    mock.resolver === undefined ? " without an answer" : ""
  }`;

/**
 * A mock's limit for messages, after its call: ` once`, ` 3 times, 1 left`,
 * or `, used up`. Empty for an unlimited mock.
 */
function formatLimit(limit: number | undefined, remaining: number | undefined): string {
  if (limit === undefined || remaining === undefined) return "";
  const count = limit === 1 ? "once" : `${limit} times`;
  if (remaining === 0) return ` ${count}, used up`;
  return remaining === limit ? ` ${count}` : ` ${count}, ${remaining} left`;
}

/**
 * A received call for a near-miss message: the args (or fields) at
 * `mismatched` in full, the rest as `…`. With nothing mismatched, the whole
 * call.
 */
export function formatMismatch(
  name: string,
  actual: unknown,
  mismatched: readonly PinnedKey[],
): string {
  // Nothing in particular, or all of it (`null`): the whole call.
  if (mismatched.length === 0 || mismatched.includes(null)) return formatCall(name, actual);
  if (Array.isArray(actual))
    return `${name}(${actual.map((v: unknown, i) => (mismatched.includes(i) ? formatValue(v) : "…")).join(", ")})`;
  if (isPlainObject(actual)) {
    const fields = mismatched.flatMap((key) =>
      key === null ? [] : [`${key}: ${formatValue(actual[key])}`],
    );
    return `${name}({ ${[...fields, "…"].join(", ")} })`;
  }
  return formatCall(name, actual);
}

/**
 * A call an unused mock's function received, and where it first differs from
 * the mock.
 */
export type ReceivedCall = { call: string; differs: string | undefined };

/**
 * What follows a registered mock in a "No mock for" message: which of its
 * args or params didn't match the call, if one didn't. It can follow "used
 * up" or "without an answer": that mock wouldn't have matched either.
 */
export const formatMissReason = (differs: string | undefined) =>
  differs === undefined ? "" : `  ← ${differs} didn't match`;

/**
 * The line under an unused mock without an answer, in place of the calls it
 * received: how to give it one. Matching calls aren't listed, since it had
 * nothing to answer them with. `answers` names its engine's, e.g.
 * `.returns() or .fails()`.
 */
export const formatNoAnswer = (answers: string) =>
  `\n    give it one with ${answers}, or don't register it`;

/**
 * The lines under an unused mock, for messages: the calls its function did
 * receive (up to 3) and where each first differs, or that it received none.
 */
export function formatReceived(
  name: string,
  received: readonly ReceivedCall[],
  /** Every call received, including those dropped past `historyLimit`. */
  total = received.length,
): string {
  if (total === 0) return `\n    received no calls to ${name}`;
  const lines = received.slice(0, 3).map(({ call, differs }) => {
    const why =
      differs === undefined ? "matches; another mock answered it" : `${differs} didn't match`;
    return `\n      ${call}  ← ${why}`;
  });
  if (received.length > 3) lines.push(`\n      … ${received.length - 3} more`);
  const count = total === 1 ? "1 call" : `${total} calls`;
  const kept =
    received.length === total ? "" : ` (the last ${received.length} kept, past historyLimit)`;
  return `\n    received ${count} to ${name}${kept}:${lines.join("")}`;
}

type FormatOptions = {
  /**
   * Whether long hex (addresses, hashes, data) is shortened to `0x1234…abcd`,
   * for overviews. Errors keep it whole.
   */
  short?: boolean;
};

/**
 * A value for messages: bigints as `5n`, arrays and structs spelled out, and
 * matchers as `formatMatcher` shows them.
 */
export function formatValue(value: unknown, options: FormatOptions = {}): string {
  if (isMatcher(value)) return formatMatcher(value, options);
  if (typeof value === "bigint") return `${value}n`;
  // JSON.stringify writes NaN and the infinities as null.
  if (typeof value === "number") return String(value);
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
 * A matcher for messages: `any`, `where(isLarge)` by its label (the one
 * given, or the predicate's name or source), or a partial's fields followed
 * by `…`.
 */
function formatMatcher(matcher: Matcher, options: FormatOptions): string {
  if (matcher.type === "any") return "any";
  if (matcher.type === "where") return `where(${matcher.label})`;
  const fields = Object.entries(matcher.fields).map(
    ([key, v]) => `${key}: ${formatValue(v, options)}`,
  );
  return `{ ${[...fields, "…"].join(", ")} }`;
}
