import {
  ExecutionRevertedError,
  InsufficientFundsError,
  InvalidParamsRpcError,
  RpcRequestError,
  createWalletClient,
  encodeFunctionData,
  isHex,
  erc20Abi,
  getContractAddress,
  keccak256,
  parseGwei,
  serializeTransaction,
  toHex,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test, vi } from "vite-plus/test";

import {
  MockNotFoundError,
  MockResolverError,
  MockSetupError,
  createMockRpc,
  testAddress,
  testHash,
  testLog,
} from "../src/index.js";
import { expectCause, hintsOf, lowercase, rejectionOf } from "./utils.js";

const alice = testAddress("alice");
const bob = testAddress("bob");
const USDC = testAddress("usdc");
const signer = privateKeyToAccount(keccak256(toHex("signer")));

function setup() {
  const mock = createMockRpc({ blockNumber: 10n });
  const client = mock.publicClient({}, { retryCount: 0 });
  return { mock, client };
}

/** A local account: viem signs, and sends the bytes with eth_sendRawTransaction. */
function localSetup() {
  const { mock, client } = setup();
  const wallet = createWalletClient({
    account: signer,
    chain: mock.chain,
    transport: mock.transport({ retryCount: 0 }),
  });
  return { mock, client, wallet };
}

/** A node's account: viem sends eth_sendTransaction, unsigned, with `from`. */
function nodeSetup() {
  const { mock, client } = setup();
  const wallet = createWalletClient({
    account: alice,
    chain: mock.chain,
    transport: mock.transport({ retryCount: 0 }),
  });
  return { mock, client, wallet };
}

/** The signed bytes of the last raw send `mock` received. */
function lastRawSend(mock: ReturnType<typeof createMockRpc>) {
  const params = mock.requests.findLast(
    ({ method }) => method === "eth_sendRawTransaction",
  )?.params;
  const raw: unknown = Array.isArray(params) ? params[0] : undefined;
  return isHex(raw) ? raw : expect.unreachable("expected a raw send");
}

