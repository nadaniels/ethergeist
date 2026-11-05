import {
  ContractFunctionRevertedError,
  createPublicClient,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  multicall3Abi,
  parseAbi,
} from "viem";
import { mainnet } from "viem/chains";
import { describe, expect, test } from "vite-plus/test";

import { MockNotFoundError, createMockRpc, testAddress } from "../src/index.js";
import { expectCause, failureOf, findCause, rejectionOf } from "./utils.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const FEED = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
const alice = testAddress("alice");

// Chainlink's AggregatorV3Interface, plus a custom error for revert cases.
const feedAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
  "error StalePrice(uint256 updatedAt)",
]);

function setup({ batch = false }: { batch?: boolean } = {}) {
  const mock = createMockRpc();
  const client = createPublicClient({
    chain: mainnet,
    transport: mock.transport(),
    ...(batch ? { batch: { multicall: true } } : {}),
  });
  const usdc = mock.contract({ abi: erc20Abi, address: USDC });
  const feed = mock.contract({ abi: feedAbi, address: FEED });
  usdc.read.decimals().returns(6);
  usdc.read.balanceOf([alice]).returns(500n);
  feed.read.decimals().returns(8);
  feed.read.latestRoundData().returns({ roundId: 1n, answer: 2000_00000000n });
  const ethCalls = () => mock.history.filter((r) => r.method === "eth_call");
  return { mock, client, usdc, feed, ethCalls };
}

describe("client.multicall", () => {
  test("answers every call in one aggregate3 request", async () => {
    const { client, ethCalls } = setup();

    const results = await client.multicall({
      contracts: [
        { abi: erc20Abi, address: USDC, functionName: "decimals" },
        { abi: erc20Abi, address: USDC, functionName: "balanceOf", args: [alice] },
        { abi: feedAbi, address: FEED, functionName: "latestRoundData" },
      ],
      allowFailure: false,
    });

    expect(results).toEqual([6, 500n, [1n, 2000_00000000n, 0n, 0n, 0n]]);
    expect(ethCalls()).toHaveLength(1);
  });

  test("contract.calls records order and batch across functions", async () => {
    const { client, feed } = setup();

    await client.multicall({
      contracts: [
        { abi: feedAbi, address: FEED, functionName: "latestRoundData" },
        { abi: feedAbi, address: FEED, functionName: "decimals" },
      ],
    });

    expect(feed.calls.map((c) => c.functionName)).toEqual(["latestRoundData", "decimals"]);
    const [first, second] = feed.calls;
    expect(first?.batch?.id).toBeDefined();
    expect(first?.batch?.id).toBe(second?.batch?.id);
    expect([first?.batch?.index, second?.batch?.index]).toEqual([0, 1]);
  });

  test("sub-calls come from the Multicall3 address; the batch keeps the sender", async () => {
    const { client, usdc } = setup();

    await client.multicall({
      contracts: [{ abi: erc20Abi, address: USDC, functionName: "decimals" }],
      account: alice,
    });

    const [call] = usdc.calls;
    expect(call?.from).toBe(getAddress(mainnet.contracts.multicall3.address));
    expect(call?.batch?.from).toBe(alice);
  });

  test("a revert fails only its own call when failure is allowed", async () => {
    const { client, feed } = setup();
    feed.read.latestRoundData().reverts({ errorName: "StalePrice", args: [100n] });

    const [round, decimals] = await client.multicall({
      contracts: [
        { abi: feedAbi, address: FEED, functionName: "latestRoundData" },
        { abi: feedAbi, address: FEED, functionName: "decimals" },
      ],
    });

    expect(decimals).toEqual({ status: "success", result: 8 });
    const revert = expectCause(failureOf(round), ContractFunctionRevertedError);
    expect(revert.data?.errorName).toBe("StalePrice");
  });

  test("a revert throws when failure is not allowed", async () => {
    const { client, feed } = setup();
    feed.read.latestRoundData().reverts("stale");

    const error = await rejectionOf(
      client.multicall({
        contracts: [
          { abi: feedAbi, address: FEED, functionName: "latestRoundData" },
          { abi: feedAbi, address: FEED, functionName: "decimals" },
        ],
        allowFailure: false,
      }),
    );
    const revert = expectCause(error, ContractFunctionRevertedError);
    expect(revert.reason).toBe("stale");
  });

  test("a missing mock surfaces as MockNotFoundError, not a revert", async () => {
    const { client } = setup();

    const [result] = await client.multicall({
      contracts: [{ abi: erc20Abi, address: USDC, functionName: "symbol" }],
    });

    // viem reports a failed aggregate3 request as a failure for each call in it.
    const error = failureOf(result);
    expectCause(error, MockNotFoundError);
    expect(findCause(error, ContractFunctionRevertedError)).toBeUndefined();
  });
});

