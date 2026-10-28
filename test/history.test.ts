import { createPublicClient, erc20Abi, getAddress, parseAbi, zeroHash } from "viem";
import { base } from "viem/chains";
import { describe, expect, expectTypeOf, test } from "vite-plus/test";
import {
  type MockHistoryEntry,
  MockNotFoundError,
  MockResolverError,
  createMockRpc,
} from "../src/index.js";
import { rejectionOf } from "./utils.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const NOWHERE = "0x000000000000000000000000000000000000dEaD";
const alice = "0x00000000000000000000000000000000000a11ce";

// OpenZeppelin's Pausable error, alongside the ERC-20.
const tokenAbi = [...erc20Abi, ...parseAbi(["error EnforcedPause()"])];

function setup({
  retryCount = 0,
  debug,
}: { retryCount?: number; debug?: (line: string) => void } = {}) {
  const mock = createMockRpc({ chain: base, blockNumber: 10n, ...(debug ? { debug } : {}) });
  const client = createPublicClient({
    chain: mock.chain,
    cacheTime: 0,
    transport: mock.transport({ retryCount }),
  });
  const read = (address: `0x${string}`, functionName: "decimals" | "symbol") =>
    client.readContract({ abi: tokenAbi, address, functionName });
  return { mock, client, read };
}

function isType<type extends MockHistoryEntry["type"]>(
  entry: MockHistoryEntry | undefined,
  type: type,
): entry is Extract<MockHistoryEntry, { type: type }> {
  return entry?.type === type;
}

/** The only entry, narrowed to `type`. */
function only<type extends MockHistoryEntry["type"]>(
  entries: MockHistoryEntry[],
  type: type,
): Extract<MockHistoryEntry, { type: type }> {
  expect(entries).toHaveLength(1);
  const [entry] = entries;
  if (!isType(entry, type)) throw new Error(`expected a ${type} entry, got ${entry?.type}`);
  return entry;
}

