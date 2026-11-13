import {
  type Address,
  InvalidAddressError,
  InvalidInputRpcError,
  InvalidParamsRpcError,
  type LogTopic,
  RpcRequestError,
  createPublicClient,
  encodeEventTopics,
  erc20Abi,
  pad,
  parseAbiItem,
  parseGwei,
  toEventSelector,
  zeroAddress,
} from "viem";
import { describe, expect, test } from "vite-plus/test";

import {
  MockCheckError,
  MockNotFoundError,
  MockSetupError,
  createMockRpc,
  match,
  testAddress,
  testHash,
} from "../src/index.js";
import { expectCause, expectThrows, lowercase, rejectionOf } from "./utils.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const alice = testAddress("alice");
const bob = testAddress("bob");
const carol = testAddress("carol");
const transfer = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

function setup() {
  const mock = createMockRpc({ blockNumber: 10n });
  const client = createPublicClient({
    chain: mock.chain,
    cacheTime: 0,
    transport: mock.transport({ retryCount: 0 }),
  });
  const usdc = mock.contract({ abi: erc20Abi, address: USDC, name: "USDC" });
  const dai = mock.contract({ abi: erc20Abi, address: DAI, name: "DAI" });
  return { mock, client, usdc, dai };
}

/** A raw `eth_getLogs` request, for filters viem never sends. */
function getLogsRaw(mock: ReturnType<typeof setup>["mock"], filter: object) {
  return mock.request({ method: "eth_getLogs", params: [filter] });
}

/**
 * The code and message a request is refused with; fails if it was counted
 * unhandled.
 */
async function refusal(mock: ReturnType<typeof setup>["mock"], promise: Promise<unknown>) {
  const error = expectCause(await rejectionOf(promise), RpcRequestError);
  expect(mock.unhandled).toEqual([]);
  return { code: error.code, message: error.details };
}

