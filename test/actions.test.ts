import {
  type Hash,
  HttpRequestError,
  InvalidAddressError,
  InvalidInputRpcError,
  MethodNotFoundRpcError,
  RpcError,
  BlockNotFoundError,
  TimeoutError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  createWalletClient,
  keccak256,
  parseEventLogs,
  parseGwei,
  toHex,
  erc20Abi,
  getAddress,
  parseEther,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, mainnet } from "viem/chains";
import { describe, expect, test } from "vite-plus/test";

import {
  MockCheckError,
  MockNotFoundError,
  MockResolverError,
  MockSetupError,
  type RpcValue,
  contractEvents,
  createMockRpc,
  match,
  zeroResult,
  testAddress,
  testHash,
  testLog,
} from "../src/index.js";
import { expectCause, expectThrows, hintsOf, findCause, lowercase, rejectionOf } from "./utils.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const NOWHERE = "0x000000000000000000000000000000000000dEaD";
const alice = testAddress("alice");
const bob = testAddress("bob");

function setup() {
  const mock = createMockRpc({ blockNumber: 10n });
  const client = createPublicClient({
    chain: mock.chain,
    cacheTime: 0,
    transport: mock.transport({ retryCount: 0 }),
  });
  return { mock, client };
}

/**
 * A wallet client with a local account, whose prepares try eth_fillTransaction
 * first. Plain transfers' gas is the mock's own estimate.
 */
function walletSetup() {
  const { mock } = setup();
  const wallet = createWalletClient({
    account: privateKeyToAccount(keccak256(toHex("alice"))),
    chain: mock.chain,
    transport: mock.transport({ retryCount: 0 }),
  });
  return { mock, wallet };
}

/** A wallet client whose account is the node's: viem sends eth_sendTransaction unsigned. */
function nodeAccountSetup() {
  const { mock } = setup();
  const wallet = createWalletClient({
    account: alice,
    chain: mock.chain,
    transport: mock.transport({ retryCount: 0 }),
  });
  return { mock, wallet };
}

describe("getBalance", () => {
  test("answers a pinned address in viem's types", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: alice }).returns(parseEther("1"));

    expect(await client.getBalance({ address: alice })).toBe(parseEther("1"));
  });

  test("an unmocked address is unhandled, with a hint", async () => {
    const { mock, client } = setup();

    const error = expectCause(
      await rejectionOf(client.getBalance({ address: alice })),
      MockNotFoundError,
    );
    expect(error.message).toContain(
      `No mock for getBalance({ address: ${getAddress(alice)}, blockNumber: 10n, blockTag: latest })`,
    );
    expect(error.message).toContain("mock.actions.getBalance({ address }).returns(…)");
    expect(mock.unhandled).toHaveLength(1);
  });

  test("the most specific mock wins", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: alice }).returns(5n);
    mock.actions.getBalance().returns(0n);

    expect(await client.getBalance({ address: alice })).toBe(5n);
    expect(await client.getBalance({ address: bob })).toBe(0n);
  });

  test("a pinned block answers that block, including as latest", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: alice, blockNumber: 10n }).returns(5n);
    mock.actions.getBalance({ address: alice }).returns(7n);

    expect(await client.getBalance({ address: alice })).toBe(5n);
    expect(await client.getBalance({ address: alice, blockNumber: 9n })).toBe(7n);
    mock.mine();
    expect(await client.getBalance({ address: alice })).toBe(7n);
  });

  test("resolvers get the call, with tags resolved to a block number", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance().returns(({ blockNumber }) => blockNumber * 100n);

    expect(await client.getBalance({ address: alice })).toBe(1000n);
    expect(await client.getBalance({ address: alice, blockTag: "safe" })).toBe(1000n);
    expect(await client.getBalance({ address: alice, blockNumber: 3n })).toBe(300n);
  });

  test("keeps the block tag, so pending can be pinned apart from latest", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: alice }).returns(parseEther("1"));
    mock.actions.getBalance({ address: alice, blockTag: "pending" }).returns(parseEther("2"));

    expect(await client.getBalance({ address: alice })).toBe(parseEther("1"));
    expect(await client.getBalance({ address: alice, blockTag: "pending" })).toBe(parseEther("2"));
    expect(await client.getBalance({ address: alice, blockNumber: 4n })).toBe(parseEther("1"));
    expect(mock.actions.getBalance.calls.map((call) => call.blockTag)).toEqual([
      "latest",
      "pending",
      undefined,
    ]);
  });

  test("calls are logged with checksummed addresses", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance().returns(0n);

    await client.getBalance({ address: lowercase(alice) });
    expect(mock.actions.getBalance.calls).toEqual([
      { address: getAddress(alice), blockNumber: 10n, blockTag: "latest" },
    ]);
  });

  test("returns() with no value, or zeroResult, answers 0n", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: alice }).returns();
    mock.actions.getBalance({ address: bob }).returns(zeroResult);

    expect(await client.getBalance({ address: alice })).toBe(0n);
    expect(await client.getBalance({ address: bob })).toBe(0n);
  });

  test("invalid values and addresses fail at registration", () => {
    const { mock } = setup();

    expectThrows(
      MockSetupError,
      "getBalance's answer must be a bigint, zero or more; got -1n.",
      () => {
        mock.actions.getBalance().returns(-1n);
      },
    );
    expectThrows(
      MockSetupError,
      "getBalance's answer must be a bigint, zero or more; got 1.",
      () => {
        // @ts-expect-error -- a balance is a bigint
        mock.actions.getBalance().returns(1);
      },
    );
    expect(() => mock.actions.getBalance({ address: "0x1234" })).toThrow(InvalidAddressError);
  });

  test("a resolver that throws, or returns an invalid value, is a resolver error", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: alice }).returns(() => {
      throw new Error("boom");
    });
    mock.actions.getBalance({ address: bob }).returns(() => -1n);

    expectCause(await rejectionOf(client.getBalance({ address: alice })), MockResolverError);
    expectCause(await rejectionOf(client.getBalance({ address: bob })), MockResolverError);
    expect(mock.unhandled).toHaveLength(2);
  });

  test("a resolver can throw MockNotFoundError to leave a request unanswered", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance().returns(({ address }) => {
      if (address === alice) return 1n;
      throw new MockNotFoundError(`No balance for ${address}.`);
    });

    await rejectionOf(client.getBalance({ address: bob }));
    expect(mock.unhandled[0]?.error).toBeInstanceOf(MockNotFoundError);
    expect(mock.unhandled[0]?.error.shortMessage).toBe(`No balance for ${bob}.`);
  });

  test("fails() fails the request, and isn't unhandled", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: alice }).fails({ status: 503 });

    expect(
      expectCause(await rejectionOf(client.getBalance({ address: alice })), HttpRequestError)
        .status,
    ).toBe(503);
    expect(mock.unhandled).toEqual([]);
  });

  test("a mock without an answer doesn't answer; the miss lists what's registered", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: bob }).once().returns(1n);
    mock.actions.getBalance({ address: alice });

    const error = await rejectionOf(client.getBalance({ address: alice }));

    expect(findCause(error, MockResolverError)).toBeUndefined();
    expect(hintsOf(expectCause(error, MockNotFoundError))).toBe(
      `Registered:\n  getBalance({ address: ${bob} }) once  ← address didn't match\n  getBalance({ address: ${alice} }) without an answer`,
    );
  });

  test("a mock without an answer steps aside for one with an answer", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance().returns(5n);
    mock.actions.getBalance({ address: alice });

    expect(await client.getBalance({ address: alice })).toBe(5n);
  });

  test("even for a copy of itself registered before it", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: alice }).returns(5n);
    mock.actions.getBalance({ address: alice });

    expect(await client.getBalance({ address: alice })).toBe(5n);
  });

  test("a resolver can answer zeroResult too", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance().returns(() => zeroResult);

    expect(await client.getBalance({ address: alice })).toBe(0n);
  });

  test("an answer can't be a matcher", () => {
    const { mock } = setup();

    expectThrows(
      MockSetupError,
      "match.any() can't go in return values; matchers only go in args and params.",
      () => {
        mock.actions.getBalance().returns(match.any());
      },
    );
  });
});

