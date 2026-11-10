import {
  ContractFunctionRevertedError,
  EstimateGasExecutionError,
  ExecutionRevertedError,
  HttpRequestError,
  FeeCapTooLowError,
  InsufficientFundsError,
  IntegerOutOfRangeError,
  IntrinsicGasTooLowError,
  InvalidAddressError,
  RpcRequestError,
  TipAboveFeeCapError,
  createPublicClient,
  type Address,
  type Hex,
  createWalletClient,
  encodeErrorResult,
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
  MockCheckError,
  type ContractDefaults,
  MockNotFoundError,
  MockResolverError,
  MockSetupError,
  type MockRpc,
  createMockRpc,
  testAddress,
} from "../src/index.js";
import { expectCause, expectThrows, hintsOf, rejectionOf } from "./utils.js";

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
  const account = privateKeyToAccount(keccak256(toHex("alice")));
  const wallet = createWalletClient({
    account,
    chain: mock.chain,
    transport: mock.transport({ retryCount: 0 }),
  });
  return { mock, client, wallet, account };
}

/** Each error in the chain viem throws, by class, with what it says of the node's error. */
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause)
    chain.push({
      name: cause.constructor.name,
      ...("details" in cause && { details: cause.details }),
      ...("code" in cause && { code: cause.code }),
      ...("data" in cause && { data: cause.data }),
    });
  return chain;
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
    mock.actions.estimateGas({ from: alice, to: bob }).returns(30_000n);

    expect(await client.estimateGas({ account: alice, to: bob, value: 1n })).toBe(30_000n);
    expect(mock.actions.estimateGas.calls).toEqual([
      { from: alice, to: bob, value: 1n, blockNumber: 10n, blockTag: "latest" },
    ]);
  });

  test("a transaction without a sender is answered, without an account", async () => {
    const { mock, client } = setup();
    mock.actions.estimateGas({ to: bob }).returns(30_000n);

    expect(await client.estimateGas({ to: bob })).toBe(30_000n);
    expect(mock.actions.estimateGas.calls).toEqual([
      { to: bob, value: 0n, blockNumber: 10n, blockTag: "latest" },
    ]);
  });

  test("a value of 0n matches a request without one; malformed pins throw", async () => {
    const { client, mock } = setup();
    mock.actions.estimateGas({ to: bob, value: 0n }).returns(25_000n);

    expect(await client.estimateGas({ account: alice, to: bob })).toBe(25_000n);
    // At registration, viem's own error: invalid params are for requests.
    expect(() => mock.actions.estimateGas({ from: "0x1234" })).toThrow(InvalidAddressError);
    expect(() => mock.actions.estimateGas({ to: "0x1234" })).toThrow(InvalidAddressError);
  });

  test("a resolver gets the request's fees and nonce, as a local account prepares them", async () => {
    const { mock, wallet, account } = walletSetup();
    mock.actions.estimateGas().returns(({ value }) => 21_000n + value);

    const request = await wallet.prepareTransactionRequest({ to: bob, value: 5n });

    expect(request.gas).toBe(21_005n);
    expect(mock.actions.estimateGas.calls).toEqual([
      {
        from: account.address,
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

  test("an estimate that reverts, fails or isn't answered is still one of its calls", async () => {
    const { mock, client } = setup();
    const carol = testAddress("carol");
    mock.actions.estimateGas({ to: bob }).reverts("paused");
    mock.actions.estimateGas({ to: alice }).fails("insufficientFunds");

    await rejectionOf(client.estimateGas({ account: alice, to: bob }));
    await rejectionOf(client.estimateGas({ account: bob, to: alice }));
    await rejectionOf(client.estimateGas({ account: alice, to: carol, data: "0x12" }));

    expect(mock.actions.estimateGas.calls.map(({ to }) => to)).toEqual([bob, alice, carol]);
  });

  test("a pinned mock answers before one without pins", async () => {
    const { mock, client } = setup();
    mock.actions.estimateGas({ from: alice }).returns(50_000n);
    mock.actions.estimateGas().returns(100_000n);

    expect(await client.estimateGas({ account: alice, to: bob })).toBe(50_000n);
    expect(await client.estimateGas({ account: bob, to: alice })).toBe(100_000n);
  });

  test("answers are gas: a non-negative bigint", () => {
    const { mock } = setup();

    expectThrows(
      MockSetupError,
      "estimateGas's answer must be a non-negative bigint; got -1n.",
      () => {
        mock.actions.estimateGas().returns(-1n);
      },
    );
    expectThrows(
      MockSetupError,
      "estimateGas's answer must be a non-negative bigint; got 21000.",
      () => {
        // @ts-expect-error -- viem's estimate is a bigint
        mock.actions.estimateGas().returns(21_000);
      },
    );
    expectThrows(
      MockSetupError,
      "estimateGas's answer can't be left out: an estimate has no zero answer.",
      () => {
        // @ts-expect-error -- there's no zero estimate
        mock.actions.estimateGas().returns();
      },
    );
  });

  test("method() refuses it, pointing at the typed action", () => {
    const { mock } = setup();

    expectThrows(
      MockSetupError,
      '"eth_estimateGas" has a typed mock: use mock.actions.estimateGas().',
      () => mock.method("eth_estimateGas"),
    );
  });
});

describe("estimateGas reverts", () => {
  test(".reverts() reverts it, as a node's estimate reverts, so a local account never sends", async () => {
    const { mock, client, wallet } = walletSetup();
    mock.actions.estimateGas({ to: bob }).reverts("paused");

    const error = await refusal(
      mock,
      client.estimateGas({ account: alice, to: bob, data: "0x12" }),
    );
    expect(expectCause(error, ExecutionRevertedError).details).toBe("execution reverted: paused");
    expect(mock.formatHistory()).toBe(
      '#1 eth_estimateGas estimateGas({ from: 0xa41f…2D9e, to: 0x4292…207f, value: 0n, data: 0x12, blockNumber: 10n, blockTag: latest }) ✗ reverted: "paused"',
    );

    const sent = await rejectionOf(wallet.sendTransaction({ to: bob, data: "0x12" }));
    expect(expectCause(sent, ExecutionRevertedError).details).toBe("execution reverted: paused");
    expect(mock.transactions).toEqual([]);
  });

  test.each([
    ["nothing, a bare revert", undefined],
    ["a reason", "paused"],
    ["a panic code", { panic: 0x11 }],
    ["raw data", { data: "0xdeadbeef" }],
  ] as const)(
    "with %s, viem gives the app the error a contract's estimate revert gives, from .reverts() or a resolver",
    async (_, spec) => {
      const { mock, client } = setup();
      const token = mock.contract({ abi: tokenAbi, address: testAddress("token") });
      token.estimateGas.transfer().reverts(spec);
      mock.actions.estimateGas({ to: bob }).reverts(spec);
      mock.actions.estimateGas({ to: alice }).returns(({ revert }) => revert(spec));
      const data = encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [bob, 1n] });

      const chainOf = async (to: Address) =>
        errorChain(await refusal(mock, client.estimateGas({ account: alice, to, data })));

      const contracts = await chainOf(token.address);
      expect(await chainOf(bob)).toEqual(contracts);
      expect(await chainOf(alice)).toEqual(contracts);
    },
  );

  test("a resolver's revert reverts the estimate only when it's called", async () => {
    const { mock, client } = setup();
    mock.actions
      .estimateGas()
      .returns(({ value, revert }) => (value > 1n ? revert("too much") : 30_000n));

    expect(await client.estimateGas({ account: alice, to: bob, value: 1n })).toBe(30_000n);
    const error = await refusal(mock, client.estimateGas({ account: alice, to: bob, value: 2n }));
    expect(expectCause(error, ExecutionRevertedError).details).toBe("execution reverted: too much");
  });

  test("a resolver's revert with a spec viem can't encode is a resolver error, as a contract estimate's is", async () => {
    const { mock, client } = setup();
    const token = mock.contract({ abi: tokenAbi, address: testAddress("token") });
    token.estimateGas.transfer().returns(({ revert }) => revert({ panic: -1 }));
    mock.actions.estimateGas({ to: bob }).returns(({ revert }) => revert({ panic: -1 }));
    const data = encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [bob, 1n] });

    for (const to of [token.address, bob]) {
      const error = await rejectionOf(client.estimateGas({ account: alice, to, data }));
      expectCause(expectCause(error, MockResolverError), IntegerOutOfRangeError);
    }
    expect(mock.unhandled).toHaveLength(2);
  });

  test("it beats a send mock's implied estimate, but not a contract's own estimate mock", async () => {
    const { mock, client } = setup();
    const token = mock.contract({ abi: tokenAbi, address: testAddress("token") });
    mock.actions.sendTransaction().returns();
    mock.actions.estimateGas().reverts("simulation failed");
    token.estimateGas.transfer().returns(65_000n);

    const reverted = await refusal(
      mock,
      client.estimateGas({ account: alice, to: bob, data: "0x12" }),
    );
    expect(expectCause(reverted, ExecutionRevertedError).details).toBe(
      "execution reverted: simulation failed",
    );
    const data = encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [bob, 1n] });
    expect(await client.estimateGas({ account: alice, to: token.address, data })).toBe(65_000n);
  });

  test("limits and pins apply as to any answer", async () => {
    const { mock, client } = setup();
    mock.actions.estimateGas().returns(30_000n);
    mock.actions.estimateGas({ from: bob }).reverts();
    mock.actions.estimateGas().once().reverts({ panic: 0x01 });

    await refusal(mock, client.estimateGas({ account: alice, to: bob }));
    expect(await client.estimateGas({ account: alice, to: bob })).toBe(30_000n);
    await refusal(mock, client.estimateGas({ account: bob, to: alice }));
    expect(
      mock
        .formatHistory()
        .split("\n")
        .map((line) => line.split(" ✗ ")[1] ?? "→"),
    ).toEqual(["reverted: Panic(1n)", "→", "reverted (0x)"]);
  });

  test("a spec viem can't encode throws at registration, changing nothing", async () => {
    const { mock, client } = setup();
    const answered = mock.actions.estimateGas({ to: bob });
    answered.returns(30_000n);
    const unanswered = mock.actions.estimateGas();

    for (const builder of [answered, unanswered])
      expect(() => {
        builder.reverts({ panic: -1 });
      }).toThrow(IntegerOutOfRangeError);
    expect(await client.estimateGas({ account: alice, to: bob })).toBe(30_000n);
    expectThrows(MockCheckError, "estimateGas(*) without an answer", () => {
      mock.assertAllUsed();
    });
  });

  test("a miss says which registered mocks revert or fail", async () => {
    const { mock, client } = setup();
    mock.actions.estimateGas({ to: bob }).reverts();
    mock.actions.estimateGas({ to: alice }).once().fails("timeout");

    const error = await rejectionOf(
      client.estimateGas({ account: alice, to: testAddress("carol"), data: "0x1234" }),
    );

    expect(hintsOf(expectCause(error, MockNotFoundError))).toBe(
      `Registered:\n  estimateGas({ to: ${bob} }) reverts  ← to didn't match\n  estimateGas({ to: ${alice} }) fails once  ← to didn't match`,
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
      // Deployments, with init code and without, aren't plain transfers.
      { account: alice, data: "0x6000" as const },
      { account: alice },
    ];
    const errors = await Promise.all(
      requests.map((request) => rejectionOf(client.estimateGas(request))),
    );
    for (const error of errors) expectCause(error, MockNotFoundError);

    expect(mock.unhandled).toHaveLength(5);
    expect(mock.unhandled[0]!.error.message).toContain(
      "Mock it with mock.actions.estimateGas({ to }).returns(…).",
    );
  });

  test("empty data to a registered contract isn't an estimate of one of its functions", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: testAddress("usdc") });

    const error = await rejectionOf(
      client.estimateGas({ account: alice, to: usdc.address, data: "0x" }),
    );

    expect(expectCause(error, MockNotFoundError).shortMessage).toMatch(
      /^No mock for estimateGas\(/u,
    );
    expect(mock.history[0]).not.toHaveProperty("contract");
  });
});

