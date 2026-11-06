import { spawnSync } from "node:child_process";
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
  "transactions",
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
        ["extends BaseError", "new Error(", "extends BaseError", "extends BaseError"],
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
        const expected = (allowed.get(file) ?? []).toSorted();
        return found.toSorted().join() === expected.join() ? [] : [`${file}: ${found.join(", ")}`];
      });
    expect(plain).toEqual([]);
  });

  test("tests check a thrown error's class, not only its message", () => {
    // A bare or message-only toThrow passes when the thrown value is undefined.
    // Use expectThrows or expectRejects from test/utils.ts, or pass the class, an
    // instance or expect.objectContaining. (`[T]` keeps this line from matching itself.)
    const tests = [
      ...files.filter((file) => file.endsWith(".test.ts")).map((file) => join(src, file)),
      ...readdirSync(import.meta.dirname, { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".ts"))
        .map((file) => join(import.meta.dirname, file)),
    ];
    const messageOnly = tests.flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return [
        ...text.matchAll(
          /(?<!\.not)\.to[T]hrow\w*\((?!\s*(?:new |[A-Z]\w*\s*[,\)]|expect\.objectContaining\())/gv,
        ),
      ].map(
        ({ index }) =>
          `${relative(resolve(src, ".."), file)}:${text.slice(0, index).split("\n").length}`,
      );
    });
    expect(messageOnly).toEqual([]);
  });

  test("src/ uses no Node APIs, so what's built from it runs in a browser", () => {
    // tsconfig.build.json is src/ without its tests, and without Node's types.
    const root = resolve(src, "..");
    // Run through Node, so it doesn't depend on the shell shim in node_modules/.bin.
    const tsc = join(root, "node_modules/typescript/bin/tsc");
    const { error, stdout, status } = spawnSync(
      process.execPath,
      [tsc, "-p", join(root, "tsconfig.build.json")],
      { encoding: "utf8" },
    );
    expect(error).toBeUndefined();
    expect(stdout).toBe("");
    expect(status).toBe(0);
  });
});
