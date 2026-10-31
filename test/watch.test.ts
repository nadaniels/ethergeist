import { createPublicClient, erc20Abi, parseAbiItem } from "viem";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { createMockRpc, testAddress } from "../src/index.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const alice = testAddress("alice");
const bob = testAddress("bob");
const transfer = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

function setup() {
  const mock = createMockRpc({ blockNumber: 10n });
  const client = mock.publicClient();
  const usdc = mock.contract({ abi: erc20Abi, address: USDC });
  return { mock, client, usdc };
}

/** Collects what a watcher delivers, one entry per `onLogs` call. */
function collector() {
  const batches: bigint[][] = [];
  return {
    batches,
    onLogs: (logs: readonly { args: { value?: bigint | undefined } }[]) => {
      batches.push(logs.map((log) => log.args.value ?? 0n));
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("watchContractEvent", () => {
  test("delivers a log emitted into a newly mined block", async () => {
    const { mock, client, usdc } = setup();
    const { batches, onLogs } = collector();
    const unwatch = client.watchContractEvent({
      abi: erc20Abi,
      address: USDC,
      eventName: "Transfer",
      onLogs,
    });

    // The first polls only note the current block; let them happen first.
    await vi.waitFor(() => {
      expect(mock.requests.map((r) => r.method)).toContain("eth_blockNumber");
    });
    usdc.emit.Transfer({ from: alice, to: bob, value: 5n }, { mine: true });
    await vi.waitFor(() => {
      expect(batches).toEqual([[5n]]);
    });
    unwatch();
  });

  test("filters are refused as many public nodes refuse them, which isn't unhandled", async () => {
    const { mock, client, usdc } = setup();
    const { batches, onLogs } = collector();
    const unwatch = client.watchContractEvent({
      abi: erc20Abi,
      address: USDC,
      eventName: "Transfer",
      onLogs,
    });

    await vi.waitFor(() => {
      expect(mock.requests.map((r) => r.method)).toContain("eth_blockNumber");
    });
    usdc.emit.Transfer({ from: alice, to: bob, value: 5n }, { mine: true });
    await vi.waitFor(() => {
      expect(batches).toHaveLength(1);
    });
    unwatch();

    expect(() => {
      mock.assertNoUnhandled();
    }).not.toThrow();
    expect(mock.history[0]).toMatchObject({
      method: "eth_newFilter",
      outcome: {
        type: "rpcError",
        code: -32601,
        message: "the method eth_newFilter does not exist/is not available",
      },
    });
  });

  test("logs from before the watcher started aren't delivered", async () => {
    const { mock, client, usdc } = setup();
    const { batches, onLogs } = collector();
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n });
    const unwatch = client.watchContractEvent({
      abi: erc20Abi,
      address: USDC,
      eventName: "Transfer",
      onLogs,
    });

    await vi.waitFor(() => {
      expect(mock.requests.map((r) => r.method)).toContain("eth_blockNumber");
    });
    usdc.emit.Transfer({ from: alice, to: bob, value: 2n }, { mine: true });
    await vi.waitFor(() => {
      expect(batches).toEqual([[2n]]);
    });
    unwatch();
  });

  test("blocks mined between polls are all read, in one batch or one log at a time", async () => {
    const { mock, client, usdc } = setup();
    const batched = collector();
    const single = collector();
    const unwatchBatched = client.watchContractEvent({
      abi: erc20Abi,
      address: USDC,
      eventName: "Transfer",
      onLogs: batched.onLogs,
    });
    const unwatchSingle = client.watchContractEvent({
      abi: erc20Abi,
      address: USDC,
      eventName: "Transfer",
      batch: false,
      onLogs: single.onLogs,
    });

    await vi.waitFor(() => {
      expect(mock.requests.map((r) => r.method)).toContain("eth_blockNumber");
    });
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n }, { mine: true });
    usdc.emit.Transfer({ from: alice, to: bob, value: 2n }, { mine: true });
    await vi.waitFor(() => {
      expect(batched.batches.flat()).toEqual([1n, 2n]);
    });
    await vi.waitFor(() => {
      expect(single.batches).toEqual([[1n], [2n]]);
    });
    unwatchBatched();
    unwatchSingle();
  });
});

describe("watchEvent", () => {
  test("works the same way, filtered by its args", async () => {
    const { mock, client, usdc } = setup();
    const { batches, onLogs } = collector();
    const unwatch = client.watchEvent({
      address: USDC,
      event: transfer,
      args: { to: bob },
      onLogs,
    });

    await vi.waitFor(() => {
      expect(mock.requests.map((r) => r.method)).toContain("eth_blockNumber");
    });
    mock.emit(
      [
        usdc.events.Transfer({ from: alice, to: alice, value: 1n }),
        usdc.events.Transfer({ from: alice, to: bob, value: 2n }),
      ],
      { mine: true },
    );
    await vi.waitFor(() => {
      expect(batches).toEqual([[2n]]);
    });
    unwatch();
  });
});

describe("polling", () => {
  test("publicClient() polls every 50ms unless told otherwise", () => {
    const { mock } = setup();
    expect(mock.publicClient().pollingInterval).toBe(50);
    expect(mock.publicClient({ pollingInterval: 1000 }).pollingInterval).toBe(1000);
  });

  test("with fake timers, a client's own interval needn't be short", async () => {
    vi.useFakeTimers();
    const { mock, usdc } = setup();
    // viem's default for mainnet is 4s.
    const client = createPublicClient({ chain: mock.chain, transport: mock.transport() });
    const { batches, onLogs } = collector();
    const unwatch = client.watchContractEvent({
      abi: erc20Abi,
      address: USDC,
      eventName: "Transfer",
      onLogs,
    });

    // One poll at a time, whatever the interval: the first notes the current block,
    // the next reads the block mined after it.
    await vi.runOnlyPendingTimersAsync();
    usdc.emit.Transfer({ from: alice, to: bob, value: 5n }, { mine: true });
    await vi.runOnlyPendingTimersAsync();
    expect(batches).toEqual([[5n]]);
    unwatch();
  });
});

describe("filters through mock.method()", () => {
  test("override the refusal, for code that uses filters directly", async () => {
    const { mock, client } = setup();
    mock.method("eth_newFilter").returns("0x1");
    mock.method("eth_getFilterChanges").returns([]);

    const filter = await client.createEventFilter({ address: USDC, event: transfer });
    expect(await client.getFilterChanges({ filter })).toEqual([]);
  });
});
