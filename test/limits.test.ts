import {
  type PublicClient,
  TransactionReceiptNotFoundError,
  createPublicClient,
  erc20Abi,
  fallback,
  getAddress,
  keccak256,
  toHex,
} from "viem";
import { describe, expect, test } from "vite-plus/test";
import { MockNotFoundError, createMockRpc, testAddress } from "../src/index.js";
import { expectCause, rejectionOf } from "./utils.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const alice = testAddress("alice");
const txHash = keccak256(toHex("tx"));

function setup() {
  const mock = createMockRpc();
  const client = mock.publicClient();
  const usdc = mock.contract({ abi: erc20Abi, address: USDC, name: "USDC" });
  const balanceOf = () =>
    client.readContract({ abi: erc20Abi, address: USDC, functionName: "balanceOf", args: [alice] });
  return { mock, client, usdc, balanceOf };
}

describe("once() and times()", () => {
  test("a limited mock answers its calls, then steps aside", async () => {
    const { usdc, balanceOf } = setup();
    usdc.read.balanceOf().returns(0n);
    usdc.read.balanceOf().times(2).returns(5n);

    expect(await balanceOf()).toBe(5n);
    expect(await balanceOf()).toBe(5n);
    expect(await balanceOf()).toBe(0n);
  });

  test("limited mocks go first, whichever is registered first", async () => {
    const { usdc, balanceOf } = setup();
    usdc.read.balanceOf().once().reverts("paused");
    usdc.read.balanceOf().returns(1n);

    await expect(balanceOf()).rejects.toThrow("paused");
    expect(await balanceOf()).toBe(1n);
  });

  test("limited mocks are used in the order registered", async () => {
    const { usdc, balanceOf } = setup();
    usdc.read.balanceOf().once().returns(1n);
    usdc.read.balanceOf().once().returns(2n);
    usdc.read.balanceOf().returns(3n);

    expect([await balanceOf(), await balanceOf(), await balanceOf()]).toEqual([1n, 2n, 3n]);
  });

  test("specificity still comes first", async () => {
    const { usdc, balanceOf } = setup();
    usdc.read.balanceOf([alice]).returns(1n);
    usdc.read.balanceOf().once().returns(2n);

    expect(await balanceOf()).toBe(1n);
  });

  test("once used up, with nothing else to answer, it's not mocked", async () => {
    const { usdc, balanceOf } = setup();
    usdc.read.balanceOf().once().returns(1n);
    usdc.read.balanceOf([USDC]).times(3).returns(2n);

    expect(await balanceOf()).toBe(1n);
    const error = expectCause(await rejectionOf(balanceOf()), MockNotFoundError);
    expect(error.details).toBe(
      ["Registered:", "  balanceOf(*) once, used up", `  balanceOf(${USDC}) 3 times`].join("\n"),
    );
  });

  test("retries use up answers: down once, then recovers", async () => {
    const { mock, usdc, balanceOf } = setup();
    usdc.read.balanceOf().returns(1n);
    usdc.read.balanceOf().once().fails({ status: 503 });

    expect(await balanceOf()).toBe(1n);
    expect(mock.requests.filter((r) => r.method === "eth_call")).toHaveLength(2);
  });

  test("a fault for more attempts than viem retries fails the call", async () => {
    const { usdc, balanceOf } = setup();
    usdc.read.balanceOf().returns(1n);
    // viem tries once and retries 3 times.
    usdc.read.balanceOf().times(3).fails({ status: 503 });
    expect(await balanceOf()).toBe(1n);

    usdc.read.balanceOf().times(4).fails({ status: 503 });
    await expect(balanceOf()).rejects.toThrow("HTTP request failed");
  });

  test("each multicall sub-call uses an answer", async () => {
    const { client, usdc } = setup();
    usdc.read.balanceOf().returns(2n);
    usdc.read.balanceOf().once().returns(1n);

    const call = {
      abi: erc20Abi,
      address: USDC,
      functionName: "balanceOf",
      args: [alice],
    } as const;
    expect(await client.multicall({ contracts: [call, call], allowFailure: false })).toEqual([
      1n,
      2n,
    ]);
  });

  test("actions and raw methods take limits", async () => {
    const { mock, client } = setup();
    mock.actions.getTransactionReceipt({ hash: txHash }).returns({});
    mock.actions.getTransactionReceipt({ hash: txHash }).once().returns(null);
    mock.method("eth_gasPrice").returns("0x2");
    mock.method("eth_gasPrice").once().returns("0x1");

    // Pending once, then mined.
    expectCause(
      await rejectionOf(client.getTransactionReceipt({ hash: txHash })),
      TransactionReceiptNotFoundError,
    );
    expect((await client.getTransactionReceipt({ hash: txHash })).status).toBe("success");
    expect([await client.getGasPrice(), await client.getGasPrice()]).toEqual([1n, 2n]);
  });

  test("takes a positive integer, once", () => {
    const { usdc } = setup();
    expect(() => usdc.read.balanceOf().times(0)).toThrow(
      "times() takes a positive integer; got 0.",
    );
    expect(() => usdc.read.balanceOf().times(1.5)).toThrow(RangeError);
    const builder = usdc.read.balanceOf();
    builder.once();
    expect(() => builder.times(2)).toThrow("This mock already has a limit");
  });

  test("a removed mock can't be limited", () => {
    const { mock, usdc } = setup();
    const builder = usdc.read.balanceOf();
    mock.reset();
    expect(() => builder.once()).toThrow("removed");
  });
});

