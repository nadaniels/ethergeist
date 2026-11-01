import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: { sortImports: true, sortPackageJson: true },
  lint: {
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
      // Type-only imports add no runtime coupling; createMockRpc wires every part together.
      "import/max-dependencies": ["warn", { max: 10, ignoreTypeImports: true }],
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
      },
      {
        // createMockRpc assembles every part of the mock, so it imports each one.
        files: ["src/createMockRpc.ts"],
        rules: { "import/max-dependencies": "off" },
      },
      {
        // The catalog of typed actions imports each one; that's its job.
        files: ["src/actions/typedActions.ts"],
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