describe("emit", () => {
  test("has one emitter per event on the ABI, and nothing else", () => {
    const { usdc } = setup();

    expect(Object.keys(usdc.emit)).toEqual(["Approval", "Transfer"]);
  });

  test("puts a log in a newly mined block, found by getLogs and decoded by viem", async () => {
    const { mock, client, usdc } = setup();

    const log = usdc.emit.Transfer({ from: alice, to: bob, value: 5n });
    expect(mock.blockNumber).toBe(11n);
    const [found] = await client.getLogs({ address: USDC, event: transfer });

    expect(found).toEqual({
      ...log,
      eventName: "Transfer",
      args: { from: alice, to: bob, value: 5n },
    });
    const block = await client.getBlock({ blockNumber: 11n });
    expect(log).toMatchObject({
      blockNumber: 11n,
      blockHash: block.hash,
      blockTimestamp: block.timestamp,
      logIndex: 0,
      transactionIndex: 0,
      transactionHash: testHash("tx:1:11:0"),
      removed: false,
    });
  });

  test("each emit is its own block, unless it names one", () => {
    const { mock, usdc } = setup();

    const first = usdc.emit.Transfer({ from: alice, to: bob });
    const second = usdc.emit.Transfer({ from: bob, to: alice });
    const placed = usdc.emit.Transfer({ from: bob, to: carol }, { blockNumber: 12n });
    expect([first, second, placed].map((log) => [log.blockNumber, log.transactionIndex])).toEqual([
      [11n, 0],
      [12n, 0],
      [12n, 1],
    ]);
    expect(mock.blockNumber).toBe(12n);
  });

  test("one call is one transaction; each call is the block's next", () => {
    const { mock, usdc, dai } = setup();
    const block = { blockNumber: 10n };

    const { logs: swap } = mock.addTransaction({
      logs: [
        usdc.events.Transfer({ from: alice, to: bob, value: 5n }),
        dai.events.Transfer({ from: bob, to: alice, value: 4n }),
      ],
      ...block,
    });
    const next = usdc.emit.Approval({ owner: alice, spender: bob, value: 1n }, block);

    expect(swap.map((log) => [log.transactionIndex, log.logIndex])).toEqual([
      [0, 0],
      [0, 1],
    ]);
    expect(swap[0]?.transactionHash).toBe(swap[1]?.transactionHash);
    expect([next.transactionIndex, next.logIndex]).toEqual([1, 2]);
    expect(next.transactionHash).not.toBe(swap[0]?.transactionHash);
  });

  test("takes a block and transaction hash from its options", () => {
    const { mock, usdc } = setup();
    const hash = testHash("swap-1");

    const log = usdc.emit.Transfer(
      { from: alice, to: bob, value: 5n },
      {
        blockNumber: 4n,
        hash,
      },
    );
    expect(log).toMatchObject({ blockNumber: 4n, transactionHash: hash, transactionIndex: 0 });
    expect(mock.blockNumber).toBe(10n);
  });

  test("refuses a transaction hash already on the chain, and changes nothing", () => {
    const { mock, usdc } = setup();
    const hash = testHash("swap-1");
    usdc.emit.Transfer({ from: alice, to: bob, value: 5n }, { hash });

    const upper = `0x${hash.slice(2).toUpperCase()}` as const;
    const again = () =>
      mock.addTransaction({ logs: [usdc.events.Transfer({ from: bob, to: carol })], hash: upper });
    expect(again).toThrow(MockSetupError);
    expectThrows(
      MockSetupError,
      `Transaction ${hash} is already in mock.transactions.\n\n` +
        "Give each added transaction its own hash; one transaction's logs go in one call, as " +
        "mock.addTransaction({ logs: [a, b] }).",
      again,
    );
    expect(mock.blockNumber).toBe(11n);
    expect(mock.transactions).toHaveLength(1);
  });

  test("refuses a sent emit whose made-up hash was named earlier, saying so", () => {
    const { mock, usdc } = setup();
    usdc.emit.Transfer({ from: alice, to: bob }, { hash: testHash("tx:1:12:0") });

    expectThrows(
      MockSetupError,
      `Transaction ${testHash("tx:1:12:0")} is already in mock.transactions.\n\n` +
        'Name a hash other than one the mock makes, testHash("tx:<chainId>:<block>:<index>").',
      () => usdc.emit.Transfer({ from: bob, to: alice }),
    );
    expect(mock.blockNumber).toBe(11n);
  });

  test("has no mine or transactionIndex option", () => {
    const { mock, usdc } = setup();

    expectThrows(
      MockSetupError,
      "mine isn't a field of contract.emit's options.\n\n" +
        "Its options are blockNumber and hash; without blockNumber, it mines a new block.",
      // @ts-expect-error -- emit takes no `mine`: a plain emit mines
      () => usdc.emit.Transfer({ from: alice, to: bob }, { mine: true }),
    );
    expectThrows(MockSetupError, "transactionIndex isn't a field of contract.emit's options.", () =>
      // @ts-expect-error -- emit takes no `transactionIndex`: a block's transactions have no holes
      usdc.emit.Transfer({ from: alice, to: bob }, { transactionIndex: 3 }),
    );
    expect(mock.blockNumber).toBe(10n);
  });

  test("names the transaction's hash as addTransaction does, refusing transactionHash", () => {
    const { mock, usdc } = setup();

    expectThrows(
      MockSetupError,
      "transactionHash isn't a field of contract.emit's options.\n\n" +
        "The transaction's hash is hash, as on a transaction; transactionHash is a log's.",
      // @ts-expect-error -- emit takes no `transactionHash`: a transaction's hash is `hash`
      () => usdc.emit.Transfer({ from: alice, to: bob }, { transactionHash: testHash("x") }),
    );
    expect(mock.blockNumber).toBe(10n);
    expect(mock.transactions).toEqual([]);
  });

  test("refuses options that aren't an object", () => {
    const { mock, usdc } = setup();

    for (const [options, got] of [
      [null, "null"],
      [5n, "5n"],
    ] as const)
      expectThrows(
        MockSetupError,
        `Expected an object for contract.emit's options; got ${got}.\n\n` +
          "Its options are blockNumber and hash; without blockNumber, it mines a new block.",
        // @ts-expect-error -- not options
        () => usdc.emit.Transfer({ from: alice, to: bob }, options),
      );
    expect(mock.transactions).toEqual([]);
  });

  test("refuses a block that isn't a non-negative bigint, or a hash that isn't 32 bytes", () => {
    const { mock, usdc } = setup();
    const args = { from: alice, to: bob };

    expectThrows(
      MockSetupError,
      "contract.emit's blockNumber must be a non-negative bigint; got 3.",
      () =>
        // @ts-expect-error -- a block number takes a bigint
        usdc.emit.Transfer(args, { blockNumber: 3 }),
    );
    expectThrows(
      MockSetupError,
      "contract.emit's blockNumber must be a non-negative bigint; got -1n.",
      () => usdc.emit.Transfer(args, { blockNumber: -1n }),
    );
    expectThrows(MockSetupError, "A transaction hash must be 32 bytes; got 0x12.", () =>
      usdc.emit.Transfer(args, { hash: "0x12" }),
    );
    expect(mock.blockNumber).toBe(10n);
    expect(mock.transactions).toEqual([]);
  });

  test("logs in a later block appear once it's mined", async () => {
    const { mock, client, usdc } = setup();

    usdc.emit.Transfer({ from: alice, to: bob, value: 5n }, { blockNumber: 11n });
    expect(await client.getLogs({ address: USDC })).toEqual([]);
    mock.mine();
    expect(await client.getLogs({ address: USDC })).toHaveLength(1);
  });

  test("refuses what it can't place", () => {
    const { mock, usdc } = setup();
    mock.empty(carol);
    const other = createMockRpc().contract({ abi: erc20Abi, address: carol });

    expectThrows(
      MockSetupError,
      "mock.addTransaction()'s log 0 is already placed (e.g. by mock.buildLog()).\n\n" +
        "Logs come from contract.events, contractEvents() or testLog().\n" +
        "Give its position as addTransaction()'s blockNumber or hash.",
      () =>
        mock.addTransaction({
          logs: [mock.buildLog(usdc.events.Transfer({ from: alice, to: bob }))],
        }),
    );
    expectThrows(MockSetupError, `${carol} is marked empty(), with no code to emit this log.`, () =>
      mock.addTransaction({
        logs: [
          usdc.events.Transfer({ from: alice, to: bob }),
          other.events.Transfer({ from: alice, to: bob }),
        ],
      }),
    );
    expect(mock.blockNumber).toBe(10n);
    expect(mock.logs).toEqual([]);
  });

  test("emits at any address, for getLogs to find", async () => {
    const { mock, client } = setup();
    const other = createMockRpc().contract({ abi: erc20Abi, address: carol });

    const { logs } = mock.addTransaction({
      logs: [other.events.Transfer({ from: alice, to: bob, value: 1n })],
    });
    expect(await client.getLogs({ address: carol })).toEqual(logs);
  });

  test("each block's transactions and logs are indexed from 0", () => {
    const { usdc } = setup();

    const earlier = usdc.emit.Transfer({ from: alice, to: bob }, { blockNumber: 9n });
    const later = usdc.emit.Transfer({ from: alice, to: bob }, { blockNumber: 10n });
    expect(
      [earlier, later].map((log) => [log.blockNumber, log.transactionIndex, log.logIndex]),
    ).toEqual([
      [9n, 0, 0],
      [10n, 0, 0],
    ]);
  });

  test("a new transaction hash names the transaction, with other logs on the chain", () => {
    const { usdc } = setup();
    const hash = testHash("swap-1");

    usdc.emit.Transfer({ from: alice, to: bob }, { blockNumber: 9n });
    const log = usdc.emit.Transfer({ from: bob, to: carol }, { blockNumber: 10n, hash });
    expect(log.transactionHash).toBe(hash);
  });

  test("refuses a log with even one position field", () => {
    const { mock, usdc } = setup();
    const log = {
      ...usdc.events.Transfer({ from: alice, to: bob }),
      transactionHash: testHash("x"),
    };

    const add = () => mock.addTransaction({ logs: [log], blockNumber: 10n });
    expect(add).toThrow(MockSetupError);
    expectThrows(MockSetupError, "mock.addTransaction()'s log 0 is already placed", add);
  });

  test("returns frozen logs: changing one throws", () => {
    const { mock, usdc } = setup();

    const log = usdc.emit.Transfer({ from: alice, to: bob, value: 5n });
    expect(() => {
      // @ts-expect-error -- a log is read-only
      log.logIndex = 7;
    }).toThrow(TypeError);
    expect(() => {
      (log.topics as unknown[]).push("0x");
    }).toThrow(TypeError);
    expect(Object.isFrozen(mock.logs[0])).toBe(true);
    expect({ ...log, logIndex: 7 }.logIndex).toBe(7);
  });

  test("mock.logs lists every log by block and log index, whatever order they were emitted in", () => {
    const { mock, usdc, dai } = setup();

    mock.addTransaction({
      logs: [
        usdc.events.Transfer({ from: alice, to: bob }),
        dai.events.Transfer({ from: bob, to: alice }),
      ],
      blockNumber: 9n,
    });
    usdc.emit.Transfer({ from: alice, to: bob }, { blockNumber: 10n });
    usdc.emit.Transfer({ from: alice, to: bob }, { blockNumber: 5n });
    expect(mock.logs.map((log) => [log.blockNumber, log.logIndex])).toEqual([
      [5n, 0],
      [9n, 0],
      [9n, 1],
      [10n, 0],
    ]);
  });
});

