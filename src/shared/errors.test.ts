import { BaseError, InvalidAddressError, setErrorConfig } from "viem";
import { afterEach, describe, expect, test } from "vite-plus/test";

import {
  MockCheckError,
  MockError,
  MockInternalError,
  MockNotFoundError,
  MockResolverError,
  MockSetupError,
} from "./errors.js";

describe("MockError", () => {
  test.each([
    [new MockNotFoundError("x"), "MockNotFoundError", -32099],
    [new MockResolverError("f", new Error("x")), "MockResolverError", -32098],
    [new MockSetupError("x"), "MockSetupError", -32097],
    [new MockCheckError("x"), "MockCheckError", -32096],
    [new MockInternalError(new Error("x")), "MockInternalError", -32095],
  ])("%s has its name and a stable code", (error, name, code) => {
    expect(error).toBeInstanceOf(MockError);
    expect(error).toBeInstanceOf(BaseError);
    expect(error.name).toBe(name);
    expect(error.code).toBe(code);
  });

  test("its message is the short message, then the hint lines, with no version line", () => {
    expect(new MockSetupError("Bad value.").message).toBe("Bad value.");
    expect(new MockSetupError("Bad value.", { metaMessages: ["Do X.", "Or Y."] }).message).toBe(
      "Bad value.\n\nDo X.\nOr Y.",
    );
  });

  test("its stack starts with its name and message", () => {
    const error = new MockSetupError("Bad value.", { metaMessages: ["Do X."] });

    expect(error.stack).toMatch(/^MockSetupError: Bad value\.\n\nDo X\.\n {4}at /u);
  });

  describe("with an app's error config", () => {
    afterEach(() => {
      // viem's defaults.
      setErrorConfig({
        getDocsUrl: ({ docsBaseUrl, docsPath = "", docsSlug }) =>
          docsPath
            ? `${docsBaseUrl ?? "https://viem.sh"}${docsPath}${docsSlug ? `#${docsSlug}` : ""}`
            : undefined,
        version: `viem@${new BaseError("").version.replace(/^viem@/u, "")}`,
      });
    });

    test("its message doesn't change", () => {
      setErrorConfig({ getDocsUrl: () => "https://example.com/docs", version: "app@1.0.0" });

      expect(new MockSetupError("Bad value.").message).toBe("Bad value.");
    });
  });

  test("its details and docs path stay empty, though a cause has them", () => {
    // viem matches `details` against node errors, and prefers a cause's docs path to its own.
    const cause = new BaseError("Nonce too low.", {
      details: "nonce too low",
      docsPath: "/docs/glossary/errors",
    });
    const error = new MockResolverError("balanceOf", cause);

    expect(error.details).toBe("");
    expect(error.docsPath).toBeUndefined();
    expect(error.cause).toBe(cause);
  });
});

describe("MockResolverError", () => {
  test("names what threw, with the cause's message", () => {
    expect(new MockResolverError("balanceOf", new Error("boom")).message).toBe(
      'Mock resolver for "balanceOf" threw: boom',
    );
    expect(new MockResolverError("balanceOf", "boom", { matcher: "where(isLarge)" }).message).toBe(
      'Matcher where(isLarge) for "balanceOf" threw: boom',
    );
  });

  test("a viem cause gives its short message and hints, without viem's version line", () => {
    const error = new MockResolverError("balanceOf", new InvalidAddressError({ address: "0xbad" }));

    expect(error.message).toBe(
      'Mock resolver for "balanceOf" threw: Address "0xbad" is invalid.\n\n' +
        "- Address must be a hex value of 20 bytes (40 hex characters).\n" +
        "- Address must match its checksum counterpart.",
    );
  });

  test("a mock error's hints carry over, once", () => {
    const cause = new MockSetupError("This mock was removed.", { metaMessages: ["Register one."] });

    expect(new MockResolverError("balanceOf", cause).message).toBe(
      'Mock resolver for "balanceOf" threw: This mock was removed.\n\nRegister one.',
    );
  });
});

describe("MockInternalError", () => {
  test("wraps what was thrown, asking for a report", () => {
    const cause = new TypeError("x is undefined");
    const error = new MockInternalError(cause);

    expect(error.shortMessage).toBe("The mock failed unexpectedly: x is undefined");
    expect(error.metaMessages).toEqual([
      "This is a bug in ethergeist; please report it at https://github.com/nadaniels/ethergeist/issues, with the request.",
    ]);
    expect(error.cause).toBe(cause);
  });
});
