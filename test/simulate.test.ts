import {
  ContractFunctionRevertedError,
  createPublicClient,
  erc20Abi,
  getAddress,
  parseAbi,
} from "viem";
import { mainnet } from "viem/chains";
import { describe, expect, test } from "vite-plus/test";

import { MockNotFoundError, createMockRpc, testAddress } from "../src/index.js";
import { expectCause, rejectionOf } from "./utils.js";

const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
// For tests that register their own contract instead of setup()'s token.
const OTHER = testAddress("other");
const alice = testAddress("alice");
const bob = testAddress("bob");

// viem's erc20Abi plus OpenZeppelin's ERC-6093 error.
const tokenAbi = [
  ...erc20Abi,
  ...parseAbi(["error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)"]),
] as const;

const wethAbi = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256 wad)",
  "function balanceOf(address owner) view returns (uint256)",
]);

function setup() {
  const mock = createMockRpc();
  const client = createPublicClient({ chain: mainnet, transport: mock.transport() });
  const token = mock.contract({ abi: tokenAbi, address: TOKEN });
  const transfer = (to: `0x${string}`, amount: bigint) =>
    client.simulateContract({
      abi: tokenAbi,
      address: TOKEN,
      functionName: "transfer",
      args: [to, amount],
      account: alice,
    });
  return { mock, client, token, transfer };
}

describe("simulate", () => {
  test("answers simulateContract for nonpayable functions", async () => {
    const { token, transfer } = setup();
    token.simulate.transfer([bob, 100n]).returns(true);

    const { result } = await transfer(bob, 100n);
    expect(result).toBe(true);
  });

  test("uses the same matching rules as read", async () => {
    const { token, transfer } = setup();
    token.simulate.transfer().returns(false);
    token.simulate.transfer([bob, 100n]).returns(true);

    expect((await transfer(bob, 100n)).result).toBe(true);
    expect((await transfer(bob, 5n)).result).toBe(false);
  });

  test("reverts decode as ContractFunctionRevertedError", async () => {
    const { token, transfer } = setup();
    token.simulate
      .transfer()
      .returns(({ from, args: [, amount], revert }) =>
        revert({ errorName: "ERC20InsufficientBalance", args: [from!, 0n, amount] }),
      );

    const error = await rejectionOf(transfer(bob, 100n));
    const revert = expectCause(error, ContractFunctionRevertedError);
    expect(revert.data?.errorName).toBe("ERC20InsufficientBalance");
    expect(revert.data?.args).toEqual([getAddress(alice), 0n, 100n]);
  });

  test("resolvers and history see the simulating account", async () => {
    const { token, transfer } = setup();
    token.simulate.transfer().returns(true);

    await transfer(bob, 1n);
    const [call] = token.simulate.transfer.calls;
    expect(call?.from).toBe(alice);
    expect(call?.args).toEqual([getAddress(bob), 1n]);
    expect(call?.value).toBe(0n);
  });

  test("payable functions see the value sent", async () => {
    const { mock, client } = setup();
    const weth = mock.contract({ abi: wethAbi, address: WETH });
    weth.simulate.deposit().returns(() => {});

    await client.simulateContract({
      abi: wethAbi,
      address: WETH,
      functionName: "deposit",
      account: alice,
      value: 10n ** 18n,
    });
    expect(weth.simulate.deposit.calls[0]?.value).toBe(10n ** 18n);
  });

  test("defaults answer simulateContract and are overridden by simulate mocks", async () => {
    const { mock, client } = setup();
    const token = mock.contract({
      abi: tokenAbi,
      address: OTHER,
      defaults: { simulate: { transfer: true, approve: true } },
    });
    token.simulate.transfer([bob, 0n]).returns(false);

    const approve = await client.simulateContract({
      abi: tokenAbi,
      address: OTHER,
      functionName: "approve",
      args: [bob, 1n],
    });
    expect(approve.result).toBe(true);
    const transfer = (amount: bigint) =>
      client.simulateContract({
        abi: tokenAbi,
        address: OTHER,
        functionName: "transfer",
        args: [bob, amount],
      });
    expect((await transfer(1n)).result).toBe(true);
    expect((await transfer(0n)).result).toBe(false);
  });

  test("read and simulate only expose their own functions", () => {
    const { mock } = setup();
    const weth = mock.contract({ abi: wethAbi, address: WETH });

    expect(Object.keys(weth.read)).toEqual(["balanceOf"]);
    expect(Object.keys(weth.simulate)).toEqual(["deposit", "withdraw"]);
  });

  test("untyped callers using the wrong namespace are pointed to the right one", () => {
    const { mock } = setup();
    const weth = mock.contract({ abi: wethAbi, address: WETH });

    expect(() => {
      // @ts-expect-error payable functions live on simulate
      weth.read.deposit(); // oxlint-disable-line typescript/no-unsafe-call -- untyped caller, on purpose
    }).toThrow('"deposit" is a payable function; register it under simulate, not read.');
    expect(() => {
      // @ts-expect-error view functions live on read
      weth.simulate.balanceOf(); // oxlint-disable-line typescript/no-unsafe-call -- untyped caller, on purpose
    }).toThrow('"balanceOf" is a view function; register it under read, not simulate.');
  });

  test("defaults under the wrong namespace, or not on the ABI, say so", () => {
    const { mock } = setup();

    expect(() =>
      mock.contract({
        abi: wethAbi,
        address: WETH,
        // @ts-expect-error payable functions belong under simulate
        defaults: { read: { deposit: undefined } },
      }),
    ).toThrow('"deposit" is a payable function; register it under simulate, not read.');
    expect(() =>
      mock.contract({
        abi: wethAbi,
        address: OTHER,
        // @ts-expect-error not on the ABI
        defaults: { read: { balanceOff: 0n } },
      }),
    ).toThrow('No function "balanceOff" on this contract\'s ABI.');
  });

  test("unmocked nonpayable functions fail loudly", async () => {
    const { token, transfer } = setup();
    token.simulate.approve().returns(true);

    const error = expectCause(await rejectionOf(transfer(bob, 1n)), MockNotFoundError);
    expect(error.message).toContain('No mocks registered for "transfer"');
  });

  test("an overload shared across read and simulate binds to its own namespace", async () => {
    const { mock, client } = setup();
    // ERC-721's two `safeTransferFrom` overloads are both nonpayable, so this
    // pairs a view and a nonpayable overload of one name directly.
    const abi = parseAbi([
      "function nonces(address owner) view returns (uint256)",
      "function nonces(address owner, uint256 increment) returns (uint256)",
    ]);
    const contract = mock.contract({ abi, address: OTHER });
    contract.read.nonces().returns(1n);
    contract.simulate.nonces().returns(2n);

    expect(
      await client.readContract({ abi, address: OTHER, functionName: "nonces", args: [alice] }),
    ).toBe(1n);
    const { result } = await client.simulateContract({
      abi,
      address: OTHER,
      functionName: "nonces",
      args: [alice, 1n],
    });
    expect(result).toBe(2n);
  });
});