describe("getLogs filters", () => {
  test("by address, one or several, in chain order across them", async () => {
    const { client, usdc, dai } = setup();
    usdc.emit.Transfer({ from: alice, to: bob }, { blockNumber: 8n });
    dai.emit.Transfer({ from: alice, to: bob }, { blockNumber: 7n });
    usdc.emit.Transfer({ from: alice, to: bob }, { blockNumber: 6n });

    const range = { fromBlock: 1n, toBlock: 10n } as const;
    expect((await client.getLogs({ address: USDC, ...range })).map((l) => l.blockNumber)).toEqual([
      6n,
      8n,
    ]);
    const both = await client.getLogs({ address: [USDC, DAI], ...range });
    expect(both.map((l) => [l.address, l.blockNumber])).toEqual([
      [lowercase(USDC), 6n],
      [lowercase(DAI), 7n],
      [lowercase(USDC), 8n],
    ]);
  });

  test("by indexed args: one value, any of several, or any", async () => {
    const { client, usdc } = setup();
    const block = { blockNumber: 10n };
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n }, block);
    usdc.emit.Transfer({ from: bob, to: carol, value: 2n }, block);
    usdc.emit.Transfer({ from: carol, to: alice, value: 3n }, block);

    const values = async (args: { from?: `0x${string}` | `0x${string}`[]; to?: `0x${string}` }) =>
      (await client.getLogs({ address: USDC, event: transfer, args })).map((l) => l.args.value);
    expect(await values({ from: alice })).toEqual([1n]);
    expect(await values({ from: [alice, carol] })).toEqual([1n, 3n]);
    expect(await values({ to: alice })).toEqual([3n]);
    expect(await values({})).toEqual([1n, 2n, 3n]);
  });

  test("by event, including all of an ABI's events", async () => {
    const { client, usdc } = setup();
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n }, { blockNumber: 10n });
    usdc.emit.Approval({ owner: alice, spender: bob, value: 2n }, { blockNumber: 10n });

    const approvals = await client.getContractEvents({
      abi: erc20Abi,
      address: USDC,
      eventName: "Approval",
    });
    expect(approvals.map((l) => l.eventName)).toEqual(["Approval"]);
    const all = await client.getContractEvents({ abi: erc20Abi, address: USDC });
    expect(all.map((l) => l.eventName)).toEqual(["Transfer", "Approval"]);
  });

  test("a filter wrong about the address finds nothing, which viem wouldn't catch", async () => {
    const { client, usdc } = setup();
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n });

    // viem checks the event and args of what comes back, but not the address.
    expect(await client.getLogs({ address: DAI, event: transfer })).toEqual([]);
  });

  test("without a range, only the current block", async () => {
    const { client, usdc } = setup();
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n }, { blockNumber: 9n });
    usdc.emit.Transfer({ from: alice, to: bob, value: 2n });

    expect(await client.getLogs({ address: USDC })).toHaveLength(1);
    expect(await client.getLogs({ address: USDC, fromBlock: 9n })).toHaveLength(2);
    expect(
      await client.getLogs({ address: USDC, fromBlock: "earliest", toBlock: "latest" }),
    ).toHaveLength(2);
  });

  test("by block hash", async () => {
    const { client, usdc } = setup();
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n }, { blockNumber: 9n });
    usdc.emit.Transfer({ from: alice, to: bob, value: 2n });

    const { hash } = await client.getBlock({ blockNumber: 9n });
    const logs = await client.getLogs({ address: USDC, blockHash: hash });
    expect(logs.map((l) => l.blockNumber)).toEqual([9n]);
  });

  test("a filter with more topics than a log has excludes it, as geth and reth do", async () => {
    const { mock, usdc } = setup();
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n });
    const [selector] = encodeEventTopics({ abi: [transfer], eventName: "Transfer" });

    expect(await getLogsRaw(mock, { topics: [selector, null, null] })).toHaveLength(1);
    expect(await getLogsRaw(mock, { topics: [selector, null, null, null] })).toEqual([]);
    expect(await getLogsRaw(mock, { topics: [selector, []] })).toHaveLength(1);
  });

  test("by topic: one value, any of several, or any, in raw requests viem can't filter", async () => {
    const { client, usdc } = setup();
    const block = { blockNumber: 10n };
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n }, block);
    usdc.emit.Transfer({ from: bob, to: carol, value: 2n }, block);
    usdc.emit.Approval({ owner: alice, spender: bob, value: 3n }, block);
    const [selector] = encodeEventTopics({ abi: [transfer], eventName: "Transfer" });

    // Raw, since viem drops what doesn't match its own filter; typed, for the answer's logIndex.
    const indexes = async (topics: LogTopic[]) =>
      (await client.request({ method: "eth_getLogs", params: [{ topics }] })).map(
        (log) => log.logIndex,
      );
    expect(await indexes([selector])).toEqual(["0x0", "0x1"]);
    expect(await indexes([selector, pad(alice)])).toEqual(["0x0"]);
    expect(await indexes([selector, [pad(carol), pad(alice)]])).toEqual(["0x0"]);
    expect(await indexes([null, pad(alice)])).toEqual(["0x0", "0x2"]);
  });

  test("any address has the chain's logs: none until something emits there", async () => {
    const { mock, client, usdc } = setup();
    mock.empty(alice);
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n });

    expect(await client.getLogs({ address: alice })).toEqual([]);
    expect(await client.getLogs({ address: bob })).toEqual([]);
    expect(await client.getLogs({ address: [USDC, bob] })).toHaveLength(1);
    expect(mock.unhandled).toEqual([]);
  });

  test("answers in JSON-RPC form, as a node sends them", async () => {
    const { mock, usdc } = setup();
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n }, { blockNumber: 10n });

    const logs = await getLogsRaw(mock, { address: USDC });
    expect(logs).toMatchObject([
      { blockNumber: "0xa", logIndex: "0x0", transactionIndex: "0x0", removed: false },
    ]);
    expect(JSON.stringify(logs)).toMatch(/"blockTimestamp":"0x[1-9a-f][0-9a-f]*"/u);
  });
});

