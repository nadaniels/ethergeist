import { isHex } from "viem";
import { MockResolverError } from "./errors.js";
import { type Matcher, formatMatcher, isMatcher } from "./matchers.js";
import { isPlainObject } from "./result.js";

/**
 * How narrowly a mock's pinned args or params constrain a call:
 * `[exact values, predicates]`, compared in that order. `match.any()` counts
 * as neither. Mocks with nothing pinned match anything and rank below all others.
 */
export type Specificity = readonly [exact: number, predicates: number];

export function specificity(pinned: unknown): Specificity {
  if (pinned === undefined) return [-1, 0];
  const count = (value: unknown): Specificity => {
    if (isMatcher(value)) return value.type === "where" ? [0, 1] : [0, 0];
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
 * The best candidate that matches: the most specific, and among equally
 * specific ones the most recent. Candidates are tried best first, each on its
 * exact values before its predicates, so a predicate runs only for a mock still
 * in contention.
 */
export function bestMatch<candidate extends { specificity: Specificity }>(
  candidates: readonly candidate[],
  matches: (candidate: candidate, options: MatchOptions) => boolean,
  /** The function or action, for the error when a predicate throws. */
  name: string,
): candidate | undefined {
  // The sort is stable, so reversing first puts the most recent first on ties.
  const ranked = candidates
    .toReversed()
    .toSorted((a, b) => b.specificity[0] - a.specificity[0] || b.specificity[1] - a.specificity[1]);
  try {
    return ranked.find(
      (candidate) => matches(candidate, { predicates: false }) && matches(candidate, {}),
    );
  } catch (error) {
    if (!(error instanceof MatcherThrewError)) throw error;
    throw new MockResolverError(name, error.cause, { matcher: error.matcher });
  }
}

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
    if (expected.type === "any" || options.predicates === false) return true;
    try {
      return expected.predicate(actual);
    } catch (error) {
      throw new MatcherThrewError(formatMatcher(expected), error);
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
      `${formatMatcher(found)} is a matcher; matchers go in args or params, not in return values.`,
    );
}
