import {
  type Address,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  InsufficientFundsError,
  IntrinsicGasTooLowError,
  InvalidAddressError,
  NonceTooHighError,
  NonceTooLowError,
  createWalletClient,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  parseAbi,
  toHex,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test, vi } from "vite-plus/test";

import {
  MockCheckError,
  MockNotFoundError,
  MockResolverError,
  type MockRpc,
  MockSetupError,
  createMockRpc,
  match,
  testAddress,
  testLog,
} from "../src/index.js";
import { expectCause, expectRejects, expectThrows, hintsOf, rejectionOf } from "./utils.js";

const alice = testAddress("alice");
const bob = testAddress("bob");
const USDC = testAddress("usdc");
const VAULT = testAddress("vault");
const signer = privateKeyToAccount(keccak256(toHex("signer")));

const vaultAbi = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256 amount)",
  "function withdraw(uint256 amount, address to)",
  "event Deposit(address indexed from, uint256 value)",
  "error Paused(uint256 until)",
]);

/**
 * The app's clients: a local account, which signs and sends raw bytes, or a
 * node's (JSON-RPC) account.
 */
function setup(account: "local" | "node" = "local") {
  const mock = createMockRpc({ blockNumber: 10n });
  const client = mock.publicClient({ retryCount: 0 });
  const wallet = createWalletClient({
    account: account === "local" ? signer : alice,
    chain: mock.chain,
    transport: mock.transport({ retryCount: 0 }),
  });
  const usdc = mock.contract({ abi: erc20Abi, address: USDC, name: "USDC" });
  const from = account === "local" ? signer.address : alice;
  const transfer = (amount = 5n, options: { gas?: bigint } = {}) =>
    wallet.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "transfer",
      args: [bob, amount],
      ...options,
    });
  return { mock, client, wallet, usdc, from, transfer };
}

const sentMethods = (mock: ReturnType<typeof createMockRpc>) =>
  mock.history
    .map(({ method }) => method)
    .filter((method) => method === "eth_estimateGas" || method.startsWith("eth_send"));

describe("a write mock", () => {
  test.each(["local", "node"] as const)(
    "is all a %s account's writeContract and waitForTransactionReceipt need",
    async (account) => {
      const { mock, client, usdc, from, transfer } = setup(account);
      const log = usdc.events.Transfer({ from, to: bob, value: 5n });
      usdc.write.transfer([bob, 5n]).emits(log);

      const hash = await transfer();
      const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 10 });

      expect(receipt).toMatchObject({
        status: "success",
        transactionHash: hash,
        from: from.toLowerCase(),
        to: USDC.toLowerCase(),
        blockNumber: 11n,
        gasUsed: 100_000n,
        logs: [{ ...log, address: USDC.toLowerCase(), logIndex: 0, transactionHash: hash }],
      });
      expect(usdc.write.transfer.calls).toEqual([
        {
          address: USDC,
          functionName: "transfer",
          args: [bob, 5n],
          from,
          value: 0n,
          blockNumber: 10n,
          batch: undefined,
        },
      ]);
      // A local account estimates first; a node's account leaves it to the node.
      expect(usdc.calls.map(({ namespace }) => namespace)).toEqual(
        account === "local" ? ["estimateGas", "write"] : ["write"],
      );
      expect(mock.calls.at(-1)).toMatchObject({ namespace: "write", functionName: "transfer" });
      expect(mock.actions.sendTransaction.calls).toMatchObject([{ from, to: USDC }]);
      expect(mock.transactions).toMatchObject([{ hash, origin: "sent" }]);
      expect(mock.history.at(-2)).toMatchObject({
        type: "action",
        action: "sendTransaction",
        contract: { namespace: "write", call: { functionName: "transfer" } },
        outcome: { type: "result", value: hash },
      });
      expect(() => {
        mock.assertAllUsed();
      }).not.toThrow();
    },
  );

  test("answers with the outcome: receipt, transaction, block and logs agree", async () => {
    const { client, usdc, transfer } = setup();
    const noise = testLog("noise");
    usdc.write.transfer([bob, 5n]).returns({
      logs: [usdc.events.Transfer({ from: signer.address, to: bob, value: 5n }), noise],
      gasUsed: 48_210n,
      effectiveGasPrice: 7n,
    });

    const hash = await transfer();

    const receipt = await client.getTransactionReceipt({ hash });
    expect(receipt).toMatchObject({
      gasUsed: 48_210n,
      cumulativeGasUsed: 48_210n,
      effectiveGasPrice: 7n,
      logs: [{ logIndex: 0 }, { address: noise.address.toLowerCase(), logIndex: 1 }],
    });
    const transaction = await client.getTransaction({ hash });
    expect(transaction).toMatchObject({ blockNumber: 11n, gas: 100_000n, to: USDC.toLowerCase() });
    expect((await client.getBlock({ blockNumber: 11n })).transactions).toEqual([hash]);
    expect(
      await client.getContractEvents({ abi: erc20Abi, address: USDC, fromBlock: 11n }),
    ).toMatchObject([{ eventName: "Transfer", transactionHash: hash }]);
  });

  test("the receipt's gas follows the gas sent", async () => {
    const { client, usdc, transfer } = setup();
    usdc.write.transfer().returns();

    const hash = await transfer(5n, { gas: 60_000n });

    expect(await client.getTransactionReceipt({ hash })).toMatchObject({
      status: "success",
      gasUsed: 60_000n,
      // The base fee plus the tip: below the max fee viem signed.
      effectiveGasPrice: 11_000_000_000n,
      logs: [],
    });
  });

  test("a resolver gets the call and answers with its outcome, or nothing for a success", async () => {
    const { usdc, mock, client, transfer } = setup();
    const resolver = vi.fn(
      ({
        from,
        args: [to, value],
      }: {
        from: `0x${string}`;
        args: readonly [`0x${string}`, bigint];
      }) => {
        if (value > 6n) return { gasUsed: 2n };
        if (value > 5n) return { logs: [usdc.events.Transfer({ from, to, value })], gasUsed: 1n };
        return undefined;
      },
    );
    usdc.write.transfer().returns(resolver);

    const hash = await transfer(5n);
    await transfer(6n);
    await transfer(7n);

    expect(resolver).toHaveBeenCalledTimes(3);
    expect(resolver.mock.calls[0]![0]).toMatchObject({
      from: signer.address,
      functionName: "transfer",
      args: [bob, 5n],
      value: 0n,
    });
    expect(await client.getTransactionReceipt({ hash })).toMatchObject({
      status: "success",
      logs: [],
    });
    expect(mock.transactions.map(({ logs }) => logs.length)).toEqual([0, 1, 0]);
    expect(mock.transactions.map(({ receipt }) => receipt.gasUsed)).toEqual([undefined, 1n, 2n]);
  });

  test("a payable write's value and an overload, by its args", async () => {
    const { mock, client, wallet, from } = setup();
    const vault = mock.contract({ abi: vaultAbi, address: VAULT });
    vault.write.deposit().returns(({ value }) => ({
      logs: [vault.events.Deposit({ from, value })],
    }));
    vault.write.withdraw([1n, bob]).returns({ gasUsed: 2n });
    vault.write.withdraw([1n]).returns({ gasUsed: 1n });

    await wallet.writeContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: "deposit",
      value: 9n,
    });
    await wallet.writeContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: "withdraw",
      args: [1n, bob],
    });
    await wallet.writeContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: "withdraw",
      args: [1n],
    });

    expect(vault.write.deposit.calls).toMatchObject([{ value: 9n }]);
    expect(vault.write.withdraw.calls.map(({ args }) => args)).toEqual([[1n, bob], [1n]]);
    expect(mock.transactions.map(({ receipt }) => receipt.gasUsed)).toEqual([undefined, 2n, 1n]);
    expect(
      await client.getContractEvents({ abi: vaultAbi, address: VAULT, fromBlock: 0n }),
    ).toMatchObject([{ eventName: "Deposit", args: { from, value: 9n } }]);
  });

  test(".once() and .times(n) count sends, not estimates", async () => {
    const { mock, usdc, transfer } = setup();
    usdc.write.transfer().once().returns({ gasUsed: 1n });
    usdc.write.transfer().times(2).returns({ gasUsed: 2n });

    await transfer(1n);
    await transfer(2n);
    await transfer(3n);

    // Limited mocks answer oldest first.
    expect(mock.transactions.map(({ receipt }) => receipt.gasUsed)).toEqual([1n, 2n, 2n]);
    await expectRejects(
      ContractFunctionExecutionError,
      /No estimateGas mock for transfer/u,
      transfer(4n),
    );
  });

  test("defaults.write answers every send of a function, exempt from assertAllUsed", async () => {
    const mock = createMockRpc({ blockNumber: 10n });
    const wallet = createWalletClient({
      account: alice,
      chain: mock.chain,
      transport: mock.transport({ retryCount: 0 }),
    });
    const usdc = mock.contract({
      abi: erc20Abi,
      address: USDC,
      defaults: { write: { approve: { gasUsed: 3n }, transfer: () => ({ gasUsed: 4n }) } },
    });

    expect(() => {
      mock.assertAllUsed();
    }).not.toThrow();
    await wallet.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "transfer",
      args: [bob, 1n],
    });
    usdc.write.transfer([bob, 2n]).returns({ gasUsed: 5n });
    await wallet.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "transfer",
      args: [bob, 2n],
    });

    expect(mock.transactions.map(({ receipt }) => receipt.gasUsed)).toEqual([4n, 5n]);
  });

  // The sendTransaction case already held its outcome as given: it's here so
  // the send paths keep one rule.
  test.each([
    {
      registered: "a write mock",
      register: (mock: MockRpc, outcome: { gasUsed: bigint }) => {
        mock.contract({ abi: erc20Abi, address: USDC }).write.transfer().returns(outcome);
      },
    },
    {
      registered: "defaults.write",
      register: (mock: MockRpc, outcome: { gasUsed: bigint }) => {
        mock.contract({ abi: erc20Abi, address: USDC, defaults: { write: { transfer: outcome } } });
      },
    },
    {
      registered: "a sendTransaction mock",
      register: (mock: MockRpc, outcome: { gasUsed: bigint }) => {
        mock.actions.sendTransaction({ to: USDC }).returns(outcome);
      },
    },
  ])("$registered holds a static outcome as given", async ({ register }) => {
    const mock = createMockRpc();
    const wallet = createWalletClient({
      account: alice,
      chain: mock.chain,
      transport: mock.transport({ retryCount: 0 }),
    });
    const outcome = { gasUsed: 21_000n };
    register(mock, outcome);
    outcome.gasUsed = 50_000n;

    await wallet.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "transfer",
      args: [bob, 1n],
    });

    expect(mock.transactions.map(({ receipt }) => receipt.gasUsed)).toEqual([50_000n]);
  });

  test("answering, it leaves a sendTransaction mock unmatched, at the estimate and the send", async () => {
    const { mock, usdc, transfer } = setup();
    const counted = vi.fn(() => true);
    mock.actions.sendTransaction({ to: match.where(counted) }).returns({ gasUsed: 1n });
    usdc.write.transfer().returns({ gasUsed: 2n });

    await transfer();

    expect(counted).not.toHaveBeenCalled();
    expect(mock.transactions).toMatchObject([
      { fields: { gas: 100_000n }, receipt: { gasUsed: 2n } },
    ]);
  });

  test("a send mock for the same to doesn't answer what it misses: the estimate misses, naming the arg and the send mock", async () => {
    const { mock, usdc, transfer } = setup();
    mock.actions.sendTransaction({ to: USDC }).returns({ gasUsed: 1n });
    usdc.write.transfer([bob, 5n]).returns({ gasUsed: 2n });

    await transfer(5n);
    const notFound = expectCause(await rejectionOf(transfer(6n)), MockNotFoundError);

    expect(notFound.shortMessage).toBe(
      `No estimateGas mock for transfer(${bob}, 6n) on USDC (${USDC}).`,
    );
    expect(notFound.metaMessages).toEqual([
      "Write mocks, which imply the estimate of a send they match:",
      `  transfer(${bob}, 5n)  ← amount didn't match`,
      "Action mocks that match, which don't answer a registered contract's functions:",
      `  sendTransaction({ to: ${USDC} })`,
    ]);
    expect(mock.transactions.map(({ receipt }) => receipt.gasUsed)).toEqual([2n]);
  });

  test("a send mock for the same to doesn't answer what it misses: a node account's send misses, naming the arg and the send mock", async () => {
    const { mock, usdc, transfer } = setup("node");
    mock.actions.sendTransaction({ to: USDC }).returns({ gasUsed: 1n });
    usdc.write.transfer([bob, 5n]).returns({ gasUsed: 2n });

    const notFound = expectCause(await rejectionOf(transfer(6n)), MockNotFoundError);

    expect(notFound.shortMessage).toBe(`No write mock for transfer(${bob}, 6n) on USDC (${USDC}).`);
    expect(notFound.metaMessages).toEqual([
      "Registered:",
      `  transfer(${bob}, 5n)  ← amount didn't match`,
      "Action mocks that match, which don't answer a registered contract's functions:",
      `  sendTransaction({ to: ${USDC} })`,
    ]);
    expect(mock.transactions).toEqual([]);
    expectThrows(MockCheckError, `sendTransaction({ to: ${USDC} })`, () => {
      mock.assertAllUsed();
    });
  });

  test("a function without a write mock isn't answered, with a hint", async () => {
    const { mock, usdc, transfer } = setup("node");
    usdc.simulate.transfer().returns(true);

    const error = await rejectionOf(transfer());

    const notFound = expectCause(error, MockNotFoundError);
    expect(notFound.shortMessage).toBe(`No write mock for transfer(${bob}, 5n) on USDC (${USDC}).`);
    expect(hintsOf(notFound)).toBe(
      `No write mocks registered for "transfer"; a simulate mock doesn't answer sends.`,
    );
    expect(mock.transactions).toEqual([]);
  });

  test("restore() takes a write back off the chain, and its mocks", async () => {
    const { mock, usdc, transfer } = setup();
    const checkpoint = mock.checkpoint();
    usdc.write.transfer().once().returns();

    await transfer();
    checkpoint.restore();

    expect(mock.transactions).toEqual([]);
    expect(mock.blockNumber).toBe(10n);
    expectCause(await rejectionOf(transfer()), MockNotFoundError);
  });
});