describe("getLogs refuses what reth refuses", () => {
  test("a range past the head", async () => {
    const { mock, client } = setup();
    const error = await rejectionOf(client.getLogs({ address: USDC, fromBlock: 5n, toBlock: 11n }));
    expectCause(error, InvalidParamsRpcError);
    expect(
      await refusal(mock, client.getLogs({ address: USDC, fromBlock: 5n, toBlock: 11n })),
    ).toEqual({
      code: -32602,
      message: "block range extends beyond current head block",
    });
  });

  test("a range that ends before it starts", async () => {
    const { mock, client } = setup();
    expect(
      await refusal(mock, client.getLogs({ address: USDC, fromBlock: 8n, toBlock: 7n })),
    ).toEqual({
      code: -32602,
      message: "invalid block range params",
    });
  });

  test("a block hash with a range, or either end of one", async () => {
    const { mock } = setup();
    for (const range of [{ fromBlock: "0x1" }, { toBlock: "0x1" }])
      expect(
        await refusal(mock, getLogsRaw(mock, { blockHash: testHash("block"), ...range })),
      ).toEqual({
        code: -32602,
        message:
          "invalid argument 0: cannot specify both BlockHash and FromBlock/ToBlock, choose one or the other",
      });
  });

  test("an unknown block hash", async () => {
    const { mock, client } = setup();
    const hash = testHash("block");
    const error = await rejectionOf(client.getLogs({ blockHash: hash }));
    expectCause(error, InvalidInputRpcError);
    expect(await refusal(mock, client.getLogs({ blockHash: hash }))).toEqual({
      code: -32000,
      message: `block not found: ${hash.slice(2)}`,
    });
  });

  test("a block hash past the head; the head's own answers", async () => {
    const { mock, client, usdc } = setup();
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n }, { blockNumber: 10n });
    usdc.emit.Transfer({ from: alice, to: bob, value: 2n }, { blockNumber: 11n });
    const head = await client.getBlock();
    // The next block's hash, from a chain that has mined it.
    const checkpoint = mock.checkpoint();
    mock.mine();
    const next = await client.getBlock();
    checkpoint.restore();

    const logs = await client.getLogs({ blockHash: head.hash });
    expect(logs.map((log) => log.blockNumber)).toEqual([10n]);
    expectCause(await rejectionOf(client.getLogs({ blockHash: next.hash })), InvalidInputRpcError);
    expect(await refusal(mock, client.getLogs({ blockHash: next.hash }))).toEqual({
      code: -32000,
      message: `block not found: ${next.hash.slice(2)}`,
    });
  });

  test("more than 4 topics", async () => {
    const { mock } = setup();
    expect(
      await refusal(mock, getLogsRaw(mock, { topics: [null, null, null, null, null] })),
    ).toEqual({
      code: -32602,
      message: "query exceeds the maximum of 4 topics",
    });
  });
});

