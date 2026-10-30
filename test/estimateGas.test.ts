import {
  EstimateGasExecutionError,
  FeeCapTooLowError,
  InsufficientFundsError,
  RpcRequestError,
  TipAboveFeeCapError,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  keccak256,
  parseGwei,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vite-plus/test";
import { MockNotFoundError, createMockRpc, testAddress } from "../src/index.js";
import { expectCause, rejectionOf } from "./utils.js";

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

/** A wallet client with a local account: its estimates carry a nonce and fees. */
function walletSetup() {
  const { mock, client } = setup();
  mock.actions.getTransactionCount().returns(0);
  const account = privateKeyToAccount(keccak256(toHex("alice")));
  const wallet = createWalletClient({
    account,
    chain: mock.chain,
    transport: mock.transport({ retryCount: 0 }),
  });
  return { mock, client, wallet, account };
}

/** The node error an estimate rejects with, after checking it isn't counted as unhandled. */
async function refusal(mock: ReturnType<typeof setup>["mock"], promise: Promise<unknown>) {
  const error = await rejectionOf(promise);
  expect(error).toBeInstanceOf(EstimateGasExecutionError);
  expect(mock.unhandled).toEqual([]);
  return error;
}

describe("estimateGas", () => {
  test("answers a pinned transaction in viem's types", async () => {
    const { mock, client } = setup();
    mock.actions.estimateGas({ account: alice, to: bob }).returns(30_000n);

    expect(await client.estimateGas({ account: alice, to: bob, value: 1n })).toBe(30_000n);
    expect(mock.actions.estimateGas.calls).toEqual([
      { account: alice, to: bob, value: 1n, blockNumber: 10n, blockTag: "latest" },
    ]);
  });

  test("a value of 0n matches a request without one; malformed pins throw", async () => {
    const { client, mock } = setup();
    mock.actions.estimateGas({ to: bob, value: 0n }).returns(25_000n);

    expect(await client.estimateGas({ account: alice, to: bob })).toBe(25_000n);
    expect(() => mock.actions.estimateGas({ account: "0x1234" })).toThrow();
  });

  test("a resolver gets the request's fees and nonce, as a local account prepares them", async () => {
    const { mock, wallet, account } = walletSetup();
    mock.actions.estimateGas().returns(({ value }) => 21_000n + value);

    const request = await wallet.prepareTransactionRequest({ to: bob, value: 5n });

    expect(request.gas).toBe(21_005n);
    expect(mock.actions.estimateGas.calls).toEqual([
      {
        account: account.address,
        to: bob,
        value: 5n,
        maxFeePerGas: parseGwei("13"),
        maxPriorityFeePerGas: parseGwei("1"),
        nonce: 0,
        blockNumber: 10n,
        blockTag: "latest",
      },
    ]);
  });

  test("a block number or tag is kept", async () => {
    const { mock, client } = setup();

    await client.estimateGas({ account: alice, to: bob, blockNumber: 4n });
    await client.estimateGas({ account: alice, to: bob, blockTag: "pending" });

    expect(
      mock.actions.estimateGas.calls.map(({ blockNumber, blockTag }) => [blockNumber, blockTag]),
    ).toEqual([
      [4n, undefined],
      [10n, "pending"],
    ]);
  });

  test("a pinned mock answers before one without pins", async () => {
    const { mock, client } = setup();
    mock.actions.estimateGas({ account: alice }).returns(50_000n);
    mock.actions.estimateGas().returns(100_000n);

    expect(await client.estimateGas({ account: alice, to: bob })).toBe(50_000n);
    expect(await client.estimateGas({ account: bob, to: alice })).toBe(100_000n);
  });

  test("answers are gas: a bigint, zero or more", () => {
    const { mock } = setup();

    expect(() => {
      mock.actions.estimateGas().returns(-1n);
    }).toThrow("A gas estimate must be a bigint, zero or more; got -1n.");
    expect(() => {
      // @ts-expect-error viem's estimate is a bigint
      mock.actions.estimateGas().returns(21_000);
    }).toThrow("A gas estimate must be a bigint, zero or more; got 21000.");
    expect(() => {
      // @ts-expect-error there's no zero estimate
      mock.actions.estimateGas().returns();
    }).toThrow("A gas estimate must be a bigint, zero or more; got undefined.");
  });

  test("method() refuses it, pointing at the typed action", () => {
    const { mock } = setup();

    expect(() => mock.method("eth_estimateGas")).toThrow(
      '"eth_estimateGas" has a typed mock: use mock.actions.estimateGas().',
    );
  });
});

describe("estimateGas unmocked", () => {
  test("a plain transfer to an address without code is 21000 gas, as a node estimates it", async () => {
    const { mock, client } = setup();
    mock.empty(testAddress("empty"));

    expect(await client.estimateGas({ account: alice, to: bob, value: 1n })).toBe(21_000n);
    expect(await client.estimateGas({ account: alice, to: testAddress("empty") })).toBe(21_000n);
    expect(await client.estimateGas({ account: alice, to: bob, data: "0x" })).toBe(21_000n);
    expect(mock.unhandled).toEqual([]);
  });

  test("anything else isn't answered", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: testAddress("usdc") });
    mock.empty(testAddress("empty"));

    const requests = [
      // A transfer to a contract runs its code.
      { account: alice, to: usdc.address, value: 1n },
      // Data to an address without code costs gas for the data.
      { account: alice, to: bob, data: "0x1234" as const },
      { account: alice, to: testAddress("empty"), data: "0x1234" as const },
      // A deployment.
      { account: alice, data: "0x6000" as const },
    ];
    const errors = await Promise.all(
      requests.map((request) => rejectionOf(client.estimateGas(request))),
    );
    for (const error of errors) expectCause(error, MockNotFoundError);

    expect(mock.unhandled).toHaveLength(4);
    expect(mock.unhandled[0]!.error.message).toContain(
      "Mock it with mock.actions.estimateGas({ to }).returns(…).",
    );
  });
});