describe("the estimate a write mock implies", () => {
  test("a .refuses() mock implies it too, and refuses only the send", async () => {
    const { mock, usdc, transfer } = setup();
    usdc.write.transfer().once().refuses("nonceTooLow");

    expectCause(await rejectionOf(transfer()), NonceTooLowError);

    const sent = mock.history.filter(
      ({ method }) => method === "eth_estimateGas" || method.startsWith("eth_send"),
    );
    expect(sent.map(({ method, outcome }) => [method, outcome])).toEqual([
      ["eth_estimateGas", { type: "result", value: 100_000n }],
      ["eth_sendRawTransaction", { type: "refusal", name: "nonceTooLow" }],
    ]);
    expect(mock.transactions).toEqual([]);
  });

  test("is 100,000 gas, without running the mock or using it up, and is an estimateGas call", async () => {
    const { mock, client, usdc } = setup();
    const resolver = vi.fn(() => ({}));
    usdc.write.transfer([bob, 5n]).once().returns(resolver);

    const gas = await client.estimateContractGas({
      account: alice,
      address: USDC,
      abi: erc20Abi,
      functionName: "transfer",
      args: [bob, 5n],
    });

    expect(gas).toBe(100_000n);
    expect(resolver).not.toHaveBeenCalled();
    expect(usdc.estimateGas.transfer.calls).toMatchObject([{ args: [bob, 5n], from: alice }]);
    expect(usdc.write.transfer.calls).toEqual([]);
    expect(usdc.calls.map(({ namespace }) => namespace)).toEqual(["estimateGas"]);
    expectThrows(
      MockCheckError,
      /transfer\(.*\) once on USDC .*\n.*received no calls to transfer/u,
      () => {
        mock.assertAllUsed();
      },
    );
  });

  test("an estimateGas mock or defaults.estimateGas answers first, and an estimate action mock doesn't answer", async () => {
    const mock = createMockRpc({ blockNumber: 10n });
    const client = mock.publicClient({ retryCount: 0 });
    const usdc = mock.contract({
      abi: erc20Abi,
      address: USDC,
      defaults: { estimateGas: { approve: 3n } },
    });
    usdc.write.transfer().returns();
    usdc.write.approve().returns();
    usdc.write.transferFrom().returns();
    usdc.estimateGas.transfer().returns(1n);
    mock.actions.estimateGas({ to: USDC }).returns(2n);
    const estimate = (
      functionName: "transfer" | "approve",
      args: readonly [`0x${string}`, bigint],
    ) =>
      client.estimateContractGas({
        account: alice,
        address: USDC,
        abi: erc20Abi,
        functionName,
        args,
      });

    expect(await estimate("transfer", [bob, 1n])).toBe(1n);
    expect(await estimate("approve", [bob, 1n])).toBe(3n);
    expect(
      await client.estimateContractGas({
        account: alice,
        address: USDC,
        abi: erc20Abi,
        functionName: "transferFrom",
        args: [alice, bob, 1n],
      }),
    ).toBe(100_000n);
  });

  test("follows the write mock, never a send mock for the same to", async () => {
    const { mock, client, usdc } = setup();
    mock.actions.sendTransaction({ to: USDC }).returns();
    usdc.write.transfer([bob, 5n]).reverts("paused");

    const error = await rejectionOf(
      client.estimateContractGas({
        account: alice,
        address: USDC,
        abi: erc20Abi,
        functionName: "transfer",
        args: [bob, 5n],
      }),
    );

    expect(expectCause(error, ContractFunctionRevertedError).reason).toBe("paused");
    const missed = await rejectionOf(
      client.estimateContractGas({
        account: alice,
        address: USDC,
        abi: erc20Abi,
        functionName: "transfer",
        args: [bob, 6n],
      }),
    );
    expect(expectCause(missed, MockNotFoundError).shortMessage).toBe(
      `No estimateGas mock for transfer(${bob}, 6n) on USDC (${USDC}).`,
    );
  });

  test("a used-up write mock implies nothing", async () => {
    const { usdc, transfer } = setup();
    usdc.write.transfer().once().returns();

    await transfer();
    const error = await rejectionOf(transfer());

    // The estimate finds no mock, so nothing is sent; its hint names the used-up `write` mock.
    const notFound = expectCause(error, MockNotFoundError);
    expect(notFound.shortMessage).toMatch(/^No estimateGas mock for transfer/u);
    expect(hintsOf(notFound)).toBe(
      "Write mocks, which imply the estimate of a send they match:\n  transfer(*) once, used up",
    );
  });

  test("an estimate no mock answers names the write mocks that missed, and why", async () => {
    const { usdc, transfer } = setup();
    usdc.write.transfer([bob, 5n]).returns();
    usdc.write.transfer([bob, 6n]).returns({ status: "reverted" });

    const notFound = expectCause(await rejectionOf(transfer(7n)), MockNotFoundError);

    expect(notFound.shortMessage).toBe(
      `No estimateGas mock for transfer(${bob}, 7n) on USDC (${USDC}).`,
    );
    expect(hintsOf(notFound)).toBe(
      [
        "Write mocks, which imply the estimate of a send they match:",
        `  transfer(${bob}, 5n)  ← amount didn't match`,
        `  transfer(${bob}, 6n)  ← amount didn't match`,
      ].join("\n"),
    );
  });

  test("a send's miss lists its write mocks once, as Registered", async () => {
    const { usdc, transfer } = setup("node");
    usdc.write.transfer([bob, 5n]).returns();

    const notFound = expectCause(await rejectionOf(transfer(7n)), MockNotFoundError);

    expect(notFound.shortMessage).toBe(`No write mock for transfer(${bob}, 7n) on USDC (${USDC}).`);
    expect(hintsOf(notFound)).toBe(`Registered:\n  transfer(${bob}, 5n)  ← amount didn't match`);
  });

  test("an estimate's miss lists its estimateGas mocks, then its write mocks", async () => {
    const { usdc, transfer } = setup();
    usdc.estimateGas.transfer([alice, 7n]).returns(50_000n);
    usdc.write.transfer([bob, 5n]).returns();

    const notFound = expectCause(await rejectionOf(transfer(7n)), MockNotFoundError);

    expect(hintsOf(notFound)).toBe(
      [
        "Registered:",
        `  transfer(${alice}, 7n)  ← recipient didn't match`,
        "Write mocks, which imply the estimate of a send they match:",
        `  transfer(${bob}, 5n)  ← amount didn't match`,
      ].join("\n"),
    );
  });

  test("an estimate without from is no send's: its miss runs no write mock's predicates", async () => {
    const { mock, usdc } = setup();
    const small = vi.fn((amount: bigint) => {
      if (amount > 100n) throw new Error("too large");
      return true;
    });
    usdc.write.transfer([bob, match.where(small)]).returns();
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [bob, 500n] });

    const error = await rejectionOf(
      mock.request({ method: "eth_estimateGas", params: [{ to: USDC, data }] }),
    );

    // The `write` mocks were never in contention, so they aren't matched for the message.
    expect(small).not.toHaveBeenCalled();
    expect(hintsOf(expectCause(error, MockNotFoundError))).toBe(
      'No estimateGas mocks registered for "transfer"; a write mock that matches the send implies one, and a simulate mock doesn\'t answer estimates.',
    );
  });

  test("a write mock's predicate that throws fails the estimate, which is still the contract's call", async () => {
    const { mock, client, usdc } = setup();
    usdc.write
      .transfer([
        bob,
        match.where((amount: bigint) => {
          if (amount > 100n) throw new Error("too large");
          return true;
        }, "small"),
      ])
      .returns();

    const error = await rejectionOf(
      client.estimateContractGas({
        account: alice,
        address: USDC,
        abi: erc20Abi,
        functionName: "transfer",
        args: [bob, 500n],
      }),
    );

    expect(expectCause(error, MockResolverError).shortMessage).toBe(
      'Matcher where(small) for "transfer" threw: too large',
    );
    expect(usdc.estimateGas.transfer.calls).toMatchObject([{ args: [bob, 500n], from: alice }]);
    expect(mock.history.at(-1)).toMatchObject({
      action: "estimateGas",
      contract: {
        namespace: "estimateGas",
        call: { functionName: "transfer" },
        outcome: { type: "unhandled" },
      },
    });
  });

  test("an estimate's miss lists only its own overload's write mocks", async () => {
    const { mock, wallet } = setup();
    const vault = mock.contract({ abi: vaultAbi, address: VAULT, name: "Vault" });
    vault.write.withdraw([5n]).returns();

    const error = await rejectionOf(
      wallet.writeContract({
        address: VAULT,
        abi: vaultAbi,
        functionName: "withdraw",
        args: [5n, bob],
      }),
    );

    expect(hintsOf(expectCause(error, MockNotFoundError))).toBe(
      'No estimateGas mocks registered for "withdraw"; a write mock that matches the send implies one, and a simulate mock doesn\'t answer estimates.',
    );
  });
});