describe("history", () => {
  test("names the contract, event, and indexed args a filter asks for", async () => {
    const { mock, client, usdc } = setup();
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n }, { blockNumber: 10n });

    await client.getLogs({ address: USDC, event: transfer, args: { from: alice } });
    await client.getContractEvents({ abi: erc20Abi, address: [USDC, DAI], fromBlock: 1n });
    await rejectionOf(client.getLogs({ address: USDC, fromBlock: 8n, toBlock: 7n }));
    expect(mock.formatHistory({ builtIns: false }).split("\n")).toEqual([
      "#1 eth_getLogs getLogs(USDC, Transfer(from: 0xa41f…2D9e), block 10n) → 1 log",
      "#2 eth_getLogs getLogs([USDC, DAI], Approval | Transfer, blocks 1n–10n) → 1 log",
      "#3 eth_getLogs getLogs(USDC, blocks 8n–7n) ✗ rpc error -32602: invalid block range params",
    ]);
  });

  test("shows an indexed arg's topic as hex when it's a hash or doesn't fit the type", async () => {
    const { mock, client } = setup();
    const uint = { name: "a", type: "uint256" } as const;
    const cases = [
      // Solidity hashes these: the topic is the value's hash.
      ["string", { type: "string" }],
      ["bytes", { type: "bytes" }],
      ["a fixed array", { type: "uint256[2]" }],
      ["a one-field struct", { type: "tuple", components: [uint] }],
      ["a two-field struct", { type: "tuple", components: [uint, { ...uint, name: "b" }] }],
      ["an array of structs", { type: "tuple[]", components: [uint] }],
      // Value types a hash doesn't fit: a bool past 1, a small int past 2^53, a function.
      ["a bool", { type: "bool" }],
      ["a uint8", { type: "uint8" }],
      ["a function", { type: "function" }],
    ] as const;
    const abi = cases.map(([, input], i) => ({
      type: "event" as const,
      name: `E${i}`,
      inputs: [{ ...input, name: "x", indexed: true }],
    }));
    mock.contract({ abi, address: alice, name: "Args" });
    const hash = testHash("arg");

    for (const event of abi)
      await client.request({
        method: "eth_getLogs",
        params: [{ address: alice, topics: [toEventSelector(event), hash] }],
      });
    expect(mock.formatHistory({ builtIns: false }).split("\n")).toEqual(
      cases.map(
        (_, i) => `#${i + 1} eth_getLogs getLogs(Args, E${i}(x: 0x62c6…22f8), block 10n) → 0 logs`,
      ),
    );
  });

  test("shows an address with no contract name as hex", async () => {
    const { mock, client } = setup();
    mock.empty(alice);

    await client.getLogs({ address: alice });
    expect(mock.formatHistory({ builtIns: false })).toBe(
      "#1 eth_getLogs getLogs(0xa41f…2D9e, block 10n) → 0 logs",
    );
  });

  test("records the decoded filter and the logs in viem's types", async () => {
    const { mock, client, usdc } = setup();
    const log = usdc.emit.Transfer({ from: alice, to: bob, value: 1n }, { blockNumber: 10n });

    await client.getLogs({ address: USDC, fromBlock: 1n });
    const [entry] = mock.history;
    expect(entry).toMatchObject({
      type: "action",
      action: "getLogs",
      call: { address: USDC, topics: [], fromBlock: 1n, toBlock: 10n },
      outcome: { type: "result", value: [log] },
    });
  });
});

