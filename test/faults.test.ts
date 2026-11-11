import {
  HttpRequestError,
  InsufficientFundsError,
  InvalidInputRpcError,
  LimitExceededRpcError,
  NonceTooLowError,
  RpcRequestError,
  TimeoutError,
  createPublicClient,
  erc20Abi,
  getAddress,
} from "viem";
import { mainnet } from "viem/chains";
import { describe, expect, test } from "vite-plus/test";

import {
  MockCheckError,
  MockNotFoundError,
  MockResolverError,
  MockSetupError,
  createMockRpc,
  testAddress,
} from "../src/index.js";
import { expectCause, expectThrows, failureOf, findCause, rejectionOf } from "./utils.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const alice = testAddress("alice");
const bob = testAddress("bob");

function setup({ retryCount }: { retryCount?: number } = {}) {
  const mock = createMockRpc();
  const client = createPublicClient({
    chain: mainnet,
    transport: mock.transport(retryCount === undefined ? {} : { retryCount }),
    cacheTime: 0,
  });
  mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);
  const decimals = () =>
    client.readContract({ abi: erc20Abi, address: USDC, functionName: "decimals" });
  return { mock, client, decimals };
}

describe("HTTP status faults", () => {
  test("a persistent 503 fails after viem's retries", async () => {
    const { mock, decimals } = setup();
    const outage = mock.failRequests({ status: 503 });

    const error = expectCause(await rejectionOf(decimals()), HttpRequestError);
    expect(error.status).toBe(503);
    expect(error.url).toBe("mock://ethergeist");
    // One attempt plus viem's 3 retries, without waiting between them.
    expect(mock.history).toHaveLength(4);
    expect(outage.count).toBe(4);
  });

  test("a fault that runs out lets viem's retries recover", async () => {
    const { mock, decimals } = setup();
    mock.failRequests({ status: 429 }, { times: 2 });

    expect(await decimals()).toBe(6);
    expect(mock.history).toHaveLength(3);
  });

  test("statuses viem doesn't retry fail on the first attempt", async () => {
    const { mock, decimals } = setup();
    mock.failRequests({ status: 400 });

    expect(expectCause(await rejectionOf(decimals()), HttpRequestError).status).toBe(400);
    expect(mock.history).toHaveLength(1);
  });

  test("retryAfter sets the Retry-After header", async () => {
    const { mock, decimals } = setup({ retryCount: 0 });
    mock.failRequests({ status: 429, retryAfter: 0 });

    const error = expectCause(await rejectionOf(decimals()), HttpRequestError);
    expect(error.headers?.get("Retry-After")).toBe("0");
  });
});

describe("JSON-RPC error faults", () => {
  test("a known code maps to viem's error class and retries like it", async () => {
    const { mock, decimals } = setup();
    mock.failRequests({ code: LimitExceededRpcError.code, message: "limit exceeded" });

    const error = expectCause(await rejectionOf(decimals()), LimitExceededRpcError);
    expect(error.code).toBe(LimitExceededRpcError.code);
    expect(mock.history).toHaveLength(4);
    expect(mock.formatHistory()).toContain(
      `✗ fault: RPC error ${LimitExceededRpcError.code} (limit exceeded) (failRequests)`,
    );
  });

  test("a known code viem doesn't retry fails on the first attempt", async () => {
    const { mock, decimals } = setup();
    mock.failRequests({ code: InvalidInputRpcError.code, message: "header not found" });

    expectCause(await rejectionOf(decimals()), InvalidInputRpcError);
    expect(mock.history).toHaveLength(1);
  });

  test("a code viem doesn't map surfaces as RpcRequestError with the message", async () => {
    const { mock, decimals } = setup();
    mock.failRequests({ code: -32010, message: "provider-specific failure" });

    const error = expectCause(await rejectionOf(decimals()), RpcRequestError);
    expect(error.code).toBe(-32010);
    expect(error.details).toBe("provider-specific failure");
    expect(findCause(error, InvalidInputRpcError)).toBeUndefined();
    expect(mock.history).toHaveLength(1);
  });
});