describe("aggregate3 called directly", () => {
  test("a sub-call that may not fail reverts the whole call", async () => {
    const { client, feed } = setup();
    feed.read.decimals().reverts();

    const error = await rejectionOf(
      client.readContract({
        abi: multicall3Abi,
        address: mainnet.contracts.multicall3.address,
        functionName: "aggregate3",
        args: [[{ target: FEED, allowFailure: false, callData: "0x313ce567" }]],
      }),
    );
    const revert = expectCause(error, ContractFunctionRevertedError);
    expect(revert.reason).toBe("Multicall3: call failed");
  });
});

describe("other Multicall3 functions", () => {
  test("aren't answered: only aggregate3 is mocked", async () => {
    const { mock, client } = setup();
    const to = mainnet.contracts.multicall3.address;
    const timestamp = encodeFunctionData({
      abi: multicall3Abi,
      functionName: "getCurrentBlockTimestamp",
    });

    const errors = [
      await rejectionOf(client.call({ to, data: timestamp })),
      // Not a Multicall3 function at all.
      await rejectionOf(client.call({ to, data: "0x12345678" })),
    ];

    for (const error of errors)
      expect(expectCause(error, MockNotFoundError).shortMessage).toBe(
        `Unsupported Multicall3 call on ${getAddress(to)}; only aggregate3 is mocked.`,
      );
    expect(mock.unhandled).toHaveLength(2);
    expect(mock.history).toMatchObject([
      { type: "multicall", calls: [], outcome: { type: "unhandled" } },
      { type: "multicall", calls: [], outcome: { type: "unhandled" } },
    ]);
  });
});

const readAll = (client: ReturnType<typeof setup>["client"]) =>
  Promise.all([
    client.readContract({ abi: erc20Abi, address: USDC, functionName: "decimals" }),
    client.readContract({
      abi: erc20Abi,
      address: USDC,
      functionName: "balanceOf",
      args: [alice],
    }),
    client.readContract({ abi: feedAbi, address: FEED, functionName: "latestRoundData" }),
  ]);

/** The decoded revert from reading a reverting feed, with batching on or off. */
async function revertOf(batch: boolean) {
  const { client, feed } = setup({ batch });
  feed.read.latestRoundData().reverts({ errorName: "StalePrice", args: [100n] });
  const error = await rejectionOf(
    client.readContract({ abi: feedAbi, address: FEED, functionName: "latestRoundData" }),
  );
  const revert = expectCause(error, ContractFunctionRevertedError);
  return { errorName: revert.data?.errorName, args: revert.data?.args };
}

describe("batch.multicall", () => {
  test("concurrent reads go out as one aggregate3 request", async () => {
    const { client, ethCalls, usdc } = setup({ batch: true });

    await readAll(client);
    expect(ethCalls()).toHaveLength(1);
    expect(usdc.calls.every((c) => c.batch !== undefined)).toBe(true);
  });

  test("results are the same with batching on and off", async () => {
    const batched = setup({ batch: true });
    const unbatched = setup();

    expect(await readAll(batched.client)).toEqual(await readAll(unbatched.client));
    expect(batched.ethCalls()).toHaveLength(1);
    expect(unbatched.ethCalls()).toHaveLength(3);
  });

  test("reverts decode the same with batching on and off", async () => {
    expect(await revertOf(true)).toEqual(await revertOf(false));
    expect(await revertOf(true)).toEqual({ errorName: "StalePrice", args: [100n] });
  });
});

describe("configuration", () => {
  test("the chain's Multicall3 address is the one answered", async () => {
    const address = testAddress("custom-multicall");
    const chain = defineChain({
      ...mainnet,
      contracts: { multicall3: { address } },
    });
    const mock = createMockRpc({ chain });
    const client = createPublicClient({ chain, transport: mock.transport() });
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);

    const [decimals] = await client.multicall({
      contracts: [{ abi: erc20Abi, address: USDC, functionName: "decimals" }],
      allowFailure: false,
    });
    expect(decimals).toBe(6);
  });

  test("deployless multicall explains that it isn't supported", async () => {
    const { client } = setup();

    const [result] = await client.multicall({
      contracts: [{ abi: erc20Abi, address: USDC, functionName: "decimals" }],
      deployless: true,
    });
    expect(failureOf(result).message).toContain("Deployless");
  });
});
