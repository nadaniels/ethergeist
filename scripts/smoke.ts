/**
 * Checks the package's declarations the way a consumer reads them. It builds
 * the package as it ships (`vp pack` with `tsconfig.build.json`) into a
 * temporary directory, then:
 *
 * - fails on any error emitting the declarations;
 * - fails on a relative import left in them: the bundled declarations are
 *   one file, so it would point at a file that isn't shipped;
 * - type-checks `smoke-consumer.ts` against them under TypeScript 5, without
 *   `skipLibCheck`, with the oldest viem and ox it supports and with the
 *   repo's own, so a type or module missing from an older viem or ox fails;
 * - and emits the consumer's own declarations, which fails where a type the
 *   consumer infers can't be written with what the package exports, such
 *   as an unexported `unique symbol`.
 *
 * A type alias the package doesn't export reads fine there: TypeScript
 * writes it out in full. So it also compiles the consumer against `src/`,
 * where TypeScript names each type in the file that declares it, and fails
 * on a name `index.ts` doesn't export (`docs/architecture.md`, "Naming").
 *
 * Usage: vp run smoke
 *
 * It installs viem, ox and TypeScript from the registry, and removes the
 * temporary directory when it's done.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const typescript = "5";
const floor = { viem: "2.50.3", ox: "0.14.22" };
const consumerOptions = {
  module: "nodenext",
  target: "esnext",
  lib: ["esnext", "dom"],
  types: [],
  strict: true,
  declaration: true,
  emitDeclarationOnly: true,
};

/** A package's `name` or `version`, from its `package.json` in `directory`. */
function manifestField(directory: string, field: "name" | "version"): string {
  const path = join(directory, "package.json");
  const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
  const value: unknown =
    typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, field) : undefined;
  if (typeof value !== "string") throw new Error(`${path} has no ${field}.`);
  return value;
}

function run(command: string, args: string[], cwd: string): void {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

/** The relative imports in the declaration files under `directory`. */
function relativeImports(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.d\.[cm]?ts$/u.test(file))
    .flatMap((file) =>
      [
        ...readFileSync(join(directory, file), "utf8").matchAll(
          /(?:from|import\(?)\s*"(\.[^"]*)"/gu,
        ),
      ].map((found) => `${file}: ${found[1]}`),
    );
}

/**
 * The names the consumer's declarations, compiled against `src/` into
 * `directory`, import from a file there that `index.ts` doesn't export.
 */
function unexportedImports(directory: string): string[] {
  const tsconfig = join(directory, "tsconfig.json");
  writeFileSync(
    tsconfig,
    JSON.stringify({
      compilerOptions: { ...consumerOptions, skipLibCheck: true, rootDir: root, outDir: "out" },
      files: [join(import.meta.dirname, "smoke-consumer.ts")],
    }),
  );
  run(join(root, "node_modules", ".bin", "tsc"), ["-p", tsconfig], root);

  const exported = new Set(
    [
      ...readFileSync(join(root, "src", "index.ts"), "utf8").matchAll(
        /export (?:type )?\{([^}]*)\}/gu,
      ),
    ]
      .flatMap((found) => found[1]?.split(",") ?? [])
      .map((name) => name.replace(/^\s*type\s+/u, "").trim()),
  );
  const declarations = readFileSync(
    join(directory, "out", "scripts", "smoke-consumer.d.ts"),
    "utf8",
  );
  return [
    ...new Set(
      [...declarations.matchAll(/import\("(\.[^"]*)"\)\.(\w+)/gu)]
        .filter((found) => !exported.has(found[2] ?? ""))
        .map((found) => `${found[2]} (${found[1]})`),
    ),
  ];
}

function failOnRelativeImports(directory: string): void {
  const found = relativeImports(directory);
  if (found.length > 0)
    throw new Error(`Declarations import files that aren't shipped:\n  ${found.join("\n  ")}`);
}

/**
 * A consumer with `versions` installed and the built package in its
 * `node_modules`, under the package's name.
 */
function createConsumer(directory: string, built: string, versions: typeof floor): void {
  mkdirSync(directory);
  writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run(
    "pnpm",
    ["add", `viem@${versions.viem}`, `ox@${versions.ox}`, `typescript@${typescript}`],
    directory,
  );

  const name = manifestField(root, "name");
  const installed = join(directory, "node_modules", name);
  cpSync(built, installed, { recursive: true });
  writeFileSync(
    join(installed, "package.json"),
    JSON.stringify({
      name,
      type: "module",
      exports: { ".": { types: "./index.d.mts", default: "./index.mjs" } },
    }),
  );

  const consumer = readFileSync(join(import.meta.dirname, "smoke-consumer.ts"), "utf8");
  const fromSource = '"../src/index.js"';
  if (!consumer.includes(fromSource))
    throw new Error(`smoke-consumer.ts must import ${fromSource}.`);
  writeFileSync(
    join(directory, "consumer.ts"),
    consumer.replaceAll(fromSource, JSON.stringify(name)),
  );
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { ...consumerOptions, skipLibCheck: false, outDir: "out" },
      files: ["consumer.ts"],
    }),
  );
}

// Ctrl-C stops only the command running, which fails, so the temporary directory is still removed.
process.on("SIGINT", () => undefined);
const temporary = mkdtempSync(join(tmpdir(), "smoke-"));
try {
  const built = join(temporary, "package");
  run(
    "vp",
    ["pack", "src/index.ts", "--dts", "--tsconfig", "tsconfig.build.json", "--out-dir", built],
    root,
  );
  failOnRelativeImports(built);

  const targets = {
    floor,
    current: {
      viem: manifestField(join(root, "node_modules", "viem"), "version"),
      ox: manifestField(join(root, "node_modules", "ox"), "version"),
    },
  };
  for (const [label, versions] of Object.entries(targets)) {
    console.log(`\nConsumer at ${label}: viem ${versions.viem}, ox ${versions.ox}`);
    const consumer = join(temporary, label);
    createConsumer(consumer, built, versions);
    run(join(consumer, "node_modules", ".bin", "tsc"), ["-p", consumer], consumer);
  }

  const source = join(temporary, "source");
  mkdirSync(source);
  const unexported = unexportedImports(source);
  if (unexported.length > 0)
    throw new Error(
      `Declarations name types index.ts doesn't export:\n  ${unexported.join("\n  ")}`,
    );
  console.log("\nThe declarations build and type-check at every version.");
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
