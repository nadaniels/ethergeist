import {
  type Hash,
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

  test("an answer that isn't an object or null is refused, a receipt's too", () => {
    const { mock } = setup();

    for (const value of [5, [{}]]) {
      expect(() => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what the types rule out
        mock.actions.getTransaction({ hash }).returns(value as never);
      }).toThrow(MockSetupError);
      expect(() => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what the types rule out
        mock.actions.getTransactionReceipt({ hash }).returns(value as never);
      }).toThrow(MockSetupError);
    }
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
      "A legacy transaction has no maxFeePerGas: set `type` to one that has it (eip1559, eip4844, eip7702).",
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

  test("takes zero for its amounts, nonce and block, and an explicit success", () => {
    const { mock } = setup();
    const record = mock.addTransaction({
      value: 0n,
      gasUsed: 0n,
      nonce: 0,
      blockNumber: 0n,
      status: "success",
    });

    expect(record).toMatchObject({
      fields: { value: 0n, nonce: 0 },
      receipt: { gasUsed: 0n, status: "success" },
      position: { blockNumber: 0n },
    });
  });

  test("places its own copy of a log's topics, so the caller's stay theirs", () => {
    const { mock } = setup();
    const log = testLog("noise");
    const { logs } = mock.addTransaction({ logs: [log] });

    log.topics.splice(0, 1);
    expect(logs[0]?.topics).toHaveLength(1);
    expect(mock.logs[0]?.topics).toHaveLength(1);
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

// A mock answers over what the chain would answer at that request: the record once it's
// mined, and otherwise zeros, in the block current at registration (static) or now (resolver).
describe("receipt and transaction mocks over the chain", () => {
  const log = testLog("noise");

  test("a mock's fields go over its mined transaction, agreeing with getTransaction and getBlock", async () => {
    const { mock, client } = setup();
    mock.addTransaction({ blockNumber: 11n });
    mock.addTransaction({
      hash,
      from: alice,
      to: bob,
      value: 1n,
      gasUsed: 21_000n,
      logs: [log],
      blockNumber: 11n,
    });
    mock.actions.getTransactionReceipt({ hash }).returns({ effectiveGasPrice: 7n });
    mock.actions.getTransaction({ hash }).returns(() => ({ nonce: 9 }));
    mock.mine();

    const receipt = await client.getTransactionReceipt({ hash });
    const transaction = await client.getTransaction({ hash });
    const block = await client.getBlock({ blockNumber: 11n, includeTransactions: true });
    expect(receipt).toMatchObject({
      effectiveGasPrice: 7n,
      status: "success",
      from: lowercase(alice),
      to: lowercase(bob),
      gasUsed: 21_000n,
      blockNumber: 11n,
      blockHash: block.hash,
      transactionIndex: 1,
      logs: mock.logs,
    });
    expect(transaction).toMatchObject({
      nonce: 9,
      from: lowercase(alice),
      value: 1n,
      transactionIndex: 1,
    });
    expect({ ...transaction, nonce: 0 }).toEqual(block.transactions[1]);
  });

  test("a pending one over a mined transaction answers it pending", async () => {
    const { mock, client } = setup();
    mock.addTransaction({ hash, from: alice });
    mock.actions.getTransaction({ hash }).returns({ blockNumber: null });

    expect(await client.getTransaction({ hash })).toMatchObject({
      from: lowercase(alice),
      blockNumber: null,
      blockHash: null,
      transactionIndex: null,
    });
  });

  test("a block number over a mined transaction moves it, still mined", async () => {
    const { mock, client } = setup();
    mock.addTransaction({ blockNumber: 11n });
    mock.addTransaction({ hash, from: alice, blockNumber: 11n });
    mock.mine();
    mock.actions.getTransaction({ hash }).returns({ blockNumber: 5n });

    expect(await client.getTransaction({ hash })).toMatchObject({
      from: lowercase(alice),
      blockNumber: 5n,
      transactionIndex: 1,
    });
  });

  test("buildReceipt() refuses a log that isn't one", () => {
    const { mock } = setup();

    expectThrows(MockSetupError, "A receipt's log 0 isn't a log; got null.", () =>
      // @ts-expect-error a log is an object
      mock.buildReceipt({ logs: [null] }),
    );
  });

  test("one for a hash in a block not mined yet goes over the pending transaction, and zeros for its receipt, until it's mined", async () => {
    const { mock, client } = setup();
    mock.addTransaction({ hash, from: alice, blockNumber: 12n, logs: [log] });
    mock.actions.getTransactionReceipt({ hash }).returns({ gasUsed: 5n });
    mock.actions.getTransaction({ hash }).returns({ value: 2n });
    mock.mine();

    expect(await client.getTransactionReceipt({ hash })).toMatchObject({
      blockNumber: 10n,
      from: zeroAddress,
      gasUsed: 5n,
      logs: [],
    });
    expect(await client.getTransaction({ hash })).toMatchObject({
      blockNumber: null,
      transactionIndex: null,
      from: lowercase(alice),
      value: 2n,
    });
    mock.mine();
    expect(await client.getTransactionReceipt({ hash })).toMatchObject({
      blockNumber: 12n,
      from: lowercase(alice),
      gasUsed: 5n,
      logs: mock.logs,
    });
    expect(await client.getTransaction({ hash })).toMatchObject({
      blockNumber: 12n,
      from: lowercase(alice),
      value: 2n,
    });
  });

  test("for a hash not on the chain, a static one stays in its block, and its own hash wins", async () => {
    const { mock, client } = setup();
    const other = testHash("other");
    mock.actions.getTransactionReceipt({ hash }).returns({ transactionHash: other });
    mock.mine();

    const receipt = await client.getTransactionReceipt({ hash });
    expect(receipt).toMatchObject({ transactionHash: other, blockNumber: 10n });
    expect(await client.getTransactionConfirmations({ transactionReceipt: receipt })).toBe(2n);
  });

  test("takes a built receipt, whose logs are empty", async () => {
    const { mock, client } = setup();
    const built = mock.buildReceipt({ transactionHash: hash, gasUsed: 5n });
    mock.actions.getTransactionReceipt({ hash }).returns(built);

    expect(await client.getTransactionReceipt({ hash })).toEqual(built);
  });

  test("a value changed after .returns() shows: it's held as given", async () => {
    const { mock, client } = setup();
    const fields: { gasUsed?: bigint } = {};
    mock.actions.getTransactionReceipt({ hash }).returns(fields);
    fields.gasUsed = 5n;
    mock.mine();

    expect(await client.getTransactionReceipt({ hash })).toMatchObject({
      gasUsed: 5n,
      blockNumber: 10n,
    });
  });

  test("restore() takes the transaction away from under it, back to zeros in its block", async () => {
    const { mock, client } = setup();
    mock.actions.getTransactionReceipt({ hash }).returns({ gasUsed: 5n });
    const checkpoint = mock.checkpoint();
    mock.addTransaction({ hash, from: alice });

    expect(await client.getTransactionReceipt({ hash })).toMatchObject({
      blockNumber: 11n,
      from: lowercase(alice),
    });
    checkpoint.restore();
    expect(await client.getTransactionReceipt({ hash })).toMatchObject({
      blockNumber: 10n,
      from: zeroAddress,
      gasUsed: 5n,
    });
  });

  test("a reverted receipt over a mined transaction with logs is refused at .returns()", () => {
    const { mock } = setup();
    mock.addTransaction({ hash, logs: [log] });

    const error = expectThrows(MockSetupError, "A reverted transaction has no logs.", () => {
      mock.actions.getTransactionReceipt({ hash }).returns({ status: "reverted" });
    });
    expect(error.metaMessages).toEqual([
      `Transaction ${hash} on the chain has 1 log(s): answer this receipt without them, ` +
        '{ status: "reverted", logs: [] }, or add it reverted, ' +
        'mock.addTransaction({ …, status: "reverted" }), so every method agrees.',
    ]);
  });

  test("a reverted receipt with logs: [] over a transaction with logs answers without them", async () => {
    const { mock, client } = setup();
    mock.addTransaction({ hash, from: alice, logs: [log] });
    mock.actions.getTransactionReceipt({ hash }).returns({ status: "reverted", logs: [] });

    expect(await client.getTransactionReceipt({ hash })).toMatchObject({
      status: "reverted",
      from: lowercase(alice),
      logs: [],
    });
    expect(await client.getLogs({ fromBlock: 0n })).toHaveLength(1);
  });

  test("and at request time once one placed later is mined, or for a resolver's", async () => {
    const { mock, client } = setup();
    mock.addTransaction({ hash, from: alice, blockNumber: 11n, logs: [log] });
    mock.actions.getTransactionReceipt({ hash }).returns({ status: "reverted" });
    mock.actions.getTransactionReceipt({ hash: testHash("tx-2") }).returns(() => ({
      status: "reverted",
    }));
    mock.addTransaction({ hash: testHash("tx-2"), logs: [log], blockNumber: 11n });

    expect((await client.getTransactionReceipt({ hash })).status).toBe("reverted");
    mock.mine();
    for (const each of [hash, testHash("tx-2")])
      expectCause(await rejectionOf(client.getTransactionReceipt({ hash: each })), MockSetupError);
    // Without logs, a reverted one keeps the rest of its receipt.
    mock.addTransaction({ hash: testHash("tx-3"), from: alice });
    mock.actions.getTransactionReceipt({ hash: testHash("tx-3") }).returns({ status: "reverted" });
    expect(await client.getTransactionReceipt({ hash: testHash("tx-3") })).toMatchObject({
      status: "reverted",
      from: lowercase(alice),
    });
  });

  test("logs over a transaction on the chain replace its logs in that receipt only", async () => {
    const { mock, client } = setup();
    const own = testLog("own");
    mock.addTransaction({ blockNumber: 11n, logs: [testLog("earlier")] });
    mock.addTransaction({ hash, blockNumber: 11n, logs: [log] });
    mock.mine();
    mock.actions.getTransactionReceipt({ hash }).returns({ logs: [own] });

    const receipt = await client.getTransactionReceipt({ hash });
    expect(receipt.logs).toEqual([
      {
        ...own,
        address: lowercase(own.address),
        blockHash: receipt.blockHash,
        blockNumber: 11n,
        blockTimestamp: (await client.getBlock({ blockNumber: 11n })).timestamp,
        transactionHash: hash,
        transactionIndex: 1,
        // After the earlier transaction's log, as a node counts them across the block.
        logIndex: 1,
        removed: false,
      },
    ]);
    expect((await client.getLogs({ fromBlock: 0n })).map((each) => each.topics)).toEqual([
      testLog("earlier").topics,
      log.topics,
    ]);
  });

  test("a receipt's logs are indexed after the logs before it in its block, wherever it's placed", async () => {
    const { mock, client } = setup();
    // Block 11: one log at index 0; block 12: two logs at indexes 0 and 1.
    mock.addTransaction({ blockNumber: 11n, logs: [testLog("a")] });
    mock.addTransaction({ blockNumber: 12n, logs: [testLog("b"), testLog("c")] });
    mock.addTransaction({ hash, blockNumber: 11n, logs: [log] });
    mock.mine(2n);

    expect((await client.getTransactionReceipt({ hash })).logs[0]?.logIndex).toBe(1);
    // Moved to block 12 after its two transactions' logs: index 2.
    mock.actions.getTransactionReceipt({ hash }).returns({ blockNumber: 12n, transactionIndex: 1 });
    expect((await client.getTransactionReceipt({ hash })).logs[0]?.logIndex).toBe(2);
    // A hash the chain doesn't have, placed after block 11's first transaction: index 1.
    const other = testHash("unknown");
    mock.actions
      .getTransactionReceipt({ hash: other })
      .returns({ blockNumber: 11n, transactionIndex: 1, logs: [testLog("own")] });
    expect((await client.getTransactionReceipt({ hash: other })).logs[0]?.logIndex).toBe(1);
  });

  test("a mock with logs for a hash placed later keeps answering them once it's mined", async () => {
    const { mock, client } = setup();
    mock.addTransaction({ hash, blockNumber: 12n, logs: [log] });
    mock.actions.getTransactionReceipt({ hash }).returns({ logs: [testLog("own")] });

    expect((await client.getTransactionReceipt({ hash })).logs[0]?.blockNumber).toBe(10n);
    mock.mine(2n);
    const { logs } = await client.getTransactionReceipt({ hash });
    expect(logs.map((each) => [each.topics, each.blockNumber])).toEqual([
      [testLog("own").topics, 12n],
    ]);
  });

  test("a receipt's placement over a transaction on the chain moves its logs, reindexed in their new block", async () => {
    const { mock, client } = setup();
    const other = testHash("other");
    mock.addTransaction({ blockNumber: 11n, logs: [testLog("earlier")] });
    mock.addTransaction({ hash, blockNumber: 11n, logs: [log] });
    mock.mine();
    mock.actions
      .getTransactionReceipt({ hash })
      .returns({ blockNumber: 7n, transactionIndex: 5, transactionHash: other });

    const receipt = await client.getTransactionReceipt({ hash });
    const block = await client.getBlock({ blockNumber: 7n });
    expect(receipt).toMatchObject({ blockNumber: 7n, blockHash: block.hash, transactionIndex: 5 });
    expect(receipt.logs).toMatchObject([
      {
        blockNumber: 7n,
        blockHash: block.hash,
        blockTimestamp: block.timestamp,
        transactionHash: other,
        transactionIndex: 5,
        // Block 7 has no logs on the chain before it: it's the block's first.
        logIndex: 0,
      },
    ]);
  });

  test("a built receipt over a transaction on the chain answers its own fields and logs", async () => {
    const { mock, client } = setup();
    mock.addTransaction({ blockNumber: 11n });
    mock.addTransaction({ hash, from: alice, blockNumber: 11n, logs: [log] });
    mock.mine();
    const built = mock.buildReceipt({ transactionHash: hash, gasUsed: 5n });
    mock.actions.getTransactionReceipt({ hash }).returns(built);

    expect(await client.getTransactionReceipt({ hash })).toEqual(built);
  });

  test("a getBlock mock's number and hash place the transactions it lists", async () => {
    const { mock, client } = setup();
    const blockHash = testHash("block");
    mock.addTransaction({ hash });
    mock.actions.getBlock({ blockNumber: 11n }).returns({ number: 5n, hash: blockHash });

    const block = await client.getBlock({ blockNumber: 11n, includeTransactions: true });
    expect(block.transactions).toMatchObject([
      { hash, blockNumber: 5n, blockHash, blockTimestamp: block.timestamp },
    ]);
  });

  test("a getBlock mock without a number or hash lists its transactions as the chain has them", async () => {
    const { mock } = setup();
    mock.addTransaction({ hash });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a pending block, which the types rule out
    mock.actions.getBlock({ blockNumber: 11n }).returns({ number: null, hash: null } as never);

    const block = await mock.request({ method: "eth_getBlockByNumber", params: ["0xb", true] });
    expect(block).toMatchObject({ number: null, transactions: [{ hash, blockNumber: "0xb" }] });
  });

  test("a type its transaction's fields don't fit is a setup error when it answers", async () => {
    const { mock, client } = setup();
    const sent = await mock.request({
      method: "eth_sendTransaction",
      params: [{ from: alice, to: bob, maxFeePerGas: "0x1" }],
    });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a send answers its hash
    mock.actions.getTransaction({ hash: sent as Hash }).returns({ type: "legacy" });

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a send answers its hash
    const error = await rejectionOf(client.getTransaction({ hash: sent as Hash }));
    expectCause(error, MockSetupError);
    expect(String(error)).toContain("A legacy transaction has no maxFeePerGas");
  });
});
