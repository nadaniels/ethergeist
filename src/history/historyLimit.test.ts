import { describe, expect, test } from "vite-plus/test";

import { createRecordLimit } from "./historyLimit.js";

describe("createRecordLimit()", () => {
  test("defaults to 1000, warning on the first drop only", () => {
    const warnings: string[] = [];
    const { limit, onDrop } = createRecordLimit(undefined, (message) => {
      warnings.push(message);
    });
    onDrop();
    onDrop();

    expect(limit).toBe(1000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("createMockRpc({ historyLimit })");
  });

  test("a given limit never warns, Infinity included", () => {
    const warnings: string[] = [];
    for (const historyLimit of [1, 500, Infinity]) {
      const { limit, onDrop } = createRecordLimit(historyLimit, (message) => {
        warnings.push(message);
      });
      onDrop();
      expect(limit).toBe(historyLimit);
    }
    expect(warnings).toEqual([]);
  });

  test("0 points to 1 and Infinity", () => {
    expect(() => createRecordLimit(0)).toThrow(
      "historyLimit keeps at least 1 entry per record; use 1 for the least memory, " +
        "or Infinity to keep them all.",
    );
  });

  test.each([-1, 1.5, Number.NaN, -Infinity])("refuses %s", (historyLimit) => {
    expect(() => createRecordLimit(historyLimit)).toThrow(
      `historyLimit takes a positive whole number or Infinity; got ${String(historyLimit)}.`,
    );
  });
});
