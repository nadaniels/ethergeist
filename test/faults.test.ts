import {
  HttpRequestError,
  InvalidInputRpcError,
  LimitExceededRpcError,
  RpcRequestError,
  TimeoutError,
  createPublicClient,
  erc20Abi,
} from "viem";
import { mainnet } from "viem/chains";
import { describe, expect, test } from "vite-plus/test";
import { createMockRpc } from "../src/index.js";
import { expectCause, failureOf, findCause, rejectionOf } from "./utils.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

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
    // One attempt plus viem's 3 retries, without waiting between them.
    expect(mock.requests).toHaveLength(4);
    expect(outage.count).toBe(4);
  });

  test("a fault that runs out lets viem's retries recover", async () => {
    const { mock, decimals } = setup();
    mock.failRequests({ status: 429 }, { times: 2 });

    expect(await decimals()).toBe(6);
    expect(mock.requests).toHaveLength(3);
  });

  test("statuses viem doesn't retry fail on the first attempt", async () => {
    const { mock, decimals } = setup();
    mock.failRequests({ status: 400 });

    expect(expectCause(await rejectionOf(decimals()), HttpRequestError).status).toBe(400);
    expect(mock.requests).toHaveLength(1);
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
    expect(mock.requests).toHaveLength(4);
  });

  test("a known code viem doesn't retry fails on the first attempt", async () => {
    const { mock, decimals } = setup();
    mock.failRequests({ code: InvalidInputRpcError.code, message: "header not found" });

    expectCause(await rejectionOf(decimals()), InvalidInputRpcError);
    expect(mock.requests).toHaveLength(1);
  });

  test("a code viem doesn't map surfaces as RpcRequestError with the message", async () => {
    const { mock, decimals } = setup();
    mock.failRequests({ code: -32010, message: "provider-specific failure" });

    const error = expectCause(await rejectionOf(decimals()), RpcRequestError);
    expect(error.code).toBe(-32010);
    expect(error.details).toBe("provider-specific failure");
    expect(findCause(error, InvalidInputRpcError)).toBeUndefined();
    expect(mock.requests).toHaveLength(1);
  });
});

describe("timeouts and network failures", () => {
  test('"timeout" throws TimeoutError and is retried', async () => {
    const { mock, decimals } = setup();
    mock.failRequests("timeout");

    expectCause(await rejectionOf(decimals()), TimeoutError);
    expect(mock.requests).toHaveLength(4);
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
    expect(mock.requests).toHaveLength(1);
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
    expect(mock.requests).toHaveLength(1);
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

  test("times must be a positive integer", () => {
    const { mock } = setup();
    expect(() => mock.failRequests("timeout", { times: 0 })).toThrow("positive integer");
    expect(() => mock.failRequests("timeout", { times: 1.5 })).toThrow("positive integer");
  });
});