describe("timeouts and network failures", () => {
  test('"timeout" throws TimeoutError and is retried', async () => {
    const { mock, decimals } = setup();
    mock.failRequests("timeout");

    expectCause(await rejectionOf(decimals()), TimeoutError);
    expect(mock.history).toHaveLength(4);
  });

  test('"network" throws HttpRequestError without a status', async () => {
    const { mock, decimals } = setup({ retryCount: 0 });
    mock.failRequests("network");

    const error = expectCause(await rejectionOf(decimals()), HttpRequestError);
    expect(error.status).toBeUndefined();
  });
});

describe("targeting", () => {
  test("method limits which requests fail", async () => {
    const { mock, client, decimals } = setup();
    mock.failRequests({ status: 503 }, { method: "eth_blockNumber" });

    expect(await decimals()).toBe(6);
    expectCause(await rejectionOf(client.getBlockNumber()), HttpRequestError);
  });

  test("method takes a list", async () => {
    const { mock, client, decimals } = setup({ retryCount: 0 });
    mock.failRequests({ status: 503 }, { method: ["eth_call", "eth_blockNumber"] });

    expectCause(await rejectionOf(decimals()), HttpRequestError);
    expectCause(await rejectionOf(client.getBlockNumber()), HttpRequestError);
    expect(await client.getChainId()).toBe(1);
  });

  test("the most recent matching fault wins", async () => {
    const { mock, decimals } = setup({ retryCount: 0 });
    mock.failRequests({ status: 503 });
    mock.failRequests({ status: 429 }, { times: 1 });

    expect(expectCause(await rejectionOf(decimals()), HttpRequestError).status).toBe(429);
    expect(expectCause(await rejectionOf(decimals()), HttpRequestError).status).toBe(503);
  });

  test("a multicall fails as one request", async () => {
    const { mock, client } = setup({ retryCount: 0 });
    mock.failRequests({ status: 503 });

    const results = await client.multicall({
      contracts: [
        { abi: erc20Abi, address: USDC, functionName: "decimals" },
        { abi: erc20Abi, address: USDC, functionName: "symbol" },
      ],
    });
    for (const result of results) expectCause(failureOf(result), HttpRequestError);
    expect(mock.history).toHaveLength(1);
  });
});

