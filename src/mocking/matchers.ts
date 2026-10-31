import type { PartialStructs } from "../shared/abiValues.js";

const matcherKey = Symbol("matcher");

/** Internal: what a `match.*` call returns, typed as the value it stands for. */
export type Matcher =
  | { readonly [matcherKey]: true; readonly type: "any" }
  | {
      readonly [matcherKey]: true;
      readonly type: "where";
      readonly label: string;
      readonly predicate: (value: unknown) => boolean;
    }
  | {
      readonly [matcherKey]: true;
      readonly type: "partial";
      readonly fields: Readonly<Record<string, unknown>>;
    };

/**
 * Matchers for a mock's args or params, in place of exact values. Each is
 * typed as the value it stands in for, so args keep viem's types.
 *
 * Exact values rank above predicates (`where`), which rank above `any`: the
 * most specific matching mock wins, and ties go to the most recent. A
 * `partial` counts what its fields pin.
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
   * `isAddressEqual`, not `===`. Messages show `label`, the predicate's name
   * (`where(isLarge)`), or its source, cut to 60 characters (`where((n) => n > 5n)`).
   */
  where<value>(predicate: (value: value) => boolean, label?: string): value {
    return asValue({
      [matcherKey]: true,
      type: "where",
      label: label ?? (predicate.name === "" ? sourceOf(predicate) : predicate.name),
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- called only with the value at its position
      predicate: predicate as (value: unknown) => boolean,
    });
  },
  /**
   * Matches a struct on the fields given, ignoring the rest: at any depth, in
   * structs inside arrays, and with matchers as field values. A field that's
   * an array still matches whole; use `where` for "contains" or "starts with".
   */
  partial<value extends object>(fields: PartialFields<NoInfer<value>>): value {
    return asValue(partialMatcher(fields));
  },
};

/**
 * A struct's fields, any of them omitted, at any depth. `NoInfer` makes the
 * struct type come from the matcher's position, not from the fields given.
 */
type PartialFields<value> = value extends readonly unknown[] ? never : PartialStructs<value>;

/** Internal: a `partial` matcher for `fields`, e.g. after normalizing them. */
export function partialMatcher(fields: unknown): Matcher {
  if (typeof fields !== "object" || fields === null || Array.isArray(fields))
    throw new TypeError(
      "match.partial() takes a struct's fields as an object; for arrays, use match.where().",
    );
  return Object.freeze<Matcher>({
    [matcherKey]: true,
    type: "partial",
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked to be a non-array object above
    fields: fields as Record<string, unknown>,
  });
}

/**
 * A function's source on one line, cut to 60 characters, for an unnamed
 * predicate's label. Test runners compile ES modules, so an imported name
 * reads back as a property of a module object. Calls take the same shape
 * everywhere, `(0, module.name)(…)` (Vite, Babel, TypeScript, swc, esbuild,
 * webpack/Rspack, Rolldown), and go back to the plain name. Other references
 * lose only prefixes no one writes by hand: Vite's, webpack's/Rspack's, and
 * esbuild's. Babel's `_viem.` or TypeScript's `viem_1.` look like real code
 * (`order.maker`), so they stay.
 */
function sourceOf(fn: (value: never) => boolean): string {
  const source = fn
    .toString()
    .replaceAll(/\(0,\s*[\w$]+\.([\w$]+)\)/gu, "$1")
    .replaceAll(
      /\b(?:__vite_ssr_import_\d+__|[\w$]+__WEBPACK_IMPORTED_MODULE_\d+__|import_[\w$]+)\./gu,
      "",
    )
    .replaceAll(/\s+/gu, " ")
    .trim();
  return source.length > 60 ? `${source.slice(0, 59)}…` : source;
}

/** A matcher stands in for a value of whatever type is at its position. */
function asValue(matcher: Matcher): never {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- typed as the value it replaces
  return Object.freeze(matcher) as never;
}

export function isMatcher(value: unknown): value is Matcher {
  return typeof value === "object" && value !== null && matcherKey in value;
}
