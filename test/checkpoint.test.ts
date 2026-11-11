import {
  BaseError,
  HttpRequestError,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vite-plus/test";

import {
  MockCheckError,
  type MockCheckpoint,
  MockNotFoundError,
  MockSetupError,
  createMockRpc,
  match,
  testAddress,
  testHash,
  testLog,
} from "../src/index.js";
import { expectCause, expectThrows, rejectionOf } from "./utils.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const NOWHERE = "0x000000000000000000000000000000000000dEaD";
const alice = testAddress("alice");

const layoutHint =
  "If this test is in a nested describe, an afterEach in a parent describe that restores or " +
  "resets per test removes its setup; keep the two describes siblings.";
const removedTransaction =
  "This transaction was on the chain until the last restore() or reset() removed it: " +
  "a receipt wait from an earlier test may still be polling.";
const removedFooter =
  "Some name what the last restore() or reset() removed: a request from an earlier test, " +
  "like a receipt wait, may still be running.";

/** The `MockNotFoundError` a request rejects with. */
const notFound = async (request: Promise<unknown>) =>
  expectCause(await rejectionOf(request), MockNotFoundError);

/** The mock's error `run` throws. */
function thrownBy(run: () => void): BaseError {
  try {
    run();
  } catch (error) {
    if (error instanceof BaseError) return error;
    throw error;
  }
  return expect.unreachable("expected it to throw");
}

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
    mock.method("eth_getBlockTransactionCountByNumber").returns("0x1");
    const baseline = mock.checkpoint();

    usdc.read.decimals().returns(18);
    usdc.read.balanceOf([alice]).returns(99n);
    mock.actions.getBalance().returns(2n);
    mock.method("eth_getBlockTransactionCountByNumber").returns("0x2");
    baseline.restore();

    expect(await read(USDC, "decimals")).toBe(6);
    expect(await balanceOf()).toBe(5n);
    expectCause(await rejectionOf(read(USDC, "symbol")), HttpRequestError);
    expect(await client.getCode({ address: NOWHERE })).toBeUndefined();
    expect(await client.getBalance({ address: alice })).toBe(1n);
    expect(await client.getBlockTransactionCount()).toBe(1);
  });

  test("puts back a baseline mock's answer when its builder is reused", async () => {
    const { mock, balanceOf } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    const balance = usdc.read.balanceOf([alice]);
    balance.returns(5n);
    const baseline = mock.checkpoint();

    balance.returns(1n);
    usdc.read.decimals().returns(18);
    expect(await balanceOf()).toBe(1n);
    baseline.restore();
    expect(await balanceOf()).toBe(5n);
    // Only the mocks registered since are removed: the baseline's builder still answers.
    balance.returns(2n);
    expect(await balanceOf()).toBe(2n);
  });

  test("puts back a baseline action mock's answer and its uses left", async () => {
    const { mock, client } = setup();
    const balance = mock.actions.getBalance({ address: alice });
    balance.returns(5n);
    mock.actions.getBalance({ address: DAI }).times(2).returns(7n);
    const baseline = mock.checkpoint();

    balance.returns(1n);
    expect(await client.getBalance({ address: alice })).toBe(1n);
    expect(await client.getBalance({ address: DAI })).toBe(7n);
    baseline.restore();
    expect(await client.getBalance({ address: alice })).toBe(5n);
    expect([
      await client.getBalance({ address: DAI }),
      await client.getBalance({ address: DAI }),
    ]).toEqual([7n, 7n]);
  });

  test("contracts, empty addresses, and raw methods registered since are gone", async () => {
    const { mock, client, read } = setup();
    const baseline = mock.checkpoint();
    const dai = mock.contract({ abi: erc20Abi, address: DAI });
    dai.read.decimals().returns(18);
    mock.empty(NOWHERE);
    mock.method("eth_getBlockTransactionCountByNumber").returns("0x1");

    baseline.restore();
    expectCause(await rejectionOf(read(DAI, "decimals")), MockNotFoundError);
    expectCause(await rejectionOf(client.getCode({ address: NOWHERE })), MockNotFoundError);
    expectCause(await rejectionOf(client.getBlockTransactionCount()), MockNotFoundError);
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
    expectThrows(MockSetupError, "was removed by restore() or reset()", () => dai.read.symbol());
    expectThrows(MockSetupError, "This mock was removed", () => {
      decimals.returns(18);
    });
    expectThrows(MockSetupError, "This mock was removed", () => {
      balance.returns(1n);
    });
  });

  test("builders from since throw for limits too: a baseline contract's, actions', raw methods'", () => {
    const { mock } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    const baseline = mock.checkpoint();
    const decimals = usdc.read.decimals();
    const balance = mock.actions.getBalance();
    const raw = mock.method("eth_getBlockTransactionCountByNumber");

    baseline.restore();
    expectThrows(MockSetupError, "This mock was removed", () => {
      decimals.returns(6);
    });
    expectThrows(MockSetupError, "This mock was removed", () => balance.times(2));
    expectThrows(MockSetupError, "This mock was removed", () => {
      raw.returns("0x1");
    });
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

    mock.mine(5);
    const first = await batchId();
    baseline.restore();
    expect(mock.blockNumber).toBe(10n);
    expect(await batchId()).toBe(first);
  });

  test("a baseline receipt keeps the block it was registered in, even answered again since", async () => {
    const { mock, client } = setup();
    const hash = testHash("tx-1");
    const receipt = mock.actions.getTransactionReceipt({ hash });
    receipt.returns();
    mock.mine();
    const baseline = mock.checkpoint();

    mock.mine(2);
    receipt.returns({ status: "reverted" });
    expect(await client.getTransactionReceipt({ hash })).toMatchObject({ blockNumber: 13n });
    baseline.restore();
    mock.mine();
    expect(await client.getTransactionReceipt({ hash })).toMatchObject({
      blockNumber: 10n,
      status: "success",
    });
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
    expect(mock.history).toEqual([]);
    expect(usdc.read.balanceOf.calls).toEqual([]);
    // Used in the last "test", but not in this one.
    expectThrows(MockCheckError, "balanceOf", () => {
      mock.assertAllUsed();
    });
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

    expectThrows(MockCheckError, "The mock couldn't answer 1 request(s)", () => {
      baseline.restore({ assertNoUnhandled: true });
    });
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

    await balanceOf();
    expect(() => {
      baseline.restore({ assertAllUsed: true });
    }).not.toThrow();

    usdc.read.balanceOf([DAI]).returns(1n);
    mock.contract({ abi: erc20Abi, address: DAI }).read.balanceOf([alice]).returns(2n);
    mock.actions.getBalance({ address: alice }).returns(3n);
    mock.method("eth_getProof", [USDC]).returns({});
    mock.actions.getBalance().returns(0n);
    await client.getBalance({ address: DAI });
    let error: unknown;
    try {
      baseline.restore({ assertAllUsed: true });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("4 mock(s) answered no call");
    expect(String(error)).toContain(`balanceOf(${DAI}) on ${USDC}`);
    expect(String(error)).toContain(`balanceOf(${getAddress(alice)}) on ${DAI}`);
    expect(String(error)).toContain(`getBalance({ address: ${getAddress(alice)} })`);
    expect(String(error)).toContain(`eth_getProof(${USDC})`);
  });

  test("assertAllUsed checks args-less mocks since the checkpoint, not defaults", () => {
    const { mock } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.decimals().returns(6);
    mock.actions.getBalance().returns(0n);
    const baseline = mock.checkpoint();

    expect(() => {
      baseline.restore({ assertAllUsed: true });
    }).not.toThrow();

    usdc.read.balanceOf().fails("network");
    mock.contract({ abi: erc20Abi, address: DAI, defaults: { read: { decimals: 18 } } });
    expectThrows(
      MockCheckError,
      `1 mock(s) answered no call:\n  - balanceOf(*) fails on ${USDC}`,
      () => {
        baseline.restore({ assertAllUsed: true });
      },
    );
  });

  test("a checkpoint after per-test setup exempts its fallbacks", async () => {
    const { mock, client, baseline } = setupWithFallbacks();
    mock.actions.getBalance({ address: alice }).returns(5n);
    expect(await client.getBalance({ address: alice })).toBe(5n);
    expect(() => {
      baseline.restore({ assertAllUsed: true });
    }).not.toThrow();
    // Plain assertAllUsed() has no such boundary.
    expectThrows(MockCheckError, "getBalance(*)", () => {
      mock.assertAllUsed();
    });
  });

  test("both checks fail together, in one error", async () => {
    const { mock, read } = setup();
    const baseline = mock.checkpoint();
    mock.contract({ abi: erc20Abi, address: DAI }).read.balanceOf([alice]).returns(1n);
    await rejectionOf(read(USDC, "decimals"));

    expectThrows(
      MockCheckError,
      /couldn't answer 1 request[\s\S]*1 mock\(s\) answered no call/u,
      () => {
        baseline.restore({ assertNoUnhandled: true, assertAllUsed: true });
      },
    );
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
    const error = thrownBy(() => {
      inner.restore();
    });
    expect(error.shortMessage).toBe(
      "This checkpoint is no longer valid: an earlier checkpoint was restored after it was taken.",
    );
    expect(error.metaMessages).toEqual([layoutHint]);
    expect(() => {
      outer.restore();
    }).not.toThrow();
  });

  test("an outer per-test restore around a nested describe's setup says what removed it", async () => {
    const { mock, read } = setup();
    // The hooks in the order vitest runs them: the parent's beforeAll, the
    // nested describe's beforeAll, then after its first test the nested
    // afterEach and the parent's.
    const baseline = mock.checkpoint();
    mock.checkpoint();
    mock.contract({ abi: erc20Abi, address: DAI, defaults: { read: { decimals: 18 } } });
    const suite = mock.checkpoint();
    expect(await read(DAI, "decimals")).toBe(18);
    suite.restore();
    baseline.restore();

    // The nested describe's second test.
    const error = await notFound(read(DAI, "decimals"));
    expect(error.shortMessage).toBe(`No mocked contract at ${DAI}.`);
    expect(error.metaMessages?.slice(-2)).toEqual([
      "A contract was registered at this address until the last restore() or reset() removed it.",
      layoutHint,
    ]);
  });

  test("so does an action mock it removed, listed with the hint", async () => {
    const { mock, client } = setup();
    // The hooks in the order vitest runs them, as above.
    const baseline = mock.checkpoint();
    mock.actions.getBalance({ address: alice }).returns(1n);
    const suite = mock.checkpoint();
    expect(await client.getBalance({ address: alice })).toBe(1n);
    suite.restore();
    baseline.restore();

    // The nested describe's second test.
    const error = await notFound(client.getBalance({ address: alice }));
    expect(error.metaMessages).toEqual([
      "Mock it with mock.actions.getBalance({ address }).returns(…).",
      "Removed by the last restore() or reset():",
      `  getBalance({ address: ${alice} })`,
      layoutHint,
    ]);
  });

  test("and a function mock it removed from a contract it kept", async () => {
    const { mock, balanceOf } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    const baseline = mock.checkpoint();
    usdc.read.balanceOf([alice]).returns(1n);
    usdc.read.decimals().returns(6);
    expect(await balanceOf()).toBe(1n);
    baseline.restore();

    const error = await notFound(balanceOf());
    expect(error.metaMessages).toEqual([
      'No mocks registered for "balanceOf".',
      "Removed by the last restore() or reset():",
      `  balanceOf(${alice})`,
      layoutHint,
    ]);
  });

  test("and a write mock it removed, on the estimate viem sends first", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    const baseline = mock.checkpoint();
    usdc.write.transfer([DAI, 1n]).returns();
    baseline.restore();

    // A local account's writeContract estimates the send before sending it.
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [DAI, 1n] });
    const error = await notFound(
      client.request({ method: "eth_estimateGas", params: [{ from: alice, to: USDC, data }] }),
    );
    expect(error.metaMessages?.slice(-3)).toEqual([
      "Removed by the last restore() or reset():",
      `  transfer(${DAI}, 1n)`,
      layoutHint,
    ]);
  });

  test("and a sendTransaction mock it removed, on the estimate of a local account's deploy", async () => {
    const { mock } = setup();
    const wallet = createWalletClient({
      account: privateKeyToAccount(keccak256(toHex("deployer"))),
      chain: mock.chain,
      transport: mock.transport({ retryCount: 0 }),
    });
    const deploy = () => wallet.deployContract({ abi: [], bytecode: "0x6000" });
    // The hooks in the order vitest runs them, as above.
    const baseline = mock.checkpoint();
    mock.actions.sendTransaction({ to: null }).returns();
    const suite = mock.checkpoint();
    await deploy();
    suite.restore();
    baseline.restore();

    // The nested describe's second test: viem estimates the deploy first.
    const error = await notFound(deploy());
    expect(error.shortMessage).toMatch(/^No mock for estimateGas\(/u);
    expect(error.metaMessages).toEqual([
      "Mock it with mock.actions.estimateGas({ to }).returns(…).",
      "Removed by the last restore() or reset():",
      "  sendTransaction({ to: null })",
      layoutHint,
    ]);
  });

  test("and after reset(), every typed action mock it removed", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: alice }).returns(1n);
    mock.reset();

    const error = await notFound(client.getBalance({ address: alice }));
    expect(error.metaMessages?.slice(1, 3)).toEqual([
      "Removed by the last restore() or reset():",
      `  getBalance({ address: ${alice} })`,
    ]);
  });

  test("an estimate's removed estimateGas mocks, then its send's, under one header", async () => {
    const { mock, client } = setup();
    const baseline = mock.checkpoint();
    mock.actions.estimateGas({ to: DAI }).returns(50_000n);
    mock.actions.sendTransaction({ to: DAI }).returns();
    baseline.restore();

    const error = await notFound(
      client.request({
        method: "eth_estimateGas",
        params: [{ from: alice, to: DAI, data: "0x12" }],
      }),
    );
    expect(error.metaMessages).toEqual([
      "Mock it with mock.actions.estimateGas({ to }).returns(…).",
      "Removed by the last restore() or reset():",
      `  estimateGas({ to: ${DAI} })`,
      `  sendTransaction({ to: ${DAI} })`,
      layoutHint,
    ]);
  });

  test("a removed mock is matched without running its predicates", async () => {
    const { mock, client } = setup();
    const baseline = mock.checkpoint();
    const asked: unknown[] = [];
    mock.actions
      .getBalance({ address: match.where((address) => asked.push(address) > 0, "any") })
      .returns(1n);
    baseline.restore();

    const error = await notFound(client.getBalance({ address: alice }));
    expect(error.metaMessages?.[1]).toBe("Removed by the last restore() or reset():");
    expect(asked).toEqual([]);
  });

  test("a removed mock is listed only for a call it matches", async () => {
    const { mock, client } = setup();
    const baseline = mock.checkpoint();
    mock.actions.getBalance({ address: alice }).returns(1n);
    mock.actions.getBalance({ address: DAI }).returns(2n);
    baseline.restore();

    // The next test, in the same describe, misses on a call of its own.
    const error = await notFound(client.getBalance({ address: USDC }));
    expect(error.metaMessages).toEqual([
      "Mock it with mock.actions.getBalance({ address }).returns(…).",
    ]);
  });

  test("and only for the function it mocked", async () => {
    const { mock, read } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    const baseline = mock.checkpoint();
    usdc.read.decimals().returns(6);
    baseline.restore();

    const error = await notFound(read(USDC, "symbol"));
    expect(error.metaMessages).toEqual(['No mocks registered for "symbol".']);
  });

  test("and only until the next restore", async () => {
    const { mock, client } = setup();
    const baseline = mock.checkpoint();
    mock.actions.getBalance({ address: alice }).returns(1n);
    baseline.restore();
    baseline.restore();

    const error = await notFound(client.getBalance({ address: alice }));
    expect(error.metaMessages).toHaveLength(1);
  });

  test("a contract the last restore didn't remove gets no such line", async () => {
    const { mock, read } = setup();
    const baseline = mock.checkpoint();
    mock.contract({ abi: erc20Abi, address: DAI });
    baseline.restore();
    baseline.restore();

    const error = await notFound(read(DAI, "decimals"));
    expect(error.metaMessages).toEqual([
      "Call data: 0x313ce567",
      "Register it with contract(), or mark it empty() for an address without code.",
    ]);
  });

  test("reset() invalidates every checkpoint", () => {
    const { mock } = setup();
    const baseline = mock.checkpoint();

    mock.reset();
    const error = thrownBy(() => {
      baseline.restore();
    });
    expect(error.shortMessage).toBe(
      "This checkpoint is no longer valid: reset() was called after it was taken.",
    );
    expect(error.metaMessages).toEqual([layoutHint]);
  });
});

