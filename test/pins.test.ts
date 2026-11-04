import {
  type Abi,
  type Address,
  InvalidAddressError,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  erc20Abi,
  parseAbi,
} from "viem";
import { mainnet } from "viem/chains";
import { describe, expect, test, vi } from "vite-plus/test";

import {
  MockCheckError,
  MockNotFoundError,
  MockSetupError,
  createMockRpc,
  match,
  testAddress,
} from "../src/index.js";
import { expectCause, expectThrows, hintsOf, lowercase, rejectionOf } from "./utils.js";

const alice = testAddress("alice");
const bob = testAddress("bob");
const carol = testAddress("carol");
const USDC = testAddress("usdc");
const VAULT = testAddress("vault");

const vaultAbi = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256 amount)",
  "function withdraw(uint256 amount, address to)",
  "function owner() view returns (address)",
]);

function setup() {
  const mock = createMockRpc({ blockNumber: 10n });
  const client = mock.publicClient({}, { retryCount: 0 });
  const usdc = mock.contract({ abi: erc20Abi, address: USDC, name: "USDC" });
  const vault = mock.contract({ abi: vaultAbi, address: VAULT, name: "Vault" });
  const walletOf = (account: typeof alice) =>
    createWalletClient({
      account,
      chain: mock.chain,
      transport: mock.transport({ retryCount: 0 }),
    });
  const balanceOf = (account?: typeof alice) =>
    client.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [bob],
      ...(account && { account }),
    });
  return { mock, client, usdc, vault, walletOf, balanceOf };
}