describe("getCode", () => {
  test("a registered contract has placeholder code; Multicall3 too", async () => {
    const { mock, client } = setup();
    mock.contract({ abi: erc20Abi, address: USDC });

    expect(await client.getCode({ address: USDC })).toBe("0xfe");
    expect(await client.getCode({ address: mainnet.contracts.multicall3.address })).toBe("0xfe");
  });

  test("an empty() address has no code", async () => {
    const { mock, client } = setup();
    mock.empty(NOWHERE);

    expect(await client.getCode({ address: NOWHERE })).toBeUndefined();
  });

  test("an unknown address is unhandled", async () => {
    const { mock, client } = setup();

    const error = expectCause(
      await rejectionOf(client.getCode({ address: NOWHERE })),
      MockNotFoundError,
    );
    expect(error.message).toContain("or mock.empty(address)");
    expect(mock.unhandled).toHaveLength(1);
  });

  test("a mock overrides the contract's placeholder", async () => {
    const { mock, client } = setup();
    mock.contract({ abi: erc20Abi, address: USDC });
    mock.actions.getCode({ address: USDC }).returns("0x6080");

    expect(await client.getCode({ address: USDC })).toBe("0x6080");
  });

  test("a generated block's hash resolves to its number; other hashes don't", async () => {
    const { mock, client } = setup();
    mock.actions.getCode().returns(({ blockNumber }) => (blockNumber === 7n ? "0x07" : "0x"));
    const { hash } = await client.getBlock({ blockNumber: 7n });

    expect(await client.getCode({ address: USDC, blockHash: hash })).toBe("0x07");
    const error = expectCause(
      await rejectionOf(client.getCode({ address: USDC, blockHash: zeroHash })),
      MockNotFoundError,
    );
    expect(error.message).toContain(`No block with hash ${zeroHash}`);
  });
});

