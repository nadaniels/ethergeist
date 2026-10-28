import { createPublicClient, parseAbi, zeroAddress } from "viem";
import { mainnet } from "viem/chains";
import { describe, expect, test } from "vite-plus/test";
import { createMockRpc, zeroResult } from "../src/index.js";

const FEED = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
const STORE = "0x0000000000000000000000000000000000005703";
const alice = "0x00000000000000000000000000000000000A11cE";
const zeroBytes32 = `0x${"00".repeat(32)}`;

// Chainlink's AggregatorV3Interface.
const feedAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function getRoundData(uint80 roundId) view returns (uint80, int256, uint256, uint256, uint80)",
]);

// A generic fixture covering every zero-value case.
const storeAbi = parseAbi([
  "struct Meta { bytes32 tag; bool active; string label; uint256[3] limits; bytes data; }",
  "struct Position { address owner; uint256 amount; Meta meta; }",
  "function position(uint256 id) view returns (Position)",
  "function positions() view returns (Position[])",
  "function summary() view returns (uint256 count, Position latest)",
]);

const emptyPosition = {
  owner: zeroAddress,
  amount: 0n,
  meta: {
    tag: zeroBytes32,
    active: false,
    label: "",
    limits: [0n, 0n, 0n],
    data: "0x",
  },
};

function setup() {
  const mock = createMockRpc();
  const client = createPublicClient({ chain: mainnet, transport: mock.transport() });
  return { mock, client };
}

describe("named outputs", () => {
  test("an object keyed by output name encodes as the tuple", async () => {
    const { mock, client } = setup();
    const feed = mock.contract({ abi: feedAbi, address: FEED });
    feed.read.latestRoundData().returns({
      roundId: 1n,
      answer: 2000_00000000n,
      startedAt: 1700000000n,
      updatedAt: 1700000060n,
      answeredInRound: 1n,
    });

    const result = await client.readContract({
      abi: feedAbi,
      address: FEED,
      functionName: "latestRoundData",
    });
    expect(result).toEqual([1n, 2000_00000000n, 1700000000n, 1700000060n, 1n]);
  });

  test("key order doesn't matter; ABI order does", async () => {
    const { mock, client } = setup();
    const feed = mock.contract({ abi: feedAbi, address: FEED });
    feed.read.latestRoundData().returns({
      updatedAt: 4n,
      answeredInRound: 5n,
      roundId: 1n,
      startedAt: 3n,
      answer: 2n,
    });

    expect(
      await client.readContract({ abi: feedAbi, address: FEED, functionName: "latestRoundData" }),
    ).toEqual([1n, 2n, 3n, 4n, 5n]);
  });

  test("omitted outputs are zero", async () => {
    const { mock, client } = setup();
    const feed = mock.contract({ abi: feedAbi, address: FEED });
    feed.read.latestRoundData().returns({ answer: 2000_00000000n });

    expect(
      await client.readContract({ abi: feedAbi, address: FEED, functionName: "latestRoundData" }),
    ).toEqual([0n, 2000_00000000n, 0n, 0n, 0n]);
  });

  test("resolvers and defaults can return the named form", async () => {
    const { mock, client } = setup();
    let answer = 100n;
    mock.contract({
      abi: feedAbi,
      address: FEED,
      defaults: { read: { latestRoundData: () => ({ answer }) } },
    });

    const latest = () =>
      client.readContract({ abi: feedAbi, address: FEED, functionName: "latestRoundData" });
    expect((await latest())[1]).toBe(100n);
    answer = 200n;
    expect((await latest())[1]).toBe(200n);
  });

  test("the tuple form still works, including for unnamed outputs", async () => {
    const { mock, client } = setup();
    const feed = mock.contract({ abi: feedAbi, address: FEED });
    feed.read.getRoundData().returns([7n, 1n, 2n, 3n, 7n]);

    expect(
      await client.readContract({
        abi: feedAbi,
        address: FEED,
        functionName: "getRoundData",
        args: [7n],
      }),
    ).toEqual([7n, 1n, 2n, 3n, 7n]);
  });
});

