import {
  InvalidAddressError,
  InvalidParamsRpcError,
  createPublicClient,
  erc20Abi,
  getAddress,
  parseAbi,
} from "viem";
import { base, mainnet } from "viem/chains";
import { describe, expect, test } from "vite-plus/test";

import { MockNotFoundError, MockSetupError, createMockRpc, testAddress } from "../src/index.js";
import { expectCause, rejectionOf } from "./utils.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const usdcLowercase = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const alice = testAddress("alice");

// OpenZeppelin's Ownable, to combine with an ERC-20 at one address.
const ownableAbi = parseAbi(["function owner() view returns (address)"]);

function setup({ batch = false }: { batch?: boolean } = {}) {
  const mock = createMockRpc({ blockNumber: 100n });
  const client = createPublicClient({
    chain: mainnet,
    transport: mock.transport(),
    cacheTime: 0,
    ...(batch ? { batch: { multicall: true } } : {}),
  });
  const decimals = (address: `0x${string}`) =>
    client.readContract({ abi: erc20Abi, address, functionName: "decimals" });
  return { mock, client, decimals };
}

describe("registration", () => {
  test("a second registration at the same address throws", () => {
    const { mock } = setup();
    mock.contract({ abi: erc20Abi, address: USDC });

    expect(() => mock.contract({ abi: ownableAbi, address: usdcLowercase })).toThrow(
      `A contract is already registered at ${USDC}`,
    );
    expect(() => mock.contract({ abi: ownableAbi, address: USDC })).toThrow(
      "restore a checkpoint after each test, or call reset()",
    );
  });

  test("a malformed address is rejected at registration", () => {
    const { mock } = setup();
    expect(() => mock.contract({ abi: erc20Abi, address: "0x1234" })).toThrow(InvalidAddressError);
  });

  test("one registration with a combined ABI answers both", async () => {
    const { mock, client, decimals } = setup();
    const usdc = mock.contract({ abi: [...erc20Abi, ...ownableAbi], address: USDC });
    usdc.read.decimals().returns(6);
    usdc.read.owner().returns(alice);

    expect(await decimals(USDC)).toBe(6);
    expect(
      await client.readContract({ abi: ownableAbi, address: USDC, functionName: "owner" }),
    ).toBe(getAddress(alice));
    expect(usdc.calls.map((c) => c.functionName)).toEqual(["decimals", "owner"]);
  });
});

describe("rpc.calls", () => {
  test("logs calls across contracts in order, with their address", async () => {
    const { mock, decimals } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);
    mock.contract({ abi: erc20Abi, address: DAI }).read.decimals().returns(18);

    await decimals(DAI);
    await decimals(USDC);
    await decimals(DAI);

    expect(mock.calls.map((c) => [c.address, c.functionName])).toEqual([
      [DAI, "decimals"],
      [USDC, "decimals"],
      [DAI, "decimals"],
    ]);
  });

  test("addresses are checksummed, whatever case was registered", async () => {
    const { mock, decimals } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: usdcLowercase });
    usdc.read.decimals().returns(6);

    await decimals(USDC);
    expect(usdc.address).toBe(USDC);
    expect(mock.calls[0]?.address).toBe(USDC);
    expect(usdc.calls[0]?.address).toBe(USDC);
  });

  test("keeps batch order for multicall sub-calls", async () => {
    const { mock, client } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);
    mock.contract({ abi: erc20Abi, address: DAI }).read.decimals().returns(18);

    await client.multicall({
      contracts: [
        { abi: erc20Abi, address: DAI, functionName: "decimals" },
        { abi: erc20Abi, address: USDC, functionName: "decimals" },
      ],
    });

    expect(mock.calls.map((c) => [c.address, c.batch?.index])).toEqual([
      [DAI, 0],
      [USDC, 1],
    ]);
  });

  test("contract.calls carries the address too", async () => {
    const { mock, decimals } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.decimals().returns(6);

    await decimals(USDC);
    expect(usdc.calls[0]?.address).toBe(USDC);
  });

  test("returned logs are copies", async () => {
    const { mock, decimals } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);
    await decimals(USDC);

    mock.calls.length = 0;
    mock.requests.length = 0;
    expect(mock.calls).toHaveLength(1);
    expect(mock.requests).toHaveLength(1);
  });
});

