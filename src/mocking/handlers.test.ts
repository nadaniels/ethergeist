import { describe, expect, test, vi } from "vite-plus/test";

import { expectRejects, expectThrows } from "../../test/utils.js";
import { MockResolverError, MockRevertError, MockSetupError } from "../shared/errors.js";
import { createHandlers } from "./handlers.js";

/**
 * A mock with no pins, its builder, and how to answer with it. Its engine
 * prepares a static value as is, and gives `.reverts()`.
 */
function setup({
  prepare = (value: unknown) => value,
  revertError = () => new MockRevertError("0x"),
}: {
  prepare?: (value: unknown) => unknown;
  revertError?: () => MockRevertError;
} = {}) {
  const mocks = createHandlers<object, unknown>();
  const handler = mocks.register(undefined, undefined);
  const builder = mocks.createBuilder(handler, "balanceOf", prepare, { revertError });
  const answer = (encode: (value: unknown) => unknown = (value) => value, reverted?: unknown) =>
    mocks.answerWith(handler, {}, encode, "balanceOf", reverted);
  return { mocks, builder, answer };
}

describe("answerWith()", () => {
  test("a static answer's setup error, from encoding it at the request, is thrown as it is", async () => {
    const { builder, answer } = setup();
    builder.returns(1n);
    const error = new MockSetupError("balanceOf's answer must be a non-negative bigint; got -1n.");

    await expect(
      answer(() => {
        throw error;
      }),
    ).rejects.toBe(error);
  });

  test("a resolver's setup error is a resolver error", async () => {
    const { builder, answer } = setup();
    const error = new MockSetupError("balanceOf's answer must be a non-negative bigint; got -1n.");
    builder.returns(() => {
      throw error;
    });

    const thrown = await expectRejects(MockResolverError, '"balanceOf"', answer());
    expect(thrown.cause).toBe(error);
  });

  test("a revert is thrown, or answers what the caller gives for it", async () => {
    const { builder, answer } = setup();
    builder.reverts!();

    await expectRejects(MockRevertError, "execution reverted", answer());
    await expect(answer(undefined, { status: "reverted" })).resolves.toEqual({
      status: "reverted",
    });
  });

  test("a resolver's revert answers what the caller gives for it too", async () => {
    const { builder, answer } = setup();
    builder.returns(() => {
      throw new MockRevertError("0x");
    });

    await expect(answer(undefined, { status: "reverted" })).resolves.toEqual({
      status: "reverted",
    });
  });
});

describe("createBuilder()", () => {
  test("has .reverts() only where its engine gives a revertError", () => {
    const mocks = createHandlers<object, unknown>();
    const builder = mocks.createBuilder(
      mocks.register(undefined, undefined),
      "getProof",
      (value) => value,
    );

    expect("reverts" in builder).toBe(false);
  });

  test("a removed mock throws before anything is prepared or checked", () => {
    const prepare = vi.fn((value: unknown) => value);
    const revertError = vi.fn(() => new MockRevertError("0x"));
    const { mocks, builder } = setup({ prepare, revertError });
    mocks.removeAll();

    const removed = "This mock was removed by restore() or reset()";
    expectThrows(MockSetupError, removed, () => {
      builder.returns(1n);
    });
    expectThrows(MockSetupError, removed, () => {
      builder.reverts!();
    });
    expectThrows(MockSetupError, removed, () => {
      // @ts-expect-error -- not a fault
      builder.fails("bogus");
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(revertError).not.toHaveBeenCalled();
  });
});
