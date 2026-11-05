import {
  TransactionNotFoundError,
  createPublicClient,
  createWalletClient,
  parseGwei,
  zeroAddress,
} from "viem";
import { describe, expect, test } from "vite-plus/test";

import {
  MockNotFoundError,
  MockSetupError,
  createMockRpc,
  testAddress,
  testHash,
  testLog,
} from "../src/index.js";
import { expectCause, expectThrows, lowercase, rejectionOf } from "./utils.js";

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

  test("a static one stays in the block it was registered in, with that block's fees; a pending one stays pending", async () => {
    const { mock, client } = setup();
    const mined = mock.buildTransaction({ hash });
    mock.actions.getTransaction({ hash }).returns({});
    mock.actions.getTransaction({ hash: testHash("tx-2") }).returns({ blockNumber: null });
    mock.mine();
    mock.setFees({ baseFeePerGas: parseGwei("50") });

    expect(await client.getTransaction({ hash })).toEqual(mined);
    expect(await client.getTransactionConfirmations({ hash })).toBe(2n);
    expect((await client.getTransaction({ hash: testHash("tx-2") })).blockNumber).toBeNull();
    // A resolver's is made when it answers.
    mock.actions.getTransaction({ hash }).returns(() => ({}));
    expect((await client.getTransaction({ hash })).blockNumber).toBe(11n);
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
    // With room under the max fee, the tip is paid in full.
    expect(
      mock.buildTransaction({
        maxFeePerGas: parseGwei("100"),
        maxPriorityFeePerGas: parseGwei("2"),
      }).gasPrice,
    ).toBe(parseGwei("52"));
    expect(mock.buildTransaction({ type: "legacy", gasPrice: 7n }).gasPrice).toBe(7n);
  });

  test("a value its encoder can't convert throws the mock's error", () => {
    const { mock } = setup();

    const error = expectThrows(
      MockSetupError,
      "buildTransaction() was given a value it can't encode: Cannot convert lots to a BigInt",
      () =>
        // @ts-expect-error value is a bigint
        mock.buildTransaction({ value: "lots" }),
    );
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });

  test("a deploy's to is null", async () => {
    const { mock, client } = setup();
    mock.actions.getTransaction({ hash }).returns({ to: null, input: "0x6080" });

    expect((await client.getTransaction({ hash })).to).toBeNull();
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

    expectThrows(
      MockSetupError,
      "An legacy transaction has no maxFeePerGas: set `type` to one that has it (eip1559, eip4844, eip7702).",
      () => {
        // @ts-expect-error legacy transactions have no max fee
        mock.actions.getTransaction().returns({ type: "legacy", maxFeePerGas: 1n });
      },
    );
    expectThrows(MockSetupError, "An eip1559 transaction has no authorizationList", () => {
      // @ts-expect-error the default type, eip1559, has no authorization list
      mock.actions.getTransaction().returns({ authorizationList: [] });
    });
    expectThrows(MockSetupError, 'A transaction has no field "data".', () => {
      // @ts-expect-error not a transaction field
      mock.actions.getTransaction().returns({ data: "0x" });
    });
    expectThrows(MockSetupError, 'Unknown transaction type "eip9999"', () => {
      // @ts-expect-error not a type viem knows
      mock.actions.getTransaction().returns({ type: "eip9999" });
    });
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
    expectThrows(
      MockSetupError,
      "A pending transaction (blockNumber: null) has a null blockHash and transactionIndex.",
      () =>
        // @ts-expect-error a pending transaction has no block hash
        mock.buildTransaction({ blockNumber: null, blockHash: hash }),
    );
    expectThrows(
      MockSetupError,
      "Only a pending transaction has a null blockHash or transactionIndex",
      () =>
        // @ts-expect-error only a pending transaction has a null block hash
        mock.buildTransaction({ blockHash: null }),
    );
    expectThrows(
      MockSetupError,
      "A pending transaction (blockNumber: null) has no blockTimestamp.",
      () => mock.buildTransaction({ blockNumber: null, blockTimestamp: 1n }),
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
    expectThrows(
      MockSetupError,
      '"eth_getTransactionByHash" has a typed mock: use mock.actions.getTransaction().',
      () => mock.method("eth_getTransactionByHash"),
    );
  });
});

