import { isHex } from "viem";

import { MockResolverError, MockSetupError } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import { formatValue } from "./format.js";
import { type Matcher, isMatcher } from "./matchers.js";
import type { PinnedKey } from "./types.js";

/**
 * How narrowly a mock's pinned args or params constrain a call:
 * `[exact values, predicates]`, compared in that order. `match.any()` counts
 * as neither, and `match.partial()` counts what its fields pin. Mocks with
 * nothing pinned match anything and rank below all others.
 */
export type Specificity = readonly [exact: number, predicates: number];

export function specificity(pinned: unknown): Specificity {
  if (pinned === undefined) return [-1, 0];
  const count = (value: unknown): Specificity => {
    if (isMatcher(value)) {
      if (value.type === "partial") return count(value.fields);
      return value.type === "where" ? [0, 1] : [0, 0];
    }
    const parts = Array.isArray(value)
      ? value
      : isPlainObject(value)
        ? Object.values(value)
        : undefined;
    if (!parts) return [1, 0];
    return parts.reduce<Specificity>(
      ([exact, predicates], v) => {
        const [e, p] = count(v);
        return [exact + e, predicates + p];
      },
      [0, 0],
    );
  };
  return count(pinned);
}

/**
 * The best candidate that matches, and the first key each one tried before
 * it differed on. Candidates are ranked by specificity; at equal specificity,
 * limited mocks (`.once()`, `.times(n)`) queue ahead of unlimited ones and are
 * used oldest first, while among unlimited ones the most recent wins.
 * Candidates are tried best first, each on its exact values before its
 * predicates, so a predicate runs only for a mock still in contention.
 * `differs` gives a candidate's first key that doesn't match, if any.
 */
export function bestMatch<candidate extends Rankable>(
  /** In registration order; only those that can answer. */
  candidates: readonly candidate[],
  differs: (candidate: candidate, options: MatchOptions) => PinnedKey | undefined,
  /** The function or action, for the error when a predicate throws. */
  name: string,
): { best: candidate | undefined; missed: Map<candidate, PinnedKey> } {
  const ranked = candidates
    .map((candidate, index) => ({ candidate, index, limited: candidate.remaining !== undefined }))
    .toSorted(
      (a, b) =>
        b.candidate.specificity[0] - a.candidate.specificity[0] ||
        b.candidate.specificity[1] - a.candidate.specificity[1] ||
        Number(b.limited) - Number(a.limited) ||
        (a.limited ? a.index - b.index : b.index - a.index),
    )
    .map(({ candidate }) => candidate);
  const missed = new Map<candidate, PinnedKey>();
  try {
    for (const candidate of ranked) {
      // Predicates run only when the exact values match (`null` is a mismatch too).
      const exact = differs(candidate, { predicates: false });
      const key = exact === undefined ? differs(candidate, {}) : exact;
      if (key === undefined) return { best: candidate, missed };
      missed.set(candidate, key);
    }
    return { best: undefined, missed };
  } catch (error) {
    if (!(error instanceof MatcherThrewError)) throw error;
    throw new MockResolverError(name, error.cause, { matcher: error.matcher });
  }
}

/**
 * Where a call differs from a mock's pinned args or params, for messages: the
 * top-level array indexes or object keys whose values don't match, in order.
 * Empty when everything pinned matches (or nothing is). A predicate that
 * throws counts as not matching.
 */
export function mismatches(
  pinned: unknown,
  actual: unknown,
  options: MatchOptions = {},
): PinnedKey[] {
  if (isMatcher(pinned) && pinned.type === "partial")
    return mismatches(pinned.fields, actual, options);
  if (!hasKeys(pinned)) {
    try {
      return isMatch(pinned, actual, options) ? [] : [null];
    } catch {
      return [null];
    }
  }
  const at = (key: number | string): unknown =>
    Array.isArray(actual) ? actual[Number(key)] : isPlainObject(actual) ? actual[key] : undefined;
  return pinnedEntries(pinned)
    .filter(([key, value]) => {
      try {
        return !isMatch(value, at(key), options);
      } catch {
        return true;
      }
    })
    .map(([key]) => key);
}

/**
 * The first of `pinned`'s keys (an array of args, or an object of params)
 * whose value doesn't match `actual`'s, or `undefined` when all match: the
 * same verdict as `isMatch(pinned, actual)`, with where it failed. It stops at
 * the first, so predicates run as they would in `isMatch`; one that throws
 * throws here too.
 */
export function firstMismatch(
  pinned: unknown,
  actual: unknown,
  options: MatchOptions = {},
): PinnedKey | undefined {
  // A matcher pinned in place of the whole params: a `partial` by its fields,
  // as `isMatch` checks it, and any other as a whole.
  if (isMatcher(pinned) && pinned.type === "partial")
    return firstMismatch(pinned.fields, actual, options);
  if (!hasKeys(pinned)) return isMatch(pinned, actual, options) ? undefined : null;
  const entries = pinnedEntries(pinned);
  const sameShape = Array.isArray(pinned)
    ? Array.isArray(actual) && actual.length === pinned.length
    : isPlainObject(actual);
  if (!sameShape) return entries[0]?.[0] ?? null;
  const at = (key: number | string): unknown =>
    Array.isArray(actual) ? actual[Number(key)] : isPlainObject(actual) ? actual[key] : undefined;
  return entries.find(([key, value]) => !isMatch(value, at(key), options))?.[0];
}