describe("named node errors", () => {
  // Reth sends "EVM error: OutOfFunds" here, which viem only names from 2.57.12.
  test('"insufficientFunds" without fees is the balance check too, which every viem names', async () => {
    const { mock, client } = setup();
    mock.actions.estimateGas({ from: alice }).fails("insufficientFunds");

    const error = await refusal(mock, client.estimateGas({ account: alice, to: bob, value: 1n }));

    expectCause(error, InsufficientFundsError);
    expect(expectCause(error, RpcRequestError)).toMatchObject({
      code: -32003,
      details: "insufficient funds for gas * price + value: have 0 want 1",
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

  test("gasExceedsAllowance names the request's gas, or the node's cap; viem takes it for a revert", async () => {
    const { mock, client } = setup();
    mock.actions.estimateGas().fails("gasExceedsAllowance");

    // viem never sends `gas` with an estimate: the app's own request does.
    const capped = await rejectionOf(
      client.request({
        method: "eth_estimateGas",
        params: [{ from: alice, to: bob, gas: "0x7530" }],
      }),
    );
    const uncapped = await refusal(mock, client.estimateGas({ account: alice, to: bob }));

    expect(capped).toMatchObject({
      code: -32000,
      details: "gas required exceeds allowance (30000)",
    });
    expectCause(uncapped, ExecutionRevertedError);
    expect(expectCause(uncapped, RpcRequestError)).toMatchObject({
      code: -32000,
      details: "gas required exceeds allowance (50000000)",
    });
  });

  test("history shows the name", async () => {
    const { mock, client } = setup();
    mock.actions.estimateGas().fails("insufficientFunds");

    await rejectionOf(client.estimateGas({ account: alice, to: bob }));

    expect(mock.formatHistory()).toBe(
      "#1 eth_estimateGas estimateGas({ from: 0xa41f…2D9e, to: 0x4292…207f, value: 0n, " +
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

  test("simulate mocks take a gas cap's refusals: too little to run, or below the base cost", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: testAddress("usdc") });
    usdc.simulate.transfer([bob, 1n]).fails("gasExceedsAllowance");
    usdc.simulate.transfer([bob, 2n]).returns(({ fail }) => fail("intrinsicGasTooLow"));
    const simulate = (amount: bigint) =>
      client.simulateContract({
        abi: erc20Abi,
        address: usdc.address,
        functionName: "transfer",
        args: [bob, amount],
        account: alice,
        gas: 25_000n,
      });

    const exceeds = await rejectionOf(simulate(1n));
    const intrinsic = await rejectionOf(simulate(2n));

    expectCause(exceeds, ExecutionRevertedError);
    expect(expectCause(exceeds, RpcRequestError).details).toBe(
      "gas required exceeds allowance (25000)",
    );
    expectCause(intrinsic, IntrinsicGasTooLowError);
    expect(mock.unhandled).toEqual([]);
  });
});

/** A token contract, and estimates of its write functions from alice. */
function tokenSetup(defaults?: ContractDefaults<typeof tokenAbi>) {
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
  return { mock, client, token, transfer, mint };
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
    expect(token.simulate.transfer.calls).toEqual([]);
    expect(token.calls.map((call) => [call.namespace, call.functionName])).toEqual([
      ["estimateGas", "transfer"],
      ["estimateGas", "mint"],
    ]);
    expect(mock.calls).toEqual(token.calls);
  });

  test("an estimate at a block is the contract's call at that block", async () => {
    const { client, token } = tokenSetup();
    token.estimateGas.transfer().returns(({ blockNumber }) => 60_000n + blockNumber);

    const gas = await client.estimateContractGas({
      abi: tokenAbi,
      address: token.address,
      functionName: "transfer",
      args: [bob, 1n],
      account: alice,
      blockNumber: 4n,
    });

    expect(gas).toBe(60_004n);
    expect(token.estimateGas.transfer.calls).toMatchObject([{ blockNumber: 4n }]);
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
    token.estimateGas.mint([1n]).fails("insufficientFunds");
    token.estimateGas.mint([2n]).returns(({ fail }) => fail("gasExceedsAllowance"));
    token.estimateGas.transfer().returns(({ fail }) => fail({ status: 503 }));

    expectCause(await rejectionOf(mint(1n, 1n)), InsufficientFundsError);
    expectCause(await rejectionOf(mint(2n)), ExecutionRevertedError);
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
    expect(hintsOf(error)).toBe(
      'No estimateGas mocks registered for "transfer"; a write mock that matches the send implies one, and a simulate mock doesn\'t answer estimates.',
    );
    expect(mock.unhandled).toHaveLength(1);
    // The contract didn't answer, so its record has the request's outcome.
    expect(mock.history[0]).toMatchObject({
      contract: { call: { functionName: "transfer" }, outcome: { type: "unhandled" } },
    });
  });

  test("history shows the function estimated", async () => {
    const { mock, token, transfer } = tokenSetup();
    token.estimateGas.transfer().returns(65_000n);

    await transfer();

    expect(mock.formatHistory()).toBe(
      "#1 eth_estimateGas estimateGas Token.transfer(0x4292…207f, 1n) → 65000n",
    );
    expect(mock.history[0]).toMatchObject({
      contract: { namespace: "estimateGas", call: { functionName: "transfer" } },
    });
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
    mock.actions.estimateGas({ from: alice }).fails("insufficientFunds");
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
    // The contract didn't answer, so its record has the request's outcome.
    expect(mock.history[0]).toMatchObject({
      contract: { call: { functionName: "mint" }, outcome: { type: "result", value: 100_000n } },
    });
  });

  test("a function not on the contract's ABI falls through to action mocks", async () => {
    const { mock, client, token } = tokenSetup();
    const approve = () =>
      client.estimateGas({
        account: alice,
        to: token.address,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [bob, 1n] }),
      });

    const error = expectCause(await rejectionOf(approve()), MockNotFoundError);
    mock.actions.estimateGas({ to: token.address }).returns(60_000n);
    expect(await approve()).toBe(60_000n);

    expect(error.shortMessage).toBe(
      `No function with selector 0x095ea7b3 on mocked contract Token (${token.address}).`,
    );
    expect(mock.unhandled).toHaveLength(1);
    expect(mock.history[1]).toMatchObject({
      contract: {
        namespace: "estimateGas",
        call: undefined,
        outcome: { type: "result", value: 60_000n },
      },
    });
    expect(mock.formatHistory().split("\n")[1]).toBe(
      "#2 eth_estimateGas estimateGas({ from: 0xa41f…2D9e, to: 0x0dc7…41c6, value: 0n, " +
        "data: 0x095e…0001, blockNumber: 10n, blockTag: latest }) → 60000n",
    );
    expect(token.calls).toEqual([]);
  });
});