describe("lifecycle", () => {
  test("clear() stops the fault; count says how many requests it failed", async () => {
    const { mock, decimals } = setup({ retryCount: 0 });
    const outage = mock.failRequests({ status: 503 });

    await rejectionOf(decimals());
    outage.clear();
    expect(await decimals()).toBe(6);
    expect(outage.count).toBe(1);
  });

  test("faulted requests are in requests, but not calls or unhandled", async () => {
    const { mock, decimals } = setup({ retryCount: 0 });
    mock.failRequests({ status: 503 });

    await rejectionOf(decimals());
    expect(mock.history).toHaveLength(1);
    expect(mock.calls).toEqual([]);
    expect(() => {
      mock.assertNoUnhandled();
    }).not.toThrow();
  });

  test("reset() clears faults; clearCalls() doesn't", async () => {
    const { mock, decimals } = setup({ retryCount: 0 });
    mock.failRequests({ status: 503 });

    mock.clearCalls();
    expect(findCause(await rejectionOf(decimals()), HttpRequestError)).toBeDefined();

    mock.reset();
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);
    expect(await decimals()).toBe(6);
  });

  test("a restore puts back a kept fault's count and the requests it has left", async () => {
    const { mock, decimals } = setup({ retryCount: 0 });
    const outage = mock.failRequests({ status: 503 }, { times: 3 });
    await rejectionOf(decimals());
    const baseline = mock.checkpoint();
    await rejectionOf(decimals());
    await rejectionOf(decimals());
    expect(await decimals()).toBe(6);

    baseline.restore();
    expect(outage.count).toBe(1);
    await rejectionOf(decimals());
    await rejectionOf(decimals());
    expect(await decimals()).toBe(6);
    expect(outage.count).toBe(3);
  });

  test("a removed fault's handle: clear() does nothing and count keeps its value", async () => {
    const { mock, decimals } = setup({ retryCount: 0 });
    const baseline = mock.checkpoint();
    const outage = mock.failRequests({ status: 503 });
    await rejectionOf(decimals());

    baseline.restore();
    expect(await decimals()).toBe(6);
    expect(() => {
      outage.clear();
    }).not.toThrow();
    expect(outage.count).toBe(1);
  });

  test("times must be a positive integer", () => {
    const { mock } = setup();
    expectThrows(MockSetupError, "failRequests()'s times must be a positive integer; got 0.", () =>
      mock.failRequests("timeout", { times: 0 }),
    );
    expectThrows(
      MockSetupError,
      "failRequests()'s times must be a positive integer; got 1.5.",
      () => mock.failRequests("timeout", { times: 1.5 }),
    );
  });

  test("method must be a method name or a list of them, not a pattern", () => {
    const { mock } = setup();
    const message =
      "failRequests()'s method must be a method name or a list of them; got /^eth_/u.";
    expectThrows(MockSetupError, message, () =>
      // @ts-expect-error -- a pattern, not a name
      mock.failRequests("timeout", { method: /^eth_/u }),
    );
    expectThrows(MockSetupError, "failRequests()'s method must be a method name or a list", () =>
      // @ts-expect-error -- a pattern, not a name
      mock.failRequests("timeout", { method: ["eth_call", /^eth_/u] }),
    );
  });
});

/** Like `setup()`, with nothing registered. */
function setupTokens({ retryCount }: { retryCount?: number | undefined } = {}) {
  const mock = createMockRpc();
  const client = createPublicClient({
    chain: mainnet,
    transport: mock.transport(retryCount === undefined ? {} : { retryCount }),
  });
  const usdc = mock.contract({ abi: erc20Abi, address: USDC });
  const dai = mock.contract({ abi: erc20Abi, address: DAI });
  const read = (address: `0x${string}`, functionName: "decimals" | "symbol") =>
    client.readContract({ abi: erc20Abi, address, functionName });
  const balanceOf = (owner: `0x${string}`) =>
    client.readContract({ abi: erc20Abi, address: USDC, functionName: "balanceOf", args: [owner] });
  return { mock, client, usdc, dai, read, balanceOf };
}