describe("getBlock", () => {
  test("blocks up to the current one are generated, with no setup", async () => {
    const { client } = setup();

    const latest = await client.getBlock();
    expect(latest).toMatchObject({ number: 10n, timestamp: 1_700_000_000n, transactions: [] });
    const parent = await client.getBlock({ blockNumber: 9n });
    expect(latest.parentHash).toBe(parent.hash);
    expect(parent.timestamp).toBe(1_700_000_000n - 12n);
  });

  test("mine() moves latest, and timestamps follow the chain's blockTime", async () => {
    const mock = createMockRpc({ chain: base, blockNumber: 100n, timestamp: 2_000n });
    const client = mock.publicClient();

    mock.mine(10);
    const block = await client.getBlock();
    expect(block.number).toBe(110n);
    // Base's blockTime is 2s.
    expect(block.timestamp).toBe(2_020n);

    const fractional = createMockRpc({ chain: { ...base, blockTime: 1_700 }, timestamp: 0n });
    fractional.mine(5);
    // 5 blocks of 1.7s is 8.5s, and a timestamp is whole seconds.
    expect((await fractional.publicClient().getBlock()).timestamp).toBe(8n);
  });

  test("tags resolve to the current block; earliest is block 0", async () => {
    const { client } = setup();

    expect((await client.getBlock({ blockTag: "finalized" })).number).toBe(10n);
    expect((await client.getBlock({ blockTag: "earliest" })).number).toBe(0n);
  });

  test("a generated block is found by its hash", async () => {
    const { client } = setup();
    const { hash } = await client.getBlock({ blockNumber: 4n });

    expect((await client.getBlock({ blockHash: hash })).number).toBe(4n);
  });

  test("future blocks and unknown hashes are unhandled", async () => {
    const { mock, client } = setup();

    expectCause(await rejectionOf(client.getBlock({ blockNumber: 11n })), MockNotFoundError);
    expectCause(await rejectionOf(client.getBlock({ blockHash: zeroHash })), MockNotFoundError);
    expect(mock.unhandled).toHaveLength(2);
  });

  test("a mock's fields merge over the generated block", async () => {
    const { mock, client } = setup();
    mock.actions.getBlock().returns({ baseFeePerGas: parseGwei("30") });
    mock.actions.getBlock({ blockNumber: 9n }).returns({ timestamp: 1_234n });

    const latest = await client.getBlock();
    expect(latest).toMatchObject({ number: 10n, baseFeePerGas: parseGwei("30") });
    expect(latest.timestamp).toBe(1_700_000_000n);
    expect(await client.getBlock({ blockNumber: 9n })).toMatchObject({
      number: 9n,
      hash: latest.parentHash,
      timestamp: 1_234n,
      baseFeePerGas: parseGwei("10"),
    });
  });

  test("resolvers get the block number, so fields can follow it", async () => {
    const { mock, client } = setup();
    mock.actions.getBlock().returns(({ blockNumber }) => ({ gasUsed: blockNumber * 1_000n }));

    expect((await client.getBlock()).gasUsed).toBe(10_000n);
    expect((await client.getBlock({ blockNumber: 3n })).gasUsed).toBe(3_000n);
  });

  test("a mock can seed a future block or a block by its own hash", async () => {
    const { mock, client } = setup();
    const hash = keccak256(toHex("seeded"));
    mock.actions.getBlock({ blockNumber: 50n }).returns({ timestamp: 5_000n });
    mock.actions.getBlock({ blockHash: hash }).returns({ number: 42n });

    expect((await client.getBlock({ blockNumber: 50n })).timestamp).toBe(5_000n);
    expect(await client.getBlock({ blockHash: hash })).toMatchObject({ number: 42n, hash });
  });

  test("returns(null) is no such block, as viem reports it", async () => {
    const { mock, client } = setup();
    mock.actions.getBlock({ blockNumber: 5n }).returns(null);

    expectCause(await rejectionOf(client.getBlock({ blockNumber: 5n })), BlockNotFoundError);
    expect(mock.unhandled).toEqual([]);
  });

  test("calls record how the block was asked for", async () => {
    const { mock, client } = setup();
    const { hash } = await client.getBlock({ blockNumber: 2n });
    await client.getBlock({ blockTag: "safe" });
    await client.getBlock({ blockHash: hash, includeTransactions: true });

    expect(mock.actions.getBlock.calls).toEqual([
      { blockNumber: 2n, includeTransactions: false },
      { blockNumber: 10n, blockTag: "safe", includeTransactions: false },
      { blockNumber: 2n, blockHash: hash, includeTransactions: true },
    ]);
  });

  test("an invalid static value fails at registration", () => {
    const { mock } = setup();

    const error = expectThrows(
      MockSetupError,
      '.returns() for "getBlock" was given a value it can\'t encode: Cannot convert soon to a BigInt',
      () => {
        // @ts-expect-error -- timestamps are bigints
        mock.actions.getBlock().returns({ timestamp: "soon" });
      },
    );
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });
});