describe("a raw send (local account)", () => {
  test("goes through viem's prepare and lands on the chain, answering everything from its record", async () => {
    const { mock, client, wallet } = localSetup();

    const hash = await wallet.sendTransaction({ to: bob, value: 5n });

    expect(mock.requests.map(({ method }) => method)).toEqual([
      "eth_fillTransaction",
      "eth_getTransactionCount",
      "eth_getBlockByNumber",
      "eth_maxPriorityFeePerGas",
      "eth_estimateGas",
      "eth_sendRawTransaction",
    ]);
    expect(hash).toBe(keccak256(lastRawSend(mock)));
    expect(mock.actions.sendTransaction.calls).toEqual([
      {
        account: signer.address,
        to: bob,
        value: 5n,
        nonce: 0,
        gas: 21_000n,
        maxFeePerGas: parseGwei("13"),
        maxPriorityFeePerGas: parseGwei("1"),
        type: "eip1559",
      },
    ]);
    expect(mock.blockNumber).toBe(11n);

    const transaction = await client.getTransaction({ hash });
    expect(transaction).toMatchObject({
      hash,
      from: signer.address.toLowerCase(),
      to: bob.toLowerCase(),
      value: 5n,
      nonce: 0,
      gas: 21_000n,
      type: "eip1559",
      blockNumber: 11n,
      transactionIndex: 0,
    });
    const receipt = await client.getTransactionReceipt({ hash });
    expect(receipt).toMatchObject({
      status: "success",
      transactionHash: hash,
      from: signer.address.toLowerCase(),
      to: bob.toLowerCase(),
      blockNumber: 11n,
      gasUsed: 21_000n,
      cumulativeGasUsed: 21_000n,
      // The base fee plus the tip: below the max fee viem signed.
      effectiveGasPrice: parseGwei("11"),
      contractAddress: null,
      logs: [],
    });
    expect((await client.getBlock({ blockNumber: 11n })).transactions).toEqual([hash]);
    expect(mock.transactions).toMatchObject([
      { hash, origin: "write", fields: { from: signer.address, to: bob, value: 5n } },
    ]);
  });

  test("waitForTransactionReceipt resolves on its first poll", async () => {
    const { mock, client, wallet } = localSetup();

    const hash = await wallet.sendTransaction({ to: bob, value: 5n });
    const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 10 });

    expect(receipt.status).toBe("success");
    expect(mock.requests.filter((r) => r.method === "eth_getTransactionReceipt")).toHaveLength(1);
  });

  test("legacy, eip2930 and eip1559 transactions keep their type, fees and signer", async () => {
    const { mock, client, wallet } = localSetup();
    const gasPrice = parseGwei("12");

    const hashes = [
      await wallet.sendTransaction({ to: bob, type: "legacy", gasPrice }),
      await wallet.sendTransaction({ to: bob, type: "eip2930", gasPrice, accessList: [] }),
      await wallet.sendTransaction({ to: bob, maxFeePerGas: parseGwei("20") }),
    ];

    const transactions = await Promise.all(hashes.map((hash) => client.getTransaction({ hash })));
    expect(transactions).toMatchObject([
      { type: "legacy", gasPrice, from: lowercase(signer.address) },
      { type: "eip2930", gasPrice, from: lowercase(signer.address) },
      { type: "eip1559", maxFeePerGas: parseGwei("20"), from: lowercase(signer.address) },
    ]);
    expect(mock.transactions.map(({ fields }) => fields.type)).toEqual([
      "legacy",
      "eip2930",
      "eip1559",
    ]);
  });

  test("a deploy's to is null, and its data is the call's", async () => {
    const { mock, client, wallet } = localSetup();
    mock.actions.sendTransaction({ to: null }).returns();

    const hash = await wallet.deployContract({ abi: [], bytecode: "0x6000", gas: 60_000n });

    expect(mock.actions.sendTransaction.calls[0]).toMatchObject({ to: null, data: "0x6000" });
    expect((await client.getTransactionReceipt({ hash })).contractAddress).toBe(
      lowercase(getContractAddress({ from: signer.address, nonce: 0n })),
    );
  });

  test("a legacy transaction's call has its gasPrice", async () => {
    const { mock, wallet } = localSetup();

    await wallet.sendTransaction({ to: bob, type: "legacy", gasPrice: 7n });

    expect(mock.actions.sendTransaction.calls[0]).toEqual({
      account: signer.address,
      to: bob,
      value: 0n,
      nonce: 0,
      gas: 21_000n,
      gasPrice: 7n,
      type: "legacy",
    });
  });

  test("an eip7702 transaction too", async () => {
    const { mock, client, wallet } = localSetup();
    const authorization = await signer.signAuthorization({
      contractAddress: USDC,
      chainId: mock.chainId,
      nonce: 1,
    });
    mock.actions.sendTransaction({ to: bob }).returns();

    const hash = await wallet.sendTransaction({ to: bob, authorizationList: [authorization] });

    expect(await client.getTransaction({ hash })).toMatchObject({
      type: "eip7702",
      from: signer.address.toLowerCase(),
    });
  });

  test("the same bytes sent again answer the same hash, without a second transaction", async () => {
    const { mock, wallet } = localSetup();
    const raw = await wallet.signTransaction(
      await wallet.prepareTransactionRequest({ to: bob, value: 1n }),
    );

    const first = await mock.request({ method: "eth_sendRawTransaction", params: [raw] });
    const again = await mock.request({ method: "eth_sendRawTransaction", params: [raw] });

    expect(first).toBe(keccak256(raw));
    expect(again).toBe(first);
    expect(mock.transactions).toHaveLength(1);
    expect(mock.blockNumber).toBe(11n);
  });

  test("a repeat isn't answered by the mocks again: a .once() one isn't needed twice", async () => {
    const { mock, wallet } = localSetup();
    const resolver = vi.fn(() => ({}));
    mock.actions.sendTransaction({ to: bob }).once().returns(resolver);
    const raw = await wallet.signTransaction(
      await wallet.prepareTransactionRequest({ to: bob, data: "0x12", gas: 50_000n }),
    );

    const first = await mock.request({ method: "eth_sendRawTransaction", params: [raw] });
    const again = await mock.request({ method: "eth_sendRawTransaction", params: [raw] });

    expect(again).toBe(first);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(mock.transactions).toHaveLength(1);
  });

  test("the same bytes sent twice at once are one transaction", async () => {
    const { mock, wallet } = localSetup();
    const raw = await wallet.signTransaction(
      await wallet.prepareTransactionRequest({ to: bob, value: 1n }),
    );

    const hashes = await Promise.all(
      [raw, raw].map((each) => mock.request({ method: "eth_sendRawTransaction", params: [each] })),
    );

    expect(hashes).toEqual([keccak256(raw), keccak256(raw)]);
    expect(mock.transactions).toHaveLength(1);
    expect(mock.blockNumber).toBe(11n);
  });

  test("bytes that aren't a signed transaction are invalid params", async () => {
    const { mock } = setup();
    const unsigned = serializeTransaction({ to: bob, chainId: 1, maxFeePerGas: 1n });

    const errors = await Promise.all(
      ["0x1234", "not hex", unsigned].map((raw) =>
        rejectionOf(mock.request({ method: "eth_sendRawTransaction", params: [raw] })),
      ),
    );
    for (const error of errors) {
      const refusal = expectCause(error, RpcRequestError);
      expect(refusal.code).toBe(InvalidParamsRpcError.code);
      expect(refusal.details).toMatch(/^invalid params: expected a signed transaction; got /u);
    }
    expect(mock.transactions).toEqual([]);
    expect(mock.unhandled).toEqual([]);
  });
});

