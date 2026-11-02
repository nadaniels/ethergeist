import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, test } from "vite-plus/test";

// The layers of docs/architecture.md, lowest first. Files at the top of src/
// (createMockRpc, types, builders, index) sit above them all.
const layers = [
  "shared",
  "mocking",
  "chain",
  "logs",
  "contracts",
  "actions",
  "history",
  "rpc",
  "viem",
];

const src = resolve(import.meta.dirname, "../src");
const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((file) =>
  file.endsWith(".ts"),
);

/** A file's folder under src/, or `undefined` for one at the top. */
const folderOf = (file: string) => (file.includes("/") ? file.split("/")[0] : undefined);
const rank = (folder: string | undefined) =>
  folder === undefined ? layers.length : layers.indexOf(folder);

describe("architecture", () => {
  test("every folder in src/ is a layer", () => {
    const folders = new Set(
      files.map((file) => folderOf(file)).filter((folder) => folder !== undefined),
    );
    expect([...folders].filter((folder) => !layers.includes(folder))).toEqual([]);
  });

  test("imports only point down the layers, or within a folder", () => {
    const upward = files.flatMap((file) => {
      const text = readFileSync(join(src, file), "utf8");
      return [...text.matchAll(/from "(\.{1,2}\/[^"]+)"/gv)].flatMap(([, specifier]) => {
        const target = relative(src, resolve(src, dirname(file), specifier!));
        const [from, to] = [folderOf(file), folderOf(target)];
        return from !== to && rank(to) > rank(from) ? [`${file} imports ${target}`] : [];
      });
    });
    expect(upward).toEqual([]);
  });

  test("the mock throws its own errors, not plain ones", () => {
    // See shared/errors.ts. Allowed: the family's base and the internal
    // answers there, wrapping a thrown non-Error as a cause, and the internal
    // signals that never leave the mock as they are.
    const allowed = new Map([
      [
        "shared/errors.ts",
        ["extends BaseError", "new Error(", "new Error(", "extends BaseError", "extends BaseError"],
      ],
      ["mocking/faults.ts", ["extends Error"]],
      ["mocking/matching.ts", ["extends Error"]],
    ]);
    const plain = files
      .filter((file) => !file.endsWith(".test.ts"))
      .flatMap((file) => {
        const found = [
          ...readFileSync(join(src, file), "utf8").matchAll(
            /(?:new|throw) (?:Type|Range|Syntax|Reference|Aggregate)?Error\(|extends (?:(?:Type|Range|Syntax|Reference|Aggregate)?Error|BaseError)\b/gv,
          ),
        ].map(([match]) => match);
        // Sorted, so moving a declaration doesn't matter, but swapping one kind for another does.
        const expected = (allowed.get(file) ?? []).toSorted();
        return found.toSorted().join() === expected.join() ? [] : [`${file}: ${found.join(", ")}`];
      });
    expect(plain).toEqual([]);
  });
});