describe(".fails()", () => {
  test("fails one function while the rest of the chain answers", async () => {
    const { usdc, dai, read } = setupTokens();
    usdc.read.decimals().fails({ status: 503 });
    usdc.read.symbol().returns("USDC");
    dai.read.decimals().returns(18);

    expect(expectCause(await rejectionOf(read(USDC, "decimals")), HttpRequestError).status).toBe(
      503,
    );
    expect(await read(USDC, "symbol")).toBe("USDC");
    expect(await read(DAI, "decimals")).toBe(18);
  });

  test("targets args like any other mock", async () => {
    const { usdc, balanceOf } = setupTokens();
    usdc.read.balanceOf([alice]).fails("timeout");
    usdc.read.balanceOf().returns(5n);

    expectCause(await rejectionOf(balanceOf(alice)), TimeoutError);
    expect(await balanceOf(bob)).toBe(5n);
  });

  test.each([
    { retryCount: undefined, attempts: 4 },
    { retryCount: 1, attempts: 2 },
  ])("every retry fails (retryCount $retryCount)", async ({ retryCount, attempts }) => {
    const { mock, usdc, read } = setupTokens({ retryCount });
    usdc.read.decimals().fails({ status: 503 });

    await rejectionOf(read(USDC, "decimals"));
    expect(mock.history).toHaveLength(attempts);
  });

  test("a JSON-RPC code maps to viem's error class", async () => {
    const { usdc, read } = setupTokens();
    usdc.read.decimals().fails({ code: LimitExceededRpcError.code });

    expectCause(await rejectionOf(read(USDC, "decimals")), LimitExceededRpcError);
  });

  test("works for simulate", async () => {
    const { client, usdc } = setupTokens({ retryCount: 0 });
    usdc.simulate.transfer().fails("network");

    const error = await rejectionOf(
      client.simulateContract({
        abi: erc20Abi,
        address: USDC,
        functionName: "transfer",
        args: [bob, 1n],
        account: alice,
      }),
    );
    expect(expectCause(error, HttpRequestError).status).toBeUndefined();
  });

  test("fails the whole multicall, even with allowFailure", async () => {
    const { mock, client, usdc } = setupTokens({ retryCount: 0 });
    usdc.read.decimals().returns(6);
    usdc.read.symbol().fails({ status: 503 });

    const results = await client.multicall({
      contracts: [
        { abi: erc20Abi, address: USDC, functionName: "decimals" },
        { abi: erc20Abi, address: USDC, functionName: "symbol" },
      ],
    });
    for (const result of results) expectCause(failureOf(result), HttpRequestError);
    expect(mock.history).toHaveLength(1);
  });

  test("a later returns() replaces it", async () => {
    const { usdc, read } = setupTokens();
    usdc.read.decimals().fails({ status: 503 });
    usdc.read.decimals().returns(6);

    expect(await read(USDC, "decimals")).toBe(6);
  });

  test("is logged and used, but not unhandled", async () => {
    const { mock, usdc, balanceOf } = setupTokens({ retryCount: 0 });
    usdc.read.balanceOf([alice]).fails({ status: 503 });

    await rejectionOf(balanceOf(alice));
    expect(usdc.read.balanceOf.calls).toMatchObject([{ args: [getAddress(alice)] }]);
    expect(() => {
      mock.assertNoUnhandled();
    }).not.toThrow();
    expect(() => {
      mock.assertAllUsed();
    }).not.toThrow();
  });

  test("failRequests() still comes first", async () => {
    const { mock, usdc, read } = setupTokens({ retryCount: 0 });
    usdc.read.decimals().fails({ status: 503 });
    mock.failRequests({ status: 429 });

    expect(expectCause(await rejectionOf(read(USDC, "decimals")), HttpRequestError).status).toBe(
      429,
    );
  });

  test("fail() in a resolver can fail some calls and answer others", async () => {
    const { mock, usdc, read } = setupTokens();
    let attempts = 0;
    usdc.read.decimals().returns(({ fail }) => (++attempts === 1 ? fail({ status: 503 }) : 6));

    expect(await read(USDC, "decimals")).toBe(6);
    expect(mock.history).toHaveLength(2);
  });
});