describe("mock.addTransaction", () => {
  test("with no fields, places a success from and to the zero address in a newly mined block", async () => {
    const { mock, client } = setup();

    const record = mock.addTransaction();

    expect(mock.blockNumber).toBe(11n);
    expect(record).toEqual({
      hash: testHash("tx:11:0"),
      origin: "added",
      fields: {},
      receipt: {},
      logs: [],
      position: { blockNumber: 11n, index: 0 },
    });
    expect(mock.transactions).toEqual([record]);
    expect(mock.transactions[0]).toBe(record);
    expect(await client.getTransaction({ hash: record.hash })).toMatchObject({
      from: zeroAddress,
      to: zeroAddress,
      value: 0n,
      input: "0x",
      nonce: 0,
      blockNumber: 11n,
    });
    expect(await client.getTransactionReceipt({ hash: record.hash })).toMatchObject({
      status: "success",
      logs: [],
      gasUsed: 0n,
    });
  });

  test("takes a send's fields, with data read back as input", async () => {
    const { mock, client } = setup();
    const router = testAddress("router");

    const record = mock.addTransaction({
      from: lowercase(alice),
      to: lowercase(router),
      value: 5n,
      data: "0x1234",
      nonce: 0x120,
      status: "reverted",
      gasUsed: 21_000n,
      hash,
      blockNumber: 4n,
    });

    expect(mock.blockNumber).toBe(10n);
    expect(record).toMatchObject({
      hash,
      fields: { from: alice, to: router, value: 5n, input: "0x1234", nonce: 0x120 },
      receipt: { status: "reverted", gasUsed: 21_000n },
      position: { blockNumber: 4n, index: 0 },
    });
    expect(await client.getTransaction({ hash })).toMatchObject({
      from: lowercase(alice),
      to: lowercase(router),
      value: 5n,
      input: "0x1234",
      nonce: 0x120,
      blockNumber: 4n,
    });
    expect(await client.getTransactionReceipt({ hash })).toMatchObject({
      status: "reverted",
      gasUsed: 21_000n,
      blockNumber: 4n,
    });
  });

  test("a nonce left out is the sender's next, so adds from one sender count up, as sends do", async () => {
    const { mock, client } = setup();
    const wallet = createWalletClient({
      account: alice,
      chain: mock.chain,
      transport: mock.transport({ retryCount: 0 }),
    });

    mock.addTransaction({ from: alice });
    mock.addTransaction({ from: alice });
    mock.addTransaction({ from: bob, nonce: 7 });
    mock.addTransaction({ nonce: 40 });
    await wallet.sendTransaction({ to: bob });
    mock.addTransaction({ from: alice });

    expect(mock.transactions.map(({ fields }) => [fields.from, fields.nonce])).toEqual([
      [alice, 0],
      [alice, 1],
      [bob, 7],
      [undefined, 40],
      [alice, 2],
      [alice, 3],
    ]);
    expect(await client.getTransactionCount({ address: alice })).toBe(4);
    expect(await client.getTransactionCount({ address: bob })).toBe(8);
    expect(await client.getTransactionCount({ address: zeroAddress })).toBe(0);
  });

  test("one in a block not mined yet counts at pending, not at the head", async () => {
    const { mock, client } = setup();

    mock.addTransaction({ from: alice, blockNumber: 12n });

    expect(await client.getTransactionCount({ address: alice, blockTag: "pending" })).toBe(1);
    expect(await client.getTransactionCount({ address: alice })).toBe(0);
    mock.mine(2n);
    expect(await client.getTransactionCount({ address: alice })).toBe(1);
  });

  test("restore() takes an added transaction off the chain, and its nonce with it", async () => {
    const { mock, client } = setup();
    mock.addTransaction({ from: alice });
    const checkpoint = mock.checkpoint();
    const { hash: later } = mock.addTransaction({ from: alice });

    checkpoint.restore();

    expect(mock.transactions).toHaveLength(1);
    expect(await client.getTransactionCount({ address: alice })).toBe(1);
    expect(mock.addTransaction({ from: alice, hash: later }).fields.nonce).toBe(1);
  });

  test.each<[string, Record<string, unknown>, string, string?]>([
    [
      "transactionHash",
      { transactionHash: hash },
      "mock.addTransaction() has no field transactionHash.",
      "The transaction's hash is hash, as on a transaction; transactionHash is a log's.",
    ],
    [
      "an unknown field",
      { gas: 1n },
      "mock.addTransaction() has no field gas.",
      "Its fields are from, to, value, data, nonce, logs, status, gasUsed, blockNumber and hash; " +
        "without blockNumber, it mines a new block.",
    ],
    ["a deploy", { to: null }, "mock.addTransaction() doesn't deploy: to can't be null."],
    ["a number block", { blockNumber: 3 }, "A block number must be a bigint, zero or more; got 3."],
    [
      "a negative block",
      { blockNumber: -1n },
      "A block number must be a bigint, zero or more; got -1n.",
    ],
    ["a short hash", { hash: "0x12" }, "A transaction hash must be 32 bytes; got 0x12."],
    [
      "logs on a reverted transaction",
      { status: "reverted", logs: [testLog("noise")] },
      "A reverted transaction has no logs.",
    ],
    [
      "an unknown status",
      { status: "pending" },
      'A transaction\'s status is "success" or "reverted"; got pending.',
    ],
    [
      "a negative value",
      { value: -1n },
      "A transaction's value must be a bigint, zero or more; got -1n.",
    ],
    [
      "a number gasUsed",
      { gasUsed: 1 },
      "A transaction's gasUsed must be a bigint, zero or more; got 1.",
    ],
    ["data that isn't hex", { data: "0xzz" }, "A transaction's data must be hex; got 0xzz."],
    [
      "a fractional nonce",
      { nonce: 1.5 },
      "A transaction's nonce must be an integer, zero or more; got 1.5.",
    ],
    ["logs that aren't a list", { logs: testLog("noise") }, "A transaction's logs must be a list"],
    ["a log that isn't one", { logs: [null] }, "A transaction's log 0 isn't a log; got null."],
    [
      "a log whose topics aren't a list",
      { logs: [testLog("noise"), { ...testLog("noise"), topics: "0xab" }] },
      "A transaction's log 1 isn't a log",
    ],
  ])("refuses %s, and changes nothing", (_, fields, message, hint) => {
    const { mock } = setup();

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what the types rule out
    const error = expectThrows(MockSetupError, message, () => mock.addTransaction(fields as never));
    if (hint !== undefined) expect(error.metaMessages).toEqual([hint]);
    expect(mock.blockNumber).toBe(10n);
    expect(mock.transactions).toEqual([]);
  });

  test("refuses what isn't an object of fields, such as a log on its own", () => {
    const { mock } = setup();

    expectThrows(MockSetupError, "mock.addTransaction() takes an object of fields; got [", () =>
      // @ts-expect-error -- logs go in { logs }
      mock.addTransaction([testLog("noise")]),
    );
    // A log alone shares data with a transaction, so the types let it through.
    const error = expectThrows(MockSetupError, "mock.addTransaction() has no field address.", () =>
      mock.addTransaction(testLog("noise")),
    );
    expect(error.metaMessages).toEqual([
      "A log goes in logs: mock.addTransaction({ logs: [log] }).",
    ]);
  });

  test("refuses a reverted write's logs with the same message", () => {
    const { mock } = setup();

    expectThrows(MockSetupError, "A reverted transaction has no logs.", () => {
      mock.actions.sendTransaction().returns({ status: "reverted", logs: [testLog("noise")] });
    });
  });
});
