import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "node", "promise", "vitest"],
  categories: { correctness: "error" },
  options: { typeAware: true, typeCheck: true },
});