describe("contract estimates answered by action mocks", () => {
  test("are still the contract's calls, tagged, even of a view function", async () => {
    const { mock, client, token } = tokenSetup();
    mock.actions.estimateGas({ to: token.address }).returns(30_000n);

    const gas = await client.estimateGas({
      account: alice,
      to: token.address,
      data: encodeFunctionData({ abi: tokenAbi, functionName: "balanceOf", args: [bob] }),
    });

    expect(gas).toBe(30_000n);
    expect(token.calls).toMatchObject([
      { namespace: "estimateGas", functionName: "balanceOf", args: [bob] },
    ]);
    expect(mock.history[0]).toMatchObject({
      contract: {
        namespace: "estimateGas",
        call: { functionName: "balanceOf" },
        outcome: { type: "result", value: 30_000n },
      },
    });
  });

  test.each([
    [
      ".reverts()",
      (mock: MockRpc, data: Hex) => {
        mock.actions.estimateGas().reverts({ data });
      },
    ],
    [
      "a resolver's revert()",
      (mock: MockRpc, data: Hex) => {
        mock.actions.estimateGas().returns(({ revert }) => revert({ data }));
      },
    ],
  ] as const)(
    "reverting with %s, the revert is decoded against the contract's ABI in history",
    async (_, revertWith) => {
      const { mock, transfer } = tokenSetup();
      const data = encodeErrorResult({ abi: tokenAbi, errorName: "Paused", args: [bob] });
      revertWith(mock, data);

      await rejectionOf(transfer());

      const outcome = { type: "revert", data, errorName: "Paused", args: [bob] };
      expect(mock.history[0]).toMatchObject({
        outcome,
        contract: { namespace: "estimateGas", outcome },
      });
    },
  );
});

