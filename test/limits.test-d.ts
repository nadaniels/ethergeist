import { erc20Abi } from "viem";
import { describe, expectTypeOf, test } from "vite-plus/test";
import { createMockRpc } from "../src/index.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

describe("once() and times()", () => {
  test("come before the answer, which keeps its types", () => {
    const mock = createMockRpc();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });

    usdc.read.balanceOf().once().returns(1n);
    usdc.read.balanceOf().times(2).reverts("paused");
    usdc.read.balanceOf().once().fails("network");
    // @ts-expect-error -- balanceOf returns a bigint
    usdc.read.balanceOf().once().returns("1");
    mock.actions.getBalance().once().returns(1n);
    mock.method("eth_gasPrice").times(2).returns("0x1");
  });

  test("can't be repeated or come after the answer", () => {
    const mock = createMockRpc();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });

    // @ts-expect-error -- one limit per mock
    usdc.read.balanceOf().once().times(2);
    // The answer returns nothing to chain a limit on.
    type Builder = ReturnType<typeof usdc.read.balanceOf>;
    expectTypeOf<ReturnType<Builder["returns"]>>().toBeVoid();
    // @ts-expect-error -- one limit per mock
    mock.actions.getBalance().once().once();
  });
});
