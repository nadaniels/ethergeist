<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/nadaniels/ethergeist/main/docs/assets/ethergeist-dark@3x.png">
    <img src="https://raw.githubusercontent.com/nadaniels/ethergeist/main/docs/assets/ethergeist-light@3x.png" alt="ethergeist" width="434">
  </picture>
</p>

# ethergeist

A mock Ethereum node for [viem](https://viem.sh). Describe what your contracts
return, not what the RPC sends.

ethergeist is a viem transport that answers from mocks you declare, fully typed
from your ABIs: "`balanceOf(alice)` returns 100", "`approve` reverts with
`InsufficientAllowance`", "this transfer emits these logs".

Your app's real viem client runs unchanged, so encoding, decoding, receipts,
and viem's error classes are all real. There's no node, RPC key, bytecode,
or network: put the chain in any state in one line, then check what your app asked
for.

It's a stub, not an emulator, so nothing executes. It answers what's mocked,
and imitates a node only where your app would see the difference.

```ts skip
// Before: a hand-rolled transport, in hex.
const transport = custom({
  async request({ method, params }) {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_call" && params[0].data.startsWith("0x70a08231"))
      return "0x0000000000000000000000000000000000000000000000000000000000000064";
    throw new Error(`Unmocked: ${method}`);
  },
});

// After: the contract, in its own terms.
const mock = createMockRpc();
const usdc = mock.contract({ abi: erc20Abi, address: USDC });
usdc.read.balanceOf([alice]).returns(100n);
```

## Who It's For

- **Frontend tests** (React, wagmi): run the real hooks against the states your
  UI has to handle, like a zero balance, a paused contract, a revert, or a
  slow node, instead of mocking the hooks.
- **Backend services and indexers:** deterministic logs, receipts, and
  block ranges, and the errors they have to survive, like a log range that's too
  large.
- **Libraries built on viem:** chain states and node errors in CI, without
  running a node.
- **Frontends without the contracts:** an ABI is all it needs, so you can test
  against a contract that isn't deployed yet.

A fork (Anvil, Tenderly) is the better tool when you need to know your app works
against the real contracts and their real state, e.g. a smoke test before a
release. ethergeist is for knowing your app does the right thing when the chain
says X: most tests, in milliseconds, without flakes, an RPC key, or a network.

## Install

```sh
npm install -D ethergeist viem
```

ESM only. Node 22.12 or later, or a browser; viem 2.50.3 or later; TypeScript
5.8 or later.

## Quick Start

These are Vitest tests, but any runner works.

### Contract Reads

```ts
import { createMockRpc, testAddress } from "ethergeist";
import { erc20Abi } from "viem";
import { expect, test } from "vitest";

const USDC = testAddress("usdc");
const alice = testAddress("alice");

test("reads a balance", async () => {
  const mock = createMockRpc();
  const usdc = mock.contract({ abi: erc20Abi, address: USDC });
  usdc.read.balanceOf([alice]).returns(100n);

  // The client your app would create, on the mock's transport.
  const client = mock.publicClient();
  const balance = await client.readContract({
    abi: erc20Abi,
    address: USDC,
    functionName: "balanceOf",
    args: [alice],
  });

  expect(balance).toBe(100n);
});
```

`testAddress()` gives a stable, checksummed address for a label.
`mock.publicClient()` is a viem public client on `mock.transport()`, which you
can hand to anything that takes a viem transport.

### Contract Writes

```ts
import { createMockRpc, testAddress } from "ethergeist";
import { createWalletClient, erc20Abi } from "viem";
import { expect, test } from "vitest";

const USDC = testAddress("usdc");
const alice = testAddress("alice");
const bob = testAddress("bob");

test("sends a transfer", async () => {
  const mock = createMockRpc();
  const usdc = mock.contract({ abi: erc20Abi, address: USDC });
  usdc.write.transfer([bob, 5n]).emits(usdc.events.Transfer({ from: alice, to: bob, value: 5n }));

  const wallet = createWalletClient({
    account: alice,
    chain: mock.chain,
    transport: mock.transport(),
  });
  const hash = await wallet.writeContract({
    abi: erc20Abi,
    address: USDC,
    functionName: "transfer",
    args: [bob, 5n],
  });

  const receipt = await mock.publicClient().waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
  expect(receipt.logs).toHaveLength(1);
});
```

The transfer is mined in a new block on the mock's chain state, so its receipt and
its `Transfer` log are there for the app to find (see [The Chain](#the-chain)).
If viem estimates the gas first, as it does for a local account, the write mock
answers the estimate too (default 100,000 gas). A `.reverts()` mock reverts the
estimate instead, as a node would, and an `estimateGas` mock sets a number.

Reads batched through Multicall3 are answered call by call, so viem's
`multicall()` and wagmi's `useReadContracts` work unchanged.

## Contracts

`mock.contract()` takes an ABI and an address. It has `read`, `simulate`,
`estimateGas`, and `write` namespaces, typed by the ABI as viem's
`getContract()` is:

```ts
import { createMockRpc, testAddress } from "ethergeist";
import { parseAbi } from "viem";

const vaultAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function deposit(uint256 amount)",
  "function withdraw(uint256 amount)",
  "error Paused()",
  "error InsufficientBalance()",
]);
const alice = testAddress("alice");

const mock = createMockRpc();
const vault = mock.contract({ abi: vaultAbi, address: testAddress("vault") });
```

A function's mock answers with a value, or reverts with an error from the ABI,
a reason string, or a panic code:

```ts continued
vault.read.totalAssets().returns(1_000_000n);
vault.write.deposit().reverts({ errorName: "Paused" });
```

`.once()` and `.times(n)` limit a mock. A limited mock answers first, then makes
way, so a test can change the answer partway through:

```ts continued
vault.read.balanceOf([alice]).returns(100n);
vault.read.balanceOf([alice]).once().returns(0n); // the first call only
```

`defaults` answer whatever no mock does, e.g. a vault nobody has used:

```ts continued
mock.contract({
  abi: vaultAbi,
  address: testAddress("empty-vault"),
  defaults: { read: { balanceOf: 0n, totalAssets: 0n } },
});
```

### Resolvers

A resolver is a function in place of a value. It runs for each call, and what
it returns is the answer. It gets the call (its decoded `args`, the sender, the
value, and the block) and `revert`, to revert this call only. It can also be async.

A resolver can keep its own state, e.g. a balance that a withdrawal lowers:

```ts continued
const savings = mock.contract({ abi: vaultAbi, address: testAddress("savings") });

let balance = 100n;
savings.read.balanceOf([alice]).returns(() => balance);
savings.write.withdraw().returns(({ args: [amount], revert }) => {
  if (amount > balance) revert({ errorName: "InsufficientBalance" });
  balance -= amount;
});
```

## Matching

A mock with args answers only calls with those args; one without args answers
any call to the function. In place of an exact value, `match` takes:

- `match.any()`: any value at that position;
- `match.where(predicate)`: a value the predicate accepts;
- `match.partial({ ...fields })`: a struct with those fields, whatever the
  rest.

```ts
import { createMockRpc, match, testAddress } from "ethergeist";
import { erc20Abi, isAddressEqual, parseAbi } from "viem";

const alice = testAddress("alice");
const router = testAddress("router");
const USDC = testAddress("usdc");
const mock = createMockRpc();
const usdc = mock.contract({ abi: erc20Abi, address: USDC });

// Alice's allowance for any spender.
usdc.read.allowance([alice, match.any()]).returns(5n);
// The router's allowance from anyone but alice.
usdc.read.allowance([match.where((owner) => !isAddressEqual(owner, alice)), router]).returns(0n);

// Any quote that sells USDC.
const quoterAbi = parseAbi([
  "struct QuoteParams { address tokenIn; address tokenOut; uint256 amountIn; }",
  "function quote(QuoteParams params) view returns (uint256 amountOut)",
]);
const quoter = mock.contract({ abi: quoterAbi, address: testAddress("quoter") });
quoter.read.quote([match.partial({ tokenIn: USDC })]).returns(990n);
```

When several mocks match a call, the most specific one answers: exact values
beat `match.where()`, which beats `match.any()` or no args at all, and a
`match.partial()` counts the fields it gives.

```ts continued
usdc.read.balanceOf().returns(0n); // anyone
usdc.read.balanceOf([alice]).returns(100n); // alice: more specific, so it answers for her
```

When two mocks are equally specific:

- Limited mocks (`.once()`, `.times(n)`) answer before unlimited ones, in the
  order you registered them.
- Otherwise the one registered last answers, so a test can override a shared
  setup by registering again.

```ts continued
usdc.read.balanceOf([alice]).once().returns(1n); // the next call
usdc.read.balanceOf([alice]).once().returns(2n); // the one after
usdc.read.balanceOf([alice]).returns(3n); // from then on, over the 100n above
```

A call no mock matches fails with the mocks that came close, and why each
missed:

```text
No mock for balanceOf(0xa0Cf…5e1C)
Registered:
  balanceOf(0x3c4D…91aB)  ← account didn't match
```

## The Chain

The mock keeps a small chain state: a current block, and the transactions placed on
it. Nothing runs on it; it records what your mocks said happened. A send that a
mock answers is placed in a new block, mined at once, and its receipt, its
transaction, the block, and `getLogs()` all answer from that record. So do
watchers, which see each new block.

`createMockRpc()` takes a viem chain definition, a starting block and time, and fee settings.
`mine()` moves it on, `setFees()` changes the fees from the current block, and
`addTransaction()` places a transaction your app didn't send, with any logs:

```ts
import { createMockRpc, testAddress } from "ethergeist";
import { erc20Abi, parseGwei } from "viem";
import { base } from "viem/chains";

const mock = createMockRpc({ chain: base, blockNumber: 1_000n });
const usdc = mock.contract({ abi: erc20Abi, address: testAddress("usdc") });

mock.mine(5); // the head is now block 1,005
mock.setFees({ baseFeePerGas: parseGwei("50") }); // a fee spike

// Someone else's transfer, in the next block.
mock.addTransaction({
  from: testAddress("carol"),
  to: usdc.address,
  logs: [usdc.events.Transfer({ from: testAddress("carol"), to: testAddress("dave"), value: 1n })],
});

// One placed two blocks ahead is pending until they're mined.
mock.addTransaction({
  from: testAddress("erin"),
  blockNumber: mock.blockNumber + 2n,
});
mock.mine(2);
```

`mock.transactions` lists what's placed, and `mock.blockNumber` is the head.
Mocks for a transaction or receipt answer over what the chain has, so a test can
change one field and keep the rest.

Use one mock per chain: a multi-chain app gets a mock for each, on its own
transport.

## Actions

`mock.actions` mocks viem's public actions beyond contract calls, in viem's own
types: balances, code, storage, blocks, transactions and receipts, logs, gas
prices and fee history, nonces, estimates, and sends. Each takes pins and answers
as a contract function's mock does:

```ts
import { createMockRpc, testAddress } from "ethergeist";
import { parseEther, parseGwei } from "viem";

const alice = testAddress("alice");
const mock = createMockRpc();

mock.actions.getBalance({ address: alice }).returns(parseEther("1"));
mock.actions.getGasPrice().returns(parseGwei("30"));
mock.actions.getBlock().returns({ timestamp: 1_700_000_000n });

// A provider's block range cap, for an app that splits the range on it.
mock.actions.getLogs().fails({ code: -32005, message: "query returned more than 10000 results" });
```

Without a mock, what the chain knows answers: blocks up to the current one, gas
prices and fee history from its fees, nonces, and the transactions and receipts
placed on it. Anything else isn't answered, and fails with what was registered.

`mock.method()` answers any other JSON-RPC method, in raw JSON-RPC values:

```ts continued
mock.method("eth_getBlockTransactionCountByNumber").returns("0x3");
```

A method may get a typed action in a later minor release before 1.0; then
`mock.method()` refuses it, naming the action to use.

## Events and Logs

A contract's `events` build an event's log, typed by the ABI. A write mock
`.emits()` it in its transaction, as in the [quick start](#contract-writes), and
`emit` places it in a transaction of its own, for `getLogs()`, watchers, and
receipts to find:

```ts
import { createMockRpc, testAddress } from "ethergeist";
import { erc20Abi } from "viem";
import { expect } from "vitest";

const alice = testAddress("alice");
const bob = testAddress("bob");
const mock = createMockRpc();
const usdc = mock.contract({ abi: erc20Abi, address: testAddress("usdc") });

usdc.emit.Transfer({ from: alice, to: bob, value: 5n });

const logs = await mock.publicClient().getContractEvents({
  abi: erc20Abi,
  address: usdc.address,
  eventName: "Transfer",
});
expect(logs[0]?.args).toEqual({ from: alice, to: bob, value: 5n });
```

`mock.logs` lists every placed log. `contractEvents({ abi, address })` builds
logs for a contract you don't mock, `testLog(label)` builds a log that matches
no event (noise your app should skip), and
`mock.buildLog()`, `buildReceipt()`, and `buildTransaction()` give complete
values in viem's types, for `toEqual` and props.

## Node Failures

`failRequests()` fails requests as a node or provider would: an HTTP status, a
JSON-RPC error, a timeout, or a network failure. viem retries them as it would
for a real node:

```ts
import { createMockRpc, testAddress } from "ethergeist";
import { erc20Abi } from "viem";

const mock = createMockRpc();
const usdc = mock.contract({ abi: erc20Abi, address: testAddress("usdc") });

mock.failRequests({ status: 503 }, { times: 2 }); // two failures, then it recovers
const outage = mock.failRequests("timeout");
outage.clear();

// Just one function.
usdc.read.balanceOf().fails({ status: 429, retryAfter: 1 });
```

Estimates, simulations, and sends also take a node's refusals by name, each
where a node can give it, and viem sorts them into its own error classes (e.g.
`NonceTooLowError`): `"insufficientFunds"`,
`"nonceTooLow"`, `"nonceTooHigh"`, `"alreadyKnown"`, `"feeCapTooLow"`,
`"tipAboveFeeCap"`, `"intrinsicGasTooLow"`, and `"gasExceedsAllowance"`.

```ts continued
usdc.write.transfer().fails("insufficientFunds");
mock.actions.sendTransaction().fails("nonceTooLow");
```

## History and Checks

The mock records what your app asked for, decoded:

```ts
import { createMockRpc, testAddress } from "ethergeist";
import { erc20Abi } from "viem";
import { expect } from "vitest";

const alice = testAddress("alice");
const mock = createMockRpc();
const usdc = mock.contract({ abi: erc20Abi, address: testAddress("usdc") });
usdc.read.balanceOf().returns(100n);

await mock.publicClient().readContract({
  abi: erc20Abi,
  address: usdc.address,
  functionName: "balanceOf",
  args: [alice],
});

expect(usdc.read.balanceOf.calls).toMatchObject([{ args: [alice] }]);
```

- `contract.calls` and `mock.calls` list decoded calls, across namespaces and
  inside multicalls; each action has `.calls` too.
- `mock.history` has every request and how it was answered, and
  `mock.formatHistory()` prints it. `createMockRpc({ debug: true })` logs each
  request as it's answered, for a test that times out before it can print.
- `mock.assertNoUnhandled()` fails if a request went unanswered, even one whose
  error your app swallowed.
- `mock.assertAllUsed()` fails if a mock never answered, e.g. because its pins
  are wrong and a broader mock answered instead.

```ts continued
mock.assertNoUnhandled();
mock.assertAllUsed();
```

## Shared Setup

Register a suite's setup once, take a checkpoint, and restore it after each
test. `restore()` undoes every mock, transaction, and fault since, and can run
the checks on the test that's ending:

```ts skip
const mock = createMockRpc();
const usdc = mock.contract({ abi: erc20Abi, address: USDC, defaults: { read: { decimals: 6 } } });
const baseline = mock.checkpoint();

afterEach(() => {
  baseline.restore({ assertNoUnhandled: true, assertAllUsed: true });
});
```

`mock.clearCalls()` clears only the records, and `mock.reset()` goes back to
an empty mock.

## With wagmi

A wagmi config on the mock's transport runs the real hooks against it:

```ts skip
import { createMockRpc, testAddress } from "ethergeist";
import { createConfig } from "wagmi";
import { mock as mockConnector } from "wagmi/connectors";

const mock = createMockRpc();
const config = createConfig({
  chains: [mock.chain],
  connectors: [mockConnector({ accounts: [testAddress("alice")], features: { reconnect: true } })],
  transports: { [mock.chain.id]: mock.transport() },
  cacheTime: 0,
  pollingInterval: 50,
  multiInjectedProviderDiscovery: false,
});
```

- Use a new `QueryClient` per test, with `retry: false`.
- Connect the connector before rendering: hooks like `useSimulateContract` wait
  for a connected account.
- Render with `findBy*` queries, and add
  `onTestFinished(() => mock.assertNoUnhandled())`, so a missing mock fails
  with its name rather than as a `waitFor` timeout.
- wagmi's `mock` connector sends its own transactions over HTTP, not through
  the transport, so this covers reads and simulations. Writes through a wallet
  need the EIP-1193 provider, planned for 0.2.0.

## Stability

ethergeist is 0.x: a breaking change is a minor release, and anything else is a
patch. Adding to a set (an action, an option, a union member, a node error) isn't
breaking; narrowing or renaming is. Release notes are on
[GitHub Releases](https://github.com/nadaniels/ethergeist/releases).

Every type a public signature reaches is exported. These are the ones you'll
write, and they're kept stable:

- setup: `CreateMockRpcParameters`, `MockRpc`, `MockContract`,
  `CreateMockContractParameters`;
- resolvers: the `*Call` and `*Context` types;
- answers: `MockReceipt`, `MockBlock`, `MockTransaction`, `MockLogContent`;
- records: `TransactionRecord`, `MockHistoryEntry`;
- parameters: `AddTransactionParameters`, `RestoreOptions`;
- the error classes and the error-name unions (`NodeErrorName` and the like).

Type parameters are promised only on `MockContract<abi>` and
`CreateMockContractParameters<abi>`. Every other exported type may change in a
minor release.

The `MockError` classes' JSON-RPC codes are stable, and `-32099` to `-32090` is
reserved for them.

Generated hashes depend on the transaction's place and the chain: don't pin
them in a test. Read them from the record or the receipt.

## Reference

The API reference is in the type definitions: every export has a doc comment,
so your editor shows it on hover.

## License

[MIT](LICENSE)
