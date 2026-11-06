import { describe, expect, test } from "vite-plus/test";

import { match } from "./matchers.js";
import { type Specificity, bestMatch, firstMismatch, isMatch, mismatches } from "./matching.js";

const yes = match.where(() => true, "yes");
const no = match.where(() => false, "no");

const cases: [name: string, pinned: unknown, actual: unknown, key: unknown][] = [
  ["args that match", ["0x1", 2n], ["0x1", 2n], undefined],
  ["the first arg that differs", ["0x1", 2n, 3n], ["0x1", 9n, 9n], 1],
  ["hex in any case", ["0xAB"], ["0xab"], undefined],
  ["a predicate that says no", [yes, no], [1n, 2n], 1],
  ["any", [match.any(), 2n], [1n, 2n], undefined],
  ["args of another length", ["0x1"], ["0x1", 2n], 0],
  ["args against a non-array", ["0x1"], { a: 1 }, 0],
  ["params that match", { address: "0x1" }, { address: "0x1", block: 3n }, undefined],
  [
    "the first param that differs",
    { address: "0x1", nonce: 1 },
    { address: "0x1", nonce: 2 },
    "nonce",
  ],
  ["params against a non-object", { address: "0x1" }, ["0x1"], "address"],
  ["a struct arg's nested field", [{ a: { b: 1n } }], [{ a: { b: 2n } }], 0],
  ["a partial struct arg", [match.partial({ b: no })], [{ b: 1n }], 0],
  [
    "a partial for all the params",
    match.partial({ address: "0x1" }),
    { address: "0x1" },
    undefined,
  ],
  ["a partial for all the params, differing", match.partial({ a: 1, b: 2 }), { a: 1, b: 3 }, "b"],
  ["any for all the params", match.any(), { address: "0x1" }, undefined],
  ["a predicate for all the params", no, { address: "0x1" }, null],
  ["a predicate for all the params, saying yes", yes, { address: "0x1" }, undefined],
];

describe("firstMismatch()", () => {
  test.each(cases)("%s", (_, pinned, actual, key) => {
    expect(firstMismatch(pinned, actual)).toBe(key);
  });

  test.each(cases)("agrees with isMatch(): %s", (_, pinned, actual) => {
    expect(firstMismatch(pinned, actual) === undefined).toBe(isMatch(pinned, actual));
  });

  test("runs predicates as isMatch() does: in order, stopping at the first that says no", () => {
    const calls: string[] = [];
    const say = (result: boolean, label: string) =>
      match.where(() => {
        calls.push(label);
        return result;
      }, label);
    const pinned = [say(true, "a"), say(false, "b"), say(false, "c")];

    firstMismatch(pinned, [1n, 2n, 3n]);
    const seen = [...calls];
    calls.length = 0;
    isMatch(pinned, [1n, 2n, 3n]);
    expect(seen).toEqual(["a", "b"]);
    expect(calls).toEqual(seen);
  });

  test("skips predicates with predicates: false", () => {
    expect(firstMismatch([no, 2n], [1n, 2n], { predicates: false })).toBeUndefined();
    expect(firstMismatch([no, 2n], [1n, 3n], { predicates: false })).toBe(1);
  });
});

describe("mismatches()", () => {
  test("lists every key that differs, or null for all the params", () => {
    expect(mismatches(["0x1", 2n, 3n], ["0x2", 2n, 4n])).toEqual([0, 2]);
    expect(mismatches(match.partial({ a: 1, b: 2 }), { a: 0, b: 0 })).toEqual(["a", "b"]);
    expect(mismatches(no, { a: 1 })).toEqual([null]);
    expect(mismatches(match.any(), { a: 1 })).toEqual([]);
  });
});

describe("bestMatch()", () => {
  test("a candidate ruled out on exact values runs no predicates, even when all its params differ", () => {
    const passes: unknown[] = [];
    const candidate = { specificity: [1, 0] as Specificity, remaining: undefined };
    const { best, missed } = bestMatch(
      [candidate],
      (_, options) => {
        passes.push(options);
        return options.predicates === false ? null : undefined;
      },
      "fn",
    );

    expect(best).toBeUndefined();
    expect(missed.get(candidate)).toBeNull();
    expect(passes).toEqual([{ predicates: false }]);
  });
});