describe("getTransactionReceipt", () => {
  const txHash = keccak256(toHex("transfer"));
  const otherHash = keccak256(toHex("other"));
  const transferLog = contractEvents({ abi: erc20Abi, address: USDC }).Transfer({
    from: alice,
    to: bob,
    value: 5n,
  });

  test("defaults to a successful receipt in the current block", async () => {
    const { mock, client } = setup();
    mock.actions.getTransactionReceipt({ hash: txHash }).returns();

    const receipt = await client.getTransactionReceipt({ hash: txHash });
    expect(receipt).toMatchObject({
      transactionHash: txHash,
      status: "success",
      blockNumber: 10n,
      blockHash: (await client.getBlock()).hash,
      logs: [],
      type: "eip1559",
    });
  });

  test("a mock's fields override the defaults", async () => {
    const { mock, client } = setup();
    mock.actions
      .getTransactionReceipt({ hash: txHash })
      .returns({ status: "reverted", from: alice, gasUsed: 21_000n, blockNumber: 7n });

    const receipt = await client.getTransactionReceipt({ hash: txHash });
    expect(receipt).toMatchObject({
      status: "reverted",
      from: lowercase(alice),
      gasUsed: 21_000n,
      blockNumber: 7n,
      blockHash: (await client.getBlock({ blockNumber: 7n })).hash,
    });
  });

  test("logs take their position, block, and transaction from the receipt", async () => {
    const { mock, client } = setup();
    mock.actions
      .getTransactionReceipt({ hash: txHash })
      .returns({ blockNumber: 7n, logs: [transferLog, { ...transferLog, address: DAI }] });

    const { logs } = await client.getTransactionReceipt({ hash: txHash });
    expect(logs.map((log) => [log.address, log.logIndex, log.blockNumber])).toEqual([
      [lowercase(USDC), 0, 7n],
      [lowercase(DAI), 1, 7n],
    ]);
    expect(logs[0]?.transactionHash).toBe(txHash);
    expect(parseEventLogs({ abi: erc20Abi, logs })[0]).toMatchObject({
      eventName: "Transfer",
      args: { from: getAddress(alice), to: getAddress(bob), value: 5n },
    });
  });

  test("resolvers get the hash", async () => {
    const { mock, client } = setup();
    mock.actions
      .getTransactionReceipt()
      .returns(({ hash }) => ({ status: hash === txHash ? "success" : "reverted" }));

    expect((await client.getTransactionReceipt({ hash: txHash })).status).toBe("success");
    expect((await client.getTransactionReceipt({ hash: otherHash })).status).toBe("reverted");
  });

  test("returns(null) is no such transaction, as viem reports it", async () => {
    const { mock, client } = setup();
    mock.actions.getTransactionReceipt({ hash: txHash }).returns(null);

    expectCause(
      await rejectionOf(client.getTransactionReceipt({ hash: txHash })),
      TransactionReceiptNotFoundError,
    );
    expect(mock.unhandled).toEqual([]);
  });

  test("an unmocked hash is unhandled", async () => {
    const { mock, client } = setup();

    const error = expectCause(
      await rejectionOf(client.getTransactionReceipt({ hash: txHash })),
      MockNotFoundError,
    );
    expect(error.message).toContain(`No mock for getTransactionReceipt({ hash: ${txHash} })`);
    expect(mock.unhandled).toHaveLength(1);
  });

  test("waitForTransactionReceipt and confirmations work against it", async () => {
    const { mock, client } = setup();
    mock.actions.getTransactionReceipt({ hash: txHash }).returns({ blockNumber: 8n });

    const receipt = await client.waitForTransactionReceipt({ hash: txHash });
    expect(receipt.blockNumber).toBe(8n);
    expect(await client.getTransactionConfirmations({ transactionReceipt: receipt })).toBe(3n);
  });

  test("a static receipt stays in the block it was registered in, as a mined one does", async () => {
    const { mock, client } = setup();
    mock.actions.getTransactionReceipt({ hash: txHash }).returns();
    const { hash } = await client.getBlock();
    mock.mine();

    const receipt = await client.getTransactionReceipt({ hash: txHash });
    expect(receipt).toMatchObject({ blockNumber: 10n, blockHash: hash });
    expect(await client.getTransactionConfirmations({ transactionReceipt: receipt })).toBe(2n);
    await expect(
      client.waitForTransactionReceipt({ hash: txHash, confirmations: 2, timeout: 1000 }),
    ).resolves.toMatchObject({ blockNumber: 10n });
    mock.actions.getTransactionReceipt({ hash: otherHash }).returns({ logs: [transferLog] });
    mock.mine();
    const { logs } = await client.getTransactionReceipt({ hash: otherHash });
    expect(logs[0]).toMatchObject({ blockNumber: 11n });
    expect(logs[0]?.blockTimestamp).toBe((await client.getBlock({ blockNumber: 11n })).timestamp);
    // A matcher pin too: the hash comes from the request, the block from registration.
    mock.actions.getTransactionReceipt({ hash: match.any() }).returns();
    mock.mine();
    expect((await client.getTransactionReceipt({ hash: testHash("any") })).blockNumber).toBe(12n);
  });

  test("a mock over an emitted log's transaction keeps its logs and block after mine()", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    const log = usdc.emit.Transfer({ from: alice, to: bob, value: 5n });
    mock.actions.getTransactionReceipt({ hash: log.transactionHash }).returns({ gasUsed: 5n });
    mock.mine();

    const receipt = await client.getTransactionReceipt({ hash: log.transactionHash });
    expect(receipt).toMatchObject({ blockNumber: log.blockNumber, gasUsed: 5n });
    expect(receipt.logs).toEqual([log]);
  });

  test("a resolver's receipt is made when it answers, in the block current then", async () => {
    const { mock, client } = setup();
    mock.actions.getTransactionReceipt({ hash: txHash }).returns(() => ({}));
    mock.mine();

    expect((await client.getTransactionReceipt({ hash: txHash })).blockNumber).toBe(11n);
  });

  test("a log that already has a position is refused: the receipt places it", () => {
    const { mock } = setup();
    const placed = mock.buildLog(
      contractEvents({ abi: erc20Abi, address: USDC }).Transfer({ from: alice, to: bob }),
    );

    const error = expectThrows(
      MockSetupError,
      "A receipt places its logs, but one already has a position (e.g. from mock.buildLog()).",
      () => {
        mock.actions.getTransactionReceipt().returns({ logs: [placed] });
      },
    );
    expect(error.metaMessages).toEqual([
      "Pass a log's content, from contract.events, or contractEvents({ abi, address }) for a " +
        "contract you don't mock.",
    ]);
  });

  test("its logs answer this receipt only: getLogs doesn't see them", async () => {
    const { mock, client } = setup();
    mock.actions.getTransactionReceipt({ hash: txHash }).returns({ logs: [transferLog] });

    expect((await client.getTransactionReceipt({ hash: txHash })).logs).toHaveLength(1);
    expect(await client.getLogs()).toEqual([]);
  });

  test("a reverted one with its own logs is refused, as a reverted transaction has none", () => {
    const { mock } = setup();

    expectThrows(MockSetupError, "A reverted transaction has no logs.", () => {
      mock.actions
        .getTransactionReceipt({ hash: txHash })
        .returns({ status: "reverted", logs: [transferLog] });
    });
  });

  test("an invalid static value fails at registration", () => {
    const { mock } = setup();

    expectThrows(
      MockSetupError,
      '.returns() for "getTransactionReceipt" was given a value it can\'t encode: Cannot convert lots to a BigInt',
      () => {
        // @ts-expect-error -- gas is a bigint
        mock.actions.getTransactionReceipt().returns({ gasUsed: "lots" });
      },
    );
    expect(() => {
      mock.actions.getTransactionReceipt().returns({ from: "0x1234" });
    }).toThrow(InvalidAddressError);
  });
});