describe("only a contract's mocks answer its functions", () => {
  test("an estimate action mock's refusal doesn't reach a write, which is sent at 100,000 and leaves it unused", async () => {
    const { mock, usdc, transfer } = setup();
    usdc.write.transfer().returns();
    mock.actions.estimateGas().refuses("insufficientFunds");

    await transfer();

    expect(mock.transactions).toMatchObject([{ fields: { gas: 100_000n } }]);
    expectThrows(MockCheckError, "estimateGas(*) refuses", () => {
      mock.assertAllUsed();
    });
  });

  test("a send mock for the same to neither reverts the estimate nor answers the send", async () => {
    const { mock, usdc, transfer } = setup();
    usdc.estimateGas.transfer().returns(77_000n);
    mock.actions.sendTransaction({ to: USDC }).reverts();

    const notFound = expectCause(await rejectionOf(transfer()), MockNotFoundError);

    expect(mock.history.find(({ method }) => method === "eth_estimateGas")).toMatchObject({
      outcome: { type: "result", value: 77_000n },
    });
    expect(notFound.shortMessage).toBe(`No write mock for transfer(${bob}, 5n) on USDC (${USDC}).`);
    expect(mock.transactions).toEqual([]);
  });

  test.each(["local", "node"] as const)(
    "action mocks registered before the contract don't answer its function either, and its miss names them (%s account)",
    async (account) => {
      const mock = createMockRpc({ blockNumber: 10n });
      mock.actions.estimateGas().returns(80_000n);
      mock.actions.sendTransaction().returns();
      mock.contract({ abi: erc20Abi, address: USDC, name: "USDC" });
      const wallet = createWalletClient({
        account: account === "local" ? signer : alice,
        chain: mock.chain,
        transport: mock.transport({ retryCount: 0 }),
      });

      const error = await rejectionOf(
        wallet.writeContract({
          address: USDC,
          abi: erc20Abi,
          functionName: "transfer",
          args: [bob, 5n],
        }),
      );

      const notFound = expectCause(error, MockNotFoundError);
      // A local account estimates first; a node's account leaves it to the node.
      if (account === "local") {
        expect(notFound.shortMessage).toBe(
          `No estimateGas mock for transfer(${bob}, 5n) on USDC (${USDC}).`,
        );
        expect(notFound.metaMessages).toEqual([
          `No estimateGas mocks registered for "transfer"; a write mock that matches the send implies one, and a simulate mock doesn't answer estimates.`,
          "Action mocks that match, which don't answer a registered contract's functions:",
          "  estimateGas(*)",
          "  sendTransaction(*)",
        ]);
      } else {
        expect(notFound.shortMessage).toBe(
          `No write mock for transfer(${bob}, 5n) on USDC (${USDC}).`,
        );
        expect(notFound.metaMessages).toEqual([
          `No write mocks registered for "transfer"; a simulate mock doesn't answer sends.`,
          "Action mocks that match, which don't answer a registered contract's functions:",
          "  sendTransaction(*)",
        ]);
      }
      expect(mock.transactions).toEqual([]);
      expectThrows(MockCheckError, "sendTransaction(*)", () => {
        mock.assertAllUsed();
      });
    },
  );

  test("an estimate without from is the contract's too, missing beside an estimate action mock, which it names, and no send mock", async () => {
    const { mock } = setup();
    mock.actions.estimateGas().returns(80_000n);
    mock.actions.sendTransaction().returns();
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [bob, 5n] });

    const error = await rejectionOf(
      mock.request({ method: "eth_estimateGas", params: [{ to: USDC, data }] }),
    );

    const notFound = expectCause(error, MockNotFoundError);
    expect(notFound.shortMessage).toBe(
      `No estimateGas mock for transfer(${bob}, 5n) on USDC (${USDC}).`,
    );
    expect(notFound.metaMessages).toEqual([
      `No estimateGas mocks registered for "transfer"; a write mock that matches the send implies one, and a simulate mock doesn't answer estimates.`,
      "Action mocks that match, which don't answer a registered contract's functions:",
      "  estimateGas(*)",
    ]);
  });

  test("its miss names action mocks with a predicate without running it", async () => {
    const { mock, transfer } = setup();
    const counted = vi.fn(() => true);
    mock.actions.estimateGas({ to: match.where(counted, "isUsdc") }).returns(80_000n);
    mock.actions.sendTransaction({ to: match.where(counted, "isUsdc") }).returns();

    const notFound = expectCause(await rejectionOf(transfer()), MockNotFoundError);

    expect(notFound.metaMessages?.slice(-3)).toEqual([
      "Action mocks that match, which don't answer a registered contract's functions:",
      "  estimateGas({ to: where(isUsdc) })",
      "  sendTransaction({ to: where(isUsdc) })",
    ]);
    expect(counted).not.toHaveBeenCalled();
  });

  test.each(["local", "node"] as const)(
    "its miss names no action mock that doesn't match, can't answer, or the last restore removed (%s account)",
    async (account) => {
      const { mock, transfer } = setup(account);
      const checkpoint = mock.checkpoint();
      mock.actions.estimateGas().returns(80_000n);
      mock.actions.sendTransaction().returns();
      checkpoint.restore();
      mock.actions.estimateGas({ to: bob }).returns(80_000n);
      mock.actions.sendTransaction({ to: bob }).returns();
      mock.actions.estimateGas({ to: USDC });
      mock.actions.sendTransaction({ to: USDC });
      mock.actions.sendTransaction({ to: USDC, value: 0n }).once().returns();
      await mock.request({
        method: "eth_sendTransaction",
        params: [{ from: alice, to: USDC, data: "0x12345678" }],
      });

      const notFound = expectCause(await rejectionOf(transfer()), MockNotFoundError);

      expect(notFound.metaMessages).toEqual([
        account === "local"
          ? `No estimateGas mocks registered for "transfer"; a write mock that matches the send implies one, and a simulate mock doesn't answer estimates.`
          : `No write mocks registered for "transfer"; a simulate mock doesn't answer sends.`,
      ]);
    },
  );

  test("a payable function's write mock implies its estimate beside an estimate action mock", async () => {
    const { mock, wallet } = setup();
    const vault = mock.contract({ abi: vaultAbi, address: VAULT, name: "Vault" });
    vault.write.deposit([], { value: 3n }).returns();
    mock.actions.estimateGas({ value: 3n }).returns(80_000n);

    await wallet.writeContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: "deposit",
      value: 3n,
    });

    expect(mock.transactions).toMatchObject([{ fields: { gas: 100_000n, value: 3n } }]);
  });
});