describe("eth_sendTransaction (node account)", () => {
  test("lands on the chain with the request's sender, a made hash, and the implied gas", async () => {
    const { mock, client, wallet } = nodeSetup();

    const hash = await wallet.sendTransaction({ to: bob, value: 5n });

    expect(mock.requests.map(({ method }) => method)).toEqual([
      "eth_chainId",
      "eth_sendTransaction",
    ]);
    expect(hash).toBe(testHash("tx:11:0"));
    expect(mock.actions.sendTransaction.calls).toEqual([
      { account: alice, to: bob, value: 5n, type: "eip1559" },
    ]);
    expect(await client.getTransaction({ hash })).toMatchObject({
      from: alice.toLowerCase(),
      nonce: 0,
      gas: 100_000n,
      blockNumber: 11n,
    });
    expect(await client.waitForTransactionReceipt({ hash, pollingInterval: 10 })).toMatchObject({
      status: "success",
      gasUsed: 100_000n,
    });
  });

  test("reads the request's fields to the spec", async () => {
    const { mock } = setup();
    mock.actions.sendTransaction().returns();

    await mock.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: alice.toLowerCase(),
          to: bob,
          input: "0x1234",
          gas: "0x5208",
          gasPrice: "0x1",
          nonce: "0x7",
          type: "0x0",
        },
      ],
    });

    expect(mock.actions.sendTransaction.calls).toEqual([
      {
        account: alice,
        to: bob,
        value: 0n,
        data: "0x1234",
        gas: 21_000n,
        gasPrice: 1n,
        nonce: 7,
        type: "legacy",
      },
    ]);
    expect(mock.transactions[0]!.fields).toMatchObject({ nonce: 7, gas: 21_000n, input: "0x1234" });
  });

  test.each([
    [{}, "eip1559"],
    [{ gasPrice: "0x1" }, "legacy"],
    [{ gasPrice: "0x1", accessList: [] }, "eip2930"],
    [{ maxFeePerGas: "0x1", accessList: [] }, "eip1559"],
    [{ blobVersionedHashes: [] }, "eip4844"],
    [{ maxFeePerBlobGas: "0x1" }, "eip4844"],
    [{ authorizationList: [], blobVersionedHashes: [] }, "eip7702"],
  ])("an untyped request's type is its fields': %o is %s", async (fields, type) => {
    const { mock } = setup();
    mock.actions.sendTransaction().returns();

    await mock.request({
      method: "eth_sendTransaction",
      params: [{ from: alice, to: bob, ...fields }],
    });

    expect(mock.actions.sendTransaction.calls[0]?.type).toBe(type);
  });

  test.each([
    { tx: { to: bob }, details: "expected a transaction with a sender (from)" },
    { tx: { from: alice, type: "0x9" }, details: "expected a transaction type; got 0x9" },
    {
      tx: { from: alice, type: "0x2", gasPrice: "0x1" },
      details: "eip1559 transactions have no gasPrice",
    },
    {
      tx: { from: alice, gasPrice: "0x1", maxFeePerGas: "0x1" },
      details: "legacy transactions have no maxFeePerGas",
    },
    { tx: { from: alice, to: 1 }, details: "expected an address; got 1" },
    {
      tx: { from: alice, type: "0x1", maxPriorityFeePerGas: "0x1" },
      details: "eip2930 transactions have no maxPriorityFeePerGas",
    },
  ])("refuses what the spec or a node rules out: $details", async ({ tx, details }) => {
    const { mock } = setup();
    mock.actions.sendTransaction().returns();

    const error = await rejectionOf(mock.request({ method: "eth_sendTransaction", params: [tx] }));

    expect(expectCause(error, RpcRequestError)).toMatchObject({
      code: InvalidParamsRpcError.code,
      details: `invalid params: ${details}`,
    });
    expect(mock.transactions).toEqual([]);
  });
});

