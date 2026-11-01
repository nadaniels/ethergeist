import {
  InvalidAddressError,
  createPublicClient,
  decodeEventLog,
  erc20Abi,
  keccak256,
  parseAbi,
  parseEventLogs,
  toHex,
  zeroAddress,
  zeroHash,
} from "viem";
import { describe, expect, test } from "vite-plus/test";

import { contractEvents, createMockRpc, match, testAddress, testHash } from "../src/index.js";
import { lowercase } from "./utils.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const alice = testAddress("alice");
const bob = testAddress("bob");
const SHAPES = testAddress("shapes");

const erc721Transfer = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);
const shapesAbi = parseAbi([
  "struct Point { int256 x; int256 y; }",
  "struct Shape { Point origin; Point[] vertices; string label; }",
  "event ShapeAdded(uint256 indexed id, Shape shape)",
  "event Registered(string indexed name, bytes indexed key, address indexed owner, string note)",
  "event Paused(address account)",
  "event Ping(uint256 a)",
  "event Ping(uint256 a, uint256 b)",
  "event Moved(Point indexed to)",
]);
const unnamedAbi = [
  {
    type: "event",
    name: "Unnamed",
    inputs: [
      { name: "", type: "address", indexed: true },
      { name: "", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Anon",
    anonymous: true,
    inputs: [
      { name: "who", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

function setup() {
  const mock = createMockRpc({ blockNumber: 10n });
  const client = createPublicClient({
    chain: mock.chain,
    cacheTime: 0,
    transport: mock.transport({ retryCount: 0 }),
  });
  const usdc = mock.contract({ abi: erc20Abi, address: USDC });
  const shapes = mock.contract({ abi: shapesAbi, address: SHAPES });
  return { mock, client, usdc, shapes };
}

describe("contract.events", () => {
  test("encodes the log the event emits, decoding back to its args", () => {
    const { usdc } = setup();

    const log = usdc.events.Transfer({ from: alice, to: bob, value: 5n });
    expect(Object.keys(log)).toEqual(["address", "topics", "data"]);
    expect(log.address).toBe(USDC);
    expect(decodeEventLog({ abi: erc20Abi, ...log })).toEqual({
      eventName: "Transfer",
      args: { from: alice, to: bob, value: 5n },
    });
  });

  test("goes into a mocked receipt, which places it", async () => {
    const { mock, client, usdc } = setup();
    const hash = testHash("transfer");
    mock.actions
      .getTransactionReceipt({ hash })
      .returns({ logs: [usdc.events.Transfer({ from: alice, to: bob, value: 5n })] });

    const { logs } = await client.getTransactionReceipt({ hash });
    expect(parseEventLogs({ abi: erc20Abi, logs })).toMatchObject([
      {
        eventName: "Transfer",
        args: { from: alice, to: bob, value: 5n },
        transactionHash: hash,
        blockNumber: 10n,
        logIndex: 0,
      },
    ]);
  });

  test("non-indexed args left out are zero, at any depth of a struct", () => {
    const { shapes } = setup();

    const log = shapes.events.ShapeAdded({
      id: 1n,
      shape: { origin: { y: 2n }, vertices: [{ x: 3n }] },
    });
    expect(decodeEventLog({ abi: shapesAbi, ...log }).args).toEqual({
      id: 1n,
      shape: { origin: { x: 0n, y: 2n }, vertices: [{ x: 3n, y: 0n }], label: "" },
    });
  });

  test("a plain non-indexed arg left out is zero too", () => {
    const { usdc } = setup();

    const log = usdc.events.Approval({ owner: alice, spender: bob });
    expect(decodeEventLog({ abi: erc20Abi, ...log }).args).toEqual({
      owner: alice,
      spender: bob,
      value: 0n,
    });
  });

  test("args can be left out when none is indexed", () => {
    const { shapes } = setup();

    expect(decodeEventLog({ abi: shapesAbi, ...shapes.events.Paused() }).args).toEqual({
      account: zeroAddress,
    });
  });

  test("an indexed arg left out throws, naming it", () => {
    const { usdc } = setup();

    expect(() =>
      // @ts-expect-error `to` is indexed, so required
      usdc.events.Transfer({ from: alice, value: 5n }),
    ).toThrow('Indexed arg "to" of event "Transfer" is required.');
  });

  test("indexed strings and bytes are hashed, as they decode", () => {
    const { shapes } = setup();

    const log = shapes.events.Registered({ name: "alice", key: "0x1234", owner: alice });
    expect(decodeEventLog({ abi: shapesAbi, ...log }).args).toEqual({
      name: keccak256(toHex("alice")),
      key: keccak256("0x1234"),
      owner: alice,
      note: "",
    });
  });

  test("an indexed struct throws: its topic can't be encoded", () => {
    const { shapes } = setup();

    expect(() => shapes.events.Moved({ to: { x: 1n, y: 2n } })).toThrow(
      `Indexed arg "to" of event "Moved" is a tuple; indexed structs and arrays aren't supported.`,
    );
  });

  test("unnamed inputs take every arg, in order", () => {
    const mock = createMockRpc();
    const contract = mock.contract({ abi: unnamedAbi, address: SHAPES });

    const log = contract.events.Unnamed([alice, 5n]);
    expect(decodeEventLog({ abi: unnamedAbi, ...log }).args).toEqual([alice, 5n]);
    expect(() =>
      // @ts-expect-error every arg is required
      contract.events.Unnamed([alice]),
    ).toThrow('Event "Unnamed" has unnamed args: pass all 2 of them, in order.');
  });

  test("anonymous events have no signature topic", () => {
    const mock = createMockRpc();
    const contract = mock.contract({ abi: unnamedAbi, address: SHAPES });

    const log = contract.events.Anon({ who: alice, amount: 5n });
    expect(log.topics).toHaveLength(1);
    expect(log.topics[0]).toBe(lowercase(`0x${alice.slice(2).padStart(64, "0")}`));
  });

  test("an unknown arg throws, listing the event's args", () => {
    const { usdc } = setup();

    expect(() =>
      // @ts-expect-error not an arg of Transfer
      usdc.events.Transfer({ from: alice, to: bob, amount: 5n }),
    ).toThrow(
      'No arg "amount" on event Transfer(address indexed from, address indexed to, uint256 value).',
    );
  });

  test("an overloaded event uses the overload its args fit", () => {
    const mock = createMockRpc();
    const token = mock.contract({ abi: [...erc20Abi, ...erc721Transfer], address: USDC });

    const fungible = token.events.Transfer({ from: alice, to: bob, value: 5n });
    const nft = token.events.Transfer({ from: alice, to: bob, tokenId: 7n });
    expect(fungible.topics).toHaveLength(3);
    expect(decodeEventLog({ abi: erc721Transfer, ...nft }).args).toEqual({
      from: alice,
      to: bob,
      tokenId: 7n,
    });
  });

  test("args that fit several overloads throw, listing them", () => {
    const { shapes } = setup();

    expect(() => shapes.events.Ping({ a: 1n })).toThrow(
      "Ambiguous overload for event Ping({ a: 1n }): pass an arg that tells them apart. " +
        "It fits:\n  event Ping(uint256 a)\n  event Ping(uint256 a, uint256 b)",
    );
    expect(() => shapes.events.Ping({ a: 1n, b: 2n })).not.toThrow();
  });

  test("args that fit no overload throw, listing them all", () => {
    const { shapes } = setup();

    expect(() =>
      // @ts-expect-error -- no overload has `c`
      shapes.events.Ping({ c: 1n }),
    ).toThrow(
      'No overload of event "Ping" takes Ping({ c: 1n }). Overloads:\n' +
        "  event Ping(uint256 a)\n  event Ping(uint256 a, uint256 b)",
    );
  });

  test("matchers aren't args here", () => {
    const { usdc } = setup();

    expect(() => usdc.events.Transfer({ from: alice, to: bob, value: match.any() })).toThrow(
      "match.any() can't go in event args; matchers only go in args and params.",
    );
  });

  test("a malformed address throws", () => {
    const { usdc } = setup();

    expect(() => usdc.events.Transfer({ from: "0x1234", to: bob, value: 5n })).toThrow(
      InvalidAddressError,
    );
  });
});

describe("contractEvents()", () => {
  // A contract the app never calls, only decodes the logs of.
  const FACTORY = testAddress("factory");

  test("builds the same logs as a registered contract's events", () => {
    const { usdc } = setup();
    const args = { from: alice, to: bob, value: 5n };

    expect(contractEvents({ abi: erc20Abi, address: USDC }).Transfer(args)).toEqual(
      usdc.events.Transfer(args),
    );
  });

  test("registers nothing: the address stays unmocked and free", async () => {
    const { mock, client } = setup();
    contractEvents({ abi: erc20Abi, address: FACTORY }).Transfer({ from: alice, to: bob });

    await expect(client.getCode({ address: FACTORY })).rejects.toThrow("No mock for getCode");
    expect(() => mock.contract({ abi: erc20Abi, address: FACTORY })).not.toThrow();
  });

  test("its logs go into a receipt the app decodes", async () => {
    const { mock, client } = setup();
    const hash = testHash("transfer");
    const factory = contractEvents({ abi: erc20Abi, address: FACTORY });
    mock.actions
      .getTransactionReceipt({ hash })
      .returns({ logs: [factory.Transfer({ from: alice, to: bob, value: 5n })] });

    const { logs } = await client.getTransactionReceipt({ hash });
    expect(parseEventLogs({ abi: erc20Abi, logs })).toMatchObject([
      { eventName: "Transfer", args: { from: alice, to: bob, value: 5n }, transactionHash: hash },
    ]);
  });

  test("validates the address up front", () => {
    expect(() => contractEvents({ abi: erc20Abi, address: "0x1234" })).toThrow(InvalidAddressError);
  });

  test("a receipt rejecting a placed log points to it", () => {
    const { mock } = setup();
    const placed = mock.buildLog({
      abi: erc20Abi,
      address: FACTORY,
      eventName: "Transfer",
      args: { from: alice, to: bob },
    });

    expect(() => {
      mock.actions
        .getTransactionReceipt({ hash: testHash("transfer") })
        .returns({ logs: [placed] });
    }).toThrow("or contractEvents({ abi, address }) for a contract you don't mock");
  });
});

describe("mock.buildLog()", () => {
  test("equals the log a mocked receipt answers, placed the same", async () => {
    const { mock, client, usdc } = setup();
    const hash = testHash("transfer");
    const args = { from: alice, to: bob, value: 5n };
    mock.actions
      .getTransactionReceipt({ hash })
      .returns({ blockNumber: 7n, transactionIndex: 2, logs: [usdc.events.Transfer(args)] });

    const { logs } = await client.getTransactionReceipt({ hash });
    expect(logs).toEqual([
      mock.buildLog({
        abi: erc20Abi,
        address: USDC,
        eventName: "Transfer",
        args,
        blockNumber: 7n,
        transactionHash: hash,
        transactionIndex: 2,
      }),
    ]);
    // The block hash is the generated block's.
    expect(logs[0]?.blockHash).toBe((await client.getBlock({ blockNumber: 7n })).hash);
  });

  test("defaults to the current block, and zeros for the rest", () => {
    const { mock } = setup();
    const log = mock.buildLog({ abi: shapesAbi, address: SHAPES, eventName: "Paused" });

    expect(log).toMatchObject({
      address: lowercase(SHAPES),
      blockNumber: 10n,
      transactionHash: zeroHash,
      transactionIndex: 0,
      logIndex: 0,
      removed: false,
    });
  });

  test("throws for an event the ABI doesn't have", () => {
    const { mock } = setup();

    expect(() =>
      // @ts-expect-error not an event of erc20Abi
      mock.buildLog({ abi: erc20Abi, address: USDC, eventName: "Swap", args: {} }),
    ).toThrow('No event "Swap" on this ABI.');
  });
});
