import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  HttpRequestError,
  InsufficientFundsError,
  parseUnits,
} from "viem";
import { afterEach, describe, expect, test, vi } from "vitest";

import { tick } from "../src/tick.ts";
import { fillable, owner, setup, slippageReason } from "./fixture.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("the limit", () => {
  test("waits while the quote is below the minimum, and sends nothing", async () => {
    const s = setup({ quote: "0.899999999999999999" });
    expect(await tick(s)).toEqual({
      kind: "waiting",
      quote: parseUnits("0.899999999999999999", 18),
    });
    expect(s.mock.transactions).toEqual([]);
  });

  test("quotes the order's amount along its path, scaled to tokenIn's decimals", async () => {
    const s = setup({ quote: "0.5" });
    await tick(s);
    expect(s.router.read.getAmountsOut.calls).toMatchObject([
      { args: [parseUnits("1500", 6), [s.tokenIn.address, s.tokenOut.address]] },
    ]);
  });

  test("fills when the quote is exactly the minimum", async () => {
    const s = setup({ quote: "0.9", allowance: "1500" });
    fillable(s);
    expect(await tick(s)).toMatchObject({ kind: "filled" });
  });

  test("checks the price before the balance", async () => {
    const s = setup({ quote: "0.5", balance: "0" });
    expect(await tick(s)).toMatchObject({ kind: "waiting" });
  });
});

describe("the balance", () => {
  test("skips an order the owner can't pay for, without approving", async () => {
    const s = setup({ balance: "1499.999999" });
    fillable(s);
    expect(await tick(s)).toEqual({ kind: "skipped", reason: "insufficientBalance" });
    expect(s.mock.transactions).toEqual([]);
  });

  test("swaps a balance of exactly the amount", async () => {
    const s = setup({ balance: "1500", allowance: "1500" });
    fillable(s);
    expect(await tick(s)).toMatchObject({ kind: "filled" });
  });
});

describe("the approval", () => {
  test("approves the router for exactly the amount, and waits for it before swapping", async () => {
    const s = setup({ allowance: "1499.999999" });
    fillable(s);
    await tick(s);

    expect(s.tokenIn.write.approve.calls).toMatchObject([
      { from: owner, args: [s.router.address, parseUnits("1500", 6)] },
    ]);
    const steps = s.mock.history.flatMap((entry) => {
      if (entry.type === "action" && entry.action === "getTransactionReceipt") return ["receipt"];
      if (entry.type === "action" && entry.action === "sendTransaction") {
        return [`send ${entry.contract?.call?.functionName}`];
      }
      if (entry.type === "call") return [`call ${entry.call?.call?.functionName}`];
      return [];
    });
    expect(steps).toEqual([
      "call getAmountsOut",
      "send approve",
      "receipt",
      "call swapExactTokensForTokens",
      "send swapExactTokensForTokens",
      "receipt",
    ]);
  });

  test("doesn't approve when the allowance covers the amount", async () => {
    const s = setup({ allowance: "1500" });
    fillable(s);
    await tick(s);
    expect(s.tokenIn.write.approve.calls).toEqual([]);
  });

  test("throws when the approval reverts on chain, and doesn't swap", async () => {
    const s = setup();
    fillable(s);
    s.tokenIn.write.approve().returns({ status: "reverted" });
    await expect(tick(s)).rejects.toThrow(/^The approve transaction 0x[0-9a-f]{64} reverted\.$/);
    expect(s.router.simulate.swapExactTokensForTokens.calls).toEqual([]);
  });

  test("throws when the approval's estimate reverts", async () => {
    const s = setup();
    fillable(s);
    s.tokenIn.write.approve().reverts("Pausable: paused");
    await expect(tick(s)).rejects.toThrow("Pausable: paused");
    expect(s.mock.transactions).toEqual([]);
  });

  test("approves once: a tick after a slipped swap uses the allowance already sent", async () => {
    const s = setup();
    fillable(s);
    // After fillable(): of two mocks with the same pins, the one registered last answers.
    let allowance = 0n;
    s.tokenIn.read.allowance([owner, s.router.address]).returns(() => allowance);
    s.tokenIn.write.approve().returns(({ args: [, amount] }) => {
      allowance = amount;
    });
    s.router.simulate.swapExactTokensForTokens().once().reverts(slippageReason);

    expect(await tick(s)).toEqual({ kind: "skipped", reason: "slippage" });
    expect(await tick(s)).toMatchObject({ kind: "filled" });
    expect(s.tokenIn.write.approve.calls).toHaveLength(1);
  });
});

