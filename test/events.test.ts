import {
  InvalidAddressError,
  createPublicClient,
  createWalletClient,
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

import {
  type MockEventLog,
  MockNotFoundError,
  MockSetupError,
  contractEvents,
  createMockRpc,
  match,
  testAddress,
  testHash,
  testLog,
} from "../src/index.js";
import { expectCause, expectRejects, expectThrows, lowercase, rejectionOf } from "./utils.js";

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

    expectThrows(MockSetupError, 'Indexed arg "to" of event "Transfer" is required.', () =>
      // @ts-expect-error `to` is indexed, so required
      usdc.events.Transfer({ from: alice, value: 5n }),
    );
  });

  test("an arg its encoder can't convert throws the mock's error", () => {
    const { usdc } = setup();

    const error = expectThrows(
      MockSetupError,
      `Event "Transfer" was given a value it can't encode: Cannot convert soon to a BigInt`,
      () =>
        // @ts-expect-error value is a bigint
        usdc.events.Transfer({ from: alice, to: bob, value: "soon" }),
    );
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });

  test("events with other arg names stay overloads, each chosen by its args", () => {
    // WETH names Transfer's args src, dst and wad.
    const abi = [
      ...erc20Abi,
      ...parseAbi(["event Transfer(address indexed src, address indexed dst, uint256 wad)"]),
    ];
    const weth = contractEvents({ abi, address: USDC });

    expect(weth.Transfer({ src: alice, dst: bob, wad: 1n })).toEqual(
      weth.Transfer({ from: alice, to: bob, value: 1n }),
    );
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

    expectThrows(
      MockSetupError,
      `Indexed arg "to" of event "Moved" is a tuple; indexed structs and arrays aren't supported.`,
      () => shapes.events.Moved({ to: { x: 1n, y: 2n } }),
    );
  });

  test("unnamed inputs take every arg, in order", () => {
    const mock = createMockRpc();
    const contract = mock.contract({ abi: unnamedAbi, address: SHAPES });

    const log = contract.events.Unnamed([alice, 5n]);
    expect(decodeEventLog({ abi: unnamedAbi, ...log }).args).toEqual([alice, 5n]);
    expectThrows(
      MockSetupError,
      'Event "Unnamed" has unnamed args: pass all 2 of them, in order.',
      () =>
        // @ts-expect-error every arg is required
        contract.events.Unnamed([alice]),
    );
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

    expectThrows(
      MockSetupError,
      'No arg "amount" on event Transfer(address indexed from, address indexed to, uint256 value).',
      () =>
        // @ts-expect-error not an arg of Transfer
        usdc.events.Transfer({ from: alice, to: bob, amount: 5n }),
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

    expectThrows(
      MockSetupError,
      "Ambiguous overload for event Ping({ a: 1n }): pass an arg that tells them apart.\n\n" +
        "It fits:\n  event Ping(uint256 a)\n  event Ping(uint256 a, uint256 b)",
      () => shapes.events.Ping({ a: 1n }),
    );
    expect(() => shapes.events.Ping({ a: 1n, b: 2n })).not.toThrow();
  });

  test("args that fit no overload throw, listing them all", () => {
    const { shapes } = setup();

    expectThrows(
      MockSetupError,
      'No overload of event "Ping" takes Ping({ c: 1n }).\n\nOverloads:\n' +
        "  event Ping(uint256 a)\n  event Ping(uint256 a, uint256 b)",
      () =>
        // @ts-expect-error -- no overload has `c`
        shapes.events.Ping({ c: 1n }),
    );
  });

  test("matchers aren't args here", () => {
    const { usdc } = setup();

    expectThrows(
      MockSetupError,
      "match.any() can't go in event args; matchers only go in args and params.",
      () => usdc.events.Transfer({ from: alice, to: bob, value: match.any() }),
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

    await expectRejects(
      MockNotFoundError,
      "No mock for getCode",
      client.getCode({ address: FACTORY }),
    );
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
    const placed = mock.buildLog(
      contractEvents({ abi: erc20Abi, address: FACTORY }).Transfer({ from: alice, to: bob }),
    );

    expectThrows(
      MockSetupError,
      "or contractEvents({ abi, address }) for a contract you don't mock",
      () => {
        mock.actions
          .getTransactionReceipt({ hash: testHash("transfer") })
          .returns({ logs: [placed] });
      },
    );
  });
});

