import { describe, expectTypeOf, test } from "vite-plus/test";

import type {
  MockCallOutcome,
  MockCallRecord,
  MockHistoryEntry,
  MockOutcome,
} from "../src/index.js";

describe("history outcomes", () => {
  test("an entry's outcome is never notReached, and a call record's can be", () => {
    expectTypeOf<MockHistoryEntry["outcome"]>().toEqualTypeOf<MockOutcome>();
    expectTypeOf<Extract<MockHistoryEntry["outcome"], { type: "notReached" }>>().toBeNever();

    expectTypeOf<MockCallRecord["outcome"]>().toEqualTypeOf<MockCallOutcome>();
    expectTypeOf<Extract<MockCallRecord["outcome"], { type: "notReached" }>>().toEqualTypeOf<{
      type: "notReached";
    }>();
  });
});