describe("action mocks answer the rest of what's sent to a registered contract", () => {
  test.each([
    { data: "0x12345678", kind: "a selector not on its ABI" },
    { data: "0xa9059cbb12", kind: "a function's selector, with data that doesn't decode" },
  ] as const)("$kind: estimated and sent by a send mock", async ({ data }) => {
    const { mock, wallet, usdc } = setup();
    mock.actions.sendTransaction({ to: USDC }).returns({ gasUsed: 1n });

    await wallet.sendTransaction({ to: USDC, data });

    expect(mock.transactions).toMatchObject([
      { fields: { gas: 100_000n }, receipt: { gasUsed: 1n } },
    ]);
    expect(usdc.calls).toEqual([]);
    mock.assertAllUsed();
  });

  test("a view function sent as a transaction, which is still the contract's call", async () => {
    const { mock, wallet, usdc } = setup();
    mock.actions.estimateGas({ to: USDC }).returns(30_000n);
    mock.actions.sendTransaction({ to: USDC }).returns({ gasUsed: 1n });

    await wallet.sendTransaction({
      to: USDC,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [bob] }),
    });

    expect(mock.transactions).toMatchObject([
      { fields: { gas: 30_000n }, receipt: { gasUsed: 1n } },
    ]);
    expect(usdc.calls).toMatchObject([
      { namespace: "estimateGas", functionName: "balanceOf", args: [bob] },
      { namespace: "write", functionName: "balanceOf", args: [bob] },
    ]);
  });

  const notAFunction = `USDC (${USDC}) is a registered contract, but this transaction isn't a call to one of its nonpayable or payable functions.`;

  describe.each([
    { kind: "a selector not on its ABI", data: "0x12345678" },
    { kind: "a function's selector, with data that doesn't decode", data: "0xa9059cbb12" },
    {
      kind: "a view function",
      data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [bob] }),
    },
  ] as const)(
    "unmocked, $kind is the action's miss, which says the contract is registered",
    ({ data }) => {
      // A local account estimates first; a node's account leaves it to the node.
      const misses = { local: "estimateGas", node: "sendTransaction" } as const;

      test.each(["local", "node"] as const)(
        "with no action mocks (%s account)",
        async (account) => {
          const { mock, wallet } = setup(account);

          const error = await rejectionOf(wallet.sendTransaction({ to: USDC, data }));

          const notFound = expectCause(error, MockNotFoundError);
          expect(notFound.shortMessage).toMatch(
            new RegExp(`^No mock for ${misses[account]}\\(`, "u"),
          );
          expect(notFound.metaMessages).toEqual([
            notAFunction,
            `Mock it with mock.actions.${misses[account]}({ to }).returns(…).`,
          ]);
          expect(mock.transactions).toEqual([]);
        },
      );

      test.each(["local", "node"] as const)(
        "beside action mocks that miss, which it lists (%s account)",
        async (account) => {
          const { mock, wallet } = setup(account);
          mock.actions.estimateGas({ to: bob }).returns(30_000n);
          mock.actions.sendTransaction({ to: bob }).returns();

          const error = await rejectionOf(wallet.sendTransaction({ to: USDC, data }));

          // A local account's estimate is its send's, so it lists the send mocks too.
          const sendLines = {
            local: [
              "sendTransaction mocks, which imply the estimate of a send they match:",
              `  sendTransaction({ to: ${bob} })  ← to didn't match`,
            ],
            node: [],
          };
          expect(expectCause(error, MockNotFoundError).metaMessages).toEqual([
            notAFunction,
            "Registered:",
            `  ${misses[account]}({ to: ${bob} })  ← to didn't match`,
            ...sendLines[account],
          ]);
          expect(mock.transactions).toEqual([]);
        },
      );
    },
  );

  test("a contract removed by restore() leaves its functions to action mocks", async () => {
    const { mock, wallet } = setup();
    const checkpoint = mock.checkpoint();
    const vault = mock.contract({ abi: vaultAbi, address: VAULT });
    vault.write.withdraw([1n]).reverts("paused");
    checkpoint.restore();
    mock.actions.sendTransaction({ to: VAULT }).returns({ gasUsed: 1n });

    await wallet.writeContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: "withdraw",
      args: [1n],
    });

    expect(mock.transactions).toMatchObject([
      { fields: { gas: 100_000n }, receipt: { gasUsed: 1n } },
    ]);
  });
});