describe("send mocks", () => {
  test("answer with what the chain did: logs, status, gas", async () => {
    const { mock, client, wallet } = nodeSetup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC, name: "USDC" });
    const transfer = usdc.events.Transfer({ from: alice, to: bob, value: 5n });
    mock.actions.sendTransaction({ to: USDC }).emits([transfer, testLog("noise")]);
    mock.actions.sendTransaction({ to: bob }).returns({
      status: "reverted",
      gasUsed: 30_000n,
      effectiveGasPrice: 7n,
    });

    const sent = await wallet.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "transfer",
      args: [bob, 5n],
    });
    const reverted = await wallet.sendTransaction({ to: bob, value: 1n });

    const receipt = await client.getTransactionReceipt({ hash: sent });
    expect(receipt.logs).toMatchObject([
      { ...transfer, address: USDC.toLowerCase(), logIndex: 0, transactionHash: sent },
      { logIndex: 1 },
    ]);
    expect(
      await client.getContractEvents({ abi: erc20Abi, address: USDC, fromBlock: 0n }),
    ).toHaveLength(1);
    expect(await client.getTransactionReceipt({ hash: reverted })).toMatchObject({
      status: "reverted",
      logs: [],
      gasUsed: 30_000n,
      effectiveGasPrice: 7n,
      blockNumber: 12n,
    });
  });

  test("a resolver gets the send and returns its outcome, or nothing for a success", async () => {
    const { mock, wallet } = localSetup();
    const resolver = vi.fn(({ value }: { value: bigint }) =>
      value > 1n ? { status: "reverted" as const } : undefined,
    );
    mock.actions.sendTransaction({ to: bob }).returns(resolver);

    await wallet.sendTransaction({ to: bob, value: 1n });
    await wallet.sendTransaction({ to: bob, value: 2n });

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(resolver.mock.calls[0]![0]).toMatchObject({
      account: signer.address,
      to: bob,
      value: 1n,
      nonce: 0,
      gas: 21_000n,
      type: "eip1559",
    });
    expect(mock.transactions.map((record) => record.receipt.status)).toEqual([
      undefined,
      "reverted",
    ]);
  });

  test("deploy at getContractAddress({ from, nonce }) unless the outcome says", async () => {
    const { mock, client, wallet } = nodeSetup();
    mock.actions.sendTransaction({ to: null }).once().returns();
    mock.actions.sendTransaction({ to: null }).returns({ contractAddress: lowercase(USDC) });

    const first = await wallet.deployContract({ abi: [], bytecode: "0x6000" });
    const second = await wallet.deployContract({ abi: [], bytecode: "0x6000" });

    expect((await client.getTransactionReceipt({ hash: first })).contractAddress).toBe(
      getContractAddress({ from: alice, nonce: 0n }).toLowerCase(),
    );
    expect((await client.getTransaction({ hash: first })).to).toBeNull();
    expect((await client.getTransactionReceipt({ hash: second })).contractAddress).toBe(
      USDC.toLowerCase(),
    );
  });

  test(".once() counts sends", async () => {
    const { mock, wallet } = nodeSetup();
    mock.actions.sendTransaction({ to: bob }).once().returns({ status: "reverted" });

    await wallet.sendTransaction({ to: bob });
    await wallet.sendTransaction({ to: bob });

    // The second falls through to the unmocked plain transfer.
    expect(mock.transactions.map((record) => record.receipt.status)).toEqual([
      "reverted",
      undefined,
    ]);
  });

  test("outcomes are checked at registration", () => {
    const { mock } = setup();
    const send = mock.actions.sendTransaction();

    expect(() => {
      // @ts-expect-error -- the block comes from where it's mined
      send.returns({ blockNumber: 3n });
    }).toThrow(
      new MockSetupError("A write's outcome has no blockNumber.", {
        metaMessages: [
          "Its fields are logs, status, gasUsed, effectiveGasPrice and contractAddress; the rest " +
            "of its receipt comes from the transaction and the block it's mined in.",
        ],
      }),
    );
    expect(() => {
      send.returns({ status: "reverted", logs: [testLog("noise")] });
    }).toThrow("A reverted transaction has no logs.");
    expect(() => {
      // @ts-expect-error -- not a status
      send.returns({ status: "failed" });
    }).toThrow('A write\'s status is "success" or "reverted"; got failed.');
    expect(() => {
      send.returns({ gasUsed: -1n });
    }).toThrow("A write's gasUsed must be a bigint, zero or more; got -1n.");
    expect(() => {
      // @ts-expect-error -- not a bigint
      send.returns({ effectiveGasPrice: 7 });
    }).toThrow("A write's effectiveGasPrice must be a bigint, zero or more; got 7.");
    expect(() => {
      // @ts-expect-error -- not a list
      send.returns({ logs: testLog("noise") });
    }).toThrow("A write's logs must be a list; got");
    send.returns({ status: "success", gasUsed: 0n, effectiveGasPrice: 0n });
    expect(() => {
      send.emits([
        mock.buildLog({
          abi: erc20Abi,
          address: USDC,
          eventName: "Approval",
          args: { owner: alice, spender: bob, value: 1n },
        }),
      ]);
    }).toThrow("A write's logs are placed when it's mined, but one already has a position");
    expect(() => {
      // @ts-expect-error -- an outcome, not an ABI value
      send.returns(true);
    }).toThrow("A write's outcome must be an object; got true.");
    expect(() => {
      send.returns({ contractAddress: "0x123" });
    }).toThrow(/Address "0x123" is invalid/u);
    expect(() => {
      // @ts-expect-error -- not an address
      send.returns({ contractAddress: 5 });
    }).toThrow("A write's contractAddress must be an address; got 5.");
    expect(() => {
      // @ts-expect-error -- not a log
      send.emits([5]);
    }).toThrow("A write's logs must be logs; got [5].");
  });

  test("only a deploy has a contractAddress, refused at registration when to is pinned", () => {
    const { mock } = setup();

    expect(() => {
      mock.actions.sendTransaction({ to: bob }).returns({ contractAddress: USDC });
    }).toThrow("Only a deploy (to: null) has a contractAddress.");
    mock.actions.sendTransaction({ to: null }).returns({ contractAddress: USDC });
    // Without a pinned `to`, it may be a deploy: that's checked at the send.
    mock.actions.sendTransaction({ account: alice }).returns({ contractAddress: USDC });
  });

  test("only a deploy has a contractAddress", async () => {
    const { mock, wallet } = nodeSetup();
    mock.actions.sendTransaction().returns({ contractAddress: USDC });

    const error = await rejectionOf(wallet.sendTransaction({ to: bob }));

    expect(expectCause(error, MockSetupError).shortMessage).toBe(
      "Only a deploy (to: null) has a contractAddress.",
    );
    expect(mock.transactions).toEqual([]);
  });

  test("a send's history is its hash", async () => {
    const { mock, wallet } = nodeSetup();

    const hash = await wallet.sendTransaction({ to: bob, value: 1n });

    expect(mock.history.at(-1)).toMatchObject({
      type: "action",
      action: "sendTransaction",
      call: { account: alice, to: bob, value: 1n },
      outcome: { type: "result", value: hash },
    });
  });
});

