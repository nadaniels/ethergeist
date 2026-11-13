import {
  BaseError,
  ContractFunctionRevertedError,
  erc20Abi,
  parseUnits,
  type Address,
  type Chain,
  type Hash,
  type LocalAccount,
  type PublicActions,
  type Transport,
  type WalletClient,
} from "viem";

import { routerAbi } from "./abi.ts";

/** `createWalletClient({ account, chain, transport }).extend(publicActions)`, with a local account. */
export type BotClient = WalletClient<Transport, Chain, LocalAccount> &
  PublicActions<Transport, Chain, LocalAccount>;

/** Swap `amountIn` of `tokenIn` on `router` once it buys at least `minAmountOut` of `tokenOut`. */
export type Order = {
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  /** In `tokenIn`'s units, such as "1500.25". */
  amountIn: string;
  /** In `tokenOut`'s units. It's the swap's `amountOutMin`. */
  minAmountOut: string;
};

/**
 * What one tick did: `waiting` below the limit, `skipped` for a short balance or a swap that
 * would slip (tried again next block), or `filled` with the swap's hash.
 */
export type TickResult =
  | { kind: "waiting"; quote: bigint }
  | { kind: "skipped"; reason: "insufficientBalance" | "slippage" }
  | { kind: "filled"; hash: Hash };

const deadlineSeconds = 300n;

/** Checks the order against the current block, and swaps if its limit is met. */
export async function tick({
  client,
  order,
}: {
  client: BotClient;
  order: Order;
}): Promise<TickResult> {
  const { router, tokenIn, tokenOut } = order;
  const owner = client.account.address;
  const path = [tokenIn, tokenOut];

  const [decimalsIn, decimalsOut, balance, allowance] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: tokenIn, abi: erc20Abi, functionName: "decimals" },
      { address: tokenOut, abi: erc20Abi, functionName: "decimals" },
      { address: tokenIn, abi: erc20Abi, functionName: "balanceOf", args: [owner] },
      { address: tokenIn, abi: erc20Abi, functionName: "allowance", args: [owner, router] },
    ],
  });
  const amountIn = parseUnits(order.amountIn, decimalsIn);
  const minAmountOut = parseUnits(order.minAmountOut, decimalsOut);

  const amounts = await client.readContract({
    address: router,
    abi: routerAbi,
    functionName: "getAmountsOut",
    args: [amountIn, path],
  });
  const quote = amounts[amounts.length - 1];
  if (quote < minAmountOut) return { kind: "waiting", quote };
  if (balance < amountIn) return { kind: "skipped", reason: "insufficientBalance" };

  if (allowance < amountIn) {
    const approval = await client.writeContract({
      address: tokenIn,
      abi: erc20Abi,
      functionName: "approve",
      args: [router, amountIn],
    });
    await confirm(client, approval, "approve");
  }

  // The write estimates gas, so it can hit the same revert as the simulation if the price moves between them.
  let hash: Hash;
  try {
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + deadlineSeconds;
    const { request } = await client.simulateContract({
      address: router,
      abi: routerAbi,
      functionName: "swapExactTokensForTokens",
      args: [amountIn, minAmountOut, path, owner, deadline],
    });
    hash = await client.writeContract(request);
  } catch (error) {
    if (isSlippage(error)) return { kind: "skipped", reason: "slippage" };
    throw error;
  }
  await confirm(client, hash, "swap");
  return { kind: "filled", hash };
}

/** The router refuses a swap that would buy less than `amountOutMin`: the price moved since the quote. */
function isSlippage(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  const revert = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  return (
    revert instanceof ContractFunctionRevertedError &&
    (revert.reason?.endsWith("INSUFFICIENT_OUTPUT_AMOUNT") ?? false)
  );
}

async function confirm(client: BotClient, hash: Hash, action: string): Promise<void> {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") throw new Error(`The ${action} transaction ${hash} reverted.`);
}
