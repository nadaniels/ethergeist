import { isHex } from "viem";

import { MockResolverError, MockSetupError } from "../shared/errors.js";
import { isNonArrayObject, isObjectLiteral } from "../shared/values.js";
import { type Path, formatPath, formatValue } from "./format.js";
import { type Matcher, isMatcher, partialMatcher } from "./matchers.js";
import type { PinnedKey } from "./types.js";

/**
 * How specific a mock's pinned args or params are:
 * `[exact values, predicates]`, compared in that order. `match.any()` counts
 * as neither, and `match.partial()` counts what its fields pin. Mocks with
 * nothing pinned match anything and rank below all others.
 */
export type Specificity = readonly [exact: number, predicates: number];

/** `pinned`'s specificity: see `Specificity`. */
export function specificity(pinned: unknown): Specificity {
  if (pinned === undefined) return [-1, 0];
  const count = (value: unknown): Specificity => {
    if (isMatcher(value)) {
      if (value.type === "partial") return count(value.fields);
      return value.type === "where" ? [0, 1] : [0, 0];
    }
    const parts = Array.isArray(value)
      ? value
      : isNonArrayObject(value)
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
 * The best candidate that matches, and for each one tried before it, the
 * first key it differs on. Candidates are ranked by specificity; at equal
 * specificity, limited mocks (`.once()`, `.times(count)`) queue ahead of
 * unlimited ones and are used oldest first, while among unlimited ones the
 * most recent wins. Candidates are tried best first, each on its exact
 * values before its predicates, so a predicate runs only for a mock still
 * in contention. `differs` gives a candidate's first key that doesn't
 * match, if any.
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
      // Predicates run only when the exact values match (`null` is a mismatch
      // too).
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
  if (pinned === undefined) return [];
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
    Array.isArray(actual)
      ? actual[Number(key)]
      : isNonArrayObject(actual)
        ? actual[key]
        : undefined;
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
 * Where a call differs from a mock, for a listing of the calls an unused mock
 * received, as matching would find it: `differ`'s keys with predicates off,
 * or, when the exact values all match, with them on. So a predicate runs only
 * where matching would run it.
 */
export function mismatchesAsMatched(
  differ: (options: MatchOptions) => readonly PinnedKey[],
): readonly PinnedKey[] {
  const exact = differ({ predicates: false });
  return exact.length > 0 ? exact : differ({});
}

/**
 * The first of `pinned`'s keys (an array of args, or an object of params)
 * whose value doesn't match `actual`'s, or `undefined` when all match: the
 * same verdict as `isMatch(pinned, actual)`, with where it failed, except
 * that nothing pinned (`undefined`) matches any call, as in `mismatches`. It
 * stops at the first, so predicates run as they would in `isMatch`; one that
 * throws throws here too.
 */
export function firstMismatch(
  pinned: unknown,
  actual: unknown,
  options: MatchOptions = {},
): PinnedKey | undefined {
  if (pinned === undefined) return undefined;
  if (isMatcher(pinned) && pinned.type === "partial")
    return firstMismatch(pinned.fields, actual, options);
  if (!hasKeys(pinned)) return isMatch(pinned, actual, options) ? undefined : null;
  const entries = pinnedEntries(pinned);
  const sameShape = Array.isArray(pinned)
    ? Array.isArray(actual) && actual.length === pinned.length
    : isNonArrayObject(actual);
  if (!sameShape) return entries[0]?.[0] ?? null;
  const at = (key: number | string): unknown =>
    Array.isArray(actual)
      ? actual[Number(key)]
      : isNonArrayObject(actual)
        ? actual[key]
        : undefined;
  return entries.find(([key, value]) => !isMatch(value, at(key), options))?.[0];
}

/**
 * Whether `pinned` is args or params by key (an array or an object), not one
 * matcher or value.
 */
const hasKeys = (pinned: unknown) =>
  Array.isArray(pinned) || (isNonArrayObject(pinned) && !isMatcher(pinned));

/** A mock's pinned args or params as [index or key, value] pairs. */
function pinnedEntries(pinned: unknown): [number | string, unknown][] {
  if (Array.isArray(pinned)) return pinned.map((value: unknown, i) => [i, value]);
  return isNonArrayObject(pinned) ? Object.entries(pinned) : [];
}

/** What `bestMatch` ranks a candidate by. */
type Rankable = {
  specificity: Specificity;
  /** Answers left for a limited mock; `undefined` when unlimited. */
  remaining: number | undefined;
};

/** How matching treats `match.where()` predicates. */
export type MatchOptions = {
  /**
   * Whether `match.where()` predicates run; with `false`, they match
   * anything. Defaults to `true`.
   */
  predicates?: boolean;
};

/**
 * Whether `actual` matches `expected`: deep equality where hex strings
 * (addresses, bytes) compare case-insensitively and equal integers match as
 * either `number` or `bigint`. Objects match on the fields `expected` has.
 * `match.*` matchers in `expected` match as they say.
 *
 * @internal Exported for its unit test.
 */
export function isMatch(expected: unknown, actual: unknown, options: MatchOptions = {}): boolean {
  if (isMatcher(expected)) {
    if (expected.type === "partial")
      return (
        isNonArrayObject(actual) &&
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
  if (isNonArrayObject(expected) && isNonArrayObject(actual))
    return Object.entries(expected).every(([key, value]) => isMatch(value, actual[key], options));
  // viem decodes integers up to 48 bits as numbers and wider ones as
  // bigints. A value of the other kind that got past the types still means
  // the same number.
  if (typeof expected === "bigint" && typeof actual === "number")
    return Number.isInteger(actual) && expected === BigInt(actual);
  if (typeof expected === "number" && typeof actual === "bigint")
    return Number.isInteger(expected) && BigInt(expected) === actual;
  return expected === actual;
}

/**
 * Thrown from `isMatch` when a predicate throws. `bestMatch` turns it into a
 * `MockResolverError` that names the matcher.
 */
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

/**
 * Throws if `value` holds a matcher anywhere: matchers go in a mock's args,
 * params and pins, not in values. `place` names the value for messages;
 * `hint` says what to do instead, where the place invites a matcher.
 */
export function checkNoMatchers(value: unknown, place: string, hint?: string): void {
  const found = findMatcher(value);
  if (found)
    throw new MockSetupError(
      `match.${found.type}() can't go in ${place}; matchers only go in a mock's args, params ` +
        "and pins.",
      hint === undefined ? undefined : { metaMessages: [hint] },
    );
}

/**
 * Where a value sits in a pin: its top-level arg, param or key, then the
 * keys and indexes inside it.
 */
type PinPath = readonly [Path[number], ...Path];

/** How a pin's engine words the refusal of an `undefined` in its list. */
type LeftOutWording = {
  /**
   * A top-level arg, param or key by name, qualified by the call that took
   * it, e.g. "read.allowance's spender".
   */
  name(key: number | string): string;
  /**
   * Why an element of the pin's own list can't be left out, e.g. "an arg
   * can't be left out". A list inside it has one reason for every engine.
   */
  reason: string;
};

/**
 * `pinned` as a mock stores it, holding no `undefined`: an object key set to
 * `undefined` is left out, at every depth and in `match.partial()`'s
 * fields, so it pins nothing. Object literals are copied; class instances
 * and other matchers are kept as they are. A test runner's matcher
 * (`expect.any()` and the like) is a class instance, and reaches
 * `checkNoRunnerMatchers` intact: a copy would lose its prototype's
 * `asymmetricMatch`, and would silently never match.
 *
 * A list's element can't be left out, so an `undefined` one throws, named
 * as `wording` says. An engine whose list can end early (a raw method's
 * params) trims it first.
 */
export function pinWithoutUndefined<pin>(pinned: pin, wording: LeftOutWording): pin {
  function refusal(path: PinPath) {
    const [key, ...inside] = path;
    const reason = inside.length === 0 ? wording.reason : "a list's elements can't be left out";
    return new MockSetupError(
      `${wording.name(key)}${formatPath(inside)} is undefined, and ${reason}.`,
      { metaMessages: ["Use match.any() to match any value there."] },
    );
  }
  function strip(value: unknown, path: PinPath | readonly []): unknown {
    if (isMatcher(value))
      return value.type === "partial" ? partialMatcher(strip(value.fields, path)) : value;
    if (Array.isArray(value))
      // `Array.from` visits holes, which `map` skips.
      return Array.from(value, (each: unknown, i) => {
        if (each === undefined) throw refusal([...path, i]);
        return strip(each, [...path, i]);
      });
    // After the matchers: a matcher is an object literal too.
    if (!isObjectLiteral(value)) return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, each]) => each !== undefined)
        .map(([key, each]) => [key, strip(each, [...path, key])]),
    );
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the same shape, less its undefined keys
  return strip(pinned, []) as pin;
}

/**
 * Throws if `pinned` holds a Jest or Vitest matcher (`expect.any(…)` and the
 * like) anywhere. The mock can't run them, and they're typed `any`, so they
 * would type-check and then never match.
 */
export function checkNoRunnerMatchers(pinned: unknown): void {
  const found = findRunnerMatcher(pinned, new Set());
  if (found !== undefined)
    throw new MockSetupError(
      `Args and params take the mock's own matchers, not Jest's or Vitest's (got ${found}): ` +
        "use match.any() or match.where(…) instead.",
    );
}

/**
 * A Jest or Vitest matcher: both give theirs `asymmetricMatch`, and a name
 * (`toAsymmetricMatcher`).
 */
type RunnerMatcher = { asymmetricMatch(other: unknown): boolean; toAsymmetricMatcher?(): string };

const isRunnerMatcher = (value: object): value is RunnerMatcher =>
  "asymmetricMatch" in value && typeof value.asymmetricMatch === "function";

/**
 * A Jest or Vitest matcher in `value`, by its name (e.g. `Any<String>`), if
 * any.
 */
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