describe("a send that's refused changes nothing", () => {
  test(".fails() with a node's refusal: no transaction, no block", async () => {
    const { mock, wallet } = localSetup();
    mock.actions.sendTransaction().fails("insufficientFunds");

    const error = await rejectionOf(wallet.sendTransaction({ to: bob, value: 7n }));

    expectCause(error, InsufficientFundsError);
    expect(expectCause(error, RpcRequestError).details).toBe(
      "insufficient funds for gas * price + value: have 0 want 7",
    );
    expect(mock.transactions).toEqual([]);
    expect(mock.blockNumber).toBe(10n);
  });

  test("a resolver's fail() or error", async () => {
    const { mock, wallet } = nodeSetup();
    mock.actions.sendTransaction({ to: bob }).returns(({ fail }) => fail({ status: 503 }));
    mock.actions.sendTransaction({ to: alice }).returns(() => {
      throw new Error("oops");
    });

    await rejectionOf(wallet.sendTransaction({ to: bob }));
    expectCause(await rejectionOf(wallet.sendTransaction({ to: alice })), MockResolverError);

    expect(mock.transactions).toEqual([]);
    expect(mock.blockNumber).toBe(10n);
  });

  test("a log at an empty() address", async () => {
    const { mock, wallet } = nodeSetup();
    mock.empty(testAddress("empty"));
    mock.actions.sendTransaction().emits([testLog("noise", { address: testAddress("empty") })]);

    const error = await rejectionOf(wallet.sendTransaction({ to: bob }));

    expect(expectCause(error, MockSetupError).shortMessage).toMatch(/is marked empty\(\)/u);
    expect(mock.transactions).toEqual([]);
    expect(mock.blockNumber).toBe(10n);
  });

  test("restore() takes a send back off the chain", async () => {
    const { mock, wallet } = nodeSetup();
    const checkpoint = mock.checkpoint();

    await wallet.sendTransaction({ to: bob });
    checkpoint.restore();

    expect(mock.transactions).toEqual([]);
    expect(mock.blockNumber).toBe(10n);
  });
});

