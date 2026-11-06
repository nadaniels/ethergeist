import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { test } from "vite-plus/test";

/**
 * Runs and type-checks the README's `ts` code blocks, so an example that
 * drifts from the API fails here. A block whose info string says `skip` isn't run, and one that
 * says `continued` runs as the end of the block before it. Imports of
 * `ethergeist` point at `src/`, and a snippet's `test()` calls run in order
 * inside this file's test, since a test can't declare another.
 */
const root = join(import.meta.dirname, "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const snippets: { section: string; code: string }[] = [];
let section = "README";
for (const [, heading, info, code] of readme.matchAll(
  /^## (.+)$|^```ts([^\n]*)\n([\s\S]*?)^```$/gmu,
))
  if (heading !== undefined) section = heading;
  else if (code === undefined || (info ?? "").includes("skip")) continue;
  else if ((info ?? "").includes("continued")) {
    const previous = snippets.at(-1);
    if (previous === undefined)
      throw new Error("The README's first ts block can't be `continued`.");
    previous.code += code;
  } else snippets.push({ section, code });

const directory = join(root, "node_modules", ".cache", "readme");
rmSync(directory, { recursive: true, force: true });
mkdirSync(directory, { recursive: true });

/** A snippet as a module this test can import. */
function runnable(code: string): string {
  const withSource = code.replaceAll(
    'from "ethergeist"',
    `from ${JSON.stringify(join(root, "src", "index.js"))}`,
  );
  const tests =
    "const tests: (() => unknown)[] = [];\nconst test = (_name: string, body: () => unknown) => {\n  tests.push(body);\n};\n";
  const withRunner = withSource.replace(
    /^import \{([^}]*)\} from "vitest";$/mu,
    (_, names: string) => {
      const kept = names
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "" && name !== "test");
      return `${kept.length > 0 ? `import { ${kept.join(", ")} } from "vite-plus/test";\n` : ""}${tests}`;
    },
  );
  const runsTests = withRunner === withSource ? "" : "for (const body of tests) await body();\n";
  return `${withRunner}\n${runsTests}export {};\n`;
}

const files = snippets.map(({ section: heading, code }, index) => {
  const file = join(directory, `snippet-${index + 1}.ts`);
  writeFileSync(file, runnable(code));
  return { heading, file, name: `snippet ${index + 1}` };
});

for (const { heading, file, name } of files)
  test(`README, ${heading} (${name}) runs`, async () => {
    await import(file);
  });

test("the README's snippets type-check", () => {
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({ extends: join(root, "tsconfig.json"), include: ["*.ts"] }),
  );
  try {
    execFileSync(join(root, "node_modules", ".bin", "tsc"), ["-p", directory], {
      encoding: "utf8",
    });
  } catch (error) {
    const output: unknown = error instanceof Error ? Reflect.get(error, "stdout") : undefined;
    throw new Error(`The README's snippets don't type-check:\n${String(output ?? error)}`, {
      cause: error,
    });
  }
});