describe("named node errors", () => {
  test('"insufficientFunds" without fees is the EVM\'s error, which viem names', async () => {
    const { mock, client } = setup();
    mock.actions.estimateGas({ account: alice }).fails("insufficientFunds");

    const error = await refusal(mock, client.estimateGas({ account: alice, to: bob, value: 1n }));

    expectCause(error, InsufficientFundsError);
    expect(expectCause(error, RpcRequestError)).toMatchObject({
      code: -32003,
      details: "EVM error: OutOfFunds",
    });
  });

  test('"insufficientFunds" with fees is the balance check, with the value wanted', async () => {
    const { mock, wallet } = walletSetup();
    mock.actions.estimateGas().fails("insufficientFunds");

    const error = await refusal(mock, wallet.prepareTransactionRequest({ to: bob, value: 7n }));

    expectCause(error, InsufficientFundsError);
    expect(expectCause(error, RpcRequestError)).toMatchObject({
      code: -32003,
      details: "insufficient funds for gas * price + value: have 0 want 7",
    });
  });

  test('"feeCapTooLow" and "tipAboveFeeCap" are reth\'s, which viem names', async () => {
    const { mock, client } = setup();
    mock.actions.estimateGas({ to: bob }).fails("feeCapTooLow");
    mock.actions.estimateGas({ to: alice }).returns(({ fail }) => fail("tipAboveFeeCap"));

    const feeCap = await refusal(mock, client.estimateGas({ account: alice, to: bob }));
    const tip = await refusal(mock, client.estimateGas({ account: bob, to: alice }));

    expectCause(feeCap, FeeCapTooLowError);
    expect(expectCause(feeCap, RpcRequestError)).toMatchObject({
      code: -32000,
      details: "max fee per gas less than block base fee",
    });
    expectCause(tip, TipAboveFeeCapError);
    expect(expectCause(tip, RpcRequestError)).toMatchObject({
      code: -32003,
      details: "max priority fee per gas higher than max fee per gas",
    });
  });

  test("history shows the name", async () => {
    const { mock, client } = setup();
    mock.actions.estimateGas().fails("insufficientFunds");

    await rejectionOf(client.estimateGas({ account: alice, to: bob }));

    expect(mock.formatHistory()).toBe(
      "#1 eth_estimateGas estimateGas({ account: 0xa41f…2D9e, to: 0x4292…207f, value: 0n, " +
        "blockNumber: 10n, blockTag: latest }) ✗ fault: insufficientFunds",
    );
  });

  test("simulate mocks take them too: eth_call refuses the same way", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: testAddress("usdc") });
    usdc.simulate.transfer().fails("insufficientFunds");

    const error = await rejectionOf(
      client.simulateContract({
        abi: erc20Abi,
        address: usdc.address,
        functionName: "transfer",
        args: [bob, 1n],
        account: alice,
      }),
    );

    expectCause(error, InsufficientFundsError);
    expect(mock.unhandled).toEqual([]);
  });
});
