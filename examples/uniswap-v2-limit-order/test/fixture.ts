import { createMockRpc, testAddress, type MockRpc } from "ethergeist";
import {
  createWalletClient,
  erc20Abi,
  parseUnits,
  publicActions,
  type CustomTransportConfig,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { onTestFinished } from "vitest";

import { routerAbi } from "../src/abi.ts";
import type { BotClient, Order } from "../src/tick.ts";

const account = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // Well-known throwaway
);
export const owner = account.address;

/** How often the bot's client polls, in milliseconds: fast, for tests. */
export const pollingInterval = 10;

/** What Uniswap V2's router reverts with when a swap would buy less than `amountOutMin`. */
export const slippageReason = "UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT";

export type Market = {
  /** tokenIn's decimals. Defaults to 6, as USDC. */
  decimalsIn?: number;
  /** tokenOut's decimals. Defaults to 18, as WETH. */
  decimalsOut?: number;
  /** The owner's tokenIn balance, in tokenIn's units. Defaults to "2000". */
  balance?: string;
  /** The router's tokenIn allowance from the owner, in tokenIn's units. Defaults to "0". */
  allowance?: string;
  /** What `getAmountsOut` quotes for the order, in tokenOut's units. Defaults to "1". */
  quote?: string;
};

/**
 * A fresh mock per test: USDC and WETH, a Uniswap V2 router, and the bot's client on them. The
 * reads answer from `market`; nothing is sendable until a test mocks the approve or the swap.
 * Fails the test if any request went unanswered, even one the app swallowed.
 */
export function setup(market: Market = {}) {
  const { decimalsIn = 6, decimalsOut = 18 } = market;
  const mock = createMockRpc();
  const tokenIn = mock.contract({ abi: erc20Abi, address: testAddress("usdc"), name: "USDC" });
  const tokenOut = mock.contract({ abi: erc20Abi, address: testAddress("weth"), name: "WETH" });
  const router = mock.contract({ abi: routerAbi, address: testAddress("router"), name: "Router" });

  tokenIn.read.decimals().returns(decimalsIn);
  tokenOut.read.decimals().returns(decimalsOut);
  tokenIn.read.balanceOf([owner]).returns(parseUnits(market.balance ?? "2000", decimalsIn));
  tokenIn.read
    .allowance([owner, router.address])
    .returns(parseUnits(market.allowance ?? "0", decimalsIn));
  router.read
    .getAmountsOut()
    .returns(({ args: [amountIn] }) => [amountIn, parseUnits(market.quote ?? "1", decimalsOut)]);

  const order: Order = {
    router: router.address,
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    amountIn: "1500",
    minAmountOut: "0.9",
  };
  const client = botClient(mock);
  onTestFinished(() => {
    mock.assertNoUnhandled();
  });
  return { mock, tokenIn, tokenOut, router, order, client };
}

/**
 * The client `main.ts` makes, on the mock's transport, polling fast enough for tests. `transport`
 * is viem's `custom()` config, e.g. `{ retryCount: 0 }` for a failure to reach the app at once.
 */
export function botClient(mock: MockRpc, transport?: CustomTransportConfig): BotClient {
  return createWalletClient({
    account,
    chain: mock.chain,
    transport: mock.transport(transport),
    pollingInterval,
  }).extend(publicActions);
}

/** Mocks a successful approve and swap, the sends a fill makes. */
export function fillable({
  tokenIn,
  router,
}: Pick<ReturnType<typeof setup>, "tokenIn" | "router">) {
  tokenIn.write.approve().returns();
  router.simulate
    .swapExactTokensForTokens()
    .returns(({ args: [amountIn, amountOutMin] }) => [amountIn, amountOutMin]);
  router.write.swapExactTokensForTokens().returns();
}
