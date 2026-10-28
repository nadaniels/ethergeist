import {
  HttpRequestError,
  InvalidAddressError,
  TimeoutError,
  createPublicClient,
  erc20Abi,
  getAddress,
  parseEther,
  zeroHash,
} from "viem";
import { describe, expect, test } from "vite-plus/test";
import {
  MockNotFoundError,
  MockResolverError,
  createMockRpc,
  multicall3Address,
  zeroResult,
} from "../src/index.js";
import { expectCause, rejectionOf } from "./utils.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const NOWHERE = "0x000000000000000000000000000000000000dEaD";
const alice = "0x00000000000000000000000000000000000a11ce";
const bob = "0x0000000000000000000000000000000000000b0b";

function setup() {
  const mock = createMockRpc({ blockNumber: 10n });
  const client = createPublicClient({
    chain: mock.chain,
    cacheTime: 0,
    transport: mock.transport({ retryCount: 0 }),
  });
  return { mock, client };
}

describe("getBalance", () => {
  test("answers a pinned address in viem's types", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: alice }).returns(parseEther("1"));

    expect(await client.getBalance({ address: alice })).toBe(parseEther("1"));
  });

  test("an unmocked address is unhandled, with a hint", async () => {
    const { mock, client } = setup();

    const error = expectCause(
      await rejectionOf(client.getBalance({ address: alice })),
      MockNotFoundError,
    );
    expect(error.message).toContain(
      `No mock for getBalance({ address: ${getAddress(alice)}, blockNumber: 10n })`,
    );
    expect(error.message).toContain("mock.actions.getBalance({ address }).returns(…)");
    expect(mock.unhandled).toHaveLength(1);
  });

  test("the most specific mock wins", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: alice }).returns(5n);
    mock.actions.getBalance().returns(0n);

    expect(await client.getBalance({ address: alice })).toBe(5n);
    expect(await client.getBalance({ address: bob })).toBe(0n);
  });

  test("a pinned block answers that block, including as latest", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: alice, blockNumber: 10n }).returns(5n);
    mock.actions.getBalance({ address: alice }).returns(7n);

    expect(await client.getBalance({ address: alice })).toBe(5n);
    expect(await client.getBalance({ address: alice, blockNumber: 9n })).toBe(7n);
    mock.mine();
    expect(await client.getBalance({ address: alice })).toBe(7n);
  });

  test("resolvers get the call, with tags resolved to a block number", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance().returns(({ blockNumber }) => blockNumber * 100n);

    expect(await client.getBalance({ address: alice })).toBe(1000n);
    expect(await client.getBalance({ address: alice, blockTag: "safe" })).toBe(1000n);
    expect(await client.getBalance({ address: alice, blockNumber: 3n })).toBe(300n);
  });

  test("calls are logged with checksummed addresses", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance().returns(0n);

    await client.getBalance({ address: alice });
    expect(mock.actions.getBalance.calls).toEqual([
      { address: getAddress(alice), blockNumber: 10n },
    ]);
  });

  test("returns() with no value, or zeroResult, answers 0n", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: alice }).returns();
    mock.actions.getBalance({ address: bob }).returns(zeroResult);

    expect(await client.getBalance({ address: alice })).toBe(0n);
    expect(await client.getBalance({ address: bob })).toBe(0n);
  });

  test("invalid values and addresses fail at registration", () => {
    const { mock } = setup();

    expect(() => {
      mock.actions.getBalance().returns(-1n);
    }).toThrow("not in safe integer range");
    expect(() => {
      // @ts-expect-error a balance is a bigint
      mock.actions.getBalance().returns(1);
    }).toThrow("A balance must be a bigint");
    expect(() => mock.actions.getBalance({ address: "0x1234" })).toThrow(InvalidAddressError);
  });

  test("a resolver that throws, or returns an invalid value, is a resolver error", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: alice }).returns(() => {
      throw new Error("boom");
    });
    mock.actions.getBalance({ address: bob }).returns(() => -1n);

    expectCause(await rejectionOf(client.getBalance({ address: alice })), MockResolverError);
    expectCause(await rejectionOf(client.getBalance({ address: bob })), MockResolverError);
    expect(mock.unhandled).toHaveLength(2);
  });

  test("fails() fails the request, and isn't unhandled", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: alice }).fails({ status: 503 });

    expect(
      expectCause(await rejectionOf(client.getBalance({ address: alice })), HttpRequestError)
        .status,
    ).toBe(503);
    expect(mock.unhandled).toEqual([]);
  });
});

