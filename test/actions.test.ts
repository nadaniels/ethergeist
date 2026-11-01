import {
  HttpRequestError,
  InvalidAddressError,
  BlockNotFoundError,
  TimeoutError,
  TransactionReceiptNotFoundError,
  encodeAbiParameters,
  encodeEventTopics,
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
  MockNotFoundError,
  MockResolverError,
  type RpcValue,
  createMockRpc,
  match,
  zeroResult,
  testAddress,
  testHash,
} from "../src/index.js";
import { expectCause, findCause, lowercase, rejectionOf } from "./utils.js";

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
  mock.actions.getTransactionCount().returns(0);
  const wallet = createWalletClient({
    account: privateKeyToAccount(keccak256(toHex("alice"))),
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

    expect(() => {
      mock.actions.getBalance().returns(-1n);
    }).toThrow("not in safe integer range");
    expect(() => {
      // @ts-expect-error a balance is a bigint
      mock.actions.getBalance().returns(1);
    }).toThrow("A balance must be a bigint");
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
    expect(expectCause(error, MockNotFoundError).details).toBe(
      `Registered:\n  getBalance({ address: ${bob} }) once\n  getBalance({ address: ${alice} }) without an answer`,
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

    expect(() => {
      mock.actions.getBalance().returns(match.any());
    }).toThrow("match.any() can't go in return values; matchers only go in args and params.");
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

    mock.mine(10n);
    const block = await client.getBlock();
    expect(block.number).toBe(110n);
    // Base's blockTime is 2s.
    expect(block.timestamp).toBe(2_020n);

    // Timestamps are whole seconds, even when blockTime isn't.
    const fractional = createMockRpc({ chain: { ...base, blockTime: 1_700 }, timestamp: 0n });
    fractional.mine(5n);
    // 5 blocks of 1.7s is 8.5s.
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

    expect(() => {
      // @ts-expect-error timestamps are bigints
      mock.actions.getBlock().returns({ timestamp: "soon" });
    }).toThrow();
  });
});

describe("getTransactionReceipt", () => {
  const txHash = keccak256(toHex("transfer"));
  const otherHash = keccak256(toHex("other"));
  const transferLog = {
    address: USDC,
    // encodeEventTopics is typed for filters; with every indexed arg given, each topic is hex.
    topics: encodeEventTopics({
      abi: erc20Abi,
      eventName: "Transfer",
      args: { from: alice, to: bob },
    }).filter((topic) => typeof topic === "string"),
    data: encodeAbiParameters([{ type: "uint256" }], [5n]),
  } as const;

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

  test("a log placed elsewhere throws, naming where", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    const placed = mock.buildLog({
      abi: erc20Abi,
      address: USDC,
      eventName: "Transfer",
      args: { from: alice, to: bob },
    });

    expect(() => {
      mock.actions.getTransactionReceipt().returns({ blockNumber: 7n, logs: [placed] });
    }).toThrow(
      "Receipt log 0 has blockNumber 10n, but the receipt's is 7n. A receipt places its logs: " +
        "pass only their content, e.g. from contract.events.",
    );
    // The hash is known only once a request arrives.
    mock.actions.getTransactionReceipt({ hash: txHash }).returns({
      logs: [{ ...usdc.events.Transfer({ from: alice, to: bob }), transactionHash: otherHash }],
    });
    expect(String(await rejectionOf(client.getTransactionReceipt({ hash: txHash })))).toContain(
      `Receipt log 0 has transactionHash ${otherHash}, but the receipt's is ${txHash}.`,
    );
  });

  test("a log placed where the receipt is fits, e.g. an emitted one", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    const log = usdc.emit.Transfer({ from: alice, to: bob, value: 5n });
    mock.actions.getTransactionReceipt({ hash: log.transactionHash }).returns({ logs: [log] });

    const receipt = await client.getTransactionReceipt({ hash: log.transactionHash });
    expect(receipt.logs).toEqual([{ ...log, blockTimestamp: undefined }]);
  });

  test("an invalid static value fails at registration", () => {
    const { mock } = setup();

    expect(() => {
      // @ts-expect-error gas is a bigint
      mock.actions.getTransactionReceipt().returns({ gasUsed: "lots" });
    }).toThrow();
    expect(() => {
      mock.actions.getTransactionReceipt().returns({ logs: [{ address: "0x1234" }] });
    }).toThrow(InvalidAddressError);
  });
});

describe("getTransactionCount", () => {
  test("answers a pinned address in viem's types", async () => {
    const { mock, client } = setup();
    mock.actions.getTransactionCount({ address: alice }).returns(7);

    expect(await client.getTransactionCount({ address: alice })).toBe(7);
  });

  test("unmocked addresses aren't answered", async () => {
    const { mock, client } = setup();

    const error = expectCause(
      await rejectionOf(client.getTransactionCount({ address: alice })),
      MockNotFoundError,
    );
    expect(error.message).toContain("No mock for getTransactionCount(");
    expect(mock.unhandled).toHaveLength(1);
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

    for (const value of [-1, 1.5])
      expect(() => {
        mock.actions.getTransactionCount().returns(value);
      }).toThrow(`A transaction count must be a whole number, zero or more; got ${value}.`);
    expect(() => {
      // @ts-expect-error -- viem's count is a number
      mock.actions.getTransactionCount().returns(1n);
    }).toThrow("A transaction count must be a whole number, zero or more; got 1n.");
  });

  test("it's a typed action, so method() refuses it", () => {
    const { mock } = setup();

    expect(() => mock.method("eth_getTransactionCount")).toThrow(
      "use mock.actions.getTransactionCount()",
    );
  });
});

describe("mock.buildReceipt()", () => {
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
// through as is, so code comparing them with === breaks against a real node.
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
    const log = mock.buildLog({
      abi: erc20Abi,
      address: USDC,
      eventName: "Transfer",
      args: { from: alice, to: bob },
    });
    expect(log.address).toBe(lowercase(USDC));
    expect(mock.buildReceipt({ from: alice }).from).toBe(lowercase(alice));
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

  test("refuses methods that have a typed or built-in answer", () => {
    const { mock } = setup();

    expect(() => mock.method("eth_getBalance")).toThrow("use mock.actions.getBalance()");
    expect(() => mock.method("eth_call")).toThrow("register a contract with mock.contract()");
    expect(() => mock.method("eth_chainId")).toThrow("it's the chain's id");
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

describe("bookkeeping", () => {
  test("assertAllUsed() reports args-less action and method mocks too", () => {
    const { mock } = setup();
    mock.actions.getBalance().returns(0n);
    mock.method("eth_getBlockTransactionCountByNumber").returns("0x1");

    expect(() => {
      mock.assertAllUsed();
    }).toThrow(/getBalance\(\*\)[\s\S]*eth_getBlockTransactionCountByNumber\(\*\)/u);
  });

  test("assertAllUsed() reports pinned action mocks that never answered", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: bob }).returns(1n);
    mock.actions.getBalance().returns(0n);
    mock.method("eth_getProof", [USDC]).returns({});

    await client.getBalance({ address: alice });
    expect(() => {
      mock.assertAllUsed();
    }).toThrow(`getBalance({ address: ${getAddress(bob)} })`);
    expect(() => {
      mock.assertAllUsed();
    }).toThrow(`eth_getProof(${USDC})`);
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