describe("contract estimate mocks", () => {
  test("are checked by assertAllUsed and removed by restore, except defaults", async () => {
    const { mock, token, transfer } = tokenSetup({ estimateGas: { mint: 1n } });
    const checkpoint = mock.checkpoint();
    token.estimateGas.transfer([alice, 1n]).returns(65_000n);

    await rejectionOf(transfer());

    expectThrows(MockCheckError, `transfer(${alice}, 1n) on Token`, () => {
      mock.assertAllUsed();
    });
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

    expectThrows(
      MockCheckError,
      `received 1 call to transfer:\n      transfer(${bob}, …)  ← to didn't match`,
      () => {
        mock.assertAllUsed();
      },
    );
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

    expectThrows(
      MockSetupError,
      "estimateGas.transfer's answer must be a non-negative bigint; got -1n.",
      () => {
        token.estimateGas.transfer().returns(-1n);
      },
    );
    expectThrows(
      MockSetupError,
      "estimateGas.transfer's answer must be a non-negative bigint; got 1.",
      () => {
        // @ts-expect-error -- an estimate is a bigint
        token.estimateGas.transfer().returns(1);
      },
    );
    expectThrows(
      MockSetupError,
      "estimateGas.transfer's answer can't be left out: an estimate has no zero answer.",
      () => {
        // @ts-expect-error -- there's no zero estimate
        token.estimateGas.transfer().returns();
      },
    );
    expectThrows(
      MockSetupError,
      '"balanceOf" is a view function; viem estimates gas only for nonpayable and payable functions.',
      () => {
        // @ts-expect-error -- viem doesn't estimate a view
        token.estimateGas.balanceOf(); // oxlint-disable-line typescript/no-unsafe-call -- untyped caller, on purpose
      },
    );
    expectThrows(MockSetupError, '"balanceOf" is a view function', () =>
      mock.contract({
        abi: tokenAbi,
        address: testAddress("other"),
        // @ts-expect-error -- viem doesn't estimate a view
        defaults: { estimateGas: { balanceOf: 1n } },
      }),
    );
  });
});