/** `balanceOf(alice)` through any client. */
function read(client: PublicClient) {
  return client.readContract({
    abi: erc20Abi,
    address: USDC,
    functionName: "balanceOf",
    args: [alice],
  });
}

describe("retries past a limited fault", () => {
  test("the 'not mocked' error explains viem retried, with the transport's retryCount", async () => {
    const { balanceOf, usdc } = setup();
    usdc.read.balanceOf().once().fails("network");

    const error = expectCause(await rejectionOf(balanceOf()), MockNotFoundError);
    expect(error.details).toBe(
      [
        "Registered:",
        "  balanceOf(*) once, used up",
        "This is a retry after a mock's fault: viem retries a failed request (this " +
          "transport's `retryCount` is 3), and each attempt uses one of a `.once()`/`.times(n)` " +
          "mock's answers. Register a mock to answer after it, or use `.fails()` without a " +
          "limit to fail every attempt.",
      ].join("\n"),
    );
  });

  test("uses the transport's retryCount, or the default under a fallback transport", async () => {
    const { mock, usdc } = setup();
    const own = createPublicClient({
      chain: mock.chain,
      transport: mock.transport({ retryCount: 1 }),
    });
    const viaFallback = createPublicClient({
      chain: mock.chain,
      transport: fallback([mock.transport()], { retryCount: 2 }),
    });

    usdc.read.balanceOf().once().fails("network");
    expect(String(await rejectionOf(read(own)))).toContain("`retryCount` is 1");
    usdc.read.balanceOf().once().fails("network");
    // fallback() retries itself and gives its transports `retryCount: 0`.
    expect(String(await rejectionOf(read(viaFallback)))).toContain(
      "viem retries a failed request (`retryCount`, 3 by default)",
    );
  });

  test("works for actions", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance().once().fails("network");

    expect(String(await rejectionOf(client.getBalance({ address: alice })))).toContain(
      "This is a retry after a mock's fault",
    );
  });

  test("not for a request that isn't a retry", async () => {
    const { mock, client, usdc } = setup();
    usdc.read.balanceOf([alice]).once().fails("network");
    usdc.read.balanceOf([alice]).returns(1n);
    expect(await read(client)).toBe(1n);

    // Different args: a new request, not a retry.
    const error = expectCause(
      await rejectionOf(
        client.readContract({
          abi: erc20Abi,
          address: USDC,
          functionName: "balanceOf",
          args: [USDC],
        }),
      ),
      MockNotFoundError,
    );
    expect(error.details).not.toContain("retry");
    expect(mock.unhandled).toHaveLength(1);
  });

  test("not after a failRequests() fault", async () => {
    const { mock, client } = setup();
    mock.failRequests("network", { times: 1 });

    const error = expectCause(await rejectionOf(read(client)), MockNotFoundError);
    expect(error.details).not.toContain("retry");
  });
});

describe("counts and lifecycle", () => {
  test("clearCalls() keeps counts; restore() refills them", async () => {
    const { mock, usdc, balanceOf } = setup();
    usdc.read.balanceOf().returns(0n);
    usdc.read.balanceOf().once().returns(1n);
    const baseline = mock.checkpoint();

    expect(await balanceOf()).toBe(1n);
    mock.clearCalls();
    expect(await balanceOf()).toBe(0n);

    baseline.restore();
    expect(await balanceOf()).toBe(1n);
  });

  test("limits set since a checkpoint are undone by restore()", async () => {
    const { mock, usdc, balanceOf } = setup();
    const builder = usdc.read.balanceOf();
    builder.returns(1n);
    mock.actions.getBalance().returns(0n);
    const baseline = mock.checkpoint();

    builder.once();
    expect(await balanceOf()).toBe(1n);
    baseline.restore();
    expect([await balanceOf(), await balanceOf()]).toEqual([1n, 1n]);
  });

  test("answering at least once counts as used", async () => {
    const { mock, usdc, balanceOf } = setup();
    usdc.read.balanceOf().times(3).returns(1n);
    usdc.read.allowance().once().returns(0n);

    await balanceOf();
    let error: unknown;
    try {
      mock.assertAllUsed();
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("1 mock(s) never answered a call");
    expect(String(error)).toContain(`allowance(*) once on USDC (${USDC})`);
  });

  test("a used-up mock isn't reported after clearCalls()", async () => {
    const { mock, usdc, balanceOf } = setup();
    usdc.read.balanceOf().once().returns(1n);
    mock.actions.getBalance().once().returns(0n);

    await balanceOf();
    await mock.publicClient().getBalance({ address: alice });
    mock.clearCalls();
    expect(() => {
      mock.assertAllUsed();
    }).not.toThrow();
  });

  test("a partly used mock shows what's left", async () => {
    const { mock, usdc, balanceOf } = setup();
    usdc.read.balanceOf().times(3).returns(1n);
    await balanceOf();
    mock.clearCalls();

    expect(() => {
      mock.assertAllUsed();
    }).toThrow(`balanceOf(*) 3 times, 2 left on USDC (${getAddress(USDC)})`);
  });
});