describe("sends unmocked", () => {
  test("a send without data to an address without code succeeds", async () => {
    const { mock, wallet } = nodeSetup();
    mock.empty(testAddress("empty"));

    await wallet.sendTransaction({ to: bob, value: 1n });
    await wallet.sendTransaction({ to: testAddress("empty") });

    expect(mock.transactions).toHaveLength(2);
    expect(mock.unhandled).toEqual([]);
  });

  test.each([
    { name: "data to an unknown address", to: bob, data: "0x1234", hint: "({ to }).returns(…)." },
    {
      name: "data to an empty() address",
      to: testAddress("empty"),
      data: "0x1234",
      hint: `({ to }).returns(…): ${testAddress("empty")} is marked empty(), with no code to run the data.`,
    },
    {
      name: "a plain send to a registered contract",
      to: USDC,
      data: undefined,
      hint: "({ to }).returns(…).",
    },
    {
      name: "a deploy",
      to: undefined,
      data: "0x6000",
      hint: "({ to: null }).returns(…), which deploys at getContractAddress({ from, nonce }).",
    },
    {
      name: "a send to Multicall3",
      to: "0xcA11bde05977b3631167028862bE2a173976CA11",
      data: "0x1234",
      hint: "({ to }).returns(…): Multicall3's batched writes aren't mocked, so send each call instead.",
    },
  ] as const)("$name isn't answered, with a hint", async ({ to, data, hint }) => {
    const { mock, wallet } = nodeSetup();
    mock.contract({ abi: erc20Abi, address: USDC });
    mock.empty(testAddress("empty"));

    const error = await rejectionOf(
      wallet.sendTransaction({ ...(to && { to }), ...(data && { data }) }),
    );

    const notFound = expectCause(error, MockNotFoundError);
    expect(notFound.shortMessage).toMatch(/^No mock for sendTransaction\(/u);
    expect(hintsOf(notFound)).toBe(`Mock it with mock.actions.sendTransaction${hint}`);
    expect(mock.transactions).toEqual([]);
    expect(mock.blockNumber).toBe(10n);
  });

  test("mock.method() refuses both methods, pointing at the typed action", () => {
    const { mock } = setup();

    for (const method of ["eth_sendTransaction", "eth_sendRawTransaction"])
      expect(() => mock.method(method)).toThrow(
        `"${method}" has a typed mock: use mock.actions.sendTransaction().`,
      );
  });
});

describe("the estimate a send mock implies", () => {
  test("is 100,000 gas, without running the mock or using it up", async () => {
    const { mock, wallet } = localSetup();
    mock.contract({ abi: erc20Abi, address: USDC });
    const resolver = vi.fn(() => ({}));
    mock.actions.sendTransaction({ to: USDC }).once().returns(resolver);

    const request = await wallet.prepareTransactionRequest({
      to: USDC,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [bob, 1n] }),
    });

    expect(request.gas).toBe(100_000n);
    expect(resolver).not.toHaveBeenCalled();
    expect(() => {
      mock.assertAllUsed();
    }).toThrow(/sendTransaction\(\{ to: 0x/u);
    // The once() is still there for the send.
    await wallet.sendTransaction(request);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(mock.transactions[0]!.fields.gas).toBe(100_000n);
  });

  test("an estimate mock answers first, and a plain transfer to an address without code is 21000", async () => {
    const { mock, client } = setup();
    mock.actions.sendTransaction().returns();
    mock.actions.estimateGas({ to: USDC }).returns(42_000n);

    expect(await client.estimateGas({ account: alice, to: USDC, data: "0x12" })).toBe(42_000n);
    expect(await client.estimateGas({ account: alice, to: bob })).toBe(21_000n);
    expect(await client.estimateGas({ account: alice, to: alice, data: "0x12" })).toBe(100_000n);
  });

  test("a .reverts() mock reverts it, so a local account never sends; sent anyway, it's mined reverted", async () => {
    const { mock, wallet } = localSetup();
    mock.actions.sendTransaction({ to: bob }).reverts("not today");

    const error = await rejectionOf(wallet.sendTransaction({ to: bob, data: "0x12" }));
    expect(expectCause(error, ExecutionRevertedError).details).toBe(
      "execution reverted: not today",
    );
    expect(mock.transactions).toEqual([]);

    await wallet.sendTransaction({ to: bob, data: "0x12", gas: 50_000n });
    expect(mock.transactions).toMatchObject([{ receipt: { status: "reverted" }, logs: [] }]);
  });

  test("a .reverts() mock reverts a plain transfer's estimate too", async () => {
    const { mock, wallet } = localSetup();
    mock.actions.sendTransaction({ to: bob }).reverts("no refunds");

    const error = await rejectionOf(wallet.sendTransaction({ to: bob, value: 1n }));

    expect(expectCause(error, ExecutionRevertedError).details).toBe(
      "execution reverted: no refunds",
    );
    expect(mock.transactions).toEqual([]);
  });

  test("a plain send to a registered contract is implied too, with no function for it to run", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    mock.actions.sendTransaction({ to: USDC }).returns();

    expect(await client.estimateGas({ account: alice, to: USDC, value: 1n })).toBe(100_000n);
    await createWalletClient({
      account: alice,
      chain: mock.chain,
      transport: mock.transport(),
    }).sendTransaction({ to: USDC, value: 1n });
    expect(usdc.calls).toEqual([]);
    expect(mock.transactions).toHaveLength(1);
  });

  test.each(["legacy", "eip2930", "eip1559", "eip7702"] as const)(
    "a mock pinning %s implies the estimate of a send of that type",
    async (type) => {
      const { mock, wallet } = localSetup();
      mock.actions.sendTransaction({ to: bob, type }).returns();
      const gasPrice = parseGwei("1");
      const send = { to: bob, data: "0x12" } as const;

      if (type === "legacy") await wallet.sendTransaction({ ...send, type, gasPrice });
      if (type === "eip2930")
        await wallet.sendTransaction({ ...send, type, gasPrice, accessList: [] });
      if (type === "eip1559") await wallet.sendTransaction(send);
      if (type === "eip7702") {
        const authorization = await signer.signAuthorization({
          contractAddress: USDC,
          chainId: mock.chainId,
          nonce: 1,
        });
        await wallet.sendTransaction({ ...send, authorizationList: [authorization] });
      }

      expect(mock.transactions[0]!.fields).toMatchObject({ type, gas: 100_000n });
    },
  );

  test.each([
    { fields: { type: "0x9" }, details: "expected a transaction type; got 0x9" },
    {
      fields: { gasPrice: "0x1", maxFeePerGas: "0x1" },
      details: "legacy transactions have no maxFeePerGas",
    },
  ])(
    "an estimate a send would refuse is refused, mocked or not: $details",
    async ({ fields, details }) => {
      const { mock } = setup();
      mock.actions.estimateGas().returns(5n);

      const error = await rejectionOf(
        mock.request({ method: "eth_estimateGas", params: [{ to: bob, ...fields }] }),
      );

      expect(expectCause(error, RpcRequestError)).toMatchObject({
        code: InvalidParamsRpcError.code,
        details: `invalid params: ${details}`,
      });
    },
  );

  test("an estimate's own type, or blob fields, set its send's", async () => {
    const { mock } = setup();
    mock.actions.sendTransaction({ type: "eip2930" }).returns();
    mock.actions.sendTransaction({ type: "eip4844" }).returns();
    const estimate = (fields: object) =>
      mock.request({
        method: "eth_estimateGas",
        params: [{ from: alice, to: bob, input: "0x12", ...fields }],
      });

    expect(await estimate({ type: "0x1", gasPrice: "0x1" })).toBe("0x186a0");
    expect(await estimate({ blobVersionedHashes: [testHash("blob")] })).toBe("0x186a0");
    await expect(estimate({ gasPrice: "0x1" })).rejects.toThrow(MockNotFoundError);
  });

  test("a mock pinning another type doesn't imply it", async () => {
    const { mock, wallet } = localSetup();
    mock.actions.sendTransaction({ to: bob, type: "eip2930" }).returns();

    const error = await rejectionOf(wallet.sendTransaction({ to: bob, data: "0x12" }));

    expectCause(error, MockNotFoundError);
  });

  test("a mock that doesn't match the estimate doesn't imply it", async () => {
    const { mock, client } = setup();
    mock.actions.sendTransaction({ account: bob }).returns();

    const error = await rejectionOf(client.estimateGas({ account: alice, to: USDC, data: "0x12" }));

    expectCause(error, MockNotFoundError);
  });
});