describe("reverts", () => {
  const paused = { errorName: "Paused", args: [7n] } as const;

  test(".reverts(spec): a local account's estimate reverts, decoded, and nothing is sent", async () => {
    const { mock, wallet } = setup();
    const vault = mock.contract({ abi: vaultAbi, address: VAULT });
    vault.write.withdraw([1n]).reverts(paused);

    const error = await rejectionOf(
      wallet.writeContract({ address: VAULT, abi: vaultAbi, functionName: "withdraw", args: [1n] }),
    );

    const reverted = expectCause(error, ContractFunctionRevertedError);
    expect(reverted.data).toMatchObject({ errorName: "Paused", args: [7n] });
    expect(sentMethods(mock)).toEqual(["eth_estimateGas"]);
    expect(mock.transactions).toEqual([]);
    expect(mock.blockNumber).toBe(10n);
  });

  test.each([
    { name: "with gas set", account: "local", gas: 50_000n },
    { name: "from a node's account", account: "node", gas: undefined },
  ] as const)(".reverts(spec) $name: no estimate, mined reverted", async ({ account, gas }) => {
    const { mock, client, usdc, transfer } = setup(account);
    usdc.write.transfer().reverts("paused");

    const hash = await transfer(5n, gas === undefined ? {} : { gas });

    expect(sentMethods(mock)).not.toContain("eth_estimateGas");
    expect(await client.waitForTransactionReceipt({ hash, pollingInterval: 10 })).toMatchObject({
      status: "reverted",
      logs: [],
      blockNumber: 11n,
      gasUsed: gas ?? 100_000n,
    });
  });

  test.each(["local", "node"] as const)(
    '.returns({ status: "reverted" }): the estimate passes and the chain reverts (%s account)',
    async (account) => {
      const { mock, client, usdc, transfer } = setup(account);
      usdc.write.transfer().returns({ status: "reverted", gasUsed: 21_500n });

      const hash = await transfer();

      expect(await client.getTransactionReceipt({ hash })).toMatchObject({
        status: "reverted",
        logs: [],
        gasUsed: 21_500n,
      });
      expect(mock.blockNumber).toBe(11n);
    },
  );

  test("a resolver's revert() mines it reverted; its estimate passes", async () => {
    const { mock, client, usdc, transfer } = setup();
    usdc.write.transfer().returns(({ from, args: [to, value], revert }) => {
      if (value > 5n) revert("too much");
      return { logs: [usdc.events.Transfer({ from, to, value })] };
    });

    const hash = await transfer(6n);

    expect(sentMethods(mock)).toEqual(["eth_estimateGas", "eth_sendRawTransaction"]);
    expect(await client.getTransactionReceipt({ hash })).toMatchObject({
      status: "reverted",
      logs: [],
    });
  });

  test("an estimateGas mock's .reverts() reverts a resolver write's estimate", async () => {
    const { mock, usdc, transfer } = setup();
    const resolver = vi.fn();
    usdc.write.transfer().returns(resolver);
    usdc.estimateGas.transfer([bob, 6n]).reverts("too much");

    const error = await rejectionOf(transfer(6n));

    expect(expectCause(error, ContractFunctionRevertedError).reason).toBe("too much");
    expect(resolver).not.toHaveBeenCalled();
    expect(mock.transactions).toEqual([]);
  });

  test("simulate is its own registration: a simulate revert doesn't touch the write", async () => {
    const { client, usdc, transfer } = setup();
    usdc.simulate.transfer().reverts("paused");
    usdc.write.transfer().returns();

    const error = await rejectionOf(
      client.simulateContract({
        account: alice,
        address: USDC,
        abi: erc20Abi,
        functionName: "transfer",
        args: [bob, 5n],
      }),
    );
    expect(expectCause(error, ContractFunctionRevertedError).reason).toBe("paused");

    const hash = await transfer();
    expect((await client.getTransactionReceipt({ hash })).status).toBe("success");
  });

  test.each(["local", "node"] as const)(
    "a node's refusal, by .refuses() or a resolver's refuse(), changes nothing (%s account)",
    async (account) => {
      const { mock, usdc, transfer } = setup(account);
      usdc.write.transfer([bob, 5n]).refuses("insufficientFunds");
      usdc.write.transfer([bob, 6n]).returns(({ refuse }) => refuse("insufficientFunds"));

      expectCause(await rejectionOf(transfer(5n)), InsufficientFundsError);
      expectCause(await rejectionOf(transfer(6n)), InsufficientFundsError);

      expect(mock.transactions).toEqual([]);
      expect(mock.blockNumber).toBe(10n);
    },
  );

  const poolRefusals = [
    { name: "nonceTooLow", errorClass: NonceTooLowError },
    { name: "nonceTooHigh", errorClass: NonceTooHighError },
    { name: "alreadyKnown", errorClass: NonceTooLowError },
    { name: "intrinsicGasTooLow", errorClass: IntrinsicGasTooLowError },
  ] as const;
  test.each(
    (["local", "node"] as const).flatMap((account) =>
      poolRefusals.map(({ name, errorClass }) => ({ account, name, errorClass })),
    ),
  )(
    "$name is the transaction pool's refusal, viem's $errorClass.name ($account account)",
    async ({ account, name, errorClass }) => {
      const { mock, client, usdc, from, transfer } = setup(account);
      usdc.write.transfer([bob, 5n]).refuses(name);
      usdc.write.transfer([bob, 6n]).returns(({ refuse }) => refuse(name));

      expectCause(await rejectionOf(transfer(5n)), errorClass);
      expectCause(await rejectionOf(transfer(6n)), errorClass);

      expect(mock.transactions).toEqual([]);
      expect(mock.blockNumber).toBe(10n);
      expect(await client.getTransactionCount({ address: from })).toBe(0);
      expect(mock.unhandled).toEqual([]);
    },
  );

  test("a resolver that throws changes nothing", async () => {
    const { mock, usdc, transfer } = setup();
    usdc.write.transfer().returns(() => {
      throw new Error("oops");
    });

    expectCause(await rejectionOf(transfer()), MockResolverError);

    expect(mock.transactions).toEqual([]);
    expect(mock.blockNumber).toBe(10n);
  });
});