describe("mock.buildLog()", () => {
  test("places a log's content, from events, contractEvents() or testLog()", async () => {
    const { mock, client, usdc } = setup();
    const block = await client.getBlock({ blockNumber: 7n });
    const hash = testHash("transfer");
    const factory = contractEvents({ abi: erc20Abi, address: testAddress("factory") });
    const placement = { blockNumber: 7n, transactionHash: hash, transactionIndex: 2, logIndex: 3 };

    for (const content of [
      usdc.events.Transfer({ from: alice, to: bob, value: 5n }),
      factory.Transfer({ from: alice, to: bob }),
      testLog("noise"),
    ])
      expect(mock.buildLog(content, placement)).toEqual({
        ...content,
        address: lowercase(content.address),
        removed: false,
        blockHash: block.hash,
        blockTimestamp: block.timestamp,
        ...placement,
      });
  });

  test("equals the log a mocked receipt answers, placed the same", async () => {
    const { mock, client, usdc } = setup();
    const hash = testHash("transfer");
    const content = usdc.events.Transfer({ from: alice, to: bob, value: 5n });
    mock.actions
      .getTransactionReceipt({ hash })
      .returns({ blockNumber: 7n, transactionIndex: 2, logs: [content] });

    const { logs } = await client.getTransactionReceipt({ hash });
    expect(logs).toEqual([
      mock.buildLog(content, { blockNumber: 7n, transactionHash: hash, transactionIndex: 2 }),
    ]);
    // The block hash and timestamp are the generated block's, not the current one's.
    const block = await client.getBlock({ blockNumber: 7n });
    expect(logs[0]?.blockHash).toBe(block.hash);
    expect(logs[0]?.blockTimestamp).toBe(block.timestamp);
  });

  test("defaults to the current block, and zeros for the rest", () => {
    const { mock, shapes } = setup();
    const log = mock.buildLog(shapes.events.Paused());

    expect(log).toMatchObject({
      address: lowercase(SHAPES),
      blockNumber: 10n,
      transactionHash: zeroHash,
      transactionIndex: 0,
      logIndex: 0,
      removed: false,
    });
    expect(mock.buildLog(shapes.events.Paused(), {})).toEqual(log);
    // Zero is a block and an index like any other.
    expect(
      mock.buildLog(shapes.events.Paused(), { blockNumber: 0n, transactionIndex: 0, logIndex: 0 }),
    ).toMatchObject({ blockNumber: 0n, transactionIndex: 0, logIndex: 0 });
  });

  test("refuses placement values a log can't have, as addTransaction refuses them", () => {
    const { mock, usdc } = setup();
    const content = usdc.events.Transfer({ from: alice, to: bob });

    for (const [placement, message] of [
      [{ blockNumber: 5 }, "A block number must be a bigint, zero or more; got 5."],
      [{ blockNumber: -1n }, "A block number must be a bigint, zero or more; got -1n."],
      [{ transactionHash: "0x12" }, "A transaction hash must be 32 bytes; got 0x12."],
      [{ transactionIndex: 1.5 }, "A transaction index must be an integer, zero or more; got 1.5."],
      [{ logIndex: -1 }, "A log index must be an integer, zero or more; got -1."],
      [{ logIndex: "x" }, "A log index must be an integer, zero or more; got x."],
    ] as const)
      // @ts-expect-error -- some aren't the placement's types
      expectThrows(MockSetupError, message, () => mock.buildLog(content, placement));
  });

  test("refuses content that's already placed: it's placed once", () => {
    const { mock, usdc } = setup();
    const placed = mock.buildLog(usdc.events.Transfer({ from: alice, to: bob }));
    const emitted = usdc.emit.Transfer({ from: alice, to: bob });

    for (const log of [
      placed,
      emitted,
      { ...usdc.events.Transfer({ from: alice, to: bob }), logIndex: 0 },
    ]) {
      const error = expectThrows(
        MockSetupError,
        "mock.buildLog() places a log's content, but this log already has a position.",
        () => mock.buildLog(log),
      );
      expect(error.metaMessages).toEqual([
        "Pass a log from contract.events, contractEvents() or testLog(), and its position as " +
          "buildLog()'s placement.",
      ]);
    }
  });

  test("refuses what isn't a log's content", () => {
    const { mock } = setup();

    const error = expectThrows(
      MockSetupError,
      "mock.buildLog()'s content isn't a log; got 5.",
      () =>
        // @ts-expect-error -- not a log
        mock.buildLog(5),
    );
    expect(error.metaMessages).toEqual([
      "Logs come from contract.events, contractEvents() or testLog().",
    ]);
    expectThrows(MockSetupError, "mock.buildLog()'s content isn't a log; got undefined.", () =>
      // @ts-expect-error -- not a log
      mock.buildLog(),
    );
    // Its parameters before it took content: a log's content has no abi.
    expectThrows(
      MockSetupError,
      "mock.buildLog()'s content has no field abi; a log's content is its address, topics and data.",
      () =>
        mock.buildLog({
          // @ts-expect-error -- not a log's content
          abi: erc20Abi,
          address: USDC,
          eventName: "Transfer",
          args: { from: alice, to: bob },
        }),
    );
    expect(() => mock.buildLog({ address: "0x12", topics: [], data: "0x" })).toThrow(
      InvalidAddressError,
    );
  });

  test("refuses a placement that isn't one, pointing a transaction's hash to transactionHash", () => {
    const { mock, usdc } = setup();
    const content = usdc.events.Transfer({ from: alice, to: bob });

    expectThrows(MockSetupError, "mock.buildLog() takes its placement as an object; got 7n.", () =>
      // @ts-expect-error -- a placement, not a block number
      mock.buildLog(content, 7n),
    );
    const hash = expectThrows(
      MockSetupError,
      "mock.buildLog()'s placement has no field hash.",
      () =>
        // @ts-expect-error -- a log's transaction is transactionHash
        mock.buildLog(content, { hash: testHash("transfer") }),
    );
    expect(hash.metaMessages).toEqual([
      "A log's transaction is transactionHash, as on a log; hash is a transaction's.",
    ]);
    const mine = expectThrows(
      MockSetupError,
      "mock.buildLog()'s placement has no field mine.",
      () =>
        // @ts-expect-error -- not a placement field
        mock.buildLog(content, { mine: true }),
    );
    expect(mine.metaMessages).toEqual([
      "Its fields are blockNumber, transactionHash, transactionIndex and logIndex; left out, " +
        "the current block and zeros.",
    ]);
  });
});