describe("nonces follow sends", () => {
  test("a local account's sends take nonces 0, 1, … with no nonce mocks", async () => {
    const { mock, client, wallet } = localSetup();

    await wallet.sendTransaction({ to: bob });
    await wallet.sendTransaction({ to: bob });

    expect(mock.transactions.map(({ fields }) => fields.nonce)).toEqual([0, 1]);
    expect(await client.getTransactionCount({ address: signer.address })).toBe(2);
    expect(await client.getTransactionCount({ address: signer.address, blockTag: "pending" })).toBe(
      2,
    );
  });

  test("an eth_sendTransaction without a nonce takes the chain's count, not a getTransactionCount mock's", async () => {
    const { mock, client, wallet } = nodeSetup();
    mock.actions.getTransactionCount({ address: alice }).returns(7);

    await wallet.sendTransaction({ to: bob });
    const second = await wallet.sendTransaction({ to: bob });

    expect(mock.transactions.map(({ fields }) => fields.nonce)).toEqual([0, 1]);
    expect((await client.getTransaction({ hash: second })).nonce).toBe(1);
    expect(mock.actions.getTransactionCount.calls).toEqual([]);
  });

  test("a deploy's address is from the nonce it took", async () => {
    const { mock, client, wallet } = nodeSetup();
    mock.actions.sendTransaction({ to: null }).returns();

    await wallet.sendTransaction({ to: bob });
    const hash = await wallet.deployContract({ abi: [], bytecode: "0x6000" });

    expect((await client.getTransactionReceipt({ hash })).contractAddress).toBe(
      lowercase(getContractAddress({ from: alice, nonce: 1n })),
    );
  });

  test("a sent nonce is taken as sent, and the count follows the highest", async () => {
    const { mock, client } = setup();
    const send = (nonce: number) =>
      mock.request({
        method: "eth_sendTransaction",
        params: [{ from: alice.toLowerCase(), to: bob, nonce: toHex(nonce) }],
      });

    await send(5);
    await send(2);

    expect(mock.transactions.map(({ fields }) => fields.nonce)).toEqual([5, 2]);
    expect(await client.getTransactionCount({ address: alice })).toBe(6);
  });

  test("each sender counts its own; emits count for no one", async () => {
    const { mock, client, wallet } = nodeSetup();
    mock.emit(testLog("noise"));

    await wallet.sendTransaction({ to: bob });
    await wallet.sendTransaction({ account: bob, to: alice });
    await wallet.sendTransaction({ to: bob });

    expect(mock.transactions.map(({ fields }) => [fields.from, fields.nonce])).toEqual([
      [undefined, undefined],
      [alice, 0],
      [bob, 0],
      [alice, 1],
    ]);
    expect(await client.getTransactionCount({ address: alice })).toBe(2);
    expect(await client.getTransactionCount({ address: bob })).toBe(1);
    expect(await client.getTransactionCount({ address: zeroAddress })).toBe(0);
  });

  test("at a block, the sends mined at or before it", async () => {
    const { mock, client, wallet } = nodeSetup();

    await wallet.sendTransaction({ to: bob });
    await wallet.sendTransaction({ to: bob });

    const at = async (blockNumber: bigint) => {
      const { hash } = await client.getBlock({ blockNumber });
      return await Promise.all([
        client.getTransactionCount({ address: alice, blockNumber }),
        mock.request({ method: "eth_getTransactionCount", params: [alice, hash] }),
        mock.request({ method: "eth_getTransactionCount", params: [alice, { blockHash: hash }] }),
      ]);
    };
    expect(await at(10n)).toEqual([0, "0x0", "0x0"]);
    expect(await at(11n)).toEqual([1, "0x1", "0x1"]);
    expect(await at(12n)).toEqual([2, "0x2", "0x2"]);
    expect(await client.getTransactionCount({ address: alice, blockTag: "earliest" })).toBe(0);
  });

  test("a resolver's count starts an account's nonce; a static answer stays fixed", async () => {
    const { mock, client, wallet } = localSetup();
    // The count is the next nonce, so it already includes the sends from 7 on.
    mock.actions
      .getTransactionCount({ address: signer.address })
      .returns(({ count }) => Math.max(7, count));

    await wallet.sendTransaction({ to: bob });
    await wallet.sendTransaction({ to: bob });
    mock.actions.getTransactionCount({ address: signer.address }).returns(3);
    await wallet.sendTransaction({ to: bob });

    expect(mock.transactions.map(({ fields }) => fields.nonce)).toEqual([7, 8, 3]);
    expect(await client.getTransactionCount({ address: signer.address })).toBe(3);
  });

  test("a refused send takes no nonce", async () => {
    const { mock, wallet } = nodeSetup();
    mock.actions.sendTransaction({ to: bob }).once().fails("insufficientFunds");

    await rejectionOf(wallet.sendTransaction({ to: bob }));
    await wallet.sendTransaction({ to: bob });

    expect(mock.transactions.map(({ fields }) => fields.nonce)).toEqual([0]);
  });

  test("reset() and restore() roll nonces back with the chain", async () => {
    const { mock, client, wallet } = nodeSetup();
    await wallet.sendTransaction({ to: bob });
    const checkpoint = mock.checkpoint();

    await wallet.sendTransaction({ to: bob });
    checkpoint.restore();
    expect(await client.getTransactionCount({ address: alice })).toBe(1);
    mock.reset();
    expect(await client.getTransactionCount({ address: alice })).toBe(0);
  });
});

describe("receipts' gas", () => {
  test("cumulativeGasUsed sums the block's transactions up to it", async () => {
    const { mock, client, wallet } = nodeSetup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    // Placed in the next block first, so the send is mined after it.
    usdc.emit.Transfer({ from: alice, to: bob, value: 1n }, { blockNumber: mock.blockNumber + 1n });

    const hash = await wallet.sendTransaction({ to: bob, gas: 30_000n });

    expect(await client.getTransactionReceipt({ hash })).toMatchObject({
      transactionIndex: 1,
      gasUsed: 30_000n,
      cumulativeGasUsed: 30_000n,
    });
    expect(await client.getTransactionReceipt({ hash: mock.transactions[0]!.hash })).toMatchObject({
      gasUsed: 0n,
      cumulativeGasUsed: 0n,
      from: zeroAddress,
    });
  });
});