describe("history entries", () => {
  test("a contract call, with its result in viem's types", async () => {
    const { mock, read } = setup();
    mock.contract({ abi: tokenAbi, address: USDC, name: "USDC" }).read.decimals().returns(6);

    await read(USDC, "decimals");
    const entry = only(mock.history, "call");
    expect(entry.to).toBe(USDC);
    expect(entry.call).toMatchObject({
      address: USDC,
      name: "USDC",
      call: { functionName: "decimals", args: [] },
      outcome: { type: "result", value: 6 },
    });
    expect(entry.outcome).toEqual({ type: "result", value: 6 });
  });

  test("reverts are decoded: custom errors and reason strings", async () => {
    const { mock, read } = setup();
    const usdc = mock.contract({ abi: tokenAbi, address: USDC });
    usdc.read.decimals().reverts({ errorName: "EnforcedPause" });
    usdc.read.symbol().reverts("paused");

    await rejectionOf(read(USDC, "decimals"));
    await rejectionOf(read(USDC, "symbol"));
    expect(mock.history.map((e) => e.outcome)).toMatchObject([
      { type: "revert", errorName: "EnforcedPause", args: [] },
      { type: "revert", reason: "paused" },
    ]);
  });

  test("faults record where they came from; retries are separate entries", async () => {
    const { mock, read } = setup({ retryCount: 1 });
    mock.contract({ abi: tokenAbi, address: USDC }).read.decimals().fails({ status: 503 });
    mock.contract({ abi: tokenAbi, address: DAI }).read.decimals().returns(18);

    await rejectionOf(read(USDC, "decimals"));
    mock.failRequests("timeout", { times: 1 });
    await read(DAI, "decimals");

    expect(mock.history.map((e) => e.outcome)).toMatchObject([
      { type: "fault", fault: { status: 503 }, source: "mock" },
      { type: "fault", fault: { status: 503 }, source: "mock" },
      { type: "fault", fault: "timeout", source: "failRequests" },
      { type: "result", value: 18 },
    ]);
  });

  test("unhandled requests and resolver errors", async () => {
    const { mock, read } = setup();
    mock
      .contract({ abi: tokenAbi, address: USDC })
      .read.decimals()
      .returns(() => {
        throw new Error("boom");
      });

    await rejectionOf(read(USDC, "decimals"));
    await rejectionOf(read(DAI, "decimals"));
    const [threw, missing] = mock.history;
    expect(threw?.outcome.type === "unhandled" && threw.outcome.error).toBeInstanceOf(
      MockResolverError,
    );
    expect(missing).toMatchObject({
      type: "call",
      to: DAI,
      call: { address: DAI, call: undefined, outcome: { type: "unhandled" } },
    });
    expect(missing?.outcome.type === "unhandled" && missing.outcome.error).toBeInstanceOf(
      MockNotFoundError,
    );
  });

  test("a multicall lists each sub-call with its own outcome", async () => {
    const { mock, client } = setup();
    mock.contract({ abi: tokenAbi, address: USDC, name: "USDC" }).read.decimals().returns(6);
    mock.contract({ abi: tokenAbi, address: DAI }).read.decimals().reverts("paused");
    mock.empty(NOWHERE);

    await client.multicall({
      contracts: [
        { abi: tokenAbi, address: USDC, functionName: "decimals" },
        { abi: tokenAbi, address: DAI, functionName: "decimals" },
        { abi: tokenAbi, address: NOWHERE, functionName: "decimals" },
      ],
    });
    const entry = only(mock.history, "multicall");
    expect(entry.batchId).toBe(1);
    expect(entry.calls).toMatchObject([
      { name: "USDC", call: { functionName: "decimals" }, outcome: { type: "result", value: 6 } },
      { address: DAI, outcome: { type: "revert", reason: "paused" } },
      { address: NOWHERE, call: undefined, outcome: { type: "result", value: "0x" } },
    ]);
    expect(entry.outcome).toMatchObject({
      type: "result",
      value: [{ success: true }, { success: false }, { success: true }],
    });
  });

  test("actions record their call, and their value in viem's types", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: alice }).returns(5n);

    await client.getBalance({ address: alice });
    await client.getBlock();
    const [balance, block] = mock.history;
    expect(balance).toMatchObject({
      type: "action",
      action: "getBalance",
      call: { address: getAddress(alice), blockNumber: 10n },
      outcome: { type: "result", value: 5n },
    });
    expect(block).toMatchObject({
      type: "action",
      action: "getBlock",
      outcome: { type: "result", value: { number: 10n, timestamp: 1_700_000_000n } },
    });
  });

  test("raw methods and built-ins", async () => {
    const { mock, client } = setup();
    mock.method("eth_gasPrice").returns("0x1");

    await client.getGasPrice();
    await client.getChainId();
    await client.getBlockNumber();
    expect(mock.history).toMatchObject([
      { type: "method", method: "eth_gasPrice", outcome: { type: "result", value: "0x1" } },
      { type: "builtIn", method: "eth_chainId", outcome: { type: "result", value: base.id } },
      { type: "builtIn", method: "eth_blockNumber", outcome: { type: "result", value: 10n } },
    ]);
  });

  test("an entry is pending until its answer arrives", async () => {
    const { mock, read } = setup();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    mock
      .contract({ abi: tokenAbi, address: USDC })
      .read.decimals()
      .returns(async () => {
        await gate;
        return 6;
      });

    const pending = read(USDC, "decimals");
    await Promise.resolve();
    expect(mock.history[0]?.outcome).toEqual({ type: "pending" });
    release();
    await pending;
    expect(mock.history[0]?.outcome).toEqual({ type: "result", value: 6 });
  });

  test("clearCalls(), restore(), and reset() clear it", async () => {
    const { mock, read } = setup();
    mock.contract({ abi: tokenAbi, address: USDC }).read.decimals().returns(6);
    const baseline = mock.checkpoint();

    await read(USDC, "decimals");
    mock.clearCalls();
    expect(mock.history).toEqual([]);
    await read(USDC, "decimals");
    baseline.restore();
    expect(mock.history).toEqual([]);
    await read(USDC, "decimals");
    mock.reset();
    expect(mock.history).toEqual([]);
  });

  test("entries narrow on type and outcome.type", () => {
    const { mock } = setup();
    for (const entry of mock.history) {
      if (entry.type === "multicall") expectTypeOf(entry.calls).toBeArray();
      if (entry.type === "action" && entry.action === "getBalance")
        expectTypeOf(entry.call).toEqualTypeOf<
          { address: `0x${string}`; blockNumber: bigint } | undefined
        >();
      if (entry.outcome.type === "revert")
        expectTypeOf(entry.outcome.data).toEqualTypeOf<`0x${string}`>();
    }
  });
});

