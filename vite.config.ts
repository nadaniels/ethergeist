import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: "src/index.ts",
    format: "esm",
    platform: "neutral",
    tsconfig: "tsconfig.build.json",
    dts: true,
    minify: false,
    sourcemap: false,
    publint: true,
    attw: { profile: "esm-only", level: "error" },
    outputOptions: { comments: { jsdoc: false } },
  },
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    typecheck: { include: ["src/**/*.test-d.ts", "test/**/*.test-d.ts"] },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.test-d.ts"],
      reporter: [["text", { skipFull: true }], "html"],
      reportsDirectory: "reports/coverage",
    },
  },
  staged: {
    "*": "vp check --fix",
  },
  fmt: { sortImports: true, sortPackageJson: true },
  lint: {
    ignorePatterns: ["examples/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "typescript/no-unnecessary-type-assertion": "error",
      "typescript/no-unnecessary-type-arguments": "error",
      "typescript/return-await": ["error", "always"],

      "eslint/max-classes-per-file": "off",
      "eslint/max-lines": "off",
      "eslint/max-lines-per-function": "off",
      "eslint/no-redeclare": "off",
      // A prompt to check a module isn't taking on too much, not a limit to design around;
      // see docs/architecture.md. Type-only imports add no runtime coupling.
      "import/max-dependencies": ["warn", { max: 10, ignoreTypeImports: true }],
      // Type-only cycles count too: they're as much a sign of tangled modules.
      "import/no-cycle": ["error", { ignoreTypes: false }],
      "typescript/prefer-readonly-parameter-types": "off",
      "typescript/strict-boolean-expressions": [
        "warn",
        { allowNullableString: true, allowNullableObject: true },
      ],
      "unicorn/no-useless-undefined": "off",
    },
    options: { reportUnusedDisableDirectives: "error", typeAware: true, typeCheck: true },
    plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "node", "promise"],
    categories: { correctness: "error", suspicious: "warn", perf: "warn", pedantic: "warn" },
    overrides: [
      {
        files: ["**/*.test.ts", "**/*.test-d.ts"],
        plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "node", "promise", "vitest"],
        rules: { "eslint/no-await-in-loop": "off" },
      },
      {
        files: [
          "src/createMockRpc.ts",
          "src/actions/typedActions.ts",
          "src/contracts/createMockContract.ts",
        ],
        rules: { "import/max-dependencies": "off" },
      },
      {
        // Type tests assert through compilation and @ts-expect-error.
        files: ["**/*.test-d.ts"],
        rules: { "typescript/no-unsafe-call": "off", "vitest/expect-expect": "off" },
      },
    ],
  },
});