describe("getTransactionCount", () => {
  test("answers a pinned address in viem's types", async () => {
    const { mock, client } = setup();
    mock.actions.getTransactionCount({ address: alice }).returns(7);

    expect(await client.getTransactionCount({ address: alice })).toBe(7);
    expect(mock.history[0]?.outcome).toEqual({ type: "result", value: 7 });
  });

  test("unmocked, an address that never sent is at 0, at any block", async () => {
    const { mock, client } = setup();

    expect(await client.getTransactionCount({ address: alice })).toBe(0);
    expect(await client.getTransactionCount({ address: alice, blockTag: "pending" })).toBe(0);
    expect(await client.getTransactionCount({ address: alice, blockNumber: 5n })).toBe(0);
    expect(mock.unhandled).toEqual([]);
  });

  test('"pending" can be pinned apart from "latest": it counts transactions not mined yet', async () => {
    const { mock, client } = setup();
    mock.actions.getTransactionCount({ address: alice }).returns(7);
    mock.actions.getTransactionCount({ address: alice, blockTag: "pending" }).returns(9);

    expect(await client.getTransactionCount({ address: alice })).toBe(7);
    expect(await client.getTransactionCount({ address: alice, blockTag: "pending" })).toBe(9);
    expect(mock.actions.getTransactionCount.calls).toEqual([
      { address: alice, blockNumber: 10n, blockTag: "latest" },
      { address: alice, blockNumber: 10n, blockTag: "pending" },
    ]);
  });

  test("a block number has no tag", async () => {
    const { mock, client } = setup();
    mock.actions.getTransactionCount().returns(({ blockNumber }) => Number(blockNumber));

    expect(await client.getTransactionCount({ address: alice, blockNumber: 5n })).toBe(5);
    expect(mock.actions.getTransactionCount.calls).toEqual([{ address: alice, blockNumber: 5n }]);
  });

  test('preparing a transaction asks for "pending"', async () => {
    const { mock, wallet } = walletSetup();

    await wallet.prepareTransactionRequest({ to: bob, value: 1n });
    expect(mock.actions.getTransactionCount.calls).toMatchObject([{ blockTag: "pending" }]);
  });

  test("a count is a whole number, zero or more", () => {
    const { mock } = setup();
    mock.actions.getTransactionCount().returns(0);

    for (const value of [-1, 1.5])
      expectThrows(
        MockSetupError,
        `A transaction count must be a whole number, zero or more; got ${value}.`,
        () => {
          mock.actions.getTransactionCount().returns(value);
        },
      );
    expectThrows(
      MockSetupError,
      "A transaction count must be a whole number, zero or more; got 1n.",
      () => {
        // @ts-expect-error -- viem's count is a number
        mock.actions.getTransactionCount().returns(1n);
      },
    );
  });

  test("it's a typed action, so method() refuses it", () => {
    const { mock } = setup();

    expectThrows(MockSetupError, "use mock.actions.getTransactionCount()", () =>
      mock.method("eth_getTransactionCount"),
    );
  });
});

describe("mock.buildReceipt()", () => {
  test("a block its encoder can't convert throws the mock's error", () => {
    const { mock } = setup();

    expectThrows(
      MockSetupError,
      "buildReceipt() was given a value it can't encode: Cannot convert x to a BigInt",
      () =>
        // @ts-expect-error -- a block number is a bigint
        mock.buildReceipt({ blockNumber: "x" }),
    );
  });

  test("equals the receipt a mock answers for the same fields", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    const hash = testHash("transfer");
    const fields = {
      from: alice,
      gasUsed: 21_000n,
      logs: [usdc.events.Transfer({ from: alice, to: bob, value: 5n })],
    };
    mock.actions.getTransactionReceipt({ hash }).returns(fields);

    expect(await client.getTransactionReceipt({ hash })).toEqual(
      mock.buildReceipt({ ...fields, transactionHash: hash }),
    );
  });

  test("a deploy's to is null", async () => {
    const { mock, client } = setup();
    const hash = testHash("deploy");
    mock.actions.getTransactionReceipt({ hash }).returns({ to: null, contractAddress: USDC });

    expect(await client.getTransactionReceipt({ hash })).toMatchObject({
      to: null,
      contractAddress: lowercase(USDC),
    });
  });

  test("places its logs' content as the chain places a transaction's", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    const content = [usdc.events.Transfer({ from: alice, to: bob, value: 5n }), testLog("noise")];
    const { hash } = mock.addTransaction({ blockNumber: 10n, logs: content });

    expect(mock.buildReceipt({ transactionHash: hash, logs: content }).logs).toEqual(
      (await client.getTransactionReceipt({ hash })).logs,
    );
  });

  test("refuses a log that already has a position, as a receipt mock does", () => {
    const { mock } = setup();
    const placed = mock.buildLog(
      contractEvents({ abi: erc20Abi, address: USDC }).Transfer({ from: alice, to: bob }),
    );

    expectThrows(
      MockSetupError,
      "A receipt places its logs, but one already has a position (e.g. from mock.buildLog()).",
      () => mock.buildReceipt({ logs: [placed] }),
    );
  });

  test("defaults to a successful receipt in the current block, with a zero hash", () => {
    const { mock } = setup();

    expect(mock.buildReceipt()).toMatchObject({
      status: "success",
      transactionHash: zeroHash,
      blockNumber: 10n,
      logs: [],
    });
  });
});

