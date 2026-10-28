const matcherKey = Symbol("matcher");

/** Internal: what a `match.*` call returns, typed as the value it stands for. */
export type Matcher =
  | { readonly [matcherKey]: true; readonly type: "any" }
  | {
      readonly [matcherKey]: true;
      readonly type: "where";
      readonly label: string | undefined;
      readonly predicate: (value: unknown) => boolean;
    };

/**
 * Matchers for a mock's args or params, in place of exact values. Each is
 * typed as the value it stands in for, so args keep viem's types.
 *
 * Exact values rank above predicates (`where`), which rank above `any`: the
 * most specific matching mock wins, and ties go to the most recent.
 */
export const match = {
  /** Matches any value at this position. */
  // The type parameter is only inferred from where the matcher is used.
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- typed by its position, like expect.any()
  any<value>(): value {
    return asValue({ [matcherKey]: true, type: "any" });
  },
  /**
   * Matches when `predicate` returns `true`. It gets the decoded value, in
   * viem's types; addresses arrive checksummed, so compare them with
   * `isAddressEqual`, not `===`. Messages show `label`, or the predicate's
   * name: `where(isLarge)`.
   */
  where<value>(predicate: (value: value) => boolean, label?: string): value {
    return asValue({
      [matcherKey]: true,
      type: "where",
      label: label ?? (predicate.name === "" ? undefined : predicate.name),
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- called only with the value at its position
      predicate: predicate as (value: unknown) => boolean,
    });
  },
};

/** A matcher stands in for a value of whatever type is at its position. */
function asValue(matcher: Matcher): never {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- typed as the value it replaces
  return Object.freeze(matcher) as never;
}

export function isMatcher(value: unknown): value is Matcher {
  return typeof value === "object" && value !== null && matcherKey in value;
}

/** A matcher for messages: `any`, `where(isLarge)`, or `where(…)` without a name. */
export function formatMatcher(matcher: Matcher): string {
  if (matcher.type === "any") return "any";
  return `where(${matcher.label ?? "…"})`;
}