describe(".refuses()", () => {
  test("is a refusal on the history entry and the contract's record, and in history", async () => {
    const { mock, client, usdc } = setupTokens();
    usdc.simulate.transfer().refuses("insufficientFunds");
    usdc.estimateGas.transfer().refuses("insufficientFunds");
    const call = { abi: erc20Abi, address: USDC, account: alice, args: [bob, 1n] } as const;

    expectCause(
      await rejectionOf(client.simulateContract({ ...call, functionName: "transfer" })),
      InsufficientFundsError,
    );
    expectCause(
      await rejectionOf(client.estimateContractGas({ ...call, functionName: "transfer" })),
      InsufficientFundsError,
    );

    const refusal = { type: "refusal", name: "insufficientFunds" };
    expect(mock.history).toMatchObject([
      { outcome: refusal, call: { outcome: refusal } },
      { outcome: refusal, contract: { outcome: refusal } },
    ]);
    expect(mock.formatHistory().match(/✗ refused: insufficientFunds$/gmu)).toHaveLength(2);
    expect(mock.unhandled).toEqual([]);
  });

  // viem retries neither -32000 nor -32003, so the same request again is the
  // app's.
  test("isn't retried: the same request after a used-up .once() is no retry", async () => {
    const { mock, client, usdc } = setupTokens();
    usdc.estimateGas.transfer().once().refuses("insufficientFunds");
    const estimate = () =>
      client.estimateContractGas({
        abi: erc20Abi,
        address: USDC,
        functionName: "transfer",
        args: [bob, 1n],
        account: alice,
      });

    expectCause(await rejectionOf(estimate()), InsufficientFundsError);
    const missed = expectCause(await rejectionOf(estimate()), MockNotFoundError);

    expect(mock.history).toHaveLength(2);
    expect(mock.formatHistory()).not.toContain("(retry)");
    expect(missed.metaMessages?.join("\n")).not.toContain("viem retrying");
  });

  test("an async resolver's refuse() refuses, after its await", async () => {
    const { mock } = setupTokens();
    mock.actions.sendTransaction().returns(async ({ refuse }) => {
      await Promise.resolve();
      return refuse("nonceTooLow");
    });

    const error = await rejectionOf(
      mock.request({ method: "eth_sendTransaction", params: [{ from: alice, to: bob }] }),
    );

    expect(expectCause(error, RpcRequestError)).toMatchObject({
      code: -32000,
      details: "nonce too low",
    });
    expect(mock.history[0]!.outcome).toEqual({ type: "refusal", name: "nonceTooLow" });
    expect(mock.transactions).toEqual([]);
  });

  test("a default's refuse() refuses, behind a .once() refusal", async () => {
    const { mock, client } = setupTokens();
    const token = mock.contract({
      abi: erc20Abi,
      address: testAddress("token"),
      defaults: { estimateGas: { transfer: ({ refuse }) => refuse("feeCapTooLow") } },
    });
    token.estimateGas.transfer().once().refuses("insufficientFunds");
    const estimate = () =>
      client.estimateContractGas({
        abi: erc20Abi,
        address: token.address,
        functionName: "transfer",
        args: [bob, 1n],
        account: alice,
      });

    expectCause(await rejectionOf(estimate()), InsufficientFundsError);
    await rejectionOf(estimate());

    expect(mock.history.map((entry) => entry.outcome)).toEqual([
      { type: "refusal", name: "insufficientFunds" },
      { type: "refusal", name: "feeCapTooLow" },
    ]);
  });

  test("a later .returns() replaces it, and it replaces a fault", async () => {
    const { mock, client } = setupTokens();
    const fee = mock.actions.estimateGas({ to: bob });
    fee.fails({ status: 503 });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a name an estimate's types refuse
    fee.refuses("nonceTooLow" as never);
    const other = mock.actions.estimateGas({ to: alice });
    other.refuses("insufficientFunds");
    other.returns(21_000n);

    expectCause(
      await rejectionOf(client.estimateGas({ account: alice, to: bob })),
      NonceTooLowError,
    );
    expect(await client.estimateGas({ account: bob, to: alice })).toBe(21_000n);
  });
});