// Nodes send every address in their answers lowercase, and viem passes them
// through as is, so an app comparing them with `===` breaks against a node.
describe("addresses in answers are lowercase, as nodes send them", () => {
  test("in receipts and their logs", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    const hash = testHash("transfer");
    mock.actions.getTransactionReceipt({ hash }).returns({
      from: alice,
      to: USDC,
      contractAddress: bob,
      logs: [usdc.events.Transfer({ from: alice, to: bob })],
    });

    const receipt = await client.getTransactionReceipt({ hash });
    expect([receipt.from, receipt.to, receipt.contractAddress, receipt.logs[0]?.address]).toEqual([
      lowercase(alice),
      lowercase(USDC),
      lowercase(bob),
      lowercase(USDC),
    ]);
  });

  test("in blocks", async () => {
    const { mock, client } = setup();
    mock.actions.getBlock().returns({ miner: alice });

    expect((await client.getBlock()).miner).toBe(lowercase(alice));
  });

  test("in emitted logs, and in what emit returns", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });

    const log = usdc.emit.Transfer({ from: alice, to: bob });
    expect(log.address).toBe(lowercase(USDC));
    expect((await client.getLogs({ address: USDC }))[0]?.address).toBe(lowercase(USDC));
  });

  test("in builders, which equal what the mock answers", () => {
    const { mock } = setup();
    const log = mock.buildLog(
      contractEvents({ abi: erc20Abi, address: USDC }).Transfer({ from: alice, to: bob }),
    );
    expect(log.address).toBe(lowercase(USDC));
    expect(mock.buildReceipt({ from: alice }).from).toBe(lowercase(alice));
  });
});

/** `hash` with its hex digits uppercased from `from` on: a different case of the same hash. */
const recased = (hash: Hash, from = 2) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the same hash, recased
  (hash.slice(0, from) + hash.slice(from).toUpperCase()) as Hash;

describe("hashes are lowercase, in and out", () => {
  const hash = testHash("tx");
  const mixed = recased(hash);

  test("an added transaction's hash goes on the chain lowercase, and requests in any case find it", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    const record = mock.addTransaction({
      hash: mixed,
      logs: [usdc.events.Transfer({ from: alice, to: bob })],
    });

    expect(record.hash).toBe(hash);
    expect(mock.transactions[0]?.hash).toBe(hash);
    expect(mock.logs[0]?.transactionHash).toBe(hash);
    for (const asked of [hash, mixed, recased(hash, 40)]) {
      expect((await client.getTransaction({ hash: asked })).hash).toBe(hash);
      const receipt = await client.getTransactionReceipt({ hash: asked });
      expect([receipt.transactionHash, receipt.logs[0]?.transactionHash]).toEqual([hash, hash]);
    }
  });

  test("contract.emit's hash and buildLog()'s transactionHash are lowercase", () => {
    const { mock } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });

    expect(usdc.emit.Transfer({ from: alice, to: bob }, { hash: mixed }).transactionHash).toBe(
      hash,
    );
    const content = usdc.events.Transfer({ from: alice, to: bob });
    expect(mock.buildLog(content, { transactionHash: mixed }).transactionHash).toBe(hash);
  });

  test("a mock's hash fields answer lowercase", async () => {
    const { mock, client } = setup();
    const block = recased(testHash("block"));
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    mock.actions.getTransactionReceipt({ hash }).returns({
      transactionHash: mixed,
      blockHash: block,
      logs: [usdc.events.Transfer({ from: alice, to: bob })],
    });
    mock.actions.getTransaction({ hash }).returns({ hash: mixed, blockHash: block });
    mock.actions.getBlock().returns({
      hash: block,
      parentHash: mixed,
      uncles: [mixed],
      transactions: [mixed],
    });

    const receipt = await client.getTransactionReceipt({ hash });
    expect([receipt.transactionHash, receipt.blockHash]).toEqual([hash, lowercase(block)]);
    expect([receipt.logs[0]?.transactionHash, receipt.logs[0]?.blockHash]).toEqual([
      hash,
      lowercase(block),
    ]);
    const transaction = await client.getTransaction({ hash });
    expect([transaction.hash, transaction.blockHash]).toEqual([hash, lowercase(block)]);
    const answered = await client.getBlock();
    expect([answered.hash, answered.parentHash, answered.uncles, answered.transactions]).toEqual([
      lowercase(block),
      hash,
      [hash],
      [hash],
    ]);
    expect(mock.buildReceipt({ transactionHash: mixed }).transactionHash).toBe(hash);
    const built = mock.buildLog(usdc.events.Transfer({ from: alice, to: bob }));
    mock.actions.getLogs().returns([{ ...built, transactionHash: mixed, blockHash: block }]);
    const [log] = await client.getLogs();
    expect([log?.transactionHash, log?.blockHash]).toEqual([hash, lowercase(block)]);
  });

  test("a mock pinned on a hash in another case answers over its transaction on the chain", async () => {
    const { mock, client } = setup();
    mock.addTransaction({ hash, from: alice });
    mock.actions.getTransactionReceipt({ hash: mixed }).returns({ gasUsed: 5n });
    mock.actions.getTransaction({ hash: mixed }).returns({ value: 2n });

    expect(await client.getTransactionReceipt({ hash })).toMatchObject({
      from: lowercase(alice),
      gasUsed: 5n,
    });
    expect(await client.getTransaction({ hash: recased(hash, 30) })).toMatchObject({
      from: lowercase(alice),
      value: 2n,
    });
  });

  test("a restore's note finds a removed hash asked for in another case", async () => {
    const { mock, client } = setup();
    const checkpoint = mock.checkpoint();
    mock.addTransaction({ hash: mixed });
    checkpoint.restore();

    const error = await rejectionOf(client.getTransaction({ hash: recased(hash, 20) }));
    expect(hintsOf(expectCause(error, MockNotFoundError))).toContain("restore()");
  });

  test("a hash in a mock's answer that isn't 32 bytes is refused", () => {
    const { mock } = setup();

    expectThrows(MockSetupError, "A receipt's transactionHash must be 32 bytes; got 0x12.", () => {
      mock.actions.getTransactionReceipt().returns({ transactionHash: "0x12" });
    });
    expectThrows(MockSetupError, "A transaction's blockHash must be 32 bytes; got 0x12.", () => {
      mock.actions.getTransaction().returns({ blockHash: "0x12" });
    });
    expectThrows(MockSetupError, "A block's parentHash must be 32 bytes; got 0x12.", () => {
      mock.actions.getBlock().returns({ parentHash: "0x12" });
    });
  });
});