/** A log the types rule out, as an untyped caller passes it. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what the types rule out
const untyped = (log: object) => log as MockEventLog;

// Every site that places a log refuses what isn't a log's content, in the same words.
describe("a log's content is checked wherever it's placed", () => {
  const content = testLog("noise");
  const bad = [
    {
      name: "the old { abi, eventName, args } shape",
      log: untyped({ abi: erc20Abi, address: USDC, eventName: "Transfer", args: {} }),
      says: "has no field abi; a log's content is its address, topics and data.",
    },
    {
      name: "data that isn't hex",
      log: untyped({ ...content, data: "0xzz" }),
      says: "has data that isn't hex; got 0xzz.",
    },
    {
      name: "a topic that isn't a 32-byte hash",
      log: untyped({ ...content, topics: ["0x12"] }),
      says: "has a topic that isn't a 32-byte hash; got 0x12.",
    },
    {
      name: "more than four topics",
      log: untyped({ ...content, topics: Array.from({ length: 5 }, () => testHash("topic")) }),
      says: "has 5 topics; a log has at most 4.",
    },
  ];
  type Setup = ReturnType<typeof setup>;
  // Each site, and how it names the log it refuses.
  const sites: { site: string; name: string; place: (setup: Setup, log: MockEventLog) => void }[] =
    [
      {
        site: "mock.addTransaction({ logs })",
        name: "A transaction's log 0",
        place: ({ mock }, log) => {
          mock.addTransaction({ logs: [log] });
        },
      },
      {
        site: "a write's .emits()",
        name: "A send's log 0",
        place: ({ usdc }, log) => {
          usdc.write.transfer().emits(log);
        },
      },
      {
        site: "a receipt mock's logs",
        name: "A receipt's log 0",
        place: ({ mock }, log) => {
          mock.actions.getTransactionReceipt().returns({ logs: [log] });
        },
      },
      {
        site: "mock.buildLog()",
        name: "mock.buildLog()'s content",
        place: ({ mock }, log) => {
          mock.buildLog(log);
        },
      },
    ];

  for (const { site, name, place } of sites)
    test.each(bad)(`${site} refuses $name, changing nothing`, ({ log, says }) => {
      const placed = setup();

      const error = expectThrows(MockSetupError, `${name} ${says}`, () => {
        place(placed, log);
      });
      expect(error.metaMessages).toEqual([
        "Logs come from contract.events, contractEvents() or testLog().",
      ]);
      expect(placed.mock.transactions).toEqual([]);
      expect(placed.mock.blockNumber).toBe(10n);
    });

  test.each(bad)("a resolver's emit() of $name is refused at the send", async ({ log, says }) => {
    const { mock, usdc } = setup();
    usdc.write.transfer().returns(({ emit }) => {
      emit(log);
    });

    const wallet = createWalletClient({
      account: alice,
      chain: mock.chain,
      transport: mock.transport({ retryCount: 0 }),
    });
    const error = await rejectionOf(
      wallet.writeContract({
        abi: erc20Abi,
        address: USDC,
        functionName: "transfer",
        args: [bob, 1n],
      }),
    );
    expect(expectCause(error, MockSetupError).shortMessage).toBe(`A send's log 0 ${says}`);
    expect(mock.transactions).toEqual([]);
  });

  test("logs from contract.events, contractEvents(), testLog() and four topics are placed everywhere", () => {
    const { mock, usdc, shapes } = setup();
    const logs: MockEventLog[] = [
      usdc.events.Transfer({ from: alice, to: bob, value: 1n }),
      contractEvents({ abi: erc20Abi, address: USDC }).Approval({ owner: alice, spender: bob }),
      shapes.events.Registered({ name: "a", key: "0x01", owner: alice }),
      testLog("noise"),
      { address: USDC, topics: [], data: "0x" },
    ];

    expect(mock.addTransaction({ logs }).logs).toHaveLength(5);
    usdc.write.transfer().emits(logs);
    mock.actions.getTransactionReceipt().returns({ logs });
    for (const log of logs) mock.buildLog(log);
    // A log's data may be left out: it's empty.
    expect(mock.buildLog(untyped({ address: USDC, topics: [] })).data).toBe("0x");
  });

  test("a placed log is refused as placed, whatever else is wrong with it", () => {
    const { mock } = setup();
    const placed = untyped({ address: USDC, topics: ["0x12"], data: "zz", blockNumber: 1n });

    expectThrows(MockSetupError, "mock.addTransaction() places logs itself, but one already", () =>
      mock.addTransaction({ logs: [placed] }),
    );
  });
});
