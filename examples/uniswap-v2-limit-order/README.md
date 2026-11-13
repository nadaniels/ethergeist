# Uniswap V2 limit-order bot

A small Node bot on viem with a local account, and the test suite you'd ship
with it. The tests run the bot's real viem client against ethergeist: no fork,
no RPC key, and no deployed contracts.

## What It Does

An order is `{ router, tokenIn, tokenOut, amountIn, minAmountOut }`, with the
amounts in human units (`"1500.25"`). On each new block, the bot:

1. reads both tokens' decimals, its `tokenIn` balance, and the router's
   allowance in one multicall;
2. quotes `amountIn` with the router's `getAmountsOut`;
3. waits while the quote is below `minAmountOut`, and skips the block when the
   balance is short;
4. approves exactly `amountIn` when the allowance is short, and waits for the
   receipt;
5. simulates `swapExactTokensForTokens`, with `minAmountOut` as its
   `amountOutMin` and a deadline 5 minutes out, then sends it.

A swap that reverts for too little output (`INSUFFICIENT_OUTPUT_AMOUNT`) is
skipped, and the bot tries again on the next block. Any other revert, a
transaction mined reverted, or a node still failing past viem's retries
throws, and the bot stops.

| File          | What's in it                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| `src/abi.ts`  | The router's two functions, as an `as const` ABI.                                                                     |
| `src/tick.ts` | `tick()`: one check of the order against the current block, returning `waiting`, `skipped`, or `filled`.              |
| `src/run.ts`  | `run()`: ticks on each new block until the order fills, skipping blocks while a tick runs. An `AbortSignal` stops it. |
| `src/main.ts` | Reads the config from env, builds the client on mainnet, and logs each tick.                                          |

## Running the Tests

From a checkout of the repo:

```sh
pnpm install
pnpm build # builds the library the example imports
cd examples/uniswap-v2-limit-order
pnpm test
```

`pnpm typecheck` type-checks the app and its tests, and `pnpm lint` lints and
type-checks every example.

## Running the Bot

> [!WARNING]
> This bot is for demonstration only. Don't run it in production or with real
> assets: it has no gas strategy, no MEV protection, and no testing against
> real contracts.

`pnpm start` runs it on mainnet, with Node 22.18 or later. It reads `RPC_URL`,
`PRIVATE_KEY`, `ROUTER`, `TOKEN_IN`, `TOKEN_OUT`, `AMOUNT_IN`, and
`MIN_AMOUNT_OUT` from env.

## A Tour of the Tests

### `test/fixture.ts`

- `setup(market)` gives each test a fresh mock: USDC, WETH, and the router,
  registered from their ABIs at `testAddress()` addresses. Their reads answer
  from `market` (decimals, balance, allowance, and quote), so a test states only
  what differs.
- It also registers `onTestFinished(() => mock.assertNoUnhandled())`. A request
  no mock answers then fails the test, naming the request, even one the app
  caught.
- `botClient(mock)` is the client `main.ts` builds, on `mock.transport()`, with
  a short `pollingInterval` so the bot sees `mock.mine()` at once.
- `fillable()` mocks the approve and the swap. Nothing can be sent until a test
  calls it.

A test overrides a fixture's mock by registering one with the same pins after
it: of two mocks that match equally, the one registered last answers.

### `test/tick.test.ts`

- **The limit and the balance:** static answers, and `.calls` to check what
  the app asked for, such as `getAmountsOut`'s amount in base units. An empty
  `mock.transactions` shows that nothing was sent.
- **The approval:** the order of the app's requests, read from `mock.history`
  (the approve sent, its receipt, then the swap). A receipt mined reverted
  (`.returns({ status: "reverted" })`), and an estimate that reverts
  (`.reverts()`). A resolver that closes over a `let allowance` keeps state
  across two ticks.
- **The swap:** the swap's args, with the deadline pinned by Vitest's fake
  `Date`, and three pairs of token decimals.
- **Slippage:** `.reverts(reason)` on the simulation, and on the write, whose
  estimate then reverts before anything is sent. The app gets viem's own
  `ContractFunctionRevertedError`, with its `reason`.
- **The node:** `mock.failRequests({ status: 503 }, { times: 2 })`, which viem's
  retries ride out, an outage that outlasts them, and
  `.refuses("insufficientFunds")`, which the app gets as viem's
  `InsufficientFundsError`.

### `test/run.test.ts`

- **Filling:** `onTick` calls `mock.mine()` to move the bot to the next block,
  and `.calls[i].blockNumber` shows one tick per block.
- **Blocks during a tick:** `holdQuotes()` answers `getAmountsOut` with an
  async resolver that waits until the test releases it. While a tick is held,
  the test mines blocks, fails the watcher, or aborts.
- **Errors:** `mock.failRequests({ status: 503 }, { method: "eth_blockNumber" })`
  fails only the block watcher's requests, and `botClient(mock, { retryCount: 0 })`
  passes a failure to the app at once.
- **Aborting:** a signal already aborted, aborted while waiting, and aborted
  while a tick runs.

To check that `run()` stopped watching, a test mines a block, waits a few
polling intervals, and checks `mock.history` for new `eth_blockNumber` requests.