describe("the transaction an emit makes", () => {
  test("answers its receipt and transaction, and is listed in its block", async () => {
    const { client, usdc } = setup();
    const log = usdc.emit.Transfer({ from: alice, to: bob, value: 5n });
    const hash = log.transactionHash;

    expect(await client.getTransactionReceipt({ hash })).toMatchObject({
      status: "success",
      transactionHash: hash,
      blockNumber: 11n,
      transactionIndex: 0,
      from: zeroAddress,
      to: zeroAddress,
      gasUsed: 0n,
      cumulativeGasUsed: 0n,
      logs: [log],
    });
    expect(await client.getTransaction({ hash })).toMatchObject({
      hash,
      blockNumber: 11n,
      transactionIndex: 0,
      from: zeroAddress,
      to: zeroAddress,
      input: "0x",
      nonce: 0,
      gas: 0n,
      value: 0n,
    });
    expect((await client.getBlock({ blockNumber: 11n })).transactions).toEqual([hash]);
    expect((await client.getBlock({ blockNumber: 10n })).transactions).toEqual([]);
  });

  test("its receipt, transaction and block agree, raw too", async () => {
    const { mock, client, usdc } = setup();
    mock.setFees({ baseFeePerGas: parseGwei("30"), maxPriorityFeePerGas: parseGwei("2") });
    const { transactionHash: hash } = usdc.emit.Transfer({ from: alice, to: bob });

    const receipt = await client.getTransactionReceipt({ hash });
    const transaction = await client.getTransaction({ hash });
    const block = await client.getBlock({ blockNumber: 11n });
    expect(receipt.effectiveGasPrice).toBe(parseGwei("32"));
    expect(transaction.gasPrice).toBe(receipt.effectiveGasPrice);
    expect([transaction.type, transaction.blockHash, transaction.blockTimestamp]).toEqual([
      receipt.type,
      block.hash,
      block.timestamp,
    ]);
    expect(receipt.blockHash).toBe(block.hash);
    expect(receipt.logs[0]?.blockTimestamp).toBe(block.timestamp);
  });

  test("stays in its block after mine()", async () => {
    const { mock, client, usdc } = setup();
    const { transactionHash: hash } = usdc.emit.Transfer({ from: alice, to: bob });
    mock.mine(2);

    expect((await client.getTransactionReceipt({ hash })).blockNumber).toBe(11n);
    expect((await client.getTransaction({ hash })).blockNumber).toBe(11n);
    expect(await client.getTransactionConfirmations({ hash })).toBe(3n);
  });

  test("a block's transactions are indexed by when they were placed, after the ones there", async () => {
    const { mock, client, usdc, dai } = setup();
    const next = { blockNumber: 11n };
    const first = usdc.emit.Transfer({ from: alice, to: bob }, next);
    const second = dai.emit.Transfer({ from: bob, to: alice }, next);
    // Sent like a write: it mines the block, last.
    const sent = usdc.emit.Approval({ owner: alice, spender: bob });

    expect(mock.blockNumber).toBe(11n);
    const receipts = await Promise.all(
      [first, second, sent].map(({ transactionHash: hash }) =>
        client.getTransactionReceipt({ hash }),
      ),
    );
    expect(
      receipts.map((receipt) => [receipt.transactionIndex, receipt.logs[0]?.logIndex]),
    ).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
    const block = await client.getBlock({ blockNumber: 11n, includeTransactions: true });
    expect(
      block.transactions.map((transaction) => [transaction.hash, transaction.transactionIndex]),
    ).toEqual([
      [first.transactionHash, 0],
      [second.transactionHash, 1],
      [sent.transactionHash, 2],
    ]);
  });

  test("one transaction with several contracts' logs has all of them", async () => {
    const { mock, client, usdc, dai } = setup();
    const { logs } = mock.addTransaction({
      logs: [
        usdc.events.Transfer({ from: alice, to: bob, value: 5n }),
        dai.events.Transfer({ from: bob, to: alice, value: 4n }),
      ],
    });

    const receipt = await client.getTransactionReceipt({ hash: logs[0]!.transactionHash });
    expect(receipt.logs).toEqual(logs);
    expect(receipt.logs.map((log) => log.address)).toEqual([lowercase(USDC), lowercase(DAI)]);
  });

  test("in a block not mined yet, it's waiting: no receipt, and a pending transaction", async () => {
    const { mock, client, usdc } = setup();
    const { transactionHash: hash } = usdc.emit.Transfer(
      { from: alice, to: bob },
      { blockNumber: 11n },
    );

    expect(await mock.request({ method: "eth_getTransactionReceipt", params: [hash] })).toBeNull();
    expect(await client.getTransaction({ hash })).toMatchObject({
      blockNumber: null,
      blockHash: null,
      transactionIndex: null,
    });
    mock.mine();
    expect((await client.getTransactionReceipt({ hash })).blockNumber).toBe(11n);
    expect((await client.getBlock()).transactions).toEqual([hash]);
    expect(mock.unhandled).toEqual([]);
  });

  test("waitForTransactionReceipt resolves once its block is mined", async () => {
    const { mock, client, usdc } = setup();
    const { transactionHash: hash } = usdc.emit.Transfer(
      { from: alice, to: bob },
      { blockNumber: 11n },
    );

    const waiting = client.waitForTransactionReceipt({ hash, pollingInterval: 5 });
    mock.mine();
    expect((await waiting).blockNumber).toBe(11n);
  });

  test("an unknown hash is still unmocked, not a node's null", async () => {
    const { mock, client, usdc } = setup();
    usdc.emit.Transfer({ from: alice, to: bob });
    const hash = testHash("unknown");

    expectCause(await rejectionOf(client.getTransactionReceipt({ hash })), MockNotFoundError);
    expectCause(await rejectionOf(client.getTransaction({ hash })), MockNotFoundError);
    expect(mock.unhandled).toHaveLength(2);
  });

  test("a mock for its hash answers first: an override", async () => {
    const { mock, client, usdc } = setup();
    const { transactionHash: hash } = usdc.emit.Transfer({ from: alice, to: bob });
    mock.actions.getTransactionReceipt({ hash }).once().returns({ gasUsed: 5n });
    mock.actions
      .getTransactionReceipt({ hash })
      .once()
      .returns(() => null);
    mock.actions.getTransaction({ hash }).once().returns({ from: alice });

    expect((await client.getTransactionReceipt({ hash })).gasUsed).toBe(5n);
    expect(await mock.request({ method: "eth_getTransactionReceipt", params: [hash] })).toBeNull();
    expect((await client.getTransactionReceipt({ hash })).gasUsed).toBe(0n);
    expect((await client.getTransaction({ hash })).from).toBe(lowercase(alice));
    expect((await client.getTransaction({ hash })).from).toBe(zeroAddress);
  });

  test("a getBlock mock shows the block's transactions, unless it sets its own", async () => {
    const { mock, client, usdc } = setup();
    const { transactionHash: hash } = usdc.emit.Transfer({ from: alice, to: bob });
    mock.actions.getBlock({ blockNumber: 11n }).returns({ gasUsed: 5n });
    mock.actions.getBlock({ blockNumber: 10n }).returns({ transactions: [testHash("own")] });
    mock.actions.getBlock({ blockNumber: 9n }).returns(() => ({ gasUsed: 1n }));

    expect(await client.getBlock({ blockNumber: 11n })).toMatchObject({
      gasUsed: 5n,
      transactions: [hash],
    });
    const full = await client.getBlock({ blockNumber: 11n, includeTransactions: true });
    expect(full.transactions.map((transaction) => transaction.hash)).toEqual([hash]);
    expect((await client.getBlock({ blockNumber: 10n })).transactions).toEqual([testHash("own")]);
    usdc.emit.Transfer({ from: alice, to: bob }, { blockNumber: 9n });
    expect((await client.getBlock({ blockNumber: 9n })).transactions).toHaveLength(1);
  });

  test("a getBlock mock for a block the chain doesn't have lists none of its transactions", async () => {
    const { mock, client, usdc } = setup();
    usdc.emit.Transfer({ from: alice, to: bob }, { blockNumber: 10n });
    usdc.emit.Transfer({ from: alice, to: bob }, { blockNumber: 11n });
    const unknown = testHash("unknown block");
    mock.actions.getBlock({ blockHash: unknown }).returns({ gasUsed: 1n });
    mock.actions.getBlock({ blockNumber: 11n }).returns({ gasUsed: 2n });

    // Past the head: the transaction placed there isn't on the chain yet.
    expect((await client.getBlock({ blockNumber: 11n })).transactions).toEqual([]);
    // A hash only the mock knows isn't the head block, though its number defaults to the head.
    expect((await client.getBlock({ blockHash: unknown })).transactions).toEqual([]);
  });

  test("mock.transactions lists the records, by block and index", () => {
    const { mock, usdc } = setup();
    const later = usdc.emit.Transfer({ from: alice, to: bob });
    const earlier = usdc.emit.Transfer({ from: bob, to: alice }, { blockNumber: 5n });

    expect(mock.transactions).toEqual([
      {
        hash: earlier.transactionHash,
        origin: "added",
        fields: {},
        receipt: {},
        logs: [earlier],
        position: { blockNumber: 5n, index: 0 },
      },
      {
        hash: later.transactionHash,
        origin: "added",
        fields: {},
        receipt: {},
        logs: [later],
        position: { blockNumber: 11n, index: 0 },
      },
    ]);
    expect(Object.isFrozen(mock.transactions[0])).toBe(true);
  });

  test("records can't be changed, so the chain's answers can't either", async () => {
    const { mock, client, usdc } = setup();
    const { transactionHash: hash } = usdc.emit.Transfer({ from: alice, to: bob });
    const record = mock.transactions[0]!;

    for (const part of [record, record.fields, record.receipt, record.logs, record.position])
      expect(Object.isFrozen(part)).toBe(true);
    expect(Reflect.set(record.fields, "from", alice)).toBe(false);
    expect((await client.getTransaction({ hash })).from).toBe(zeroAddress);
  });

  test("historyLimit doesn't cap them", () => {
    const mock = createMockRpc({ blockNumber: 10n, historyLimit: 1 });
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    for (const value of [1n, 2n, 3n]) usdc.emit.Transfer({ from: alice, to: bob, value });

    expect(mock.transactions).toHaveLength(3);
    expect(mock.logs).toHaveLength(3);
  });
});