describe("the swap", () => {
  test("swaps the order's amounts along its path to the owner, with a deadline 5 minutes out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.500Z"));
    const now = 1_767_225_600n;

    const s = setup({ allowance: "1500" });
    fillable(s);
    await tick(s);

    const args = [
      parseUnits("1500", 6),
      parseUnits("0.9", 18),
      [s.tokenIn.address, s.tokenOut.address],
      owner,
      now + 300n,
    ];
    expect(s.router.simulate.swapExactTokensForTokens.calls).toMatchObject([{ from: owner, args }]);
    // The write sends what was simulated, deadline included.
    expect(s.router.write.swapExactTokensForTokens.calls).toMatchObject([{ from: owner, args }]);
  });

  test("returns the hash of the swap, once it's mined", async () => {
    const s = setup({ allowance: "1500" });
    fillable(s);
    const result = await tick(s);

    const swap = s.mock.transactions.at(-1);
    expect(swap?.fields.to).toBe(s.router.address);
    expect(result).toEqual({ kind: "filled", hash: swap?.hash });
    expect(s.mock.history.at(-1)).toMatchObject({
      action: "getTransactionReceipt",
      call: { hash: swap?.hash },
    });
  });

  test.each([
    { decimalsIn: 18, decimalsOut: 6, amountIn: "0.000000000000000001", minAmountOut: "1500.25" },
    { decimalsIn: 6, decimalsOut: 18, amountIn: "1500.25", minAmountOut: "0.000000000000000001" },
    { decimalsIn: 0, decimalsOut: 8, amountIn: "3", minAmountOut: "0.00000001" },
  ])(
    "scales $amountIn and $minAmountOut to $decimalsIn and $decimalsOut decimals",
    async ({ decimalsIn, decimalsOut, amountIn, minAmountOut }) => {
      const s = setup({
        decimalsIn,
        decimalsOut,
        balance: amountIn,
        allowance: amountIn,
        quote: minAmountOut,
      });
      fillable(s);
      expect(
        await tick({ client: s.client, order: { ...s.order, amountIn, minAmountOut } }),
      ).toMatchObject({
        kind: "filled",
      });
      expect(s.router.write.swapExactTokensForTokens.calls[0]?.args.slice(0, 2)).toEqual([
        parseUnits(amountIn, decimalsIn),
        parseUnits(minAmountOut, decimalsOut),
      ]);
    },
  );
});

describe("slippage", () => {
  test("skips when the simulation reverts for too little output, and sends nothing", async () => {
    const s = setup({ allowance: "1500" });
    fillable(s);
    s.router.simulate.swapExactTokensForTokens().reverts(slippageReason);
    expect(await tick(s)).toEqual({ kind: "skipped", reason: "slippage" });
    expect(s.mock.transactions).toEqual([]);
  });

  test("skips when the price moves between the simulation and the write's estimate", async () => {
    const s = setup({ allowance: "1500" });
    fillable(s);
    s.router.write.swapExactTokensForTokens().reverts(slippageReason);
    expect(await tick(s)).toEqual({ kind: "skipped", reason: "slippage" });
    expect(s.mock.transactions).toEqual([]);
  });

  test("recognizes the library's wording of the same revert", async () => {
    const s = setup({ allowance: "1500" });
    s.router.simulate
      .swapExactTokensForTokens()
      .reverts("UniswapV2Library: INSUFFICIENT_OUTPUT_AMOUNT");
    expect(await tick(s)).toEqual({ kind: "skipped", reason: "slippage" });
  });

  test.each(["UniswapV2Router: EXPIRED", "TransferHelper: TRANSFER_FROM_FAILED", "UniswapV2: K"])(
    "throws any other revert: %s",
    async (reason) => {
      const s = setup({ allowance: "1500" });
      s.router.simulate.swapExactTokensForTokens().reverts(reason);
      const error = await tick(s).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ContractFunctionExecutionError);
      expect((error as ContractFunctionExecutionError).cause).toBeInstanceOf(
        ContractFunctionRevertedError,
      );
      expect((error as ContractFunctionExecutionError).cause).toMatchObject({ reason });
    },
  );

  test("throws a revert without a reason", async () => {
    const s = setup({ allowance: "1500" });
    s.router.simulate.swapExactTokensForTokens().reverts();
    await expect(tick(s)).rejects.toBeInstanceOf(ContractFunctionExecutionError);
  });

  // Only a revert before sending is a skip. The receipt has no reason, so a swap mined reverted
  // is an error even when the price moved while it was pending, and run() stops on it.
  test("throws when the swap is mined reverted", async () => {
    const s = setup({ allowance: "1500" });
    fillable(s);
    s.router.write.swapExactTokensForTokens().returns({ status: "reverted" });
    await expect(tick(s)).rejects.toThrow(/^The swap transaction 0x[0-9a-f]{64} reverted\.$/);
  });
});

describe("the node", () => {
  test("throws when a token read fails, as multicall doesn't allow failures", async () => {
    const s = setup();
    s.tokenOut.read.decimals().reverts();
    await expect(tick(s)).rejects.toBeInstanceOf(ContractFunctionExecutionError);
    expect(s.router.read.getAmountsOut.calls).toEqual([]);
  });

  test("rides out a flaky node, as viem retries", async () => {
    const s = setup();
    fillable(s);
    const outage = s.mock.failRequests({ status: 503 }, { times: 2 });
    expect(await tick(s)).toMatchObject({ kind: "filled" });
    expect(outage.count).toBe(2);
  });

  test("throws once the node is still down past viem's retries, and sends nothing", async () => {
    const s = setup();
    fillable(s);
    const outage = s.mock.failRequests({ status: 503 });
    const error = await tick(s).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ContractFunctionExecutionError);
    expect(
      (error as ContractFunctionExecutionError).walk((cause) => cause instanceof HttpRequestError),
    ).toMatchObject({ status: 503 });
    // The first request and viem's three retries.
    expect(outage.count).toBe(4);
    expect(s.mock.transactions).toEqual([]);
  });

  test("throws, not skips, when the node refuses the swap", async () => {
    const s = setup({ allowance: "1500" });
    fillable(s);
    s.router.write.swapExactTokensForTokens().refuses("insufficientFunds");
    const error = await tick(s).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ContractFunctionExecutionError);
    expect(
      (error as ContractFunctionExecutionError).walk(
        (cause) => cause instanceof InsufficientFundsError,
      ),
    ).toBeInstanceOf(InsufficientFundsError);
    expect(s.mock.transactions).toEqual([]);
  });
});
