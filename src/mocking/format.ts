import { isHex } from "viem";

import { nestedRestoreHint, removedMocksHeader } from "../shared/errors.js";
import { isNonArrayObject } from "../shared/values.js";
import { type Matcher, isMatcher } from "./matchers.js";
import type { Answer, PinnedKey } from "./types.js";

/**
 * A call for messages, e.g. `balanceOf(0x…)` or
 * `getBalance({ address: 0x… })`. Positional args are listed; anything else
 * is formatted as one value. With nothing pinned (`undefined`), it's
 * `name(*)`: any args. A call without params, e.g. `getGasPrice`, is
 * `name()`.
 */
export function formatCall(name: string, args: unknown, options: FormatOptions = {}): string {
  if (args === undefined) return `${name}(*)`;
  if (isNonArrayObject(args) && Object.keys(args).length === 0) return `${name}()`;
  const list = Array.isArray(args)
    ? args.map((arg: unknown) => formatValue(arg, options))
    : [formatValue(args, options)];
  return `${name}(${list.join(", ")})`;
}

/** What messages read of a mock to describe it: see `describeMock`. */
type DescribedMock = {
  pinned: unknown;
  /** A contract's mock's `from` and `value`, if it pins them. */
  pins?: object | undefined;
  limit: number | undefined;
  remaining: number | undefined;
  answer: Answer | undefined;
};

/** What `describeMock` says of a mock's answer, where it says anything. */
const answerVerbs: Partial<Record<Answer["kind"], string>> = {
  revert: " reverts",
  fault: " fails",
  refusal: " refuses",
};

/**
 * A mock as messages name it: its call, what else it pins, whether it
 * reverts, fails, or refuses, its limit, and whether it's still without an
 * answer, e.g. `read.balanceOf(*) once`,
 * `write.transfer(*) { from: 0x… } reverts`, `getBalance(*) fails once`, or
 * `getBalance() without an answer`.
 */
export function describeMock(name: string, mock: DescribedMock): string {
  const pins = mock.pins ? ` ${formatValue(mock.pins)}` : "";
  const verb = mock.answer === undefined ? "" : (answerVerbs[mock.answer.kind] ?? "");
  const unanswered = mock.answer === undefined ? " without an answer" : "";
  return `${formatCall(name, mock.pinned)}${pins}${verb}${formatLimit(mock.limit, mock.remaining)}${unanswered}`;
}

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
  if (mismatched.length === 0 || mismatched.includes(null)) return formatCall(name, actual);
  if (Array.isArray(actual))
    return `${name}(${actual.map((v: unknown, i) => (mismatched.includes(i) ? formatValue(v) : "…")).join(", ")})`;
  if (isNonArrayObject(actual)) {
    const fields = mismatched.flatMap((key) =>
      key === null ? [] : [`${key}: ${formatValue(actual[key])}`],
    );
    return `${name}({ ${[...fields, "…"].join(", ")} })`;
  }
  return formatCall(name, actual);
}

type MissedKey = { name: string; leftOut: boolean };

const missReason = ({ name, leftOut }: MissedKey) =>
  leftOut ? `the call has no ${name}` : `${name} didn't match`;

/**
 * A call an unused mock's function received, and where it first differs from
 * the mock.
 */
export type ReceivedCall = {
  call: string;
  differs: MissedKey | undefined;
  /**
   * Whether the call was a registered contract's to answer, under an
   * action's mock.
   */
  forContract?: boolean;
};

/**
 * What follows a registered mock in a "No mock for" message: where it first
 * differs from the call, a key the call leaves out included, if it does. It
 * can follow "used up" or "without an answer": that mock wouldn't have
 * matched either.
 */
const formatMissReason = (differs: MissedKey | undefined) =>
  differs === undefined ? "" : `  ← ${missReason(differs)}`;

/**
 * A miss's lines for the mocks it tried. `missed` holds where each one first
 * differed from the call; a mock that isn't in it gets no reason.
 */