describe("state", () => {
  test("restore() removes logs emitted since the checkpoint, and keeps the baseline", async () => {
    const { mock, client, usdc } = setup();
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n });
    const checkpoint = mock.checkpoint();

    usdc.emit.Transfer({ from: alice, to: bob, value: 2n });
    checkpoint.restore();
    expect(mock.blockNumber).toBe(11n);
    expect((await client.getLogs({ address: USDC, fromBlock: 1n })).map((l) => l.data)).toEqual([
      usdc.events.Transfer({ from: alice, to: bob, value: 1n }).data,
    ]);
  });

  test("restore() between placing a transaction and mining its block keeps it waiting", async () => {
    const { mock, client, usdc } = setup();
    const { transactionHash: hash } = usdc.emit.Transfer(
      { from: alice, to: bob },
      { blockNumber: 11n },
    );
    const checkpoint = mock.checkpoint();
    mock.mine();
    usdc.emit.Transfer({ from: bob, to: alice });

    checkpoint.restore();
    expect(mock.blockNumber).toBe(10n);
    expect(mock.transactions.map((record) => record.hash)).toEqual([hash]);
    expect(await mock.request({ method: "eth_getTransactionReceipt", params: [hash] })).toBeNull();
    mock.mine();
    expect((await client.getTransactionReceipt({ hash })).blockNumber).toBe(11n);
  });

  test("clearCalls() keeps logs; reset() clears them", () => {
    const { mock, usdc } = setup();
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n });

    mock.clearCalls();
    expect(mock.logs).toHaveLength(1);
    expect(mock.transactions).toHaveLength(1);
    mock.reset();
    expect(mock.logs).toEqual([]);
    expect(mock.transactions).toEqual([]);
    expect(mock.blockNumber).toBe(10n);
    expectThrows(
      MockSetupError,
      `The contract at USDC (${USDC}) was removed by restore() or reset(); register it again.`,
      () => usdc.emit.Transfer({ from: alice, to: bob }),
    );
  });

  test("eth_getLogs can't be mocked raw", () => {
    const { mock } = setup();
    expectThrows(
      MockSetupError,
      '"eth_getLogs" has a typed mock: use mock.actions.getLogs().',
      // @ts-expect-error -- a typed action answers it
      () => mock.method("eth_getLogs"),
    );
  });
});

// Limits nodes enforce, as their public endpoints sent them (captured 2026-10-29).
// Linea's block range cap (geth-based):
const rangeTooLarge = { code: -32602, message: "range 49999 exceeds limit of 10000" };
// reth's own cap on results, with a range that would fit (Base's publicnode endpoint):
const tooManyResults = {
  code: -32602,
  message: "query exceeds max results 20000, retry with the range 53247950-53248109",
};

