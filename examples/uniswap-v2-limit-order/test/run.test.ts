import type { MockRpc } from "ethergeist";
import { ContractFunctionExecutionError, HttpRequestError, parseUnits } from "viem";
import { describe, expect, test, vi } from "vitest";

import { run } from "../src/run.ts";
import type { TickResult } from "../src/tick.ts";
import { botClient, fillable, pollingInterval, setup, slippageReason } from "./fixture.ts";

/** How many `eth_blockNumber` requests the mock has had, failed ones included: the block watcher's polls. */
function polls(mock: MockRpc): number {
  return mock.history.filter((entry) => entry.method === "eth_blockNumber").length;
}

/** Waits until the watcher has polled `count` more times. */
async function morePolls(mock: MockRpc, count: number): Promise<void> {
  const target = polls(mock) + count;
  await vi.waitFor(() => {
    expect(polls(mock)).toBeGreaterThanOrEqual(target);
  });
}

/** Checks that nothing polls for blocks any more: run() has unwatched. */
async function expectStoppedWatching(mock: MockRpc): Promise<void> {
  const before = polls(mock);
  mock.mine();
  await new Promise((resolve) => setTimeout(resolve, 5 * pollingInterval));
  expect(polls(mock)).toBe(before);
}

/** Whether `promise` has settled, without waiting for it. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol("pending");
  const result = await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise((resolve) => setTimeout(resolve, 2 * pollingInterval, pending)),
  ]);
  return result !== pending;
}

/**
 * Holds every quote until `release()`, so a test can act while a tick is running. `entered`
 * resolves once a tick has asked for its quote.
 */
function holdQuotes(s: ReturnType<typeof setup>, quote: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  s.router.read.getAmountsOut().returns(async ({ args: [amountIn] }) => {
    enter();
    await released;
    return [amountIn, parseUnits(quote, 18)];
  });
  return { release, entered };
}

describe("filling", () => {
  test("ticks on the first block, and resolves with the swap's hash once it fills", async () => {
    const s = setup({ allowance: "1500" });
    fillable(s);
    const results: TickResult[] = [];

    const hash = await run({ ...s, onTick: (result) => results.push(result) });

    expect(hash).toBe(s.mock.transactions.at(-1)?.hash);
    expect(results).toEqual([{ kind: "filled", hash }]);
    await expectStoppedWatching(s.mock);
  });

  test("ticks on each new block until the price meets the limit", async () => {
    const s = setup({ allowance: "1500" });
    fillable(s);
    s.router.read
      .getAmountsOut()
      .times(2)
      .returns(({ args: [amountIn] }) => [amountIn, parseUnits("0.8", 18)]);
    const results: TickResult[] = [];

    const hash = await run({
      ...s,
      onTick: (result) => {
        results.push(result);
        s.mock.mine();
      },
    });

    expect(results).toEqual([
      { kind: "waiting", quote: parseUnits("0.8", 18) },
      { kind: "waiting", quote: parseUnits("0.8", 18) },
      { kind: "filled", hash },
    ]);
    // One tick per block: the blocks the two waits mined, after the first.
    expect(s.router.read.getAmountsOut.calls.map((call) => call.blockNumber)).toEqual([1n, 2n, 3n]);
  });

  test("approves, then swaps, in a single tick", async () => {
    const s = setup();
    fillable(s);

    const hash = await run(s);

    expect(hash).toBe(s.mock.transactions.at(-1)?.hash);
    // The tick ran at block 1, and the approve and the swap mined blocks 2 and 3. It ends before
    // a poll lands, so the held-quote test below is the one that checks the overlap guard.
    expect(
      s.mock.transactions.map((transaction) => [
        transaction.fields.to,
        transaction.position.blockNumber,
      ]),
    ).toEqual([
      [s.tokenIn.address, 2n],
      [s.router.address, 3n],
    ]);
    expect(s.tokenIn.write.approve.calls).toHaveLength(1);
    expect(s.router.write.swapExactTokensForTokens.calls).toHaveLength(1);
    expect(s.router.read.getAmountsOut.calls).toHaveLength(1);
  });

  test("keeps going after slippage", async () => {
    const s = setup({ allowance: "1500" });
    fillable(s);
    s.router.simulate.swapExactTokensForTokens().once().reverts(slippageReason);
    const results: TickResult["kind"][] = [];

    await run({
      ...s,
      onTick: (result) => {
        results.push(result.kind);
        s.mock.mine();
      },
    });

    expect(results).toEqual(["skipped", "filled"]);
  });

  test("skips the blocks that arrive while a tick is running", async () => {
    const s = setup({ allowance: "1500" });
    fillable(s);
    const held = holdQuotes(s, "0.8");
    const results: TickResult[] = [];
    const filled = run({ ...s, onTick: (result) => results.push(result) });

    await held.entered;
    s.mock.mine(3);
    await morePolls(s.mock, 2);
    // The quote that fills, from the next tick on.
    s.router.read
      .getAmountsOut()
      .returns(({ args: [amountIn] }) => [amountIn, parseUnits("1", 18)]);
    held.release();
    await vi.waitFor(() => {
      expect(results).toHaveLength(1);
    });

    // No tick for the blocks mined during the first: the next one waits for a new block.
    await morePolls(s.mock, 2);
    expect(s.router.read.getAmountsOut.calls).toHaveLength(1);
    s.mock.mine();
    await filled;
    expect(results.map((result) => result.kind)).toEqual(["waiting", "filled"]);
    expect(s.router.read.getAmountsOut.calls).toHaveLength(2);
  });
});

