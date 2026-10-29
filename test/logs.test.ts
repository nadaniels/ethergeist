import {
  InvalidInputRpcError,
  InvalidParamsRpcError,
  RpcRequestError,
  createPublicClient,
  encodeEventTopics,
  erc20Abi,
  parseAbiItem,
} from "viem";
import { describe, expect, test } from "vite-plus/test";
import { MockNotFoundError, buildLog, createMockRpc, testAddress, testHash } from "../src/index.js";
import { expectCause, lowercase, rejectionOf } from "./utils.js";

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

/** The RPC error a request rejects with, after checking it isn't counted as unhandled. */
async function refusal(mock: ReturnType<typeof setup>["mock"], promise: Promise<unknown>) {
  const error = expectCause(await rejectionOf(promise), RpcRequestError);
  expect(mock.unhandled).toEqual([]);
  return { code: error.code, message: error.details };
}

describe("emit", () => {
  test("puts a log in the current block, found by getLogs and decoded by viem", async () => {
    const { client, usdc } = setup();

    const log = usdc.emit.Transfer({ from: alice, to: bob, value: 5n });
    const [found] = await client.getLogs({ address: USDC, event: transfer });

    expect(found).toEqual({
      ...log,
      eventName: "Transfer",
      args: { from: alice, to: bob, value: 5n },
    });
    const block = await client.getBlock({ blockNumber: 10n });
    expect(log).toMatchObject({
      blockNumber: 10n,
      blockHash: block.hash,
      blockTimestamp: block.timestamp,
      logIndex: 0,
      transactionIndex: 0,
      transactionHash: testHash("tx:10:0"),
      removed: false,
    });
  });

  test("{ mine: true } mines a block and puts the log in it", () => {
    const { mock, usdc } = setup();

    const log = usdc.emit.Transfer({ from: alice, to: bob, value: 5n }, { mine: true });
    expect(mock.blockNumber).toBe(11n);
    expect(log.blockNumber).toBe(11n);
  });

  test("one call is one transaction; each call is the block's next", () => {
    const { mock, usdc, dai } = setup();

    const swap = mock.emit([
      usdc.events.Transfer({ from: alice, to: bob, value: 5n }),
      dai.events.Transfer({ from: bob, to: alice, value: 4n }),
    ]);
    const next = usdc.emit.Approval({ owner: alice, spender: bob, value: 1n });

    expect(swap.map((log) => [log.transactionIndex, log.logIndex])).toEqual([
      [0, 0],
      [0, 1],
    ]);
    expect(swap[0]?.transactionHash).toBe(swap[1]?.transactionHash);
    expect([next.transactionIndex, next.logIndex]).toEqual([1, 2]);
    expect(next.transactionHash).not.toBe(swap[0]?.transactionHash);
  });

  test("takes a block and transaction from its options", () => {
    const { mock, usdc } = setup();
    const hash = testHash("swap-1");

    const log = mock.emit(usdc.events.Transfer({ from: alice, to: bob, value: 5n }), {
      blockNumber: 4n,
      transactionHash: hash,
      transactionIndex: 3,
    });
    expect(log).toMatchObject({ blockNumber: 4n, transactionHash: hash, transactionIndex: 3 });
  });

  test("an existing transaction hash adds logs to that transaction", () => {
    const { mock, usdc } = setup();
    const hash = testHash("swap-1");

    usdc.emit.Transfer({ from: alice, to: bob, value: 5n }, { transactionHash: hash });
    const added = usdc.emit.Transfer(
      { from: bob, to: carol, value: 5n },
      { transactionHash: hash },
    );
    expect([added.transactionIndex, added.logIndex]).toEqual([0, 1]);

    usdc.emit.Transfer({ from: carol, to: alice, value: 1n });
    expect(() =>
      mock.emit(usdc.events.Transfer({ from: alice, to: bob }), { transactionHash: hash }),
    ).toThrow(
      `Transaction ${hash} isn't the last in block 10; logs can only be added to a block's last transaction.`,
    );
    expect(() =>
      mock.emit(usdc.events.Transfer({ from: alice, to: bob }), {
        transactionHash: hash,
        blockNumber: 9n,
      }),
    ).toThrow(`Transaction ${hash} is in block 10; a transaction's logs are all in one block.`);
  });

  test("a block's transactions go in order", () => {
    const { usdc } = setup();

    usdc.emit.Transfer({ from: alice, to: bob }, { transactionIndex: 2 });
    expect(() => usdc.emit.Transfer({ from: alice, to: bob }, { transactionIndex: 1 })).toThrow(
      "Transaction index 1 in block 10 isn't after the block's last transaction (2); emit a " +
        "block's transactions in order.",
    );
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
    const other = createMockRpc().contract({ abi: erc20Abi, address: carol });
    const log = usdc.events.Transfer({ from: alice, to: bob });

    expect(() => mock.emit([])).toThrow("emit() requires at least one log.");
    expect(() => mock.emit(log, { mine: true, blockNumber: 3n })).toThrow(
      "emit() takes `mine` or `blockNumber`, not both.",
    );
    expect(() =>
      mock.emit(
        buildLog({
          abi: erc20Abi,
          address: USDC,
          eventName: "Transfer",
          args: { from: alice, to: bob },
        }),
      ),
    ).toThrow(
      "emit() places logs itself, but this one already has a position (e.g. from buildLog()). " +
        "Pass a log from contract.events, and set its block or transaction in emit()'s options.",
    );
    expect(() => mock.emit(other.events.Transfer({ from: alice, to: bob }))).toThrow(
      `No mocked contract at ${carol} to emit this log; register it with contract().`,
    );
  });

  test("returns frozen logs: changing one throws", () => {
    const { mock, usdc } = setup();

    const log = usdc.emit.Transfer({ from: alice, to: bob, value: 5n });
    expect(() => {
      // @ts-expect-error -- read-only
      log.logIndex = 7;
    }).toThrow(TypeError);
    expect(() => {
      (log.topics as unknown[]).push("0x");
    }).toThrow(TypeError);
    expect(Object.isFrozen(mock.logs[0])).toBe(true);
    // A changed log is a spread away.
    expect({ ...log, logIndex: 7 }.logIndex).toBe(7);
  });

  test("mock.logs lists every log by block and log index", () => {
    const { mock, usdc } = setup();

    usdc.emit.Transfer({ from: alice, to: bob, value: 2n });
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n }, { blockNumber: 3n });
    expect(mock.logs.map((log) => log.blockNumber)).toEqual([3n, 10n]);
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
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n });
    usdc.emit.Transfer({ from: bob, to: carol, value: 2n });
    usdc.emit.Transfer({ from: carol, to: alice, value: 3n });

    const values = async (args: { from?: `0x${string}` | `0x${string}`[]; to?: `0x${string}` }) =>
      (await client.getLogs({ address: USDC, event: transfer, args })).map((l) => l.args.value);
    expect(await values({ from: alice })).toEqual([1n]);
    expect(await values({ from: [alice, carol] })).toEqual([1n, 3n]);
    expect(await values({ to: alice })).toEqual([3n]);
    expect(await values({})).toEqual([1n, 2n, 3n]);
  });

  test("by event, including all of an ABI's events", async () => {
    const { client, usdc } = setup();
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n });
    usdc.emit.Approval({ owner: alice, spender: bob, value: 2n });

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

  test("an address without a mocked contract is unhandled; an empty one has no logs", async () => {
    const { mock, client } = setup();
    mock.empty(alice);

    expect(await client.getLogs({ address: alice })).toEqual([]);
    const error = expectCause(
      await rejectionOf(client.getLogs({ address: [USDC, bob] })),
      MockNotFoundError,
    );
    expect(error.shortMessage).toBe(`No mocked contract at ${bob}.`);
    expect(mock.unhandled).toHaveLength(1);
  });

  test("answers in JSON-RPC form, as a node sends them", async () => {
    const { mock, usdc } = setup();
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n });

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

  test("a block hash with a range", async () => {
    const { mock } = setup();
    expect(
      await refusal(mock, getLogsRaw(mock, { blockHash: testHash("block"), fromBlock: "0x1" })),
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
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n });

    await client.getLogs({ address: USDC, event: transfer, args: { from: alice } });
    await client.getContractEvents({ abi: erc20Abi, address: [USDC, DAI], fromBlock: 1n });
    await rejectionOf(client.getLogs({ address: USDC, fromBlock: 8n, toBlock: 7n }));
    expect(mock.formatHistory({ builtIns: false }).split("\n")).toEqual([
      "#1 eth_getLogs getLogs(USDC, Transfer(from: 0xa41f…2D9e), block 10) → 1 log",
      "#2 eth_getLogs getLogs([USDC, DAI], Approval | Transfer, blocks 1–10) → 1 log",
      "#3 eth_getLogs getLogs(USDC, blocks 8–7) ✗ rpc error -32602: invalid block range params",
    ]);
  });

  test("records the decoded filter and the logs in viem's types", async () => {
    const { mock, client, usdc } = setup();
    const log = usdc.emit.Transfer({ from: alice, to: bob, value: 1n });

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

describe("state", () => {
  test("restore() removes logs emitted since the checkpoint, and keeps the baseline", async () => {
    const { mock, client, usdc } = setup();
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n });
    const checkpoint = mock.checkpoint();

    usdc.emit.Transfer({ from: alice, to: bob, value: 2n }, { mine: true });
    checkpoint.restore();
    expect(mock.blockNumber).toBe(10n);
    expect((await client.getLogs({ address: USDC, fromBlock: 1n })).map((l) => l.data)).toEqual([
      usdc.events.Transfer({ from: alice, to: bob, value: 1n }).data,
    ]);
  });

  test("clearCalls() keeps logs; reset() clears them", () => {
    const { mock, usdc } = setup();
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n });

    mock.clearCalls();
    expect(mock.logs).toHaveLength(1);
    mock.reset();
    expect(mock.logs).toEqual([]);
    expect(() => usdc.emit.Transfer({ from: alice, to: bob })).toThrow(
      `The contract at USDC (${USDC}) was removed by restore() or reset(); register it again.`,
    );
  });

  test("eth_getLogs can't be mocked raw", () => {
    const { mock } = setup();
    expect(() => mock.method("eth_getLogs")).toThrow(
      '"eth_getLogs" is answered from emitted logs: use mock.emit().',
    );
  });
});