describe("partial structs", () => {
  test("omitted fields are zero values, recursively", async () => {
    const { mock, client } = setup();
    const store = mock.contract({ abi: storeAbi, address: STORE });
    store.read.position().returns({ amount: 5n, meta: { active: true } });

    expect(
      await client.readContract({
        abi: storeAbi,
        address: STORE,
        functionName: "position",
        args: [1n],
      }),
    ).toEqual({ ...emptyPosition, amount: 5n, meta: { ...emptyPosition.meta, active: true } });
  });

  test("an empty object is an all-zero struct", async () => {
    const { mock, client } = setup();
    const store = mock.contract({ abi: storeAbi, address: STORE });
    store.read.position().returns({});

    expect(
      await client.readContract({
        abi: storeAbi,
        address: STORE,
        functionName: "position",
        args: [1n],
      }),
    ).toEqual(emptyPosition);
  });

  test("struct elements of arrays may be partial", async () => {
    const { mock, client } = setup();
    const store = mock.contract({ abi: storeAbi, address: STORE });
    store.read.positions().returns([{ owner: alice }, { amount: 2n }]);

    expect(
      await client.readContract({ abi: storeAbi, address: STORE, functionName: "positions" }),
    ).toEqual([
      { ...emptyPosition, owner: alice },
      { ...emptyPosition, amount: 2n },
    ]);
  });

  test("structs inside named outputs may be partial", async () => {
    const { mock, client } = setup();
    const store = mock.contract({ abi: storeAbi, address: STORE });
    store.read.summary().returns({ count: 3n, latest: { owner: alice } });

    expect(
      await client.readContract({ abi: storeAbi, address: STORE, functionName: "summary" }),
    ).toEqual([3n, { ...emptyPosition, owner: alice }]);
  });
});

describe("zeroResult", () => {
  const wethAbi = parseAbi(["function deposit() payable"]);

  test("every output is zero", async () => {
    const { mock, client } = setup();
    mock.contract({ abi: feedAbi, address: FEED }).read.latestRoundData().returns(zeroResult);

    expect(
      await client.readContract({ abi: feedAbi, address: FEED, functionName: "latestRoundData" }),
    ).toEqual([0n, 0n, 0n, 0n, 0n]);
  });

  test("structs and arrays are zero and empty", async () => {
    const { mock, client } = setup();
    const store = mock.contract({ abi: storeAbi, address: STORE });
    store.read.position().returns(zeroResult);
    store.read.positions().returns(zeroResult);

    expect(
      await client.readContract({
        abi: storeAbi,
        address: STORE,
        functionName: "position",
        args: [1n],
      }),
    ).toEqual(emptyPosition);
    expect(
      await client.readContract({ abi: storeAbi, address: STORE, functionName: "positions" }),
    ).toEqual([]);
  });

  test("a function without outputs just succeeds", async () => {
    const { mock, client } = setup();
    mock.contract({ abi: wethAbi, address: STORE }).simulate.deposit().returns(zeroResult);

    const { result } = await client.simulateContract({
      abi: wethAbi,
      address: STORE,
      functionName: "deposit",
      value: 1n,
    });
    expect(result).toBeUndefined();
  });

  test(".returns() with no argument is the same", async () => {
    const { mock, client } = setup();
    mock.contract({ abi: feedAbi, address: FEED }).read.latestRoundData().returns();
    mock.contract({ abi: wethAbi, address: STORE }).simulate.deposit().returns();

    expect(
      await client.readContract({ abi: feedAbi, address: FEED, functionName: "latestRoundData" }),
    ).toEqual([0n, 0n, 0n, 0n, 0n]);
    await client.simulateContract({ abi: wethAbi, address: STORE, functionName: "deposit" });
  });

  test("works in defaults and from resolvers", async () => {
    const { mock, client } = setup();
    let live = false;
    const feed = mock.contract({
      abi: feedAbi,
      address: FEED,
      defaults: { read: { latestRoundData: zeroResult } },
    });
    const latest = () =>
      client.readContract({ abi: feedAbi, address: FEED, functionName: "latestRoundData" });
    expect(await latest()).toEqual([0n, 0n, 0n, 0n, 0n]);

    feed.read.latestRoundData().returns(() => (live ? { answer: 5n } : zeroResult));
    expect((await latest())[1]).toBe(0n);
    live = true;
    expect((await latest())[1]).toBe(5n);
  });
});