export function missedLines<mock>(
  mocks: readonly mock[],
  missed: ReadonlyMap<mock, PinnedKey>,
  describe: (mock: mock) => string,
  missedKey: (mock: mock, key: PinnedKey) => MissedKey,
): string[] {
  return mocks.map((mock) => {
    const key = missed.get(mock);
    const reason = formatMissReason(key === undefined ? undefined : missedKey(mock, key));
    return `  ${describe(mock)}${reason}`;
  });
}

/**
 * A miss's block for the mocks the last restore removed that match the call,
 * given as their lines (`removed`), under a header and with the layout that
 * often causes it, unless `layout` is false (the miss gave it already); none
 * if there are none.
 */
export function removedLines(
  removed: readonly string[],
  { layout = true }: { layout?: boolean } = {},
): string[] {
  if (removed.length === 0) return [];
  return [removedMocksHeader, ...removed, ...(layout ? [nestedRestoreHint] : [])];
}

/**
 * The line under an unused mock without an answer, in place of the calls it
 * received: how to give it one. Matching calls aren't listed, since it had
 * nothing to answer them with. `answers` names its engine's, e.g.
 * `.returns() or .fails()`.
 */
export const formatNoAnswer = (answers: string) =>
  `\n    give it one with ${answers}, or don't register it`;

/** Why a call an unused mock's function received wasn't the mock's use. */
function formatReceivedReason({ differs, forContract }: ReceivedCall): string {
  if (differs !== undefined) return missReason(differs);
  if (forContract === true)
    return "matches; it's to a registered contract's function, which action mocks don't answer";
  return "matches; another mock answered it";
}

/**
 * The lines under an unused mock, for messages: the calls its function did
 * receive (up to 3) and why each wasn't its use, or that it received none.
 */
export function formatReceived(
  name: string,
  received: readonly ReceivedCall[],
  /** Every call received, including those dropped past `historyLimit`. */
  total = received.length,
): string {
  if (total === 0) return `\n    received no calls to ${name}`;
  const lines = received
    .slice(0, 3)
    .map((entry) => `\n      ${entry.call}  ← ${formatReceivedReason(entry)}`);
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
 * A value for messages: bigints as `5n`, arrays and structs spelled out,
 * patterns as written, and matchers as `formatMatcher` shows them. A string
 * is quoted, as `"latest"`, unless it's hex, e.g. `0x12`.
 */
export function formatValue(value: unknown, options: FormatOptions = {}): string {
  if (isMatcher(value)) return formatMatcher(value, options);
  if (typeof value === "bigint") return `${value}n`;
  // JSON.stringify writes NaN and the infinities as null.
  if (typeof value === "number") return String(value);
  if (Array.isArray(value))
    return `[${value.map((v: unknown) => formatValue(v, options)).join(", ")}]`;
  if (value instanceof RegExp) return String(value);
  if (isNonArrayObject(value)) {
    const fields = Object.entries(value).map(([key, v]) => `${key}: ${formatValue(v, options)}`);
    return fields.length === 0 ? "{}" : `{ ${fields.join(", ")} }`;
  }
  if (typeof value === "string" && isHex(value))
    return options.short === true && value.length > 14
      ? `${value.slice(0, 6)}…${value.slice(-4)}`
      : value;
  return JSON.stringify(value);
}

/**
 * `items` as a sentence lists them: "a", "a and b", "a, b, and c", or with
 * `"or"`, "a, b, or c".
 */
export function formatList(items: readonly string[], conjunction: "and" | "or"): string {
  if (items.length < 3) return items.join(` ${conjunction} `);
  return `${items.slice(0, -1).join(", ")}, ${conjunction} ${items.at(-1)!}`;
}

/** Where a part sits inside a value: the indexes and keys to it. */
export type Path = readonly (number | string)[];

/**
 * A path inside a value for messages, after the value's own name: `[1]` for
 * an index and `.amountIn` for a key, e.g. `.swaps[0].amountIn`.
 */
export function formatPath(path: Path): string {
  return path.map((each) => (typeof each === "number" ? `[${each}]` : `.${each}`)).join("");
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
