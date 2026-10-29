import { isHex } from "viem";
import { MockResolverError } from "./errors.js";
import { formatValue } from "./format.js";
import { type Matcher, isMatcher } from "./matchers.js";
import { isPlainObject } from "./result.js";

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
 * The best candidate that matches. Candidates are ranked by specificity; at
 * equal specificity, limited mocks (`.once()`, `.times(n)`) queue ahead of
 * unlimited ones and are used oldest first, while among unlimited ones the
 * most recent wins. Used-up mocks are skipped. Candidates are tried best first,
 * each on its exact values before its predicates, so a predicate runs only for
 * a mock still in contention.
 */
export function bestMatch<candidate extends Rankable>(
  /** In registration order. */
  candidates: readonly candidate[],
  matches: (candidate: candidate, options: MatchOptions) => boolean,
  /** The function or action, for the error when a predicate throws. */
  name: string,
): candidate | undefined {
  const ranked = candidates
    .map((candidate, index) => ({ candidate, index, limited: candidate.remaining !== undefined }))
    .filter(({ candidate }) => candidate.remaining !== 0)
    .toSorted(
      (a, b) =>
        b.candidate.specificity[0] - a.candidate.specificity[0] ||
        b.candidate.specificity[1] - a.candidate.specificity[1] ||
        Number(b.limited) - Number(a.limited) ||
        (a.limited ? a.index - b.index : b.index - a.index),
    )
    .map(({ candidate }) => candidate);
  try {
    return ranked.find(
      (candidate) => matches(candidate, { predicates: false }) && matches(candidate, {}),
    );
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
export function mismatches(pinned: unknown, actual: unknown): (number | string)[] {
  const entries: [number | string, unknown][] = Array.isArray(pinned)
    ? pinned.map((value: unknown, i) => [i, value])
    : isPlainObject(pinned)
      ? Object.entries(pinned)
      : [];
  const at = (key: number | string): unknown =>
    Array.isArray(actual) ? actual[Number(key)] : isPlainObject(actual) ? actual[key] : undefined;
  return entries
    .filter(([key, value]) => {
      try {
        return !isMatch(value, at(key));
      } catch {
        return true;
      }
    })
    .map(([key]) => key);
}

/** A mock's limit: `limit` answers in all, `remaining` of them left. */
type Limit = { limit: number | undefined; remaining: number | undefined };

/** Limits a mock to `count` answers, for `.once()` and `.times(count)`. */
export function setLimit(mock: Limit, count: number): void {
  if (!Number.isInteger(count) || count < 1)
    throw new RangeError(`times() takes a positive integer; got ${String(count)}.`);
  if (mock.limit !== undefined)
    throw new Error("This mock already has a limit; call once() or times() only once.");
  mock.limit = count;
  mock.remaining = count;
}

type Rankable = {
  specificity: Specificity;
  /** Answers left for a limited mock; `undefined` when unlimited. */
  remaining: number | undefined;
};

type MatchOptions = {
  /** Run `match.where()` predicates; with `false`, they match anything. Defaults to `true`. */
  predicates?: boolean;
};

/**
 * Deep equality where hex strings (addresses, bytes) compare case-insensitively
 * and equal integers match as either `number` or `bigint`. Objects match on the
 * fields `expected` has. `match.*` matchers in `expected` match as they say.
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
export function assertNoMatchers(value: unknown): void {
  const found = findMatcher(value);
  if (found)
    throw new TypeError(
      `${formatValue(found)} is a matcher; matchers go in args or params, not in return values.`,
    );
}