describe("a write's .reverts() reverts its estimate before any estimate mock", () => {
  test("an estimate action mock, shared or pinned to the contract, sets no write's number: one goes through at 100,000, one reverts", async () => {
    const { mock, usdc, transfer } = setup();
    mock.actions.estimateGas().returns(80_000n);
    mock.actions.estimateGas({ to: USDC }).returns(55_000n);
    usdc.write.transfer([bob, 5n]).returns();
    usdc.write.transfer([bob, 6n]).reverts("paused");

    await transfer(5n);
    const error = await rejectionOf(transfer(6n));

    expect(expectCause(error, ContractFunctionRevertedError).reason).toBe("paused");
    expect(mock.transactions).toMatchObject([{ fields: { gas: 100_000n } }]);
    expect(mock.formatHistory({ builtIns: false }).split("\n").slice(-1)).toEqual([
      `#10 eth_estimateGas estimateGas USDC.transfer(0x4292…207f, 6n) ✗ reverted: "paused"`,
    ]);
  });

  test("the contract's own estimate mocks and defaults lose to its write's revert", async () => {
    const { mock, wallet } = setup();
    const usdc = mock.contract({
      abi: erc20Abi,
      address: testAddress("token"),
      defaults: { estimateGas: { transfer: 60_000n, approve: 46_000n } },
    });
    usdc.estimateGas.transferFrom().returns(65_000n);
    usdc.estimateGas.approve([alice, 1n]).refuses("insufficientFunds");
    usdc.write.transfer().reverts("paused");
    usdc.write.transferFrom().reverts("paused");
    usdc.write.approve().reverts("paused");
    const writes = [
      () =>
        wallet.writeContract({
          address: usdc.address,
          abi: erc20Abi,
          functionName: "transfer",
          args: [bob, 1n],
        }),
      () =>
        wallet.writeContract({
          address: usdc.address,
          abi: erc20Abi,
          functionName: "transferFrom",
          args: [alice, bob, 1n],
        }),
      () =>
        wallet.writeContract({
          address: usdc.address,
          abi: erc20Abi,
          functionName: "approve",
          args: [alice, 1n],
        }),
    ];

    for (const write of writes)
      expect(expectCause(await rejectionOf(write()), ContractFunctionRevertedError).reason).toBe(
        "paused",
      );
    expect(mock.transactions).toEqual([]);
  });

  test("the contract's estimate mocks aren't matched, so their predicates don't run", async () => {
    const { usdc, transfer } = setup();
    const counted = vi.fn(() => true);
    usdc.estimateGas.transfer([match.where(counted), 5n]).returns(1n);
    usdc.estimateGas
      .transfer([
        bob,
        match.where(() => {
          throw new Error("boom");
        }),
      ])
      .returns(1n);
    usdc.write.transfer().reverts("paused");

    const error = await rejectionOf(transfer());

    expect(expectCause(error, ContractFunctionRevertedError).reason).toBe("paused");
    expect(counted).not.toHaveBeenCalled();
  });

  test("history decodes the revert against the contract's ABI", async () => {
    const { mock, wallet } = setup();
    const vault = mock.contract({
      abi: vaultAbi,
      address: VAULT,
      name: "Vault",
      defaults: { estimateGas: { withdraw: 50_000n } },
    });
    vault.write.withdraw([1n]).reverts({ errorName: "Paused", args: [7n] });

    await rejectionOf(
      wallet.writeContract({ address: VAULT, abi: vaultAbi, functionName: "withdraw", args: [1n] }),
    );

    expect(mock.formatHistory().split("\n").at(-1)).toBe(
      "#5 eth_estimateGas estimateGas Vault.withdraw(1n) ✗ reverted: Paused(7n)",
    );
  });

  test('for an estimate that passes and a send mined reverted, .returns({ status: "reverted" }) and an estimate mock', async () => {
    const { mock, client, usdc, transfer } = setup();
    usdc.estimateGas.transfer().returns(65_000n);
    usdc.write.transfer().returns({ status: "reverted" });

    const hash = await transfer();

    expect(await client.getTransactionReceipt({ hash })).toMatchObject({
      status: "reverted",
      gasUsed: 65_000n,
    });
    expect(mock.transactions).toHaveLength(1);
  });

  test("a revert that answers an estimate counts as used, and spends a .once()", async () => {
    const { mock, usdc, transfer } = setup();
    usdc.write.transfer().returns();
    usdc.write.transfer().once().reverts("paused");

    expectCause(await rejectionOf(transfer()), ContractFunctionRevertedError);
    // The .once() was the estimate's answer, so the next write goes through.
    await transfer();
    expect(mock.transactions).toHaveLength(1);
    mock.assertAllUsed();
  });

  test("the estimate it reverts is still the contract's call, recorded with the revert", async () => {
    const { mock, usdc, from, transfer } = setup();
    usdc.write.transfer().reverts("paused");

    await rejectionOf(transfer());

    expect(usdc.estimateGas.transfer.calls).toMatchObject([{ args: [bob, 5n], from }]);
    expect(usdc.write.transfer.calls).toEqual([]);
    expect(mock.calls).toMatchObject([{ namespace: "estimateGas", functionName: "transfer" }]);
    expect(mock.history.at(-1)).toMatchObject({
      action: "estimateGas",
      contract: {
        namespace: "estimateGas",
        call: { functionName: "transfer", args: [bob, 5n] },
        outcome: { type: "revert", reason: "paused" },
      },
    });
  });

  test.each([
    { answer: "implies 100,000", estimateMock: undefined, reverts: false },
    { answer: "reverts", estimateMock: undefined, reverts: true },
    {
      answer: "implies 100,000 beside an action's estimate mock",
      estimateMock: "action",
      reverts: false,
    },
    {
      answer: "leaves the number to the contract's estimate mock",
      estimateMock: "contract",
      reverts: false,
    },
  ] as const)(
    "a write mock's predicate runs once per estimate, as it could revert it: one that $answer",
    async ({ estimateMock, reverts }) => {
      const { mock, client, usdc } = setup();
      const small = vi.fn((amount: bigint) => amount < 10n);
      const builder = usdc.write.transfer([bob, match.where(small)]);
      if (reverts) builder.reverts("paused");
      else builder.returns();
      if (estimateMock === "action") mock.actions.estimateGas().returns(80_000n);
      if (estimateMock === "contract") usdc.estimateGas.transfer().returns(80_000n);

      const estimated = client.estimateContractGas({
        account: alice,
        address: USDC,
        abi: erc20Abi,
        functionName: "transfer",
        args: [bob, 5n],
      });

      if (reverts) expectCause(await rejectionOf(estimated), ContractFunctionRevertedError);
      else expect(await estimated).toBe(estimateMock === "contract" ? 80_000n : 100_000n);
      expect(small).toHaveBeenCalledTimes(1);
    },
  );
});

describe("wagmi's flow: simulate, then write, then wait", () => {
  test("with simulate registered on its own, and a reverted receipt's eth_call replay answered from simulate", async () => {
    const { client, wallet, usdc, from } = setup();
    usdc.simulate.transfer([bob, 5n]).returns(true);
    usdc.write.transfer([bob, 5n]).returns({ status: "reverted" });

    const { request, result } = await client.simulateContract({
      account: signer,
      address: USDC,
      abi: erc20Abi,
      functionName: "transfer",
      args: [bob, 5n],
    });
    expect(result).toBe(true);
    const hash = await wallet.writeContract(request);
    const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 10 });
    expect(receipt.status).toBe("reverted");

    // wagmi replays a reverted transaction with eth_call, to decode its reason.
    const transaction = await client.getTransaction({ hash });
    const { data } = await client.call({
      account: transaction.from,
      to: transaction.to,
      data: transaction.input,
      value: transaction.value,
    });
    expect(
      decodeFunctionResult({ abi: erc20Abi, functionName: "transfer", data: data ?? "0x" }),
    ).toBe(true);
    expect(usdc.calls.map(({ namespace }) => namespace)).toEqual([
      "simulate",
      "estimateGas",
      "write",
      "simulate",
    ]);
    expect(usdc.write.transfer.calls).toMatchObject([{ from }]);
  });
});