describe("a fault that isn't one", () => {
  const notFaults: unknown[] = [
    undefined,
    null,
    "nonce too low",
    ["nonceTooLow"],
    503,
    {},
    { status: "503" },
    { status: 503, retryAfter: "1" },
    { code: "-32005" },
    { code: -32005, message: 5 },
  ];

  test.each(notFaults)(".fails(%o) is refused at registration, on every builder", (fault) => {
    const { mock, usdc } = setupTokens();
    const builders = [
      () => mock.actions.getBalance(),
      () => mock.actions.estimateGas(),
      () => mock.actions.sendTransaction(),
      () => mock.method("eth_foo"),
      () => usdc.read.decimals(),
      () => usdc.simulate.transfer(),
      () => usdc.estimateGas.transfer(),
      () => usdc.write.transfer(),
    ];
    // oxlint-disable typescript/no-unsafe-type-assertion -- what a JavaScript caller can pass
    for (const builder of builders)
      expect(() => {
        builder().fails(fault as never);
      }).toThrow(MockSetupError);
    expect(() => mock.failRequests(fault as never)).toThrow(MockSetupError);
    // oxlint-enable typescript/no-unsafe-type-assertion
  });

  test("names what was given, and the kinds", () => {
    const { usdc } = setupTokens();
    expect(() => {
      // @ts-expect-error -- `fails()` takes a fault
      usdc.read.decimals().fails();
    }).toThrow(
      new MockSetupError("Expected a fault; got undefined.", {
        metaMessages: [
          "A fault is one of:",
          "- { status, retryAfter? }: an HTTP error response, e.g. { status: 503 };",
          "- { code, message?, data? }: a JSON-RPC error response;",
          '- "timeout" or "network".',
        ],
      }),
    );
  });

  test.each(["insufficientFunds", "nonceTooLow"])(
    'a refusal\'s name, "%s", is refused by .fails() on every builder, and by failRequests(), naming .refuses()',
    (name) => {
      const { mock, usdc } = setupTokens();
      const builders = [
        () => mock.actions.getBalance(),
        () => mock.actions.estimateGas(),
        () => mock.actions.sendTransaction(),
        () => mock.method("eth_foo"),
        () => usdc.read.decimals(),
        () => usdc.simulate.transfer(),
        () => usdc.estimateGas.transfer(),
        () => usdc.write.transfer(),
      ];
      // oxlint-disable typescript/no-unsafe-type-assertion -- what a cast or JavaScript can pass
      const registrations = [
        ...builders.map((builder) => () => {
          builder().fails(name as never);
        }),
        () => mock.failRequests(name as never),
      ];
      // oxlint-enable typescript/no-unsafe-type-assertion
      for (const register of registrations) {
        const error = expectThrows(MockSetupError, "Expected a fault", register);
        expect(error.shortMessage).toBe(`Expected a fault; got ${name}.`);
        expect(error.metaMessages).toEqual([
          `"${name}" is a node's refusal: use .refuses("${name}"), or refuse("${name}") in a resolver.`,
          "A node refuses only simulations, estimates and sends.",
        ]);
      }
    },
  );

  test("a refused .fails() leaves the mock without an answer", () => {
    const { mock } = setupTokens();
    const builder = mock.actions.estimateGas();
    expectThrows(MockSetupError, "Expected a fault", () => {
      // @ts-expect-error -- a refusal is `.refuses()`
      builder.fails("insufficientFunds");
    });

    expectThrows(MockCheckError, "estimateGas(*) without an answer", () => {
      mock.assertAllUsed();
    });
  });

  test("a resolver's fail() with one is a MockResolverError, and history still formats", async () => {
    const { mock, usdc, read } = setupTokens({ retryCount: 0 });
    // @ts-expect-error -- `fail()` takes a fault
    usdc.read.decimals().returns(({ fail }) => fail());

    const rejection = await rejectionOf(read(USDC, "decimals"));
    expect(mock.formatHistory()).toContain("✗ resolver threw: Expected a fault; got undefined.");
    expect(expectCause(rejection, MockResolverError).cause).toBeInstanceOf(MockSetupError);
  });

  test("a resolver's fail() with a refusal's name is a MockResolverError naming refuse()", async () => {
    const { mock, client } = setupTokens({ retryCount: 0 });
    // @ts-expect-error -- a refusal is `refuse()`
    mock.actions.estimateGas().returns(({ fail }) => fail("insufficientFunds"));

    const rejection = await rejectionOf(client.estimateGas({ account: alice, to: bob }));
    const cause = expectCause(rejection, MockResolverError).cause;
    expect(cause).toBeInstanceOf(MockSetupError);
    expect(cause).toMatchObject({
      shortMessage: "Expected a fault; got insufficientFunds.",
      metaMessages: [
        '"insufficientFunds" is a node\'s refusal: use .refuses("insufficientFunds"), or refuse("insufficientFunds") in a resolver.',
        "A node refuses only simulations, estimates and sends.",
      ],
    });
  });
});

