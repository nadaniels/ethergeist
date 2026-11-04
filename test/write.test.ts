import {
  type Address,
  ContractFunctionRevertedError,
  InsufficientFundsError,
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
  MockNotFoundError,
  MockResolverError,
  MockSetupError,
  createMockRpc,
  testAddress,
  testLog,
} from "../src/index.js";
import { expectCause, hintsOf, rejectionOf } from "./utils.js";

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

/** The app's clients: a local account, which signs and sends raw bytes, or a node's (JSON-RPC) account. */
function setup(account: "local" | "node" = "local") {
  const mock = createMockRpc({ blockNumber: 10n });
  const client = mock.publicClient({}, { retryCount: 0 });
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
  mock.requests
    .map(({ method }) => method)
    .filter((method) => method === "eth_estimateGas" || method.startsWith("eth_send"));

describe("a write mock", () => {
  test.each(["local", "node"] as const)(
    "is all a %s account's writeContract and waitForTransactionReceipt need",
    async (account) => {
      const { mock, client, usdc, from, transfer } = setup(account);
      const log = usdc.events.Transfer({ from, to: bob, value: 5n });
      usdc.write.transfer([bob, 5n]).emits([log]);

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
      expect(mock.actions.sendTransaction.calls).toMatchObject([{ account: from, to: USDC }]);
      expect(mock.transactions).toMatchObject([{ hash, origin: "write" }]);
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

  test("a resolver gets the call and answers with its emit(), its outcome, or both", async () => {
    const { usdc, mock, transfer } = setup();
    const resolver = vi.fn(
      ({
        from,
        args: [to, value],
        emit,
      }: {
        from: `0x${string}`;
        args: readonly [`0x${string}`, bigint];
        emit: (logs: ReturnType<typeof usdc.events.Transfer>) => void;
      }) => {
        emit(usdc.events.Transfer({ from, to, value }));
        if (value > 6n) return { gasUsed: 2n };
        return value > 5n ? { logs: [testLog("noise")], gasUsed: 1n } : undefined;
      },
    );
    usdc.write.transfer().returns(resolver);

    await transfer(5n);
    await transfer(6n);
    await transfer(7n);

    expect(resolver).toHaveBeenCalledTimes(3);
    expect(resolver.mock.calls[0]![0]).toMatchObject({
      from: signer.address,
      functionName: "transfer",
      args: [bob, 5n],
      value: 0n,
    });
    expect(mock.transactions.map(({ logs }) => logs.length)).toEqual([1, 2, 1]);
    expect(mock.transactions.map(({ receipt }) => receipt.gasUsed)).toEqual([undefined, 1n, 2n]);
  });

  test("a payable write's value and an overload, by its args", async () => {
    const { mock, client, wallet, from } = setup();
    const vault = mock.contract({ abi: vaultAbi, address: VAULT });
    vault.write.deposit().returns(({ value, emit }) => {
      emit(vault.events.Deposit({ from, value }));
    });
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

    // Each send is estimated first; the estimates use nothing up.
    await transfer(1n);
    await transfer(2n);
    await transfer(3n);

    // Limited mocks answer oldest first.
    expect(mock.transactions.map(({ receipt }) => receipt.gasUsed)).toEqual([1n, 2n, 2n]);
    await expect(transfer(4n)).rejects.toThrow(/No estimateGas mock for transfer/u);
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

  test("answers before a send mock for the same to, which answers what it doesn't", async () => {
    const { mock, usdc, transfer } = setup();
    mock.actions.sendTransaction({ to: USDC }).returns({ gasUsed: 1n });
    usdc.write.transfer([bob, 5n]).returns({ gasUsed: 2n });

    await transfer(5n);
    await transfer(6n);

    expect(mock.transactions.map(({ receipt }) => receipt.gasUsed)).toEqual([2n, 1n]);
    // The contract still had its turn at the second.
    expect(usdc.write.transfer.calls).toHaveLength(2);
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
    expect(() => {
      mock.assertAllUsed();
    }).toThrow(/transfer\(.*\) once on USDC .*\n.*received no calls to transfer/u);
  });

  test("an estimateGas mock, defaults.estimateGas or an estimate action mock answers first", async () => {
    const mock = createMockRpc({ blockNumber: 10n });
    const client = mock.publicClient({}, { retryCount: 0 });
    const usdc = mock.contract({
      abi: erc20Abi,
      address: USDC,
      defaults: { estimateGas: { approve: 3n } },
    });
    usdc.write.transfer().returns();
    usdc.write.approve().returns();
    usdc.write.transferFrom().returns();
    usdc.estimateGas.transfer().returns(1n);
    mock.actions
      .estimateGas({
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transferFrom",
          args: [alice, bob, 1n],
        }),
      })
      .returns(2n);
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
    ).toBe(2n);
  });

  test("follows the write mock over a send mock for the same to", async () => {
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
    expect(
      await client.estimateContractGas({
        account: alice,
        address: USDC,
        abi: erc20Abi,
        functionName: "transfer",
        args: [bob, 6n],
      }),
    ).toBe(100_000n);
  });

  test("a used-up write mock implies nothing", async () => {
    const { usdc, transfer } = setup();
    usdc.write.transfer().once().returns();

    await transfer();
    const error = await rejectionOf(transfer());

    // The estimate finds no mock, so nothing is sent.
    const notFound = expectCause(error, MockNotFoundError);
    expect(notFound.shortMessage).toMatch(/^No estimateGas mock for transfer/u);
    expect(hintsOf(notFound)).toBe(
      `No estimateGas mocks registered for "transfer"; a write mock that matches the send ` +
        "implies one, and a simulate mock doesn't answer estimates.",
    );
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

  test("a resolver's revert() mines it reverted, dropping what it emitted; its estimate passes", async () => {
    const { mock, client, usdc, transfer } = setup();
    usdc.write.transfer().returns(({ from, args: [to, value], emit, revert }) => {
      emit(usdc.events.Transfer({ from, to, value }));
      if (value > 5n) revert("too much");
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
    "a node's refusal, by .fails() or a resolver's fail(), changes nothing (%s account)",
    async (account) => {
      const { mock, usdc, transfer } = setup(account);
      usdc.write.transfer([bob, 5n]).fails("insufficientFunds");
      usdc.write.transfer([bob, 6n]).returns(({ fail }) => fail("insufficientFunds"));

      expectCause(await rejectionOf(transfer(5n)), InsufficientFundsError);
      expectCause(await rejectionOf(transfer(6n)), InsufficientFundsError);

      expect(mock.transactions).toEqual([]);
      expect(mock.blockNumber).toBe(10n);
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

    expect(() => {
      // @ts-expect-error -- the transaction's hash comes from where it's mined
      write.returns({ transactionHash: "0x12" });
    }).toThrow("A write's outcome has no transactionHash.");
    expect(() => {
      write.returns({ status: "reverted", logs: [testLog("noise")] });
    }).toThrow("A reverted transaction has no logs.");
    expect(() => {
      write.returns({ contractAddress: USDC });
    }).toThrow("Only a deploy (to: null) has a contractAddress.");
    expect(() => {
      // @ts-expect-error -- a write answers with its outcome; the return value goes on simulate
      write.returns(true);
    }).toThrow("A write's outcome must be an object; got true.");
    expect(() => {
      // @ts-expect-error -- a view isn't written
      usdc.write.balanceOf(); // oxlint-disable-line typescript/no-unsafe-call -- untyped caller, on purpose
    }).toThrow('"balanceOf" is a view function; register it under read, not write.');
  });

  test("a resolver's outcome is checked at the send, changing nothing", async () => {
    const { mock, usdc, transfer } = setup();
    usdc.write.transfer().returns(({ emit }) => {
      emit(testLog("noise"));
      return { status: "reverted" };
    });

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
      name: "a value that isn't an outcome, after emit()",
      outcome: true,
      message: "A write's outcome must be an object; got true.",
    },
  ])("a resolver's outcome with $name is refused at the send", async ({ outcome, message }) => {
    const { mock, usdc, transfer } = setup();
    usdc.write.transfer().returns(({ emit }) => {
      emit(testLog("noise"));
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what an untyped resolver might return
      return outcome as never;
    });

    const error = await rejectionOf(transfer());

    expect(expectCause(error, MockSetupError).shortMessage).toBe(message);
    expect(mock.transactions).toEqual([]);
  });

  test("mock.emit() in a write's resolver is refused, pointing at the resolver's emit()", async () => {
    const { mock, usdc, transfer } = setup();
    usdc.write.transfer().returns(() => {
      usdc.emit.Transfer({ from: alice, to: bob, value: 1n });
    });
    // An async resolver is refused too, up to its first await.
    mock.actions.sendTransaction({ to: bob }).returns(async () => {
      mock.emit(testLog("noise"));
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
        "emit() can't run while a write's resolver answers a send.",
      );
      expect(hintsOf(refused)).toMatch(/^Use the resolver's emit\(\)/u);
    }
    expect(mock.transactions).toEqual([]);
    // Once the resolver is done, emit() works again.
    mock.emit(testLog("noise"));
    expect(mock.transactions).toHaveLength(1);
  });
});

describe("emit() while a write's resolver waits", () => {
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
    // A demo's ticker emits while the send is pending.
    mock.emit(testLog("tick"));
    release();
    await sent;

    expect(mock.transactions.map(({ origin }) => origin)).toEqual(["emit", "write"]);
  });
});

describe("a send mock's resolver", () => {
  test("gets emit() and revert() too", async () => {
    const { mock, client, wallet } = setup();
    mock.actions.sendTransaction({ to: bob }).returns(({ value, emit, revert }) => {
      emit(testLog("paid"));
      if (value > 1n) revert("too much");
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

  /** The docs' example: balances in a closure, read by `balanceOf`, changed only by `transfer`. */
  function ledger() {
    const { mock, client, wallet, from: sender } = setup();
    const token = mock.contract({ abi: tokenAbi, address: TOKEN, name: "Token" });
    const balances = new Map([[sender, 10n]]);
    token.read.balanceOf().returns(({ args: [who] }) => balances.get(who) ?? 0n);
    token.write.transfer().returns(({ from, args: [to, amount], emit, revert }) => {
      const have = balances.get(from) ?? 0n;
      if (have < amount)
        revert({ errorName: "ERC20InsufficientBalance", args: [from, have, amount] });
      emit(token.events.Transfer({ from, to, value: amount }));
      balances.set(from, have - amount);
      balances.set(to, (balances.get(to) ?? 0n) + amount);
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
    expect(mock.transactions).toMatchObject([{ hash, origin: "write" }]);
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
    // Within the balance, the estimate answers and the write moves it.
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