describe("formatHistory()", () => {
  test("one line per request, and per multicall sub-call", async () => {
    const { mock, client, read } = setup({ retryCount: 1 });
    const usdc = mock.contract({ abi: tokenAbi, address: USDC, name: "USDC" });
    usdc.read.decimals().returns(6);
    usdc.read.balanceOf([alice]).returns(5n);
    usdc.read.symbol().fails({ status: 503 });
    mock
      .contract({ abi: tokenAbi, address: DAI })
      .read.decimals()
      .reverts({ errorName: "EnforcedPause" });
    mock.actions.getBalance().returns(10n ** 18n);

    await read(USDC, "decimals");
    await client.multicall({
      contracts: [
        { abi: tokenAbi, address: USDC, functionName: "balanceOf", args: [alice] },
        { abi: tokenAbi, address: DAI, functionName: "decimals" },
      ],
    });
    await rejectionOf(read(USDC, "symbol"));
    await client.getBalance({ address: alice });
    await rejectionOf(client.getGasPrice());
    await client.getBlockNumber();

    expect(mock.formatHistory()).toBe(
      [
        "#1 eth_call USDC.decimals() → 6",
        "#2 eth_call multicall, batch 1 (2 calls)",
        "   ├ USDC.balanceOf(0x0000…11cE) → 5n",
        "   └ 0x6B17…1d0F.decimals() ✗ reverted: EnforcedPause()",
        "#3 eth_call USDC.symbol() ✗ fault: HTTP 503",
        "#4 eth_call (retry) USDC.symbol() ✗ fault: HTTP 503",
        "#5 eth_getBalance getBalance({ address: 0x0000…11cE, blockNumber: 10n }) → 1000000000000000000n",
        "#6 eth_gasPrice ✗ not mocked",
        "#7 eth_blockNumber → 10n",
      ].join("\n"),
    );
  });

  test("builtIns: false leaves out eth_chainId and eth_blockNumber, keeping numbers", async () => {
    const { mock, client } = setup();
    mock.method("eth_gasPrice").returns("0x1");

    await client.getBlockNumber();
    await client.getGasPrice();
    expect(mock.formatHistory({ builtIns: false })).toBe("#2 eth_gasPrice → 0x1");
  });

  test("blocks and receipts are summarized", async () => {
    const { mock, client } = setup();
    mock.actions.getTransactionReceipt().returns({ logs: [{ address: USDC }] });

    await client.getBlock();
    await client.getTransactionReceipt({ hash: zeroHash });
    expect(mock.formatHistory()).toBe(
      [
        "#1 eth_getBlockByNumber getBlock({ blockNumber: 10n, blockTag: latest, includeTransactions: false }) → block 10n, timestamp 1700000000n",
        "#2 eth_getTransactionReceipt getTransactionReceipt({ hash: 0x0000…0000 }) → success, block 10n, 1 log(s)",
      ].join("\n"),
    );
  });

  test("resolver errors show what threw", async () => {
    const { mock, read } = setup();
    mock
      .contract({ abi: tokenAbi, address: USDC, name: "USDC" })
      .read.decimals()
      .returns(() => {
        throw new Error("boom");
      });

    await rejectionOf(read(USDC, "decimals"));
    expect(mock.formatHistory()).toBe("#1 eth_call USDC.decimals() ✗ resolver threw: boom");
  });
});

describe("debug", () => {
  test("a function gets each line as its request finishes, with the entry", async () => {
    const lines: string[] = [];
    const entries: MockHistoryEntry[] = [];
    const mock = createMockRpc({
      debug: (line, entry) => {
        lines.push(line);
        entries.push(entry);
      },
    });
    mock.contract({ abi: tokenAbi, address: USDC, name: "USDC" }).read.decimals().returns(6);

    await mock
      .publicClient()
      .readContract({ abi: tokenAbi, address: USDC, functionName: "decimals" });
    expect(lines).toEqual(["#1 eth_call USDC.decimals() → 6"]);
    expect(entries[0]?.type).toBe("call");
  });

  test("true logs with console.log", async () => {
    const logged: unknown[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logged.push(...args);
    };
    try {
      const mock = createMockRpc({ debug: true });
      await mock.publicClient().getChainId();
    } finally {
      console.log = original;
    }
    expect(logged).toEqual([`#1 eth_chainId → 1`]);
  });
});