describe("pinning from", () => {
  test("a read answers only its sender; a more specific pin wins whatever the order", async () => {
    const { usdc, balanceOf } = setup();
    usdc.read.balanceOf([bob], { from: alice }).returns(5n);
    usdc.read.balanceOf([bob]).returns(1n);

    expect(await balanceOf(alice)).toBe(5n);
    expect(await balanceOf(carol)).toBe(1n);
  });

  test("a read without an account sends no from, which a pinned from doesn't match", async () => {
    const { mock, usdc, balanceOf } = setup();
    const isAlice = vi.fn(() => true);
    usdc.read.balanceOf([bob], { from: match.where(isAlice, "isAlice") }).returns(5n);

    const error = await rejectionOf(balanceOf());

    expect(mock.requests[0]?.params).toEqual([
      {
        to: USDC,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [bob] }),
      },
      "latest",
    ]);
    expect(isAlice).not.toHaveBeenCalled();
    const miss = expectCause(error, MockNotFoundError);
    expect(miss.shortMessage).toBe(
      `No mock for balanceOf(${bob}) { from: undefined } on USDC (${USDC}).`,
    );
    expect(hintsOf(miss)).toBe(
      `Registered:\n  balanceOf(${bob}) { from: where(isAlice) }  ← { from } didn't match`,
    );
  });

  test("its reason is braced, apart from an input named from", async () => {
    const mock = createMockRpc({ blockNumber: 10n });
    const client = mock.publicClient({}, { retryCount: 0 });
    const abi = parseAbi(["function pull(address from, uint256 value) view returns (bool)"]);
    const token = mock.contract({ abi, address: USDC });
    token.read.pull([alice, 1n]).returns(true);
    token.read.pull([bob, 1n], { from: alice }).returns(true);

    const error = await rejectionOf(
      client.readContract({ abi, address: USDC, functionName: "pull", args: [bob, 1n] }),
    );

    expect(hintsOf(expectCause(error, MockNotFoundError))).toBe(
      [
        "Registered:",
        `  pull(${alice}, 1n)  ← from didn't match`,
        `  pull(${bob}, 1n) { from: ${alice} }  ← { from } didn't match`,
      ].join("\n"),
    );
  });

  test("is compared checksummed: a lowercase from matches, and predicates get it checksummed", async () => {
    const { mock, usdc } = setup();
    const seen = vi.fn<(from: Address) => boolean>(() => true);
    usdc.read.balanceOf([bob], { from: lowercase(alice) }).returns(5n);
    usdc.read.balanceOf([carol], { from: match.where(seen) }).returns(6n);
    const call = (who: typeof bob) =>
      mock.request({
        method: "eth_call",
        params: [
          {
            from: lowercase(alice),
            to: USDC,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [who] }),
          },
        ],
      });

    expect(await call(bob)).toBe(`0x${"5".padStart(64, "0")}`);
    await call(carol);

    expect(seen).toHaveBeenCalledWith(alice);
    expect(usdc.read.balanceOf.calls.map(({ from }) => from)).toEqual([alice, alice]);
  });

  test("a multicall's sub-call is from Multicall3, not the batch's sender", async () => {
    const mock = createMockRpc();
    const client = createPublicClient({ chain: mainnet, transport: mock.transport() });
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    const multicall3 = getAddress(mainnet.contracts.multicall3.address);
    usdc.read.balanceOf([bob], { from: alice }).returns(5n);
    usdc.read.balanceOf([bob], { from: multicall3 }).returns(7n);

    const [balance] = await client.multicall({
      account: alice,
      contracts: [{ abi: erc20Abi, address: USDC, functionName: "balanceOf", args: [bob] }],
      allowFailure: false,
    });

    expect(balance).toBe(7n);
    expect(usdc.read.balanceOf.calls[0]).toMatchObject({
      from: multicall3,
      batch: { from: alice },
    });
  });

  test("on a write: any args from this sender, beside a mock for all senders", async () => {
    const { usdc, walletOf } = setup();
    const fromAlice = vi.fn(() => {});
    // Registered first, so it wins on its rank, not as the most recent.
    usdc.write.transfer([bob, 5n]).returns();
    usdc.write.transfer(undefined, { from: alice }).returns(fromAlice);
    const transfer = (account: typeof alice, amount: bigint) =>
      walletOf(account).writeContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "transfer",
        args: [bob, amount],
      });

    await transfer(alice, 6n);
    // Pinned args (2) beat a pinned sender alone (1).
    await transfer(alice, 5n);
    const error = await rejectionOf(transfer(carol, 6n));

    expect(fromAlice).toHaveBeenCalledTimes(1);
    expect(hintsOf(expectCause(error, MockNotFoundError))).toBe(
      [
        "Registered:",
        `  transfer(${bob}, 5n)  ← amount didn't match`,
        `  transfer(*) { from: ${alice} }  ← { from } didn't match`,
      ].join("\n"),
    );
  });

  test("at equal specificity, the most recent wins; a limited one queues first", async () => {
    const { usdc, balanceOf } = setup();
    usdc.read.balanceOf([bob], { from: match.any() }).returns(1n);
    usdc.read.balanceOf([match.any()], { from: alice }).returns(2n);
    usdc.read.balanceOf([bob]).returns(3n);

    expect(await balanceOf(alice)).toBe(3n);

    usdc.read.balanceOf([bob], { from: alice }).once().returns(4n);
    expect(await balanceOf(alice)).toBe(4n);
    expect(await balanceOf(alice)).toBe(3n);
  });

  test("match.any() as a from adds nothing to pinned args' rank, and needs a from", async () => {
    const { usdc, balanceOf } = setup();
    usdc.read.balanceOf([bob], { from: match.any() }).returns(1n);
    usdc.read.balanceOf([bob]).returns(2n);

    expect(await balanceOf(alice)).toBe(2n);
    usdc.read.balanceOf([bob], { from: match.any() }).returns(3n);
    expect(await balanceOf(alice)).toBe(3n);
    expect(await balanceOf()).toBe(2n);
  });
});