describe("registration refusals", () => {
  test("an outcome is checked as a send's is; a call to a contract deploys nothing", () => {
    const { usdc } = setup();
    const write = usdc.write.transfer();

    expectThrows(MockSetupError, "transactionHash isn't a field of a send's outcome.", () => {
      // @ts-expect-error -- a send's outcome has no transactionHash: it comes from where it's mined
      write.returns({ transactionHash: "0x12" });
    });
    expectThrows(MockSetupError, "A reverted transaction has no logs.", () => {
      write.returns({ status: "reverted", logs: [testLog("noise")] });
    });
    expectThrows(MockSetupError, "Only a deploy (to: null) has a contractAddress.", () => {
      write.returns({ contractAddress: USDC });
    });
    expectThrows(MockSetupError, /^A send's log 0 isn't a log; got \{ eventName: Transfer/u, () => {
      // @ts-expect-error -- not a log
      write.returns({ logs: [{ eventName: "Transfer", args: { to: alice, value: 1n } }] });
    });
    expectThrows(InvalidAddressError, /Address "0x12" is invalid/u, () => {
      write.emits([{ address: "0x12", topics: [], data: "0x" }]);
    });
    expectThrows(MockSetupError, "Expected an object for a send's outcome; got true.", () => {
      // @ts-expect-error -- a `write` mock answers an outcome, not a return value
      write.returns(true);
    });
    expectThrows(
      MockSetupError,
      '"balanceOf" is a view function; register it under read, not write.',
      () => {
        // @ts-expect-error -- `balanceOf` is a view: it's on read, not write
        usdc.write.balanceOf(); // oxlint-disable-line typescript/no-unsafe-call -- untyped caller, on purpose
      },
    );
  });

  test("a resolver's log with an invalid address is refused at the send, as viem's error", async () => {
    const { mock, usdc, transfer } = setup();
    usdc.write.transfer().returns(() => ({ logs: [{ address: "0x12", topics: [], data: "0x" }] }));

    const error = await rejectionOf(transfer());

    expectCause(error, MockResolverError);
    expect(expectCause(error, InvalidAddressError).shortMessage).toBe('Address "0x12" is invalid.');
    expect(mock.transactions).toEqual([]);
  });

  test("a resolver's outcome is checked at the send, changing nothing", async () => {
    const { mock, usdc, transfer } = setup();
    usdc.write.transfer().returns(() => ({ status: "reverted", logs: [testLog("noise")] }));

    const error = await rejectionOf(transfer());

    expect(expectCause(error, MockSetupError).shortMessage).toBe(
      "A reverted transaction has no logs.",
    );
    expect(mock.transactions).toEqual([]);
  });

  test.each([
    {
      name: "a contractAddress",
      outcome: { contractAddress: USDC },
      message: "Only a deploy (to: null) has a contractAddress.",
    },
    {
      name: "a log without an address",
      outcome: { logs: [{ topics: [], data: "0x" }] },
      message: "A send's log 0 isn't a log; got { topics: [], data: 0x }.",
    },
    {
      name: "a log whose topics aren't a list",
      outcome: { logs: [{ address: USDC, topics: 5, data: "0x" }] },
      message: `A send's log 0 isn't a log; got { address: ${USDC}, topics: 5, data: 0x }.`,
    },
    {
      name: "logs that aren't a list",
      outcome: { logs: 5 },
      message: "A send's logs must be a list; got 5.",
    },
    {
      name: "a value that isn't an outcome",
      outcome: true,
      message: "Expected an object for a send's outcome; got true.",
    },
  ])("a resolver's outcome with $name is refused at the send", async ({ outcome, message }) => {
    const { mock, usdc, transfer } = setup();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what an untyped resolver might return
    usdc.write.transfer().returns(() => outcome as never);

    const error = await rejectionOf(transfer());

    expect(expectCause(error, MockSetupError).shortMessage).toBe(message);
    expect(mock.transactions).toEqual([]);
  });

  test("adding a transaction in a write's resolver is refused, pointing at returning its logs", async () => {
    const { mock, usdc, transfer } = setup();
    usdc.write.transfer().returns(() => {
      usdc.emit.Transfer({ from: alice, to: bob, value: 1n });
    });
    // An async resolver is refused too, up to its first await.
    mock.actions.sendTransaction({ to: bob }).returns(async () => {
      mock.addTransaction({ logs: [testLog("noise")] });
      await Promise.resolve();
    });

    const errors = [
      await rejectionOf(transfer()),
      await rejectionOf(
        createWalletClient({
          account: signer,
          chain: mock.chain,
          transport: mock.transport(),
        }).sendTransaction({ to: bob }),
      ),
    ];

    for (const error of errors) {
      const refused = expectCause(error, MockSetupError);
      expect(refused.shortMessage).toBe(
        "mock.addTransaction() and contract.emit can't run while a send mock's resolver answers a send.",
      );
      expect(refused.metaMessages).toEqual([
        "They would place a transaction of their own, mid-send.",
        "For the send's own logs, return them from the resolver: return { logs: [contract.events.Transfer(args)] }.",
      ]);
    }
    expect(mock.transactions).toEqual([]);
    mock.addTransaction({ logs: [testLog("noise")] });
    expect(mock.transactions).toHaveLength(1);
  });
});

describe("adding a transaction while a write's resolver waits", () => {
  test("is the app's own: only a resolver's body is refused", async () => {
    const { mock, usdc, transfer } = setup();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    usdc.write.transfer().returns(async () => {
      await gate;
    });

    const sent = transfer();
    await vi.waitFor(() => {
      expect(usdc.write.transfer.calls).toHaveLength(1);
    });
    // A demo's ticker adds one while the send is pending.
    mock.addTransaction({ logs: [testLog("tick")] });
    release();
    await sent;

    expect(mock.transactions.map(({ origin }) => origin)).toEqual(["added", "sent"]);
  });
});

describe("a send mock's resolver", () => {
  test("answers with its outcome's logs, or reverts with revert()", async () => {
    const { mock, client, wallet } = setup();
    mock.actions.sendTransaction({ to: bob }).returns(({ value, revert }) => {
      if (value > 1n) revert("too much");
      return { logs: [testLog("paid")] };
    });

    const paid = await wallet.sendTransaction({ to: bob, value: 1n });
    const reverted = await wallet.sendTransaction({ to: bob, value: 2n });

    expect((await client.getTransactionReceipt({ hash: paid })).logs).toHaveLength(1);
    expect(await client.getTransactionReceipt({ hash: reverted })).toMatchObject({
      status: "reverted",
      logs: [],
    });
  });
});

describe("state the test owns (controlled mocks)", () => {
  const tokenAbi = [
    ...erc20Abi,
    ...parseAbi([
      "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
    ]),
  ] as const;
  // setup() registers USDC with viem's erc20Abi, which has no errors.
  const TOKEN = testAddress("token");

  /**
   * The docs' example: balances in a closure, read by `balanceOf`, changed only
   * by `transfer`.
   */
  function ledger() {
    const { mock, client, wallet, from: sender } = setup();
    const token = mock.contract({ abi: tokenAbi, address: TOKEN, name: "Token" });
    const balances = new Map([[sender, 10n]]);
    token.read.balanceOf().returns(({ args: [who] }) => balances.get(who) ?? 0n);
    token.write.transfer().returns(({ from, args: [to, amount], revert }) => {
      const have = balances.get(from) ?? 0n;
      if (have < amount)
        revert({ errorName: "ERC20InsufficientBalance", args: [from, have, amount] });
      balances.set(from, have - amount);
      balances.set(to, (balances.get(to) ?? 0n) + amount);
      return { logs: [token.events.Transfer({ from, to, value: amount })] };
    });
    const balanceOf = (who: Address) =>
      client.readContract({
        address: TOKEN,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [who],
      });
    const transfer = (amount: bigint) =>
      wallet.writeContract({
        address: TOKEN,
        abi: tokenAbi,
        functionName: "transfer",
        args: [bob, amount],
      });
    return { mock, client, token, balances, sender, balanceOf, transfer };
  }

  test("a transfer moves the balances its reads answer, once, though it's estimated first", async () => {
    const { mock, client, token, sender, balanceOf, transfer } = ledger();

    const hash = await transfer(4n);

    expect(await client.waitForTransactionReceipt({ hash, pollingInterval: 10 })).toMatchObject({
      status: "success",
      logs: [{ address: TOKEN.toLowerCase() }],
    });
    expect([await balanceOf(sender), await balanceOf(bob)]).toEqual([6n, 4n]);
    // The implied estimate didn't run the resolver: the balances moved once.
    expect(sentMethods(mock)).toEqual(["eth_estimateGas", "eth_sendRawTransaction"]);
    expect(
      await client.getContractEvents({ abi: tokenAbi, address: TOKEN, eventName: "Transfer" }),
    ).toMatchObject([{ args: { from: sender, to: bob, value: 4n } }]);
    expect(token.write.transfer.calls).toHaveLength(1);
  });

  test("a transfer over the balance is mined reverted and changes nothing", async () => {
    const { mock, client, sender, balanceOf, transfer } = ledger();

    // The resolver runs only at the send, so its revert isn't the estimate's: it's mined reverted.
    const hash = await transfer(11n);

    expect(await client.waitForTransactionReceipt({ hash, pollingInterval: 10 })).toMatchObject({
      status: "reverted",
      logs: [],
    });
    expect([await balanceOf(sender), await balanceOf(bob)]).toEqual([10n, 0n]);
    expect(mock.transactions).toMatchObject([{ hash, origin: "sent" }]);
  });

  test("an estimate that reads the closure makes an overdraft throw before it's sent", async () => {
    const { mock, token, balances, sender, balanceOf, transfer } = ledger();
    token.estimateGas.transfer().returns(({ from = zeroAddress, args: [, amount], revert }) => {
      const have = balances.get(from) ?? 0n;
      if (have < amount)
        revert({ errorName: "ERC20InsufficientBalance", args: [from, have, amount] });
      return 50_000n;
    });

    const error = await rejectionOf(transfer(11n));

    expect(expectCause(error, ContractFunctionRevertedError).data?.errorName).toBe(
      "ERC20InsufficientBalance",
    );
    expect(mock.transactions).toEqual([]);
    expect(await balanceOf(sender)).toBe(10n);
    await transfer(4n);
    expect(await balanceOf(sender)).toBe(6n);
  });

  test("a resolver's revert() undoes nothing it changed before it", async () => {
    const { mock, client, wallet } = setup();
    const token = mock.contract({ abi: tokenAbi, address: TOKEN });
    let transfers = 0;
    let after = false;
    token.write.transfer().returns(({ revert }) => {
      transfers += 1;
      revert("paused");
      after = true;
    });

    const hash = await wallet.writeContract({
      address: TOKEN,
      abi: tokenAbi,
      functionName: "transfer",
      args: [bob, 1n],
    });

    expect(transfers).toBe(1);
    expect(after).toBe(false);
    expect((await client.getTransactionReceipt({ hash })).status).toBe("reverted");
  });

  test("a native balance: getBalance reads the closure, and a payable write changes it", async () => {
    const { mock, client, wallet, from: sender } = setup();
    const vault = mock.contract({ abi: vaultAbi, address: VAULT, name: "Vault" });
    const native = new Map([[sender, 10n]]);
    mock.actions.getBalance().returns(({ address }) => native.get(address) ?? 0n);
    vault.write.deposit().returns(({ from, value }) => {
      native.set(from, (native.get(from) ?? 0n) - value);
      native.set(VAULT, (native.get(VAULT) ?? 0n) + value);
    });

    await wallet.writeContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: "deposit",
      value: 3n,
    });
    // Nothing moves ETH but the test: a plain transfer, unmocked, changes no balance.
    await wallet.sendTransaction({ to: bob, value: 1n });

    expect(await client.getBalance({ address: sender })).toBe(7n);
    expect(await client.getBalance({ address: VAULT })).toBe(3n);
    expect(await client.getBalance({ address: bob })).toBe(0n);
  });
});