/** Whether `pinned` is args or params by key (an array or an object), not one matcher or value. */
const hasKeys = (pinned: unknown) =>
  Array.isArray(pinned) || (isPlainObject(pinned) && !isMatcher(pinned));

/** A mock's pinned args or params as [index or key, value] pairs. */
function pinnedEntries(pinned: unknown): [number | string, unknown][] {
  if (Array.isArray(pinned)) return pinned.map((value: unknown, i) => [i, value]);
  return isPlainObject(pinned) ? Object.entries(pinned) : [];
}

/** A mock's limit: `limit` answers in all, `remaining` of them left. */
type Limit = { limit: number | undefined; remaining: number | undefined };

/** Limits a mock to `count` answers, for `.once()` and `.times(count)`. */
export function setLimit(mock: Limit, count: number): void {
  if (!Number.isInteger(count) || count < 1)
    throw new MockSetupError(`times() takes a positive integer; got ${String(count)}.`);
  if (mock.limit !== undefined)
    throw new MockSetupError("This mock already has a limit; call once() or times() only once.");
  mock.limit = count;
  mock.remaining = count;
}

type Rankable = {
  specificity: Specificity;
  /** Answers left for a limited mock; `undefined` when unlimited. */
  remaining: number | undefined;
};

export type MatchOptions = {
  /** Run `match.where()` predicates; with `false`, they match anything. Defaults to `true`. */
  predicates?: boolean;
};

/**
 * Deep equality where hex strings (addresses, bytes) compare case-insensitively
 * and equal integers match as either `number` or `bigint`. Objects match on the
 * fields `expected` has. `match.*` matchers in `expected` match as they say.
 *
 * @internal Exported for its unit test.
 */
export function isMatch(expected: unknown, actual: unknown, options: MatchOptions = {}): boolean {
  if (isMatcher(expected)) {
    if (expected.type === "partial")
      return (
        isPlainObject(actual) &&
        Object.entries(expected.fields).every(([key, value]) =>
          isMatch(value, actual[key], options),
        )
      );
    if (expected.type === "any" || options.predicates === false) return true;
    try {
      return expected.predicate(actual);
    } catch (error) {
      throw new MatcherThrewError(formatValue(expected), error);
    }
  }
  if (isHex(expected) && isHex(actual)) return expected.toLowerCase() === actual.toLowerCase();
  if (Array.isArray(expected) && Array.isArray(actual))
    return (
      expected.length === actual.length &&
      expected.every((value, i) => isMatch(value, actual[i], options))
    );
  if (isPlainObject(expected) && isPlainObject(actual))
    return Object.entries(expected).every(([key, value]) => isMatch(value, actual[key], options));
  // viem decodes integers up to 48 bits as numbers and wider ones as bigints. A
  // value of the other kind that got past the types still means the same number.
  if (typeof expected === "bigint" && typeof actual === "number")
    return Number.isInteger(actual) && expected === BigInt(actual);
  if (typeof expected === "number" && typeof actual === "bigint")
    return Number.isInteger(expected) && BigInt(expected) === actual;
  return expected === actual;
}

/** Thrown from `isMatch` when a predicate throws; `bestMatch` reports it as unhandled. */
class MatcherThrewError extends Error {
  /** The matcher for messages, e.g. `where(isLarge)`. */
  matcher: string;

  constructor(matcher: string, cause: unknown) {
    super(`${matcher} threw`, { cause });
    this.matcher = matcher;
  }
}

/** The first matcher anywhere in `value`, if any. */
export function findMatcher(value: unknown): Matcher | undefined {
  if (isMatcher(value)) return value;
  if (typeof value !== "object" || value === null) return undefined;
  for (const v of Object.values(value)) {
    const found = findMatcher(v);
    if (found) return found;
  }
  return undefined;
}

/** Throws if `value` holds a matcher anywhere: they go in args, not in answers. */
export function assertNoMatchers(value: unknown, place = "return values"): void {
  const found = findMatcher(value);
  if (found)
    throw new MockSetupError(
      `match.${found.type}() can't go in ${place}; matchers only go in args and params.`,
    );
}

/**
 * Throws if `pinned` holds a Jest or Vitest matcher (`expect.any(…)` and the
 * like) anywhere. The mock can't run them, and they're typed `any`, so they
 * would type-check and then never match.
 */
export function assertNoRunnerMatchers(pinned: unknown): void {
  const found = findRunnerMatcher(pinned, new Set());
  if (found !== undefined)
    throw new MockSetupError(
      `Args and params take the mock's own matchers, not Jest's or Vitest's (got ${found}): ` +
        "use match.any() or match.where(…) instead.",
    );
}

/** A Jest or Vitest matcher: both give theirs `asymmetricMatch`, and a name. */
type RunnerMatcher = { asymmetricMatch(other: unknown): boolean; toAsymmetricMatcher?(): string };

const isRunnerMatcher = (value: object): value is RunnerMatcher =>
  "asymmetricMatch" in value && typeof value.asymmetricMatch === "function";

/** A Jest or Vitest matcher in `value`, by its name (e.g. `Any<String>`), if any. */
function findRunnerMatcher(value: unknown, seen: Set<object>): string | undefined {
  if (typeof value !== "object" || value === null || seen.has(value)) return undefined;
  seen.add(value);
  if (isRunnerMatcher(value)) return value.toAsymmetricMatcher?.() ?? "a test runner matcher";
  for (const each of Array.isArray(value) ? value : Object.values(value)) {
    const found = findRunnerMatcher(each, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}
