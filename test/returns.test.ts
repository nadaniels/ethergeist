import { InvalidArrayError, createPublicClient, parseAbi, zeroAddress } from "viem";
import { mainnet } from "viem/chains";
import { describe, expect, test } from "vite-plus/test";

import { MockSetupError, createMockRpc, zeroResult, testAddress } from "../src/index.js";
import { expectThrows } from "./utils.js";

const FEED = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
const STORE = testAddress("store");
const alice = testAddress("alice");
const zeroBytes32 = `0x${"00".repeat(32)}`;

// Chainlink's AggregatorV3Interface.
const feedAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function getRoundData(uint80 roundId) view returns (uint80, int256, uint256, uint256, uint80)",
]);

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

  test("an answer of the wrong shape fails at registration, as viem's encoder refuses it", () => {
    const { mock } = setup();
    const feed = mock.contract({
      abi: [...feedAbi, ...parseAbi(["function quote() view returns (uint256 amount, uint256)"])],
      address: FEED,
    });

    expect(() => {
      // @ts-expect-error -- unnamed outputs take a tuple, not an object
      feed.read.getRoundData().returns({ roundId: 7n });
    }).toThrow(InvalidArrayError);
    expect(() => {
      // @ts-expect-error -- one unnamed output makes the answer a tuple
      feed.read.quote().returns({ amount: 1n });
    }).toThrow(InvalidArrayError);
    expect(() => {
      // @ts-expect-error -- several outputs take a tuple or an object, not one value
      feed.read.latestRoundData().returns(7n);
    }).toThrow(InvalidArrayError);
  });

  test("a value the encoder can't convert fails at registration as the mock's error", () => {
    const { mock } = setup();
    const feed = mock.contract({
      abi: parseAbi(["function total() view returns (uint256)"]),
      address: FEED,
    });

    const error = expectThrows(
      MockSetupError,
      `.returns() for "total" was given a value it can't encode: Cannot convert soon to a BigInt`,
      () => {
        // @ts-expect-error -- a uint256 takes a bigint
        feed.read.total().returns("soon");
      },
    );
    expect(error.cause).toBeInstanceOf(SyntaxError);
    expectThrows(
      MockSetupError,
      /^\.returns\(\) for "total" was given a value it can't encode: The number 1\.5 cannot be converted/u,
      () => {
        // @ts-expect-error -- a uint256 takes a bigint
        feed.read.total().returns(1.5);
      },
    );
    const throwsOnConversion = {
      get [Symbol.toPrimitive]() {
        // oxlint-disable-next-line eslint/no-throw-literal, typescript/only-throw-error -- a thrown non-Error, on purpose
        throw "nope";
      },
    };
    const thrown = expectThrows(
      MockSetupError,
      `"total" was given a value it can't encode: nope`,
      () => {
        // @ts-expect-error -- a uint256 takes a bigint
        feed.read.total().returns(throwsOnConversion);
      },
    );
    expect(thrown.cause).toEqual(new Error("nope"));
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

  test("a tuple with unnamed components is zero by position", async () => {
    const { mock, client } = setup();
    const abi = [
      {
        type: "function",
        name: "pair",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "tuple", components: [{ type: "uint256" }, { type: "address" }] }],
      },
    ] as const;
    const pair = mock.contract({ abi, address: STORE });
    const read = () => client.readContract({ abi, address: STORE, functionName: "pair" });
    pair.read.pair().returns();

    expect(await read()).toEqual([0n, zeroAddress]);
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

  test(".returns() on a single bool or address output answers false or the zero address", async () => {
    const { mock, client } = setup();
    const flagsAbi = parseAbi([
      "function paused() view returns (bool)",
      "function owner() view returns (address)",
    ]);
    const flags = mock.contract({ abi: flagsAbi, address: STORE });
    flags.read.paused().returns();
    flags.read.owner().returns();

    expect(
      await client.readContract({ abi: flagsAbi, address: STORE, functionName: "paused" }),
    ).toBe(false);
    expect(
      await client.readContract({ abi: flagsAbi, address: STORE, functionName: "owner" }),
    ).toBe(zeroAddress);
  });

  test("an untyped resolver that returns nothing answers zero values, not a send's outcome", async () => {
    const { mock, client } = setup();
    const flagsAbi = parseAbi([
      "function paused() view returns (bool)",
      "function pause() returns (bool)",
    ]);
    const flags = mock.contract({ abi: flagsAbi, address: STORE });
    // oxlint-disable typescript/no-unsafe-type-assertion -- what a JavaScript caller can pass
    flags.read.paused().returns((() => undefined) as never);
    flags.simulate.pause().returns((() => undefined) as never);
    // oxlint-enable typescript/no-unsafe-type-assertion

    expect(
      await client.readContract({ abi: flagsAbi, address: STORE, functionName: "paused" }),
    ).toBe(false);
    const { result } = await client.simulateContract({
      abi: flagsAbi,
      address: STORE,
      functionName: "pause",
    });
    expect(result).toBe(false);
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