describe("a transaction the last restore() or reset() removed", () => {
  test("its receipt and transaction lookups still aren't answered, and say why", async () => {
    const { mock, client } = setup();
    const baseline = mock.checkpoint();
    const { hash } = mock.addTransaction({ logs: [testLog("sent")] });
    baseline.restore();

    const receipt = await notFound(client.getTransactionReceipt({ hash }));
    expect(receipt.shortMessage).toBe(`No mock for getTransactionReceipt({ hash: ${hash} }).`);
    expect(receipt.metaMessages).toEqual([
      removedTransaction,
      "Mock it with mock.actions.getTransactionReceipt({ hash }).returns(…).",
    ]);
    const transaction = await notFound(client.getTransaction({ hash }));
    expect(transaction.metaMessages).toEqual([
      removedTransaction,
      "Mock it with mock.actions.getTransaction({ hash }).returns(…).",
    ]);
  });

  test("after reset() too, in any case, ahead of the registered mocks", async () => {
    const { mock, client } = setup();
    const { hash } = mock.addTransaction({ logs: [testLog("sent")] });
    mock.reset();
    mock.actions.getTransactionReceipt({ hash: testHash("other") }).returns({});

    const error = await notFound(
      client.getTransactionReceipt({ hash: `0x${hash.slice(2).toUpperCase()}` }),
    );
    expect(error.metaMessages?.slice(0, 2)).toEqual([removedTransaction, "Registered:"]);
  });

  test("the next restore replaces what the last one removed", async () => {
    const { mock, client } = setup();
    const baseline = mock.checkpoint();
    const { hash } = mock.addTransaction({ logs: [testLog("sent")] });
    baseline.restore();
    baseline.restore();

    const error = await notFound(client.getTransactionReceipt({ hash }));
    expect(error.metaMessages).toEqual([
      "Mock it with mock.actions.getTransactionReceipt({ hash }).returns(…).",
    ]);
  });

  test("a transaction the restore kept isn't one it removed", async () => {
    const { mock, client } = setup();
    const { hash: kept } = mock.addTransaction({ logs: [testLog("kept")] });
    const baseline = mock.checkpoint();
    mock.addTransaction({ logs: [testLog("sent")] });
    baseline.restore();

    expect((await client.getTransactionReceipt({ hash: kept })).transactionHash).toBe(kept);
    const error = await notFound(client.getTransactionReceipt({ hash: testHash("never") }));
    expect(error.metaMessages).toHaveLength(1);
  });

  test("assertNoUnhandled, in restore() or on its own, ends saying so", async () => {
    const { mock, client, read } = setup();
    const baseline = mock.checkpoint();
    mock.contract({ abi: erc20Abi, address: DAI });
    const { hash } = mock.addTransaction({ logs: [testLog("sent")] });
    baseline.restore();

    // A receipt wait from the last test, still polling, and this test's own miss.
    await rejectionOf(client.getTransactionReceipt({ hash }));
    await rejectionOf(read(USDC, "decimals"));
    expectThrows(
      MockCheckError,
      `The mock couldn't answer 2 request(s):\n  - No mock for getTransactionReceipt({ hash: ${hash} }).\n` +
        "      This transaction was on the chain until the last restore() or reset() removed it: " +
        "a receipt wait from an earlier test may still be polling.\n" +
        "      Mock it with mock.actions.getTransactionReceipt({ hash }).returns(…).\n" +
        `  - No mocked contract at ${USDC}.\n` +
        "      Call data: 0x313ce567\n" +
        "      Register it with contract(), or mark it empty() for an address without code.\n" +
        removedFooter,
      () => {
        mock.assertNoUnhandled();
      },
    );
    // And a read of a contract it removed, in this test's own restore.
    mock.clearCalls();
    await rejectionOf(read(DAI, "decimals"));
    expectThrows(
      MockCheckError,
      `The mock couldn't answer 1 request(s):\n  - No mocked contract at ${DAI}.\n` +
        "      Call data: 0x313ce567\n" +
        "      Register it with contract(), or mark it empty() for an address without code.\n" +
        "      A contract was registered at this address until the last restore() or reset() " +
        "removed it.\n" +
        `      ${layoutHint}\n` +
        removedFooter,
      () => {
        baseline.restore({ assertNoUnhandled: true });
      },
    );
  });

  test("an estimate or a send to a contract it removed says so too", async () => {
    const { mock, client } = setup();
    const baseline = mock.checkpoint();
    mock.contract({ abi: erc20Abi, address: DAI });
    baseline.restore();

    // A send from the last test that lands after its restore.
    const tx = { from: alice, to: DAI, data: "0x313ce567" } as const;
    const estimate = await notFound(client.request({ method: "eth_estimateGas", params: [tx] }));
    const send = await notFound(mock.request({ method: "eth_sendTransaction", params: [tx] }));
    const removedContract =
      "A contract was registered at this address until the last restore() or reset() removed it.";
    expect(estimate.metaMessages?.slice(0, 2)).toEqual([removedContract, layoutHint]);
    expect(send.metaMessages?.slice(0, 2)).toEqual([removedContract, layoutHint]);
    expect(
      thrownBy(() => {
        mock.assertNoUnhandled();
      }).message,
    ).toContain(removedFooter);
  });

  test.each(["restore()", "reset()"] as const)(
    "an estimate or a send to a contract registered again after %s says nothing of the one removed",
    async (restore) => {
      const { mock, client } = setup();
      const baseline = mock.checkpoint();
      mock.contract({ abi: erc20Abi, address: DAI });
      if (restore === "restore()") baseline.restore();
      else mock.reset();
      mock.contract({ abi: erc20Abi, address: DAI });

      // ETH sent with no data, which only action mocks answer.
      const tx = { from: alice, to: DAI, value: "0x1" } as const;
      const estimate = await notFound(client.request({ method: "eth_estimateGas", params: [tx] }));
      const send = await notFound(mock.request({ method: "eth_sendTransaction", params: [tx] }));
      expect(estimate.metaMessages).toEqual([
        "Mock it with mock.actions.estimateGas({ to }).returns(…).",
      ]);
      expect(send.metaMessages).toEqual([
        "Mock it with mock.actions.sendTransaction({ to }).returns(…).",
      ]);
    },
  );

  test("assertNoUnhandled says so for a mock it removed too", async () => {
    const { mock, client } = setup();
    const baseline = mock.checkpoint();
    mock.actions.getBalance({ address: alice }).returns(1n);
    baseline.restore();

    // A balance refetch from the last test that lands after its restore.
    await rejectionOf(client.getBalance({ address: alice }));
    expect(
      thrownBy(() => {
        mock.assertNoUnhandled();
      }).shortMessage,
    ).toContain(`removes its setup; keep the two describes siblings.\n${removedFooter}`);
  });

  test("nor for a contract or transaction that's back since", async () => {
    const { mock, client, read } = setup();
    const baseline = mock.checkpoint();
    mock.contract({ abi: erc20Abi, address: DAI });
    const { hash } = mock.addTransaction({ logs: [testLog("sent")] });
    baseline.restore();

    // The next test registers and sends the same again, then misses for real.
    mock.contract({ abi: erc20Abi, address: DAI });
    mock.addTransaction({ logs: [testLog("sent")], hash });
    expect((await client.getTransactionReceipt({ hash })).transactionHash).toBe(hash);
    await rejectionOf(read(DAI, "decimals"));
    await rejectionOf(client.getTransactionReceipt({ hash: testHash("other") }));
    expect(
      thrownBy(() => {
        mock.assertNoUnhandled();
      }).shortMessage,
    ).not.toContain("restore()");
    expect(mock.unhandled).toHaveLength(2);
  });

  test("assertNoUnhandled doesn't say so for requests that name nothing removed", async () => {
    const { mock, read } = setup();
    mock.contract({ abi: erc20Abi, address: USDC });
    const baseline = mock.checkpoint();
    mock.contract({ abi: erc20Abi, address: DAI });
    mock.addTransaction({ logs: [testLog("sent")] });
    baseline.restore();

    // A contract the restore kept.
    await rejectionOf(read(USDC, "decimals"));
    expect(
      thrownBy(() => {
        mock.assertNoUnhandled();
      }).shortMessage,
    ).toBe(
      `The mock couldn't answer 1 request(s):\n  - No mock for decimals() on ${USDC}.\n` +
        '      No mocks registered for "decimals".',
    );
  });
});

describe("checkpoint()", () => {
  test("throws if the setup left requests unanswered", async () => {
    const { mock, read } = setup();
    await rejectionOf(read(USDC, "decimals"));

    expectThrows(
      MockCheckError,
      "Can't checkpoint: 1 request(s) since the last clear went unanswered. Fix the setup, or " +
        "call clearCalls() first if they were intentional:\n" +
        `  - No mocked contract at ${USDC}.\n` +
        "      Call data: 0x313ce567\n" +
        "      Register it with contract(), or mark it empty() for an address without code.\n\n",
      () => mock.checkpoint(),
    );
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
