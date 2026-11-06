/**
 * Checks the package the way a consumer gets it. It packs the tarball
 * (`pnpm pack`, which builds it with `vp pack`), then:
 *
 * - fails on a file in the tarball outside `dist/`, the LICENSE, the README
 *   and `package.json`, so colocated tests never ship;
 * - installs the tarball into two consumers, one with the oldest viem and ox
 *   its peer ranges allow and one with the repo's viem and the ox it
 *   depends on;
 * - type-checks `smoke-consumer.ts` in each consumer, without
 *   `skipLibCheck`, under TypeScript 5.8.2, the latest TypeScript 5 and 6,
 *   and the repo's own, with `nodenext` and `bundler` resolution, so a type
 *   or module missing from an older viem, ox or TypeScript fails, as does an
 *   import of a file that isn't shipped;
 * - emits the consumer's own declarations, which fails where a type the
 *   consumer infers can't be written with what the package exports, such
 *   as an unexported `unique symbol`;
 * - runs `smoke-runtime.ts` in each consumer under Node;
 * - and bundles it for a browser, failing on a Node module the bundle
 *   imports, and runs the bundle without Node's globals.
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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Rolldown } from "vite-plus/pack";

const root = join(import.meta.dirname, "..");
const consumerOptions = {
  module: "nodenext",
  target: "esnext",
  lib: ["esnext", "dom"],
  types: [],
  strict: true,
  declaration: true,
  emitDeclarationOnly: true,
};
const shipped = /^package\/(?:dist\/[^/]+\.(?:js|d\.ts)|LICENSE|README\.md|package\.json)$/u;

/** The string at `path` in the `package.json` in `directory`. */
function manifestField(directory: string, ...path: string[]): string {
  const file = join(directory, "package.json");
  let value: unknown = JSON.parse(readFileSync(file, "utf8"));
  for (const key of path)
    value = typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  if (typeof value !== "string") throw new Error(`${file} has no ${path.join(".")}.`);
  return value;
}

/** The oldest version the package's peer range for `peer` allows. */
function oldestPeer(peer: string): string {
  const range = manifestField(root, "peerDependencies", peer);
  const oldest = /^(?:\^|~|>=)?(\d+\.\d+\.\d+)$/u.exec(range)?.[1];
  if (oldest === undefined) throw new Error(`Can't read the oldest ${peer} in "${range}".`);
  return oldest;
}

function run(command: string, args: string[], cwd: string): void {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
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

/** The files in the tarball at `tarball` that shouldn't ship. */
function unshippedFiles(tarball: string): string[] {
  return execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .split("\n")
    .filter((file) => file !== "" && !shipped.test(file));
}

/** `script` from `scripts/`, importing the package by name instead of `../src/index.js`. */
function asConsumer(script: string, name: string): string {
  const source = readFileSync(join(import.meta.dirname, script), "utf8");
  const fromSource = '"../src/index.js"';
  if (!source.includes(fromSource)) throw new Error(`${script} must import ${fromSource}.`);
  return source.replaceAll(fromSource, JSON.stringify(name));
}

/**
 * A consumer with the tarball, `versions` of viem and ox, and each of
 * `typescripts` (as `typescript-<version>`) installed.
 */
function createConsumer(
  directory: string,
  tarball: string,
  versions: { viem: string; ox: string },
  typescripts: string[],
): void {
  mkdirSync(directory);
  writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run(
    "pnpm",
    [
      "add",
      tarball,
      `viem@${versions.viem}`,
      `ox@${versions.ox}`,
      ...typescripts.map((version) => `typescript-${version}@npm:typescript@${version}`),
    ],
    directory,
  );

  const name = manifestField(root, "name");
  writeFileSync(join(directory, "consumer.ts"), asConsumer("smoke-consumer.ts", name));
  writeFileSync(join(directory, "runtime.js"), asConsumer("smoke-runtime.ts", name));
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { ...consumerOptions, skipLibCheck: false, outDir: "out" },
      files: ["consumer.ts"],
    }),
  );
}

/**
 * Bundles the consumer's `runtime.js` for a browser into `browser.js`, and
 * runs it in Node without Node's globals.
 */
async function runInBrowserBundle(directory: string): Promise<void> {
  console.log("\nBundling runtime.js for a browser");
  const { output } = await Rolldown.build({
    input: join(directory, "runtime.js"),
    cwd: directory,
    platform: "browser",
    write: false,
    logLevel: "silent",
    output: { format: "esm", codeSplitting: false },
  });
  const [bundle] = output;
  const nodeImports = [...bundle.imports, ...bundle.dynamicImports].filter((id) => isBuiltin(id));
  if (nodeImports.length > 0)
    throw new Error(`The browser bundle imports Node's ${nodeImports.join(", ")}.`);
  writeFileSync(join(directory, "browser.js"), bundle.code);

  const withoutNodeGlobals =
    "for (const name of ['process', 'Buffer', 'global', 'setImmediate', 'clearImmediate']) delete globalThis[name];";
  run(
    process.execPath,
    ["--import", `data:text/javascript,${encodeURIComponent(withoutNodeGlobals)}`, "browser.js"],
    directory,
  );
}

// Ctrl-C stops only the command running, which fails, so the temporary directory is still removed.
process.on("SIGINT", () => undefined);
const temporary = mkdtempSync(join(tmpdir(), "smoke-"));
try {
  run("pnpm", ["pack", "--pack-destination", temporary], root);
  const tarballName = readdirSync(temporary).find((file) => file.endsWith(".tgz"));
  if (tarballName === undefined) throw new Error(`pnpm pack left no tarball in ${temporary}.`);
  const tarball = join(temporary, tarballName);
  const unshipped = unshippedFiles(tarball);
  if (unshipped.length > 0)
    throw new Error(`The tarball has files that shouldn't ship:\n  ${unshipped.join("\n  ")}`);

  const targets = {
    floor: { viem: oldestPeer("viem"), ox: oldestPeer("ox") },
    current: {
      viem: manifestField(join(root, "node_modules", "viem"), "version"),
      ox: manifestField(join(root, "node_modules", "viem"), "dependencies", "ox"),
    },
  };
  const typescripts = [
    // The oldest that reads viem's and ox's declarations under nodenext without skipLibCheck.
    "5.8.2",
    "5",
    "6",
    manifestField(join(root, "node_modules", "typescript"), "version"),
  ];
  for (const [label, versions] of Object.entries(targets)) {
    console.log(`\nConsumer at ${label}: viem ${versions.viem}, ox ${versions.ox}`);
    const consumer = join(temporary, label);
    createConsumer(consumer, tarball, versions, typescripts);

    for (const typescript of typescripts) {
      const tsc = join(consumer, "node_modules", `typescript-${typescript}`, "bin", "tsc");
      run(process.execPath, [tsc, "-p", consumer], consumer);
      run(
        process.execPath,
        [tsc, "-p", consumer, "--module", "esnext", "--moduleResolution", "bundler"],
        consumer,
      );
    }
    run(process.execPath, ["runtime.js"], consumer);
  }
  await runInBrowserBundle(join(temporary, "current"));

  const source = join(temporary, "source");
  mkdirSync(source);
  const unexported = unexportedImports(source);
  if (unexported.length > 0)
    throw new Error(
      `Declarations name types index.ts doesn't export:\n  ${unexported.join("\n  ")}`,
    );
  console.log("\nThe package installs, type-checks and runs at every version.");
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
