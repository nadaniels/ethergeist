import {
  ContractFunctionRevertedError,
  EstimateGasExecutionError,
  HttpRequestError,
  FeeCapTooLowError,
  InsufficientFundsError,
  RpcRequestError,
  TipAboveFeeCapError,
  createPublicClient,
  type Address,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  parseAbi,
  parseGwei,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vite-plus/test";

import {
  type MockContractDefaults,
  MockNotFoundError,
  createMockRpc,
  testAddress,
} from "../src/index.js";
import { expectCause, rejectionOf } from "./utils.js";

const alice = testAddress("alice");
const bob = testAddress("bob");
const tokenAbi = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function mint(uint256 amount) payable",
  "function balanceOf(address owner) view returns (uint256)",
  "error Paused(address by)",
]);

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

/** A token contract, and estimates of its write functions from alice. */
function tokenSetup(defaults?: MockContractDefaults<typeof tokenAbi>) {
  const { mock, client } = setup();
  const token = mock.contract({
    abi: tokenAbi,
    address: testAddress("token"),
    name: "Token",
    ...(defaults && { defaults }),
  });
  const transfer = (account: Address = alice) =>
    client.estimateContractGas({
      abi: tokenAbi,
      address: token.address,
      functionName: "transfer",
      args: [bob, 1n],
      account,
    });
  const mint = (amount: bigint, value = 0n) =>
    client.estimateContractGas({
      abi: tokenAbi,
      address: token.address,
      functionName: "mint",
      args: [amount],
      account: alice,
      value,
    });
  return { mock, token, transfer, mint };
}

describe("contract estimates", () => {
  test("answer estimateContractGas for a function, as their own calls", async () => {
    const { mock, token, transfer, mint } = tokenSetup();
    token.estimateGas.transfer([bob, 1n]).returns(65_000n);
    token.estimateGas.mint().returns(({ args: [amount], value }) => 50_000n + amount + value);

    expect(await transfer()).toBe(65_000n);
    expect(await mint(5n, 2n)).toBe(50_007n);
    expect(token.estimateGas.transfer.calls).toEqual([
      {
        address: token.address,
        functionName: "transfer",
        args: [bob, 1n],
        from: alice,
        value: 0n,
        blockNumber: 10n,
        batch: undefined,
      },
    ]);
    // Estimates aren't eth_calls.
    expect(token.simulate.transfer.calls).toEqual([]);
    expect(token.calls).toEqual([]);
    expect(mock.calls).toEqual([]);
  });

  test("reverts decode against the contract's ABI, as viem decodes a node's", async () => {
    const { mock, token, transfer } = tokenSetup();
    token.estimateGas.transfer().reverts({ errorName: "Paused", args: [bob] });

    const error = await rejectionOf(transfer());

    expect(expectCause(error, ContractFunctionRevertedError).data).toMatchObject({
      errorName: "Paused",
      args: [bob],
    });
    expect(mock.unhandled).toEqual([]);
    expect(mock.formatHistory()).toBe(
      "#1 eth_estimateGas estimateGas Token.transfer(0x4292…207f, 1n) ✗ reverted: Paused(0x4292…207f)",
    );
  });

  test("named node errors and faults fail the estimate", async () => {
    const { mock, token, transfer, mint } = tokenSetup();
    token.estimateGas.mint().fails("insufficientFunds");
    token.estimateGas.transfer().returns(({ fail }) => fail({ status: 503 }));

    expectCause(await rejectionOf(mint(1n, 1n)), InsufficientFundsError);
    expect(expectCause(await rejectionOf(transfer()), HttpRequestError).status).toBe(503);
    expect(mock.unhandled).toEqual([]);
  });

  test("unmocked, a function isn't answered, even with a simulate mock", async () => {
    const { mock, token, transfer } = tokenSetup();
    token.simulate.transfer().returns(true);

    const error = expectCause(await rejectionOf(transfer()), MockNotFoundError);

    expect(error.shortMessage).toBe(
      `No estimateGas mock for transfer(${bob}, 1n) on Token (${token.address}).`,
    );
    expect(error.details).toBe(
      'No estimateGas mocks registered for "transfer"; a simulate mock doesn\'t answer estimates.',
    );
    expect(mock.unhandled).toHaveLength(1);
  });

  test("history shows the function estimated", async () => {
    const { mock, token, transfer } = tokenSetup();
    token.estimateGas.transfer().returns(65_000n);

    await transfer();

    expect(mock.formatHistory()).toBe(
      "#1 eth_estimateGas estimateGas Token.transfer(0x4292…207f, 1n) → 65000n",
    );
  });

  test("a write's prepare uses the contract's estimate", async () => {
    const { mock, wallet } = walletSetup();
    const token = mock.contract({ abi: tokenAbi, address: testAddress("token") });
    token.estimateGas.transfer().returns(65_000n);

    const request = await wallet.prepareTransactionRequest({
      to: token.address,
      data: encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [bob, 1n] }),
    });

    expect(request.gas).toBe(65_000n);
  });
});