describe("pinning value", () => {
  test("a payable write answers the value it's pinned to, or a predicate's", async () => {
    const { vault, walletOf } = setup();
    vault.write.deposit([], { value: 1n }).returns({ status: "reverted" });
    vault.write.deposit([], { value: match.where((value) => value > 1n, "large") }).returns();
    const deposit = (value: bigint) =>
      walletOf(alice).writeContract({
        address: VAULT,
        abi: vaultAbi,
        functionName: "deposit",
        value,
      });

    expect(await deposit(2n)).toMatch(/^0x/u);
    expect(await deposit(1n)).toMatch(/^0x/u);
    const error = await rejectionOf(deposit(0n));

    expect(hintsOf(expectCause(error, MockNotFoundError))).toBe(
      [
        "Registered:",
        "  deposit() { value: 1n }  ← { value } didn't match",
        "  deposit() { value: where(large) }  ← { value } didn't match",
      ].join("\n"),
    );
  });

  test("0n matches a call that sends no value", async () => {
    const { vault, client } = setup();
    vault.simulate.deposit([], { value: 0n }).returns();

    await client.simulateContract({
      account: alice,
      address: VAULT,
      abi: vaultAbi,
      functionName: "deposit",
    });

    expect(vault.simulate.deposit.calls).toMatchObject([{ value: 0n }]);
  });

  test("an estimate pins from and value both", async () => {
    const { vault, client } = setup();
    vault.estimateGas.deposit(undefined, { from: alice, value: 1n }).returns(30_000n);
    vault.estimateGas.deposit().returns(40_000n);
    const estimate = (account: typeof alice, value: bigint) =>
      client.estimateContractGas({
        account,
        address: VAULT,
        abi: vaultAbi,
        functionName: "deposit",
        value,
      });

    expect(await estimate(alice, 1n)).toBe(30_000n);
    expect(await estimate(alice, 2n)).toBe(40_000n);
    expect(await estimate(bob, 1n)).toBe(40_000n);
  });

  test("a value alone matches an estimate without an account", async () => {
    const { vault, client } = setup();
    vault.estimateGas.deposit(undefined, { value: 1n }).returns(30_000n);

    expect(
      await client.estimateContractGas({
        address: VAULT,
        abi: vaultAbi,
        functionName: "deposit",
        value: 1n,
      }),
    ).toBe(30_000n);
  });

  test("a nonpayable function takes none, even through a loose ABI or a payable overload", () => {
    const { mock } = setup();
    const loose: Abi = vaultAbi;
    const vault = mock.contract({ abi: loose, address: testAddress("loose") });

    expect(() => vault.write.withdraw?.([1n], { value: 1n })).toThrow(
      new MockSetupError(
        '"withdraw" is nonpayable, so it takes no value; only a payable function\'s mock pins one.',
      ),
    );
    expectThrows(MockSetupError, /"owner" is view/u, () =>
      vault.read.owner?.(undefined, { value: 0n }),
    );
    expect(() => vault.write.deposit?.([], { value: 1n })).not.toThrow();
    const mixed = mock.contract({
      abi: parseAbi(["function f(uint256) payable", "function f(uint256, address)"]),
      address: testAddress("mixed"),
    });
    expectThrows(MockSetupError, /"f" is nonpayable/u, () =>
      mixed.write.f([1n, alice], { value: 1n }),
    );
    expect(() => mixed.write.f([1n], { value: 1n })).not.toThrow();
  });
});

describe("pins at registration", () => {
  test("are refused when malformed", () => {
    const { usdc } = setup();
    const pins = (given: unknown) => () =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what a JavaScript caller can pass
      usdc.read.balanceOf([bob], given as { from: never });

    expect(pins({ account: alice })).toThrow(
      new MockSetupError("A mock pins from and value, not account.", {
        metaMessages: ["Pin the sender as from, e.g. { from: alice }."],
      }),
    );
    expectThrows(
      MockSetupError,
      /^from takes an address or a matcher/u,
      pins({ from: { address: alice } }),
    );
    expectThrows(InvalidAddressError, /Address "0x1234" is invalid/u, pins({ from: "0x1234" }));
    expectThrows(
      MockSetupError,
      /mock's own matchers, not Jest's/u,
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- typed `any`, as users meet it
      pins({ from: expect.any(String) }),
    );
    expectThrows(MockSetupError, /^A mock pins from and value as an object; got 5/u, pins(5));
    expect(usdc.read.balanceOf.calls).toEqual([]);
  });

  test("pick an overload with the args, as before", async () => {
    const { vault, walletOf } = setup();
    vault.write.withdraw([5n], { from: alice }).returns();

    await walletOf(alice).writeContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: "withdraw",
      args: [5n],
    });

    expect(vault.write.withdraw.calls).toMatchObject([{ args: [5n], from: alice }]);
  });
});