describe("writes in history", () => {
  test("a local account's whole write: fill refused, nonce, block, tip, estimate, send", async () => {
    const { mock, usdc, transfer } = setup();
    usdc.write
      .transfer([bob, 5n])
      .emits([usdc.events.Transfer({ from: signer.address, to: bob, value: 5n })]);

    await transfer();

    expect(mock.formatHistory()).toBe(
      [
        "#1 eth_fillTransaction({ data: 0xa905…0005, from: 0x6E12…6bd2, to: 0x99d9…bfC7 }) ✗ rpc error -32601: the method eth_fillTransaction does not exist/is not available",
        "#2 eth_getTransactionCount getTransactionCount({ address: 0x6E12…6bd2, blockNumber: 10n, blockTag: pending }) → 0",
        "#3 eth_getBlockByNumber getBlock({ blockNumber: 10n, blockTag: latest, includeTransactions: false }) → block 10n, timestamp 1700000000n",
        "#4 eth_maxPriorityFeePerGas estimateMaxPriorityFeePerGas() → 1000000000n",
        "#5 eth_estimateGas estimateGas USDC.transfer(0x4292…207f, 5n) → 100000n",
        "#6 eth_sendRawTransaction write USDC.transfer(0x4292…207f, 5n) → 0xa4a9…c417 (mined in block 11n, 1 log)",
      ].join("\n"),
    );
  });

  test("a mined revert is a hash, mined reverted; a refused send is its refusal", async () => {
    const { mock, usdc, transfer } = setup("node");
    usdc.write.transfer([bob, 5n]).returns({ status: "reverted" });
    usdc.write.transfer([bob, 6n]).reverts();
    usdc.write.transfer([bob, 7n]).refuses("nonceTooLow");
    usdc.write.transfer([bob, 8n]).returns();

    await transfer(5n);
    await transfer(6n);
    await rejectionOf(transfer(7n));
    await transfer(8n);
    await rejectionOf(transfer(9n));

    expect(mock.formatHistory({ builtIns: false })).toBe(
      [
        "#2 eth_sendTransaction write USDC.transfer(0x4292…207f, 5n) → 0x340f…155f (mined in block 11n, reverted)",
        "#4 eth_sendTransaction write USDC.transfer(0x4292…207f, 6n) → 0x7bff…b2a9 (mined in block 12n, reverted)",
        "#6 eth_sendTransaction write USDC.transfer(0x4292…207f, 7n) ✗ refused: nonceTooLow",
        // viem tries the wallet's method after a node's refusal.
        "#7 wallet_sendTransaction({ data: 0xa905…0007, from: 0xa41f…2D9e, to: 0x99d9…bfC7 }) ✗ rpc error -32601: the method wallet_sendTransaction does not exist/is not available",
        "#9 eth_sendTransaction write USDC.transfer(0x4292…207f, 8n) → 0x3b1a…6563 (mined in block 13n, 0 logs)",
        "#11 eth_sendTransaction write USDC.transfer(0x4292…207f, 9n) ✗ not mocked",
      ].join("\n"),
    );
  });

  test("a write its mock answers but that can't be placed is recorded as the refusal, on the entry and the contract's record", async () => {
    const { mock, usdc, wallet } = setup();
    usdc.write.transfer().returns();
    const raw = await wallet.signTransaction(
      await wallet.prepareTransactionRequest({
        to: USDC,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [bob, 5n] }),
      }),
    );
    mock.addTransaction({ logs: [testLog("noise")], hash: keccak256(raw), blockNumber: 15n });

    const error = await rejectionOf(
      mock.request({ method: "eth_sendRawTransaction", params: [raw] }),
    );

    const refused = expectCause(error, MockSetupError);
    expect(refused.shortMessage).toContain("is already in mock.transactions");
    const outcome = { type: "unhandled", error: refused };
    expect(mock.history.at(-1)).toMatchObject({
      method: "eth_sendRawTransaction",
      outcome,
      contract: { namespace: "write", call: { functionName: "transfer" }, outcome },
    });
  });

  test("a send to no contract is its call, with where it was mined", async () => {
    const { mock, wallet } = setup("node");

    await wallet.sendTransaction({ to: bob, value: 1n });

    expect(mock.formatHistory({ builtIns: false })).toBe(
      "#2 eth_sendTransaction sendTransaction({ from: 0xa41f…2D9e, to: 0x4292…207f, value: 1n, type: eip1559 }) → 0x340f…155f (mined in block 11n, 0 logs)",
    );
  });

  test("mock.transactions is state: past historyLimit and after clearCalls(), every send is kept", async () => {
    const mock = createMockRpc({ blockNumber: 10n, historyLimit: 2 });
    const wallet = createWalletClient({
      account: alice,
      chain: mock.chain,
      transport: mock.transport({ retryCount: 0 }),
    });

    await wallet.sendTransaction({ to: bob, value: 1n });
    await wallet.sendTransaction({ to: bob, value: 2n });

    expect(mock.formatHistory({ builtIns: false })).toBe(
      [
        "(2 older requests dropped, past historyLimit)",
        "#4 eth_sendTransaction sendTransaction({ from: 0xa41f…2D9e, to: 0x4292…207f, value: 2n, type: eip1559 }) → 0x7bff…b2a9 (mined in block 12n, 0 logs)",
      ].join("\n"),
    );
    mock.clearCalls();
    expect(mock.history).toEqual([]);
    expect(mock.transactions.map(({ fields }) => fields.value)).toEqual([1n, 2n]);
  });

  test("a failed check on a write test ends with the write's lines", async () => {
    const { mock, usdc, transfer } = setup();
    usdc.write.transfer([bob, 5n]).returns();
    usdc.write.transfer([bob, 6n]).returns();

    await transfer(5n);

    expectThrows(
      MockCheckError,
      [
        "1 mock(s) answered no call:",
        `  - transfer(${bob}, 6n) on USDC (${USDC})`,
        "    received 1 call to transfer:",
        "      transfer(…, 5n)  ← amount didn't match",
        "",
        "Requests so far:",
        "#1 eth_fillTransaction({ data: 0xa905…0005, from: 0x6E12…6bd2, to: 0x99d9…bfC7 }) ✗ rpc error -32601: the method eth_fillTransaction does not exist/is not available",
        "#2 eth_getTransactionCount getTransactionCount({ address: 0x6E12…6bd2, blockNumber: 10n, blockTag: pending }) → 0",
        "#3 eth_getBlockByNumber getBlock({ blockNumber: 10n, blockTag: latest, includeTransactions: false }) → block 10n, timestamp 1700000000n",
        "#4 eth_maxPriorityFeePerGas estimateMaxPriorityFeePerGas() → 1000000000n",
        "#5 eth_estimateGas estimateGas USDC.transfer(0x4292…207f, 5n) → 100000n",
        "#6 eth_sendRawTransaction write USDC.transfer(0x4292…207f, 5n) → 0xa4a9…c417 (mined in block 11n, 0 logs)",
      ].join("\n"),
      () => {
        mock.assertAllUsed();
      },
    );
  });
});