describe("estimate precedence", () => {
  test("a contract's mocks answer estimates of its functions before action mocks", async () => {
    const { mock, token, transfer } = tokenSetup();
    token.estimateGas.transfer().returns(65_000n);
    mock.actions.estimateGas({ account: alice }).fails("insufficientFunds");
    mock.actions.estimateGas({ to: token.address }).returns(1n);

    expect(await transfer()).toBe(65_000n);
  });

  test("defaults answer too, and a contract mock overrides them", async () => {
    const { mock, token, transfer } = tokenSetup({ estimateGas: { transfer: 60_000n } });
    mock.actions.estimateGas().returns(100_000n);

    expect(await transfer()).toBe(60_000n);
    token.estimateGas.transfer().once().returns(65_000n);
    expect(await transfer()).toBe(65_000n);
    expect(await transfer()).toBe(60_000n);
  });

  test("action mocks answer functions the contract doesn't mock, by their own rules", async () => {
    const { mock, mint } = tokenSetup({ estimateGas: { transfer: 60_000n } });
    mock.actions.estimateGas().returns(100_000n);
    mock.actions.estimateGas({ value: 1n }).fails("insufficientFunds");

    expect(await mint(1n)).toBe(100_000n);
    expectCause(await rejectionOf(mint(1n, 1n)), InsufficientFundsError);
    expect(mock.formatHistory()).toBe(
      "#1 eth_estimateGas estimateGas Token.mint(1n) → 100000n\n" +
        "#2 eth_estimateGas estimateGas Token.mint(1n) ✗ fault: insufficientFunds",
    );
  });
});

describe("contract estimate mocks", () => {
  test("are checked by assertAllUsed and removed by restore, except defaults", async () => {
    const { mock, token, transfer } = tokenSetup({ estimateGas: { mint: 1n } });
    const checkpoint = mock.checkpoint();
    token.estimateGas.transfer([alice, 1n]).returns(65_000n);

    await rejectionOf(transfer());

    expect(() => {
      mock.assertAllUsed();
    }).toThrow(`transfer(${alice}, 1n) on Token`);
    checkpoint.restore();
    expect(() => {
      mock.assertAllUsed();
    }).not.toThrow();
  });

  test("an unused one lists the estimates its function received", async () => {
    const { mock, token, transfer } = tokenSetup();
    token.simulate.transfer().returns(true);
    token.estimateGas.transfer([alice, 1n]).returns(65_000n);

    await rejectionOf(transfer());

    expect(() => {
      mock.assertAllUsed();
    }).toThrow(`received 1 call to transfer:\n      transfer(${bob}, …)  ← to didn't match`);
  });

  test("clearCalls() clears their calls", async () => {
    const { mock, token, transfer } = tokenSetup();
    token.estimateGas.transfer().returns(65_000n);
    await transfer();

    mock.clearCalls();
    expect(token.estimateGas.transfer.calls).toEqual([]);
  });

  test("history records the contract's answer in viem's types", async () => {
    const { mock, token, transfer } = tokenSetup();
    token.estimateGas.transfer().returns(65_000n);

    await transfer();

    expect(mock.history[0]).toMatchObject({
      contract: { name: "Token", outcome: { type: "result", value: 65_000n } },
    });
  });

  test("answers are gas, and only write functions estimate", () => {
    const { mock, token } = tokenSetup();

    expect(() => {
      token.estimateGas.transfer().returns(-1n);
    }).toThrow("A gas estimate must be a bigint, zero or more; got -1n.");
    expect(() => {
      // @ts-expect-error an estimate is a bigint
      token.estimateGas.transfer().returns(1);
    }).toThrow("A gas estimate must be a bigint, zero or more; got 1.");
    expect(() => {
      // @ts-expect-error there's no zero estimate
      token.estimateGas.transfer().returns();
    }).toThrow("A gas estimate must be a bigint, zero or more; got undefined.");
    expect(() => {
      // @ts-expect-error viem estimates only writes
      token.estimateGas.balanceOf(); // oxlint-disable-line typescript/no-unsafe-call -- untyped caller, on purpose
    }).toThrow(
      '"balanceOf" is a view function; viem estimates gas only for nonpayable and payable functions.',
    );
    expect(() =>
      mock.contract({
        abi: tokenAbi,
        address: testAddress("other"),
        // @ts-expect-error viem estimates only writes
        defaults: { estimateGas: { balanceOf: 1n } },
      }),
    ).toThrow('"balanceOf" is a view function');
  });
});