describe("errors", () => {
  test("rejects with the first error a tick throws, and stops watching", async () => {
    const s = setup({ allowance: "1500" });
    s.router.simulate.swapExactTokensForTokens().reverts("UniswapV2Router: EXPIRED");

    await expect(run(s)).rejects.toBeInstanceOf(ContractFunctionExecutionError);
    await expectStoppedWatching(s.mock);
    expect(s.router.read.getAmountsOut.calls).toHaveLength(1);
  });

  test("rejects with what onTick throws", async () => {
    const s = setup({ quote: "0.8" });
    const failure = new Error("log sink down");
    await expect(
      run({
        ...s,
        onTick: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    await expectStoppedWatching(s.mock);
  });

  test("rejects with the watcher's error when the node stops answering block numbers", async () => {
    const s = setup({ quote: "0.8" });
    const client = botClient(s.mock, { retryCount: 0 });

    const stopped = run({
      client,
      order: s.order,
      onTick: () => {
        s.mock.failRequests({ status: 503 }, { method: "eth_blockNumber" });
      },
    });

    await expect(stopped).rejects.toBeInstanceOf(HttpRequestError);
    await expect(stopped).rejects.toMatchObject({ status: 503 });
    await expectStoppedWatching(s.mock);
  });

  test("rides out a watcher poll that viem's retries recover from", async () => {
    const s = setup({ allowance: "1500" });
    fillable(s);
    s.router.read
      .getAmountsOut()
      .once()
      .returns(({ args: [amountIn] }) => [amountIn, parseUnits("0.8", 18)]);

    const hash = await run({
      ...s,
      onTick: () => {
        s.mock.failRequests({ status: 503 }, { method: "eth_blockNumber", times: 2 });
        s.mock.mine();
      },
    });
    expect(hash).toBe(s.mock.transactions.at(-1)?.hash);
  });

  test("lets a running tick finish when the watcher fails, then rejects unless it filled", async () => {
    const s = setup({ allowance: "1500" });
    fillable(s);
    const held = holdQuotes(s, "0.8");
    const stopped = run({ client: botClient(s.mock, { retryCount: 0 }), order: s.order });

    await held.entered;
    const outage = s.mock.failRequests({ status: 503 }, { method: "eth_blockNumber" });
    await vi.waitFor(() => {
      expect(outage.count).toBeGreaterThan(0);
    });
    expect(await settled(stopped)).toBe(false);

    held.release();
    await expect(stopped).rejects.toBeInstanceOf(HttpRequestError);
    await expectStoppedWatching(s.mock);
  });

  test("resolves when the tick running as the watcher fails fills the order", async () => {
    const s = setup({ allowance: "1500" });
    fillable(s);
    const held = holdQuotes(s, "1");
    const filled = run({ client: botClient(s.mock, { retryCount: 0 }), order: s.order });

    await held.entered;
    const outage = s.mock.failRequests({ status: 503 }, { method: "eth_blockNumber" });
    await vi.waitFor(() => {
      expect(outage.count).toBeGreaterThan(0);
    });

    held.release();
    expect(await filled).toBe(s.mock.transactions.at(-1)?.hash);
    await expectStoppedWatching(s.mock);
  });
});

describe("aborting", () => {
  test("rejects with the reason of a signal already aborted, without a request", async () => {
    const s = setup();
    const reason = new Error("shutting down");
    await expect(run({ ...s, signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(s.mock.history).toEqual([]);
  });

  test("stops watching and rejects with the signal's reason while waiting", async () => {
    const s = setup({ quote: "0.8" });
    const controller = new AbortController();
    const results: TickResult[] = [];
    const stopped = run({
      ...s,
      signal: controller.signal,
      onTick: (result) => results.push(result),
    });

    await vi.waitFor(() => {
      expect(results).toHaveLength(1);
    });
    controller.abort();

    await expect(stopped).rejects.toBe(controller.signal.reason);
    await expectStoppedWatching(s.mock);
  });

  test("lets a running tick finish: a fill wins over the abort", async () => {
    const s = setup({ allowance: "1500" });
    fillable(s);
    const held = holdQuotes(s, "1");
    const controller = new AbortController();
    const filled = run({ ...s, signal: controller.signal });

    await held.entered;
    controller.abort();
    expect(await settled(filled)).toBe(false);

    held.release();
    expect(await filled).toBe(s.mock.transactions.at(-1)?.hash);
    await expectStoppedWatching(s.mock);
  });

  test("lets a running tick finish, then rejects with the reason if it didn't fill", async () => {
    const s = setup();
    const held = holdQuotes(s, "0.8");
    const controller = new AbortController();
    const results: TickResult[] = [];
    const stopped = run({
      ...s,
      signal: controller.signal,
      onTick: (result) => results.push(result),
    });

    await held.entered;
    controller.abort();
    expect(await settled(stopped)).toBe(false);

    held.release();
    await expect(stopped).rejects.toBe(controller.signal.reason);
    await expectStoppedWatching(s.mock);
    expect(results).toEqual([{ kind: "waiting", quote: parseUnits("0.8", 18) }]);
  });

  test("rejects with the error of a tick that throws after the abort", async () => {
    const s = setup({ allowance: "1500" });
    const held = holdQuotes(s, "1");
    s.router.simulate.swapExactTokensForTokens().reverts("UniswapV2Router: EXPIRED");
    const controller = new AbortController();
    const stopped = run({ ...s, signal: controller.signal });

    await held.entered;
    controller.abort();
    held.release();

    await expect(stopped).rejects.toBeInstanceOf(ContractFunctionExecutionError);
    await expectStoppedWatching(s.mock);
  });
});