describe("a refusal that isn't one", () => {
  const notRefusals: unknown[] = [
    undefined,
    null,
    "timeout",
    "network",
    { status: 503 },
    { code: -32000, message: "nonce too low" },
    "nonce too low",
    "NonceTooLow",
    ["nonceTooLow"],
  ];

  test.each(notRefusals)(
    ".refuses(%o) is refused at registration, on every builder whose types offer it",
    (refusal) => {
      const { mock, usdc } = setupTokens();
      const builders = [
        () => mock.actions.estimateGas(),
        () => mock.actions.sendTransaction(),
        () => usdc.simulate.transfer(),
        () => usdc.estimateGas.transfer(),
        () => usdc.write.transfer(),
      ];
      // oxlint-disable typescript/no-unsafe-type-assertion -- what a cast or JavaScript can pass
      for (const builder of builders)
        expect(() => {
          builder().refuses(refusal as never);
        }).toThrow(MockSetupError);
      // oxlint-enable typescript/no-unsafe-type-assertion
    },
  );

  test("names what was given, and the names", () => {
    const { usdc } = setupTokens();
    expect(() => {
      // @ts-expect-error -- `refuses()` takes a node's refusal by name
      usdc.write.transfer().refuses({ status: 503 });
    }).toThrow(
      new MockSetupError("Expected a node's refusal by name; got { status: 503 }.", {
        metaMessages: [
          'A node\'s refusal is one of: "insufficientFunds", "feeCapTooLow", "tipAboveFeeCap", ' +
            '"gasExceedsAllowance", "intrinsicGasTooLow", "nonceTooLow", "nonceTooHigh", ' +
            '"alreadyKnown".',
          "For a fault, use .fails(), or fail() in a resolver.",
        ],
      }),
    );
  });

  test("a .refuses() left without a value is refused too", () => {
    const { mock } = setupTokens();
    expectThrows(MockSetupError, "Expected a node's refusal by name; got undefined.", () => {
      // @ts-expect-error -- `refuses()` takes a node's refusal by name
      mock.actions.sendTransaction().refuses();
    });
  });

  test("a resolver's refuse() with a fault is a MockResolverError naming fail()", async () => {
    const { mock, client } = setupTokens({ retryCount: 0 });
    // @ts-expect-error -- a fault is `fail()`
    mock.actions.estimateGas().returns(({ refuse }) => refuse({ status: 503 }));

    const rejection = await rejectionOf(client.estimateGas({ account: alice, to: bob }));
    expect(mock.formatHistory()).toContain(
      "✗ resolver threw: Expected a node's refusal by name; got { status: 503 }.",
    );
    expect(expectCause(rejection, MockResolverError).cause).toBeInstanceOf(MockSetupError);
  });

  // The types allow a name only where a node can refuse with it; the check
  // lets any through.
  test.each([
    { name: "nonceTooLow", code: -32000 },
    { name: "intrinsicGasTooLow", code: -32000 },
  ])("$name where its types refuse it answers as a node's error", async ({ name, code }) => {
    const { mock, client } = setupTokens({ retryCount: 0 });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what a cast can pass
    mock.actions.estimateGas().refuses(name as never);

    const error = await rejectionOf(client.estimateGas({ account: alice, to: bob }));
    expect(expectCause(error, RpcRequestError).code).toBe(code);
    expect(mock.history[0]!.outcome).toEqual({ type: "refusal", name });
  });
});
