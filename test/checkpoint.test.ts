import { HttpRequestError, createPublicClient, erc20Abi, getAddress } from "viem";
import { base } from "viem/chains";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vite-plus/test";
import { type MockCheckpoint, MockNotFoundError, createMockRpc } from "../src/index.js";
import { expectCause, rejectionOf } from "./utils.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const NOWHERE = "0x000000000000000000000000000000000000dEaD";
const alice = "0x00000000000000000000000000000000000a11ce";

function setup() {
  const mock = createMockRpc({ chain: base, blockNumber: 10n });
  const client = createPublicClient({
    chain: mock.chain,
    cacheTime: 0,
    transport: mock.transport({ retryCount: 0 }),
  });
  const read = (address: `0x${string}`, functionName: "decimals" | "symbol") =>
    client.readContract({ abi: erc20Abi, address, functionName });
  const balanceOf = () =>
    client.readContract({ abi: erc20Abi, address: USDC, functionName: "balanceOf", args: [alice] });
  return { mock, client, read, balanceOf };
}

describe("restore()", () => {
  test("drops mocks registered since, and keeps the baseline", async () => {
    const { mock, client, read, balanceOf } = setup();
    const usdc = mock.contract({
      abi: erc20Abi,
      address: USDC,
      defaults: { read: { decimals: 6 } },
    });
    usdc.read.balanceOf([alice]).returns(5n);
    usdc.read.symbol().fails({ status: 503 });
    mock.empty(NOWHERE);
    mock.actions.getBalance().returns(1n);
    mock.method("eth_gasPrice").returns("0x1");
    const baseline = mock.checkpoint();

    usdc.read.decimals().returns(18);
    usdc.read.balanceOf([alice]).returns(99n);
    mock.actions.getBalance().returns(2n);
    mock.method("eth_gasPrice").returns("0x2");
    baseline.restore();

    expect(await read(USDC, "decimals")).toBe(6);
    expect(await balanceOf()).toBe(5n);
    expectCause(await rejectionOf(read(USDC, "symbol")), HttpRequestError);
    expect(await client.getCode({ address: NOWHERE })).toBeUndefined();
    expect(await client.getBalance({ address: alice })).toBe(1n);
    expect(await client.getGasPrice()).toBe(1n);
  });

  test("puts back a baseline mock's answer when its builder is reused", async () => {
    const { mock, balanceOf } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    const balance = usdc.read.balanceOf([alice]);
    balance.returns(5n);
    const baseline = mock.checkpoint();

    balance.returns(1n);
    expect(await balanceOf()).toBe(1n);
    baseline.restore();
    expect(await balanceOf()).toBe(5n);
  });

  test("contracts, empty addresses, and raw methods registered since are gone", async () => {
    const { mock, client, read } = setup();
    const baseline = mock.checkpoint();
    const dai = mock.contract({ abi: erc20Abi, address: DAI });
    dai.read.decimals().returns(18);
    mock.empty(NOWHERE);
    mock.method("eth_gasPrice").returns("0x1");

    baseline.restore();
    expectCause(await rejectionOf(read(DAI, "decimals")), MockNotFoundError);
    expectCause(await rejectionOf(client.getCode({ address: NOWHERE })), MockNotFoundError);
    expectCause(await rejectionOf(client.getGasPrice()), MockNotFoundError);
    // The addresses are free to register again.
    mock.contract({ abi: erc20Abi, address: DAI });
    mock.empty(NOWHERE);
  });

  test("handles and builders from since throw instead of silently not answering", () => {
    const { mock } = setup();
    const baseline = mock.checkpoint();
    const dai = mock.contract({ abi: erc20Abi, address: DAI });
    const decimals = dai.read.decimals();
    const balance = mock.actions.getBalance();

    baseline.restore();
    expect(() => dai.read.symbol()).toThrow("was removed by restore() or reset()");
    expect(() => {
      decimals.returns(18);
    }).toThrow("This mock was removed");
    expect(() => {
      balance.returns(1n);
    }).toThrow("This mock was removed");
  });

  test("a removed contract's history can still be read", async () => {
    const { mock, read } = setup();
    const baseline = mock.checkpoint();
    const dai = mock.contract({ abi: erc20Abi, address: DAI });
    dai.read.decimals().returns(18);
    await read(DAI, "decimals");

    baseline.restore();
    expect(() => dai.calls).not.toThrow();
  });

  test("the block number and batch ids go back", async () => {
    const { mock, client } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);
    const batchId = async () => {
      await client.multicall({
        contracts: [{ abi: erc20Abi, address: USDC, functionName: "decimals" }],
      });
      return mock.calls.at(-1)?.batch?.id;
    };
    const baseline = mock.checkpoint();

    mock.mine(5n);
    const first = await batchId();
    baseline.restore();
    expect(mock.blockNumber).toBe(10n);
    expect(await batchId()).toBe(first);
  });

  test("faults go back, including their counts and clear()", async () => {
    const { mock, read } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);
    const outage = mock.failRequests({ status: 503 }, { times: 2 });
    const baseline = mock.checkpoint();

    await rejectionOf(read(USDC, "decimals"));
    outage.clear();
    mock.failRequests("timeout");
    baseline.restore();

    expect(outage.count).toBe(0);
    expectCause(await rejectionOf(read(USDC, "decimals")), HttpRequestError);
    expectCause(await rejectionOf(read(USDC, "decimals")), HttpRequestError);
    expect(await read(USDC, "decimals")).toBe(6);
  });

  test("history and usage are cleared", async () => {
    const { mock, balanceOf } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.balanceOf([alice]).returns(5n);
    const baseline = mock.checkpoint();

    await balanceOf();
    baseline.restore();
    expect(mock.calls).toEqual([]);
    expect(mock.requests).toEqual([]);
    expect(usdc.read.balanceOf.calls).toEqual([]);
    // Used in the last "test", but not in this one.
    expect(() => {
      mock.assertAllUsed();
    }).toThrow("balanceOf");
  });

  test("can be restored repeatedly", async () => {
    const { mock, read } = setup();
    mock.contract({ abi: erc20Abi, address: USDC, defaults: { read: { decimals: 6 } } });
    const baseline = mock.checkpoint();

    for (const decimals of [8, 18]) {
      mock.contract({ abi: erc20Abi, address: DAI }).read.decimals().returns(decimals);
      baseline.restore();
    }
    expect(await read(USDC, "decimals")).toBe(6);
    expectCause(await rejectionOf(read(DAI, "decimals")), MockNotFoundError);
  });
});

