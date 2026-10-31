import { TransactionNotFoundError, createPublicClient, parseGwei } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { MockNotFoundError, createMockRpc, testAddress, testHash } from "../src/index.js";
import { expectCause, rejectionOf } from "./utils.js";

const alice = testAddress("alice");
const bob = testAddress("bob");
const hash = testHash("tx-1");

function setup() {
  const mock = createMockRpc({ blockNumber: 10n });
  const client = createPublicClient({
    chain: mock.chain,
    cacheTime: 0,
    transport: mock.transport({ retryCount: 0 }),
  });
  return { mock, client };
}

describe("getTransaction", () => {
  test("answers a pinned hash: an eip1559 transaction in the current block, paying the suggested fees", async () => {
    const { mock, client } = setup();
    mock.actions.getTransaction({ hash }).returns({ from: alice, to: bob, value: 1n });

    const transaction = await client.getTransaction({ hash });

    expect(transaction).toEqual({
      type: "eip1559",
      typeHex: "0x2",
      chainId: 1,
      nonce: 0,
      gas: 0n,
      maxFeePerGas: parseGwei("11"),
      maxPriorityFeePerGas: parseGwei("1"),
      gasPrice: parseGwei("11"),
      to: bob.toLowerCase(),
      value: 1n,
      accessList: [],
      input: "0x",
      r: "0x0",
      s: "0x0",
      yParity: 0,
      v: 0n,
      hash,
      blockHash: (await client.getBlock({ blockNumber: 10n })).hash,
      blockNumber: 10n,
      transactionIndex: 0,
      from: alice.toLowerCase(),
      blockTimestamp: (await client.getBlock({ blockNumber: 10n })).timestamp,
    });
    expect(transaction).toEqual(mock.buildTransaction({ hash, from: alice, to: bob, value: 1n }));
  });

  test("unmocked hashes aren't answered; null is no such transaction", async () => {
    const { mock, client } = setup();
    mock.actions.getTransaction({ hash }).returns(null);

    expectCause(await rejectionOf(client.getTransaction({ hash })), TransactionNotFoundError);
    expectCause(
      await rejectionOf(client.getTransaction({ hash: testHash("tx-2") })),
      MockNotFoundError,
    );
    expect(mock.unhandled).toHaveLength(1);
  });

  test("fees come from the transaction's block; set ones give its effective gas price", () => {
    const { mock } = setup();
    mock.setFees({ baseFeePerGas: parseGwei("50") });

    expect(mock.buildTransaction({ blockNumber: 5n })).toMatchObject({
      maxFeePerGas: parseGwei("11"),
      gasPrice: parseGwei("11"),
    });
    expect(mock.buildTransaction({})).toMatchObject({
      maxFeePerGas: parseGwei("51"),
      gasPrice: parseGwei("51"),
    });
    // The tip it pays is capped by its max fee.
    expect(
      mock.buildTransaction({
        maxFeePerGas: parseGwei("60"),
        maxPriorityFeePerGas: parseGwei("15"),
      }).gasPrice,
    ).toBe(parseGwei("60"));
    expect(mock.buildTransaction({ type: "legacy", gasPrice: 7n }).gasPrice).toBe(7n);
  });

  test("each type has its own fields and defaults", () => {
    const { mock } = setup();

    const legacy = mock.buildTransaction({ type: "legacy" });
    expect(legacy).toMatchObject({ typeHex: "0x0", gasPrice: parseGwei("11"), v: 37n });
    expect(legacy).not.toHaveProperty("accessList");
    expect(legacy).not.toHaveProperty("maxFeePerGas");
    expect(mock.buildTransaction({ type: "eip2930" })).toMatchObject({
      typeHex: "0x1",
      gasPrice: parseGwei("11"),
      accessList: [],
    });
    expect(mock.buildTransaction({ type: "eip4844" })).toMatchObject({
      typeHex: "0x3",
      blobVersionedHashes: [],
      maxFeePerBlobGas: 1n,
    });
    expect(
      mock.buildTransaction({
        type: "eip7702",
        authorizationList: [
          { address: alice, chainId: 1, nonce: 3, r: "0x1", s: "0x2", yParity: 1 },
        ],
      }).authorizationList,
    ).toEqual([
      { address: alice.toLowerCase(), chainId: 1, nonce: 3, r: "0x1", s: "0x2", yParity: 1 },
    ]);
  });

  test("a field the type doesn't have throws, at registration", () => {
    const { mock } = setup();

    expect(() => {
      // @ts-expect-error legacy transactions have no max fee
      mock.actions.getTransaction().returns({ type: "legacy", maxFeePerGas: 1n });
    }).toThrow(
      "An legacy transaction has no maxFeePerGas: set `type` to one that has it (eip1559, eip4844, eip7702).",
    );
    expect(() => {
      // @ts-expect-error the default type, eip1559, has no authorization list
      mock.actions.getTransaction().returns({ authorizationList: [] });
    }).toThrow("An eip1559 transaction has no authorizationList");
    expect(() => {
      // @ts-expect-error not a transaction field
      mock.actions.getTransaction().returns({ data: "0x" });
    }).toThrow('A transaction has no field "data".');
    expect(() => {
      // @ts-expect-error not a type viem knows
      mock.actions.getTransaction().returns({ type: "eip9999" });
    }).toThrow('Unknown transaction type "eip9999"');
  });

  test("blockNumber: null makes it pending, priced at its max fee", () => {
    const { mock } = setup();

    const pending = mock.buildTransaction({ blockNumber: null });

    expect(pending).toMatchObject({
      blockNumber: null,
      blockHash: null,
      transactionIndex: null,
      gasPrice: parseGwei("11"),
    });
    expect(pending).not.toHaveProperty("blockTimestamp");
    expect(() =>
      // @ts-expect-error a pending transaction has no block hash
      mock.buildTransaction({ blockNumber: null, blockHash: hash }),
    ).toThrow(
      "A pending transaction (blockNumber: null) has a null blockHash and transactionIndex.",
    );
    expect(() =>
      // @ts-expect-error only a pending transaction has a null block hash
      mock.buildTransaction({ blockHash: null }),
    ).toThrow("Only a pending transaction has a null blockHash or transactionIndex");
    expect(() => mock.buildTransaction({ blockNumber: null, blockTimestamp: 1n })).toThrow(
      "A pending transaction (blockNumber: null) has no blockTimestamp.",
    );
  });

  test("waitForTransactionReceipt asks for the transaction while the receipt is missing", async () => {
    const mock = createMockRpc({ blockNumber: 10n });
    const client = mock.publicClient();
    mock.actions.getTransaction({ hash }).returns({ from: alice });
    mock.actions.getTransactionReceipt({ hash }).once().returns(null);
    mock.actions.getTransactionReceipt({ hash }).returns({ from: alice });

    const receipt = await client.waitForTransactionReceipt({ hash });

    expect(receipt.status).toBe("success");
    // The receipt is missing, so viem looks the transaction up once (to watch
    // for a replacement), then finds the receipt.
    expect(mock.actions.getTransaction.calls).toEqual([{ hash }]);
    const short = `0x${hash.slice(2, 6)}…${hash.slice(-4)}`;
    expect(mock.formatHistory()).toBe(
      [
        `#1 eth_getTransactionReceipt getTransactionReceipt({ hash: ${short} }) → null`,
        "#2 eth_blockNumber → 10n",
        `#3 eth_getTransactionByHash getTransaction({ hash: ${short} }) → eip1559, block 10n`,
        `#4 eth_getTransactionReceipt getTransactionReceipt({ hash: ${short} }) → success, block 10n, 0 log(s)`,
      ].join("\n"),
    );
  });

  test("getTransactionConfirmations counts from the transaction's block", async () => {
    const { mock, client } = setup();
    mock.actions.getTransaction({ hash }).returns({ blockNumber: 8n });

    expect(await client.getTransactionConfirmations({ hash })).toBe(3n);
  });

  test("history summarizes it; method() refuses it", async () => {
    const { mock, client } = setup();
    mock.actions.getTransaction({ hash }).returns({});

    await client.getTransaction({ hash });

    expect(mock.formatHistory()).toBe(
      `#1 eth_getTransactionByHash getTransaction({ hash: 0x${hash.slice(2, 6)}…${hash.slice(-4)} }) → eip1559, block 10n`,
    );
    expect(() => mock.method("eth_getTransactionByHash")).toThrow(
      '"eth_getTransactionByHash" has a typed mock: use mock.actions.getTransaction().',
    );
  });
});