describe("mock.actions.getLogs", () => {
  test("a mock's logs replace the emitted ones", async () => {
    const { mock, client, usdc } = setup();
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n });
    const instead = mock.buildLog(usdc.events.Transfer({ from: bob, to: carol, value: 2n }), {
      blockNumber: 9n,
    });
    mock.actions.getLogs({ address: USDC }).returns([instead]);

    const logs = await client.getLogs({ address: USDC, event: transfer });
    expect(logs.map((log) => log.args.value)).toEqual([2n]);
  });

  test("returns() answers no logs", async () => {
    const { mock, client, usdc } = setup();
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n });
    mock.actions.getLogs().returns();

    expect(await client.getLogs({ address: USDC })).toEqual([]);
  });

  test("a resolver gets the filter and the store's logs: a node's block range cap", async () => {
    const { mock, client, usdc } = setup();
    const log = usdc.emit.Transfer({ from: alice, to: bob, value: 1n });
    mock.actions
      .getLogs()
      .returns(({ blockHash, fromBlock, toBlock, logs, fail }) =>
        blockHash === undefined && toBlock - fromBlock > 5n ? fail(rangeTooLarge) : logs,
      );

    const error = expectCause(
      await rejectionOf(client.getContractEvents({ abi: erc20Abi, address: USDC, fromBlock: 1n })),
      InvalidParamsRpcError,
    );
    expect(error.details).toBe(rangeTooLarge.message);
    const events = await client.getContractEvents({ abi: erc20Abi, address: USDC, fromBlock: 6n });
    expect(events.map((event) => event.transactionHash)).toEqual([log.transactionHash]);
  });

  test("a resolver can cap results, as reth does", async () => {
    const { mock, client, usdc } = setup();
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n }, { blockNumber: 9n });
    usdc.emit.Transfer({ from: alice, to: bob, value: 2n });
    mock.actions
      .getLogs()
      .returns(({ logs, fail }) => (logs.length > 1 ? fail(tooManyResults) : logs));

    const error = expectCause(
      await rejectionOf(client.getLogs({ address: USDC, fromBlock: 9n })),
      InvalidParamsRpcError,
    );
    expect(error.details).toBe(tooManyResults.message);
    expect(await client.getLogs({ address: USDC })).toHaveLength(1);
  });

  test("once() fails one request, then the store answers", async () => {
    const { mock, client, usdc } = setup();
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n });
    mock.actions.getLogs().once().fails(rangeTooLarge);

    await rejectionOf(client.getLogs({ address: USDC }));
    expect(await client.getLogs({ address: USDC })).toHaveLength(1);
  });

  test("a mock answers before the store's rules", async () => {
    const { mock, client } = setup();
    mock.actions.getLogs({ address: carol }).returns([]);
    mock.actions.getLogs({ fromBlock: 5n }).returns([]);

    expect(await client.getLogs({ address: carol })).toEqual([]);
    expect(await client.getLogs({ address: USDC, fromBlock: 5n, toBlock: 20n })).toEqual([]);
    expect(mock.unhandled).toEqual([]);
  });

  test("reading logs the store refuses throws its refusal, not a resolver error", async () => {
    const { mock, client } = setup();
    mock.actions.getLogs().returns(({ logs }) => logs);

    const refused = expectCause(
      await rejectionOf(client.getLogs({ address: USDC, fromBlock: 8n, toBlock: 7n })),
      RpcRequestError,
    );
    expect(refused.details).toBe("invalid block range params");
    expect(await client.getLogs({ address: carol })).toEqual([]);
    expect(mock.history.map((entry) => entry.outcome.type)).toEqual(["rpcError", "result"]);
  });

  test("pins match the decoded filter, with matchers", async () => {
    const { mock, client } = setup();
    mock.actions
      .getLogs({ fromBlock: match.where((block: bigint) => block < 5n, "early") })
      .fails(rangeTooLarge);

    expect(await client.getLogs({ address: USDC, fromBlock: 5n })).toEqual([]);
    await rejectionOf(client.getLogs({ address: USDC, fromBlock: 1n }));
    expect(mock.actions.getLogs.calls.map((call) => call.fromBlock)).toEqual([5n, 1n]);
  });

  test("calls record a range or a block hash, not both", async () => {
    const { mock, client } = setup();
    const { hash } = await client.getBlock({ blockNumber: 9n });

    await client.getLogs({ address: USDC, fromBlock: 1n });
    await client.getLogs({ address: USDC, blockHash: hash });
    expect(mock.actions.getLogs.calls).toStrictEqual([
      { address: USDC, topics: [], fromBlock: 1n, toBlock: 10n },
      { address: USDC, topics: [], blockHash: hash },
    ]);
  });

  test("a pinned list of addresses matches in any casing, and a malformed one fails at registration", async () => {
    const { mock, client } = setup();
    mock.actions.getLogs({ address: [lowercase(USDC), DAI] }).fails(rangeTooLarge);

    await rejectionOf(client.getLogs({ address: [USDC, DAI] }));
    expect(await client.getLogs({ address: [USDC] })).toEqual([]);
    expect(() => mock.actions.getLogs({ address: [USDC, "0x12"] })).toThrow(InvalidAddressError);
  });

  test("a matcher in a pinned list of addresses stands for any one address there", async () => {
    const { mock, client } = setup();
    mock.actions.getLogs({ address: [USDC, match.any<Address>()] }).fails(rangeTooLarge);

    await rejectionOf(client.getLogs({ address: [USDC, bob] }));
    expect(await client.getLogs({ address: [DAI, bob] })).toEqual([]);
  });

  test("an answer that isn't a list of logs fails at registration", () => {
    const { mock } = setup();

    expectThrows(MockSetupError, "getLogs's answer must be a list; got { logs: [] }.", () => {
      // @ts-expect-error -- getLogs answers a list
      mock.actions.getLogs().returns({ logs: [] });
    });
  });

  test("assertAllUsed() reports an unused mock with the filters it received", async () => {
    const { mock, client } = setup();
    mock.actions.getLogs({ address: DAI }).returns([]);

    await client.getLogs({ address: USDC });
    expectThrows(MockCheckError, `getLogs({ address: ${DAI} })`, () => {
      mock.assertAllUsed();
    });
  });

  test("refuses log content: nothing would place it", () => {
    const { mock, usdc } = setup();

    const error = expectThrows(MockSetupError, "log 0 in getLogs's answer has no position.", () => {
      // @ts-expect-error -- content, not a placed log
      mock.actions.getLogs().returns([usdc.events.Transfer({ from: alice, to: bob })]);
    });
    expect(error.metaMessages).toEqual([
      "Answer placed logs, e.g. from mock.logs or mock.buildLog().",
    ]);
  });

  test("refuses a log placed only in part", () => {
    const { mock, usdc } = setup();
    const content = usdc.events.Transfer({ from: alice, to: bob });

    expectThrows(MockSetupError, "log 0 in getLogs's answer has no position.", () => {
      // @ts-expect-error -- a block number alone doesn't place a log
      mock.actions.getLogs().returns([{ ...content, blockNumber: 9n }]);
    });
  });

  test("refuses a blockTimestamp that isn't a bigint", () => {
    const { mock, usdc } = setup();
    const log = usdc.emit.Transfer({ from: alice, to: bob });

    expectThrows(
      MockSetupError,
      "blockTimestamp of log 0 in getLogs's answer must be a non-negative bigint; got 0x5.",
      () => {
        // @ts-expect-error -- a log's blockTimestamp is a bigint
        mock.actions.getLogs().returns([{ ...log, blockTimestamp: "0x5" }]);
      },
    );
  });

  test("answers a log without blockTimestamp, as a node that doesn't send it", async () => {
    const { mock, client, usdc } = setup();
    const log = usdc.emit.Transfer({ from: alice, to: bob });
    mock.actions.getLogs().returns([{ ...log, blockTimestamp: undefined }]);

    const [answered] = await client.getLogs({ address: USDC });
    expect(answered).toBeDefined();
    expect(answered?.blockTimestamp).toBeUndefined();
  });
});