describe("method()", () => {
  test("answers a method with raw JSON-RPC values", async () => {
    const { mock, client } = setup();
    mock.method("eth_getBlockTransactionCountByNumber").returns("0x3b9aca00");

    expect(await client.getBlockTransactionCount()).toBe(1_000_000_000);
  });

  test("pinned params match a prefix of the request's", async () => {
    const { mock, client } = setup();
    mock.method("eth_getProof", [USDC, ["0x1"]]).returns({ balance: "0x2a" });
    mock.method("eth_getProof").returns({ balance: "0x0" });

    const pinned = await client.getProof({ address: USDC, storageKeys: ["0x1"] });
    const other = await client.getProof({ address: USDC, storageKeys: ["0x2"] });
    expect(pinned.balance).toBe(42n);
    expect(other.balance).toBe(0n);
  });

  test("resolvers get the raw params", async () => {
    const { mock, client } = setup();
    const received: (readonly RpcValue[])[] = [];
    mock.method("eth_getProof").returns(({ params }) => {
      received.push(params);
      return {};
    });

    await client.getProof({ address: USDC, storageKeys: ["0x1"] });
    expect(received).toEqual([[USDC, ["0x1"], "latest"]]);
  });

  test("an unmocked method suggests method()", async () => {
    const { mock, client } = setup();

    const error = expectCause(
      await rejectionOf(client.getBlockTransactionCount()),
      MockNotFoundError,
    );
    expect(error.message).toContain(
      'RPC method "eth_getBlockTransactionCountByNumber" is not mocked',
    );
    expect(error.message).toContain('mock.method("eth_getBlockTransactionCountByNumber", …)');
    expect(mock.unhandled).toHaveLength(1);
  });

  test("a miss shows the request's params, as the registered mocks show theirs", async () => {
    const { mock } = setup();
    mock.method("eth_getProof", [USDC]).returns({});

    const error = expectCause(
      await rejectionOf(mock.request({ method: "eth_getProof", params: [DAI, [], "latest"] })),
      MockNotFoundError,
    );
    expect(error.shortMessage).toBe(`No mock for eth_getProof(${DAI}, [], latest).`);
    expect(error.metaMessages).toEqual([
      "Registered:",
      `  eth_getProof(${USDC})  ← param 1 didn't match`,
    ]);
  });

  test("refuses methods that have a typed or built-in answer", () => {
    const { mock } = setup();

    expectThrows(MockSetupError, "use mock.actions.getBalance()", () =>
      mock.method("eth_getBalance"),
    );
    expectThrows(MockSetupError, "register a contract with mock.contract()", () =>
      mock.method("eth_call"),
    );
    expectThrows(MockSetupError, "it's the chain's id", () => mock.method("eth_chainId"));
  });

  test("fails() works here too", async () => {
    const { mock, client } = setup();
    mock.method("eth_getBlockTransactionCountByNumber").fails("timeout");

    expectCause(await rejectionOf(client.getBlockTransactionCount()), TimeoutError);
  });
});