/**
 * One mock per test, built by a setup function: its fallbacks aren't
 * `defaults`, so a checkpoint marks where the test's own mocks begin.
 */
function setupWithFallbacks() {
  const { mock, client } = setup();
  mock.actions.getBalance().returns(0n);
  mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);
  return { mock, client, baseline: mock.checkpoint() };
}

describe("restore() checks", () => {
  test("assertNoUnhandled restores first, then throws", async () => {
    const { mock, read } = setup();
    const baseline = mock.checkpoint();
    mock.contract({ abi: erc20Abi, address: DAI }).read.decimals().returns(18);
    await rejectionOf(read(USDC, "decimals"));

    expect(() => {
      baseline.restore({ assertNoUnhandled: true });
    }).toThrow("The mock couldn't answer 1 request(s)");
    // Restored anyway: the next test doesn't inherit this one's mocks or history.
    expectCause(await rejectionOf(read(DAI, "decimals")), MockNotFoundError);
    mock.clearCalls();
    expect(() => {
      baseline.restore({ assertNoUnhandled: true });
    }).not.toThrow();
  });

  test("assertAllUsed checks only mocks registered since the checkpoint", async () => {
    const { mock, client, balanceOf } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.balanceOf([alice]).returns(5n);
    usdc.read.allowance([alice, DAI]).returns(0n);
    const baseline = mock.checkpoint();

    // The baseline's allowance mock goes unused; that's not this test's concern.
    await balanceOf();
    expect(() => {
      baseline.restore({ assertAllUsed: true });
    }).not.toThrow();

    usdc.read.balanceOf([DAI]).returns(1n);
    mock.contract({ abi: erc20Abi, address: DAI }).read.balanceOf([alice]).returns(2n);
    mock.actions.getBalance({ address: alice }).returns(3n);
    mock.method("eth_getStorageAt", [USDC]).returns("0x");
    mock.actions.getBalance().returns(0n);
    await client.getBalance({ address: DAI });
    let error: unknown;
    try {
      baseline.restore({ assertAllUsed: true });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("4 mock(s) never answered a call");
    expect(String(error)).toContain(`balanceOf(${DAI}) on ${USDC}`);
    expect(String(error)).toContain(`balanceOf(${getAddress(alice)}) on ${DAI}`);
    expect(String(error)).toContain(`getBalance({ address: ${getAddress(alice)} })`);
    expect(String(error)).toContain(`eth_getStorageAt(${USDC})`);
  });

  test("assertAllUsed checks args-less mocks since the checkpoint, not defaults", () => {
    const { mock } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.decimals().returns(6);
    mock.actions.getBalance().returns(0n);
    const baseline = mock.checkpoint();

    // In the baseline: not this test's concern.
    expect(() => {
      baseline.restore({ assertAllUsed: true });
    }).not.toThrow();

    usdc.read.balanceOf().fails("network");
    mock.contract({ abi: erc20Abi, address: DAI, defaults: { read: { decimals: 18 } } });
    expect(() => {
      baseline.restore({ assertAllUsed: true });
    }).toThrow(`1 mock(s) never answered a call:\n  - balanceOf(*) on ${USDC}`);
  });

  test("a checkpoint after per-test setup exempts its fallbacks", async () => {
    const { mock, client, baseline } = setupWithFallbacks();
    mock.actions.getBalance({ address: alice }).returns(5n);
    expect(await client.getBalance({ address: alice })).toBe(5n);
    expect(() => {
      baseline.restore({ assertAllUsed: true });
    }).not.toThrow();
    // Plain assertAllUsed() has no such boundary.
    expect(() => {
      mock.assertAllUsed();
    }).toThrow("getBalance(*)");
  });

  test("both checks fail together, in one error", async () => {
    const { mock, read } = setup();
    const baseline = mock.checkpoint();
    mock.contract({ abi: erc20Abi, address: DAI }).read.balanceOf([alice]).returns(1n);
    await rejectionOf(read(USDC, "decimals"));

    expect(() => {
      baseline.restore({ assertNoUnhandled: true, assertAllUsed: true });
    }).toThrow(/couldn't answer 1 request[\s\S]*1 mock\(s\) never answered/u);
  });

  test("without options, restore() doesn't check", async () => {
    const { mock, read } = setup();
    const baseline = mock.checkpoint();
    mock.contract({ abi: erc20Abi, address: DAI }).read.balanceOf([alice]).returns(1n);
    await rejectionOf(read(USDC, "decimals"));

    expect(() => {
      baseline.restore();
    }).not.toThrow();
  });
});

describe("nesting", () => {
  test("restoring an inner checkpoint keeps the outer one valid", async () => {
    const { mock, read } = setup();
    const outer = mock.checkpoint();
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);
    const inner = mock.checkpoint();

    inner.restore();
    expect(await read(USDC, "decimals")).toBe(6);
    outer.restore();
    expectCause(await rejectionOf(read(USDC, "decimals")), MockNotFoundError);
  });

  test("restoring an outer checkpoint invalidates the inner one", () => {
    const { mock } = setup();
    const outer = mock.checkpoint();
    const inner = mock.checkpoint();

    outer.restore();
    expect(() => {
      inner.restore();
    }).toThrow("This checkpoint is no longer valid");
    expect(() => {
      outer.restore();
    }).not.toThrow();
  });

  test("reset() invalidates every checkpoint", () => {
    const { mock } = setup();
    const baseline = mock.checkpoint();

    mock.reset();
    expect(() => {
      baseline.restore();
    }).toThrow("This checkpoint is no longer valid");
  });
});

describe("checkpoint()", () => {
  test("throws if the setup left requests unanswered", async () => {
    const { mock, read } = setup();
    await rejectionOf(read(USDC, "decimals"));

    expect(() => mock.checkpoint()).toThrow("Can't checkpoint: 1 request(s)");
    mock.clearCalls();
    expect(() => mock.checkpoint()).not.toThrow();
  });
});

// The serial pattern from MockCheckpoint's docs, run as vitest runs it. Per-test
// restores and a nested suite's setup are siblings: restore at one level only per test.
describe("module-scope setup", () => {
  const { mock, read } = setup();
  const usdc = mock.contract({ abi: erc20Abi, address: USDC, defaults: { read: { decimals: 6 } } });
  let baseline: MockCheckpoint;
  beforeAll(() => {
    baseline = mock.checkpoint();
  });

  describe("tests restoring the baseline", () => {
    afterEach(() => {
      baseline.restore({ assertNoUnhandled: true });
    });

    test("an override in one test…", async () => {
      usdc.read.decimals().returns(18);
      expect(await read(USDC, "decimals")).toBe(18);
    });

    test("…doesn't leak into the next", async () => {
      expect(await read(USDC, "decimals")).toBe(6);
    });
  });

  describe("a nested suite, with a checkpoint on each side of its setup", () => {
    let outer: MockCheckpoint;
    let suite: MockCheckpoint;
    beforeAll(() => {
      outer = mock.checkpoint();
      mock.contract({ abi: erc20Abi, address: DAI, defaults: { read: { decimals: 18 } } });
      suite = mock.checkpoint();
    });
    afterEach(() => {
      suite.restore({ assertNoUnhandled: true });
    });
    afterAll(() => {
      outer.restore();
    });

    test("sees the outer baseline and its own setup", async () => {
      expect(await read(USDC, "decimals")).toBe(6);
      expect(await read(DAI, "decimals")).toBe(18);
    });

    test("and its own overrides don't leak either", async () => {
      expect(await read(DAI, "decimals")).toBe(18);
    });
  });

  describe("a sibling after the nested suite", () => {
    afterEach(() => {
      baseline.restore();
    });

    test("doesn't inherit it", async () => {
      expectCause(await rejectionOf(read(DAI, "decimals")), MockNotFoundError);
    });
  });
});