describe("clearCalls()", () => {
  test("clears history but keeps mocks and the block number", async () => {
    const { mock, decimals } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.decimals().returns(6);
    mock.mine(5n);
    await decimals(USDC);

    mock.clearCalls();
    expect(mock.calls).toEqual([]);
    expect(mock.requests).toEqual([]);
    expect(usdc.calls).toEqual([]);
    expect(usdc.read.decimals.calls).toEqual([]);
    expect(mock.blockNumber).toBe(105n);

    expect(await decimals(USDC)).toBe(6);
    expect(usdc.calls).toHaveLength(1);
  });
});

describe("reset()", () => {
  test("removes contracts and history and restores the starting block", async () => {
    const { mock, client, decimals } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);
    mock.mine(5n);
    await decimals(USDC);

    mock.reset();
    expect(mock.calls).toEqual([]);
    expect(mock.requests).toEqual([]);
    expect(mock.blockNumber).toBe(100n);
    expect(await client.getBlockNumber()).toBe(100n);

    const error = expectCause(await rejectionOf(decimals(USDC)), MockNotFoundError);
    expect(error.message).toContain(`No mocked contract at ${USDC}`);
  });

  test("frees the address for a new registration", async () => {
    const { mock, decimals } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);

    mock.reset();
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(18);
    expect(await decimals(USDC)).toBe(18);
  });

  test("handles from before the reset throw instead of silently not answering", async () => {
    const { mock, decimals } = setup();
    const stale = mock.contract({ abi: erc20Abi, address: USDC });
    const decimalsMock = stale.read.decimals();

    mock.reset();
    expect(() => stale.read.decimals()).toThrow(
      `The contract at ${USDC} was removed by restore() or reset()`,
    );
    expect(() => {
      decimalsMock.returns(6);
    }).toThrow("This mock was removed by restore() or reset()");
    expectCause(await rejectionOf(decimals(USDC)), MockNotFoundError);
  });

  test("action and raw method builders from before the reset throw too", () => {
    const { mock } = setup();
    const balance = mock.actions.getBalance();
    const raw = mock.method("eth_getBlockTransactionCountByNumber");

    mock.reset();
    expect(() => {
      balance.returns(1n);
    }).toThrow("This mock was removed by restore() or reset()");
    expect(() => {
      raw.returns("0x1");
    }).toThrow("This mock was removed by restore() or reset()");
  });

  test("batch ids start over", async () => {
    const { mock, client } = setup();
    const register = () => {
      mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);
    };
    const batchId = async () => {
      await client.multicall({
        contracts: [{ abi: erc20Abi, address: USDC, functionName: "decimals" }],
      });
      return mock.calls.at(-1)?.batch?.id;
    };

    register();
    const first = await batchId();
    mock.reset();
    register();
    expect(await batchId()).toBe(first);
  });
});

describe("chainId", () => {
  test("matches what eth_chainId answers", async () => {
    const mock = createMockRpc({ chain: base });
    const client = createPublicClient({ transport: mock.transport() });

    expect(mock.chainId).toBe(8453);
    expect(await client.getChainId()).toBe(8453);
  });
});