describe("eth_fillTransaction", () => {
  test("is refused as unsupported, so viem fills each field with its own request", async () => {
    const { mock, wallet } = walletSetup();

    const request = await wallet.prepareTransactionRequest({ to: bob, value: 1n });
    expect(request).toMatchObject({ nonce: 0, gas: 21_000n });
    expect(() => {
      mock.assertNoUnhandled();
    }).not.toThrow();
    expect(mock.history[0]).toMatchObject({
      method: "eth_fillTransaction",
      outcome: {
        type: "rpcError",
        code: -32601,
        message: "the method eth_fillTransaction does not exist/is not available",
      },
    });
  });

  test("a client tries it once: viem remembers the refusal", async () => {
    const { mock, wallet } = walletSetup();

    await wallet.prepareTransactionRequest({ to: bob, value: 1n });
    await wallet.prepareTransactionRequest({ to: bob, value: 2n });
    const fills = mock.history.filter((entry) => entry.method === "eth_fillTransaction");
    expect(fills).toHaveLength(1);
  });

  test("method() answers it instead", async () => {
    const { mock, wallet } = walletSetup();
    mock.method("eth_fillTransaction").fails({ code: -32000, message: "custom" });

    await wallet.prepareTransactionRequest({ to: bob, value: 1n });
    expect(mock.history[0]).toMatchObject({
      method: "eth_fillTransaction",
      outcome: { type: "fault" },
    });
  });
});

describe("wallet_* methods", () => {
  test("wallet_sendTransaction is refused, so a failed send keeps the error the test set up", async () => {
    const { mock, wallet } = nodeAccountSetup();
    mock.actions.sendTransaction().fails({ code: -32000, message: "insufficient funds" });

    const error = expectCause(
      await rejectionOf(wallet.sendTransaction({ to: bob, value: 1n })),
      InvalidInputRpcError,
    );
    expect(error.details).toBe("insufficient funds");
    expect(() => {
      mock.assertNoUnhandled();
    }).not.toThrow();
    expect(mock.history.at(-1)).toMatchObject({
      method: "wallet_sendTransaction",
      outcome: {
        type: "rpcError",
        code: -32601,
        message: "the method wallet_sendTransaction does not exist/is not available",
      },
    });
  });

  test.each([
    { code: -32602, retried: true },
    { code: -32601, retried: true },
    { code: -32004, retried: true },
    { code: -32003, retried: false },
  ])("a send failing with $code keeps its error (retried: $retried)", async ({ code, retried }) => {
    const { mock, wallet } = nodeAccountSetup();
    mock.actions.sendTransaction().fails({ code, message: "failed" });

    const error = await rejectionOf(wallet.sendTransaction({ to: bob, value: 1n }));
    expect(findCause(error, RpcError)?.code).toBe(code);
    expect(mock.unhandled).toHaveLength(0);
    const retries = mock.history.filter((entry) => entry.method === "wallet_sendTransaction");
    expect(retries).toHaveLength(retried ? 1 : 0);
  });

  test("method() answers wallet_sendTransaction instead", async () => {
    const { mock, wallet } = nodeAccountSetup();
    mock.actions.sendTransaction().fails({ code: -32601, message: "not here" });
    mock.method("wallet_sendTransaction").returns(testHash("sent"));

    expect(await wallet.sendTransaction({ to: bob, value: 1n })).toBe(testHash("sent"));
  });

  test("wallet_sendCalls is refused, so sendCalls falls back to separate sends", async () => {
    const { mock, wallet } = nodeAccountSetup();

    const { id } = await wallet.sendCalls({
      calls: [{ to: bob, value: 1n }],
      experimental_fallback: true,
      experimental_fallbackDelay: 0,
    });
    expect(id.startsWith(mock.transactions[0]!.hash)).toBe(true);
    expect(() => {
      mock.assertNoUnhandled();
    }).not.toThrow();
    expect(mock.history[0]).toMatchObject({
      method: "wallet_sendCalls",
      outcome: { type: "rpcError", code: -32601 },
    });
  });

  test("without the fallback, sendCalls rejects as unsupported", async () => {
    const { mock, wallet } = nodeAccountSetup();

    expectCause(
      await rejectionOf(wallet.sendCalls({ calls: [{ to: bob, value: 1n }] })),
      MethodNotFoundRpcError,
    );
    expect(mock.unhandled).toHaveLength(0);
  });
});

describe("bookkeeping", () => {
  test("assertAllUsed() reports args-less action and method mocks too", () => {
    const { mock } = setup();
    mock.actions.getBalance().returns(0n);
    mock.method("eth_getBlockTransactionCountByNumber").returns("0x1");

    expectThrows(
      MockCheckError,
      /getBalance\(\*\)[\s\S]*eth_getBlockTransactionCountByNumber\(\*\)/u,
      () => {
        mock.assertAllUsed();
      },
    );
  });

  test("assertAllUsed() reports pinned action mocks that never answered", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: bob }).returns(1n);
    mock.actions.getBalance().returns(0n);
    mock.method("eth_getProof", [USDC]).returns({});

    await client.getBalance({ address: alice });
    expectThrows(MockCheckError, `getBalance({ address: ${getAddress(bob)} })`, () => {
      mock.assertAllUsed();
    });
    expectThrows(MockCheckError, `eth_getProof(${USDC})`, () => {
      mock.assertAllUsed();
    });
  });

  test("clearCalls() clears history; reset() clears mocks", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance().returns(1n);
    mock.method("eth_getBlockTransactionCountByNumber").returns("0x1");
    await client.getBalance({ address: alice });

    mock.clearCalls();
    expect(mock.actions.getBalance.calls).toEqual([]);
    expect(await client.getBalance({ address: alice })).toBe(1n);

    mock.reset();
    expectCause(await rejectionOf(client.getBalance({ address: alice })), MockNotFoundError);
    expectCause(await rejectionOf(client.getBlockTransactionCount()), MockNotFoundError);
  });
});
