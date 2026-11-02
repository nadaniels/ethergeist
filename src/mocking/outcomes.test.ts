import { describe, expect, test } from "vite-plus/test";

import {
  MockInternalError,
  MockRevertError,
  MockRpcError,
  removedMockError,
} from "../shared/errors.js";
import { MockFailure } from "./faults.js";
import { asMockError, errorOutcome, failureOutcome, isAnswer } from "./outcomes.js";

describe("asMockError()", () => {
  test("a mock error is itself", () => {
    const error = removedMockError();

    expect(asMockError(error)).toBe(error);
  });

  test("anything else is wrapped, in the same MockInternalError each time", () => {
    // So a request and the contract call inside it record the same error.
    const thrown = new TypeError("x is undefined");
    const error = asMockError(thrown);

    expect(error).toBeInstanceOf(MockInternalError);
    expect(error.cause).toBe(thrown);
    expect(asMockError(thrown)).toBe(error);
    expect(errorOutcome(thrown)).toEqual({ type: "unhandled", error });
    expect(failureOutcome(thrown)).toEqual({ type: "unhandled", error });
  });

  test("a thrown value that isn't an object is wrapped too", () => {
    expect(asMockError("boom").shortMessage).toBe("The mock failed unexpectedly: boom");
  });
});

describe("isAnswer()", () => {
  test("reverts, faults and a node's refusals are answers; the mock's errors aren't", () => {
    expect(isAnswer(new MockRevertError("0x"))).toBe(true);
    expect(isAnswer(new MockFailure("timeout"))).toBe(true);
    expect(isAnswer(new MockRpcError(-32602, "invalid params"))).toBe(true);
    expect(isAnswer(removedMockError())).toBe(false);
    expect(isAnswer(new TypeError("x"))).toBe(false);
  });
});
