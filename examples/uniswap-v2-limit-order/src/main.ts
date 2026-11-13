import { createWalletClient, getAddress, http, publicActions, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

import { run } from "./run.ts";
import type { Order } from "./tick.ts";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in the environment.`);
  return value;
}

const config = {
  rpcUrl: env("RPC_URL"),
  privateKey: env("PRIVATE_KEY") as Hex,
  order: {
    router: getAddress(env("ROUTER")),
    tokenIn: getAddress(env("TOKEN_IN")),
    tokenOut: getAddress(env("TOKEN_OUT")),
    amountIn: env("AMOUNT_IN"),
    minAmountOut: env("MIN_AMOUNT_OUT"),
  } satisfies Order,
};

const client = createWalletClient({
  account: privateKeyToAccount(config.privateKey),
  chain: mainnet,
  transport: http(config.rpcUrl),
}).extend(publicActions);

const controller = new AbortController();
process.once("SIGINT", () => {
  controller.abort();
});
process.once("SIGTERM", () => {
  controller.abort();
});

try {
  const hash = await run({
    client,
    order: config.order,
    signal: controller.signal,
    onTick: (result) => {
      console.log(new Date().toISOString(), result);
    },
  });
  console.log(`Filled in ${hash}.`);
} catch (error) {
  if (controller.signal.aborted && error === controller.signal.reason) {
    console.log("Stopped before the order filled.");
  } else {
    console.error(error);
    process.exitCode = 1;
  }
}