describe("pins and the estimate a write mock implies", () => {
  test("only a send that matches the pins has its estimate implied", async () => {
    const { vault, client } = setup();
    vault.write.deposit([], { from: alice, value: 1n }).returns();
    const estimate = (account: typeof alice, value: bigint) =>
      client.estimateContractGas({
        account,
        address: VAULT,
        abi: vaultAbi,
        functionName: "deposit",
        value,
      });

    expect(await estimate(alice, 1n)).toBe(100_000n);
    const error = await rejectionOf(estimate(bob, 1n));

    const miss = expectCause(error, MockNotFoundError);
    expect(miss?.shortMessage).toBe(
      `No estimateGas mock for deposit() { from: ${bob}, value: 1n } on Vault (${VAULT}).`,
    );
    expect(hintsOf(miss)).toBe(
      [
        "Write mocks, which imply the estimate of a send they match:",
        `  deposit() { from: ${alice}, value: 1n }  ← { from } didn't match`,
      ].join("\n"),
    );
    expect(hintsOf(expectCause(await rejectionOf(estimate(alice, 2n)), MockNotFoundError))).toMatch(
      /← \{ value \} didn't match$/u,
    );
  });
});

describe("pins in assertAllUsed()", () => {
  test("a pin left undefined pins nothing", async () => {
    const { mock, usdc, balanceOf } = setup();
    // Typed out under exactOptionalPropertyTypes; a JavaScript caller, or a project without it, can pass it.
    usdc.read.balanceOf(undefined, { from: undefined } as object).returns(1n);
    usdc.read.balanceOf().returns(2n);

    expect(await balanceOf(alice)).toBe(2n);
    expectThrows(MockCheckError, `  - balanceOf(*) on USDC (${USDC})\n`, () => {
      mock.assertAllUsed();
    });
  });

  test("an unused mock shows the value, or the missing from, its function's calls had", async () => {
    const { mock, vault, usdc, walletOf, balanceOf } = setup();
    vault.write.deposit([], { value: 1n }).returns();
    vault.write.deposit().returns();
    usdc.read.balanceOf([bob], { from: alice }).returns(5n);
    usdc.read.balanceOf().returns(1n);

    await walletOf(alice).writeContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: "deposit",
      value: 2n,
    });
    await balanceOf();

    expectThrows(
      MockCheckError,
      [
        `  - balanceOf(${bob}) { from: ${alice} } on USDC (${USDC})`,
        "    received 1 call to balanceOf:",
        "      balanceOf(…) { from: undefined }  ← { from } didn't match",
        `  - deposit() { value: 1n } on Vault (${VAULT})`,
        "    received 1 call to deposit:",
        "      deposit() { value: 2n }  ← { value } didn't match",
      ].join("\n"),
      () => {
        mock.assertAllUsed();
      },
    );
  });

  test("an unused mock shows the from or value its function's calls had instead", async () => {
    const { mock, usdc, balanceOf } = setup();
    usdc.read.balanceOf([bob]).returns(1n);
    usdc.read.balanceOf([bob], { from: alice }).returns(5n);
    usdc.read.balanceOf([carol], { from: alice }).returns(5n);

    usdc.read.balanceOf([alice], { from: carol }).returns(5n);

    await balanceOf(carol);

    expectThrows(
      MockCheckError,
      [
        "3 mock(s) answered no call:",
        `  - balanceOf(${bob}) { from: ${alice} } on USDC (${USDC})`,
        "    received 1 call to balanceOf:",
        `      balanceOf(…) { from: ${carol} }  ← { from } didn't match`,
        `  - balanceOf(${carol}) { from: ${alice} } on USDC (${USDC})`,
        "    received 1 call to balanceOf:",
        `      balanceOf(${bob}) { from: ${carol} }  ← account didn't match`,
        // A pin that matches isn't shown.
        `  - balanceOf(${alice}) { from: ${carol} } on USDC (${USDC})`,
        "    received 1 call to balanceOf:",
        `      balanceOf(${bob})  ← account didn't match`,
      ].join("\n"),
      () => {
        mock.assertAllUsed();
      },
    );
  });
});