describe("getCode", () => {
  test("a registered contract has placeholder code; Multicall3 too", async () => {
    const { mock, client } = setup();
    mock.contract({ abi: erc20Abi, address: USDC });

    expect(await client.getCode({ address: USDC })).toBe("0xfe");
    expect(await client.getCode({ address: multicall3Address })).toBe("0xfe");
  });

  test("an empty() address has no code", async () => {
    const { mock, client } = setup();
    mock.empty(NOWHERE);

    expect(await client.getCode({ address: NOWHERE })).toBeUndefined();
  });

  test("an unknown address is unhandled", async () => {
    const { mock, client } = setup();

    const error = expectCause(
      await rejectionOf(client.getCode({ address: NOWHERE })),
      MockNotFoundError,
    );
    expect(error.message).toContain("or mock.empty(address)");
    expect(mock.unhandled).toHaveLength(1);
  });

  test("a mock overrides the contract's placeholder", async () => {
    const { mock, client } = setup();
    mock.contract({ abi: erc20Abi, address: USDC });
    mock.actions.getCode({ address: USDC }).returns("0x6080");

    expect(await client.getCode({ address: USDC })).toBe("0x6080");
  });

  test("blocks by hash aren't supported yet", async () => {
    const { mock, client } = setup();
    mock.actions.getCode().returns("0x6080");

    const error = expectCause(
      await rejectionOf(client.getCode({ address: USDC, blockHash: zeroHash })),
      MockNotFoundError,
    );
    expect(error.message).toContain("Blocks by hash are not supported yet");
  });
});

describe("method()", () => {
  test("answers a method with raw JSON-RPC values", async () => {
    const { mock, client } = setup();
    mock.method("eth_gasPrice").returns("0x3b9aca00");

    expect(await client.getGasPrice()).toBe(1_000_000_000n);
  });

  test("pinned params match a prefix of the request's", async () => {
    const { mock, client } = setup();
    const slot = `0x${"00".repeat(31)}01` as const;
    mock.method("eth_getStorageAt", [USDC, slot]).returns(`0x${"00".repeat(31)}2a`);
    mock.method("eth_getStorageAt").returns(zeroHash);

    expect(await client.getStorageAt({ address: USDC, slot })).toBe(`0x${"00".repeat(31)}2a`);
    expect(await client.getStorageAt({ address: USDC, slot: zeroHash })).toBe(zeroHash);
  });

  test("resolvers get the raw params", async () => {
    const { mock, client } = setup();
    mock.method("eth_getStorageAt").returns(({ params }) => params[1] ?? null);

    expect(await client.getStorageAt({ address: USDC, slot: zeroHash })).toBe(zeroHash);
  });

  test("an unmocked method suggests method()", async () => {
    const { mock, client } = setup();

    const error = expectCause(await rejectionOf(client.getGasPrice()), MockNotFoundError);
    expect(error.message).toContain('RPC method "eth_gasPrice" is not mocked');
    expect(error.message).toContain('mock.method("eth_gasPrice", …)');
    expect(mock.unhandled).toHaveLength(1);
  });

  test("refuses methods that have a typed or built-in answer", () => {
    const { mock } = setup();

    expect(() => mock.method("eth_getBalance")).toThrow("use mock.actions.getBalance()");
    expect(() => mock.method("eth_call")).toThrow("register a contract with mock.contract()");
    expect(() => mock.method("eth_chainId")).toThrow("it's the chain's id");
  });

  test("fails() works here too", async () => {
    const { mock, client } = setup();
    mock.method("eth_gasPrice").fails("timeout");

    expectCause(await rejectionOf(client.getGasPrice()), TimeoutError);
  });
});

describe("bookkeeping", () => {
  test("assertAllUsed() reports pinned action mocks that never answered", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: bob }).returns(1n);
    mock.actions.getBalance().returns(0n);
    mock.method("eth_getStorageAt", [USDC]).returns(zeroHash);

    await client.getBalance({ address: alice });
    expect(() => {
      mock.assertAllUsed();
    }).toThrow(`getBalance({ address: ${getAddress(bob)} })`);
    expect(() => {
      mock.assertAllUsed();
    }).toThrow(`eth_getStorageAt([${USDC}])`);
  });

  test("clearCalls() clears history; reset() clears mocks", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance().returns(1n);
    mock.method("eth_gasPrice").returns("0x1");
    await client.getBalance({ address: alice });

    mock.clearCalls();
    expect(mock.actions.getBalance.calls).toEqual([]);
    expect(await client.getBalance({ address: alice })).toBe(1n);

    mock.reset();
    expectCause(await rejectionOf(client.getBalance({ address: alice })), MockNotFoundError);
    expectCause(await rejectionOf(client.getGasPrice()), MockNotFoundError);
  });
});
