// Mutation testing, run with `vp run mutate` (about 11 minutes; one file with
// `vp run mutate --mutate src/chain/fees.ts`). Reports go to reports/mutation/.
export default {
  testRunner: "vitest",
  // Under pnpm, Stryker looks for plugins next to its own install, so it
  // doesn't find the runner unless it's named.
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vite.config.ts" },
  mutate: ["src/mocking/**/*.ts", "src/chain/**/*.ts", "!src/**/*.test.ts"],
  coverageAnalysis: "perTest",
  // Mutants in module-level values rerun every test, for a quarter of the
  // mutants and nearly all the time.
  ignoreStatic: true,
  // Stryker rewrites tsconfig.json with TypeScript's JS API, which TypeScript 7
  // doesn't have; the tests don't need it rewritten, so point it at nothing.
  tsconfigFile: "no-tsconfig-for-stryker.json",
  tempDirName: ".stryker-tmp",
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
};