describe("malformed params", () => {
  // A node refuses params it can't parse with -32602 (invalid params). The
  // messages are the mock's own: none were captured from a node.
  test.each([
    ["an address that isn't one", "eth_getBalance", ["0x1234", "latest"]],
    ["a block tag that isn't one", "eth_getBlockByNumber", ["banana", false]],
    ["a transaction hash that isn't one", "eth_getTransactionByHash", [5]],
    ["a receipt hash that isn't one", "eth_getTransactionReceipt", ["0x12"]],
    ["reward percentiles that aren't numbers", "eth_feeHistory", ["0x1", "latest", ["a"]]],
    ["a block count that isn't a number", "eth_feeHistory", ["many", "latest"]],
    ["an eth_call target that isn't an address", "eth_call", [{ to: 5, data: "0x313ce567" }]],
    ["an eth_call without a transaction", "eth_call", ["0x313ce567"]],
    ["a storage slot that isn't hex", "eth_getStorageAt", [USDC, "0xzz", "latest"]],
    ["a storage slot over 32 bytes", "eth_getStorageAt", [USDC, `0x${"11".repeat(33)}`, "latest"]],
    ["an estimate's sender that isn't an address", "eth_estimateGas", [{ from: "0xzz", to: USDC }]],
    ["an estimate's target that isn't an address", "eth_estimateGas", [{ to: "0x1234" }]],
    [
      "a nonce too large for a number",
      "eth_estimateGas",
      [{ to: USDC, nonce: "0x" + "f".repeat(20) }],
    ],
    ["a logs address that isn't one", "eth_getLogs", [{ address: "0x1234" }]],
    ["a logs address list with one that isn't", "eth_getLogs", [{ address: [USDC, 5] }]],
    ["a block count too large for a number", "eth_feeHistory", ["0x" + "f".repeat(20), "latest"]],
    // A quantity has at least one digit: zero is "0x0".
    ["an empty nonce", "eth_estimateGas", [{ to: USDC, nonce: "0x" }]],
    ["an empty estimate value", "eth_estimateGas", [{ to: USDC, value: "0x" }]],
    ["an empty block count", "eth_feeHistory", ["0x", "latest"]],
    ["an empty block number", "eth_getBalance", [USDC, "0x"]],
    ["an empty EIP-1898 block number", "eth_getBalance", [USDC, { blockNumber: "0x" }]],
    ["an empty eth_call value", "eth_call", [{ to: USDC, data: "0x313ce567", value: "0x" }]],
  ])("%s is refused as invalid params", async (_, method, params) => {
    const mock = createMockRpc();

    await mock.request({ method, params }).catch(() => {});
    expect(mock.history[0]?.outcome).toMatchObject({ type: "rpcError", code: -32602 });
  });

  test("is refused once, not retried", async () => {
    const mock = createMockRpc();

    const error = await rejectionOf(
      mock.publicClient().request({ method: "eth_getStorageAt", params: [USDC, "0xzz", "latest"] }),
    );
    expect(error).toBeInstanceOf(InvalidParamsRpcError);
    expect(mock.history).toHaveLength(1);
  });
});

describe("options", () => {
  // Typed, but JavaScript callers (or a cast) can pass anything: without a
  // check, the first block fails inside a request instead.
  test.each([
    [{ blockNumber: 5 }, "blockNumber must be a bigint; got number."],
    [{ blockNumber: -1n }, "blockNumber can't be negative; got -1."],
    [{ timestamp: 5 }, "timestamp must be a bigint; got number."],
    [{ timestamp: -1n }, "timestamp can't be negative; got -1."],
    [
      { chain: { ...mainnet, blockTime: "x" } },
      "chain.blockTime must be a whole number of milliseconds, zero or more; got string.",
    ],
    [
      { chain: { ...mainnet, blockTime: 1.5 } },
      "chain.blockTime must be a whole number of milliseconds, zero or more; got 1.5.",
    ],
    [
      { chain: { ...mainnet, blockTime: -1 } },
      "chain.blockTime must be a whole number of milliseconds, zero or more; got -1.",
    ],
  ])("%o is refused when the mock is created", (parameters, message) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what a JavaScript caller can pass
    expect(() => createMockRpc(parameters as never)).toThrow(new MockSetupError(message));
  });
});
