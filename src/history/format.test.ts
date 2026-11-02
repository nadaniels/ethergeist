import { describe, expect, test } from "vite-plus/test";

import {
  MockInternalError,
  MockNotFoundError,
  MockResolverError,
  MockSetupError,
} from "../shared/errors.js";
import { formatOutcome } from "./format.js";

describe("formatOutcome()", () => {
  test.each([
    [
      new MockNotFoundError("No mock for decimals().", { metaMessages: ["Registered:"] }),
      "✗ not mocked",
    ],
    [new MockResolverError("decimals", new Error("boom")), "✗ resolver threw: boom"],
    [
      new MockResolverError("decimals", new Error("no"), { matcher: "where(isLarge)" }),
      "✗ matcher where(isLarge) threw: no",
    ],
    [
      // One line, without the cause's hints.
      new MockResolverError(
        "decimals",
        new MockSetupError("This mock was removed.", { metaMessages: ["Register a new one."] }),
      ),
      "✗ resolver threw: This mock was removed.",
    ],
    [new MockInternalError(new TypeError("x is undefined")), "✗ mock failed: x is undefined"],
    [
      new MockSetupError("This mock was removed.", { metaMessages: ["Register a new one."] }),
      "✗ This mock was removed.",
    ],
  ])("an unhandled %s", (error, line) => {
    expect(formatOutcome({ type: "unhandled", error })).toBe(line);
  });
});
