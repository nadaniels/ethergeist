import {
  InvalidAddressError,
  InvalidParamsRpcError,
  createPublicClient,
  erc20Abi,
  getAddress,
  parseAbi,
  toHex,
} from "viem";
import { base, mainnet } from "viem/chains";
import { describe, expect, test } from "vite-plus/test";

import { MockNotFoundError, MockSetupError, createMockRpc, testAddress } from "../src/index.js";
import { expectCause, expectThrows, rejectionOf } from "./utils.js";

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

    expectThrows(MockSetupError, `A contract is already registered at ${USDC}`, () =>
      mock.contract({ abi: ownableAbi, address: usdcLowercase }),
    );
    expectThrows(MockSetupError, "restore a checkpoint after each test, or call reset()", () =>
      mock.contract({ abi: ownableAbi, address: USDC }),
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

describe("mock.calls", () => {
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

  test("holds every namespace's calls, each tagged with its namespace, in order", async () => {
    const { mock, client, decimals } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    const dai = mock.contract({ abi: erc20Abi, address: DAI });
    usdc.read.decimals().returns(6);
    usdc.simulate.transfer().returns(true);
    usdc.estimateGas.transfer().returns(65_000n);
    dai.read.decimals().returns(18);
    const transfer = { abi: erc20Abi, address: USDC, functionName: "transfer" } as const;

    await decimals(USDC);
    await client.simulateContract({ ...transfer, args: [DAI, 1n], account: alice });
    await decimals(DAI);
    await client.estimateContractGas({ ...transfer, args: [DAI, 2n], account: alice });

    expect(mock.calls.map((c) => [c.namespace, c.address, c.functionName])).toEqual([
      ["read", USDC, "decimals"],
      ["simulate", USDC, "transfer"],
      ["read", DAI, "decimals"],
      ["estimateGas", USDC, "transfer"],
    ]);
    expect(usdc.calls.map((c) => c.namespace)).toEqual(["read", "simulate", "estimateGas"]);
    expect(usdc.calls[2]).toEqual({
      namespace: "estimateGas",
      address: USDC,
      functionName: "transfer",
      args: [DAI, 2n],
      from: alice,
      value: 0n,
      blockNumber: 100n,
      batch: undefined,
    });
    // A function's own list is bare: its namespace is where it's read from.
    expect(usdc.estimateGas.transfer.calls).toEqual([
      {
        address: USDC,
        functionName: "transfer",
        args: [DAI, 2n],
        from: alice,
        value: 0n,
        blockNumber: 100n,
        batch: undefined,
      },
    ]);
    expect(usdc.simulate.transfer.calls.map((c) => c.args)).toEqual([[DAI, 1n]]);
  });

  test("tags multicall sub-calls, keeping their batch", async () => {
    const { mock, client } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).simulate.approve().returns(true);
    mock.contract({ abi: erc20Abi, address: DAI }).read.decimals().returns(18);

    await client.multicall({
      contracts: [
        { abi: erc20Abi, address: DAI, functionName: "decimals" },
        { abi: erc20Abi, address: USDC, functionName: "approve", args: [DAI, 1n] },
      ],
    });

    expect(mock.calls).toMatchObject([
      { namespace: "read", address: DAI, batch: { id: 1, index: 0 } },
      { namespace: "simulate", address: USDC, batch: { id: 1, index: 1 } },
    ]);
  });

  test("contract.calls carries the address too", async () => {
    const { mock, decimals } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.decimals().returns(6);

    await decimals(USDC);
    expect(usdc.calls[0]?.address).toBe(USDC);
  });

  test("the returned lists are copies", async () => {
    const { mock, decimals } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);
    await decimals(USDC);

    mock.calls.length = 0;
    mock.history.length = 0;
    expect(mock.calls).toHaveLength(1);
    expect(mock.history).toHaveLength(1);
  });
});

describe("mine()", () => {
  test("mines one block, or the count given", async () => {
    const { mock, client } = setup();

    mock.mine();
    expect(mock.blockNumber).toBe(101n);
    mock.mine(3);
    expect(mock.blockNumber).toBe(104n);
    expect(await client.getBlockNumber()).toBe(104n);
  });

  test.each([
    ["a bigint", 2n, "got 2n."],
    ["zero, which would mine nothing", 0, "got 0."],
    ["a non-integer number", 1.5, "got 1.5."],
    ["a negative count, which would move the head back", -1, "got -1."],
    ["NaN", Number.NaN, "got NaN."],
    ["Infinity", Infinity, "got Infinity."],
    ["a count past 2^53, which a number can't hold exactly", 2 ** 53, "got 9007199254740992."],
  ])("refuses %s, changing nothing", (_, blocks, got) => {
    const { mock } = setup();

    expectThrows(
      MockSetupError,
      `mock.mine()'s block count must be a positive integer; ${got}`,
      () => {
        // @ts-expect-error -- a count is a number
        mock.mine(blocks);
      },
    );
    expect(mock.blockNumber).toBe(100n);
  });

  test("mines the largest count a number holds exactly", () => {
    const { mock } = setup();

    mock.mine(Number.MAX_SAFE_INTEGER);
    expect(mock.blockNumber).toBe(100n + BigInt(Number.MAX_SAFE_INTEGER));
  });
});

describe("clearCalls()", () => {
  test("clears history but keeps mocks and the block number", async () => {
    const { mock, decimals } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.decimals().returns(6);
    mock.mine(5);
    await decimals(USDC);

    mock.clearCalls();
    expect(mock.calls).toEqual([]);
    expect(mock.history).toEqual([]);
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
    mock.mine(5);
    await decimals(USDC);

    mock.reset();
    expect(mock.calls).toEqual([]);
    expect(mock.history).toEqual([]);
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
    expectThrows(
      MockSetupError,
      `The contract at ${USDC} was removed by restore() or reset()`,
      () => stale.read.decimals(),
    );
    expectThrows(MockSetupError, "This mock was removed by restore() or reset()", () => {
      decimalsMock.returns(6);
    });
    expectCause(await rejectionOf(decimals(USDC)), MockNotFoundError);
  });

  test("action and raw method builders from before the reset throw too", () => {
    const { mock } = setup();
    const balance = mock.actions.getBalance();
    const raw = mock.method("eth_getBlockTransactionCountByNumber");

    mock.reset();
    expectThrows(MockSetupError, "This mock was removed by restore() or reset()", () => {
      balance.returns(1n);
    });
    expectThrows(MockSetupError, "This mock was removed by restore() or reset()", () => {
      raw.returns("0x1");
    });
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

describe("chain.id", () => {
  test("matches what eth_chainId answers", async () => {
    const mock = createMockRpc({ chain: base });
    const client = createPublicClient({ transport: mock.transport() });

    expect(mock.chain.id).toBe(8453);
    expect(await client.getChainId()).toBe(8453);
  });
});

describe("malformed params", () => {
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
    // Estimates, sends and calls read a transaction the same way (the spec's GenericTransaction).
    ["an estimate without a transaction", "eth_estimateGas", []],
    ["an estimate's transaction that isn't an object", "eth_estimateGas", ["0x313ce567"]],
    ["an estimate's sender that's null", "eth_estimateGas", [{ from: null, to: USDC }]],
    ["an eth_call sender that's null", "eth_call", [{ from: null, to: USDC, data: "0x313ce567" }]],
    ["an eth_call nonce that isn't a quantity", "eth_call", [{ to: USDC, data: "0x", nonce: "a" }]],
    ["an eth_call gas price as a JSON number", "eth_call", [{ to: USDC, data: "0x", gasPrice: 1 }]],
    ["an eth_call max fee that's null", "eth_call", [{ to: USDC, data: "0x", maxFeePerGas: null }]],
    [
      "an eth_call tip with a leading zero",
      "eth_call",
      [{ to: USDC, data: "0x", maxPriorityFeePerGas: "0x01" }],
    ],
    [
      "a nonce too large for a number",
      "eth_estimateGas",
      [{ to: USDC, nonce: "0x" + "f".repeat(20) }],
    ],
    ["a logs address that isn't one", "eth_getLogs", [{ address: "0x1234" }]],
    ["a logs address list with one that isn't", "eth_getLogs", [{ address: [USDC, 5] }]],
    ["a block count too large for a number", "eth_feeHistory", ["0x" + "f".repeat(20), "latest"]],
    // A quantity is compact hex: at least one digit, no leading zeros, never a JSON number.
    ["an empty nonce", "eth_estimateGas", [{ to: USDC, nonce: "0x" }]],
    ["an empty estimate value", "eth_estimateGas", [{ to: USDC, value: "0x" }]],
    ["an empty block count", "eth_feeHistory", ["0x", "latest"]],
    ["an empty block number", "eth_getBalance", [USDC, "0x"]],
    ["an empty EIP-1898 block number", "eth_getBalance", [USDC, { blockNumber: "0x" }]],
    ["an empty eth_call value", "eth_call", [{ to: USDC, data: "0x313ce567", value: "0x" }]],
    ["an eth_call gas with a leading zero", "eth_call", [{ to: USDC, data: "0x", gas: "0x01" }]],
    ["a block number with a leading zero", "eth_getBalance", [USDC, "0x0a"]],
    ["a value with a leading zero", "eth_estimateGas", [{ to: USDC, value: "0x01" }]],
    ["a value as a JSON number", "eth_estimateGas", [{ to: USDC, value: 1 }]],
    ["a nonce as a JSON number", "eth_estimateGas", [{ to: USDC, nonce: 7 }]],
    [
      "an eth_call value as a JSON number",
      "eth_call",
      [{ to: USDC, data: "0x313ce567", value: 0 }],
    ],
    ["a block count as a JSON number", "eth_feeHistory", [1, "latest", []]],
    ["an estimate's value that isn't a quantity", "eth_estimateGas", [{ to: USDC, value: "abc" }]],
    ["a nonce that isn't a quantity", "eth_estimateGas", [{ to: USDC, nonce: "abc" }]],
    // An estimate or a send with data that isn't hex isn't a plain transfer.
    ["an estimate's data that isn't hex", "eth_estimateGas", [{ to: USDC, data: "zz" }]],
    ["an estimate's input that isn't hex", "eth_estimateGas", [{ to: USDC, input: "zz" }]],
    ["a send's data that isn't hex", "eth_sendTransaction", [{ from: USDC, to: USDC, data: "zz" }]],
    ["a send's input that isn't hex", "eth_sendTransaction", [{ from: USDC, to: USDC, input: 5 }]],
    // The spec's input is bytes, never null; only `to` may be null (a deploy).
    ["an estimate's data that's null", "eth_estimateGas", [{ to: USDC, data: null }]],
    [
      "an estimate's input that isn't hex, beside data that is",
      "eth_estimateGas",
      [{ to: USDC, data: "0x", input: "zz" }],
    ],
    ["a block as a JSON number", "eth_getBalance", [USDC, 10]],
    // A null at the end is a param left out (JSON writes one so); anywhere else it's refused.
    ["a block that's null before another param", "eth_feeHistory", ["0x1", null, []]],
    ["a storage slot that's null", "eth_getStorageAt", [USDC, null, "latest"]],
    ["an eth_call block that isn't one", "eth_call", [{ to: USDC, data: "0x313ce567" }, "bogus"]],
    ["an EIP-1898 block with neither", "eth_getBalance", [USDC, {}]],
    [
      "an EIP-1898 block where only a number or tag goes",
      "eth_getBlockByNumber",
      [{ blockNumber: "0x1" }, false],
    ],
    ["a block hash that isn't 32 bytes", "eth_getBlockByHash", ["0x12", false]],
    // getLogs: a range takes no pending, and nothing is null but a whole topic position.
    ["a logs range from pending", "eth_getLogs", [{ address: USDC, fromBlock: "pending" }]],
    ["a logs range to pending", "eth_getLogs", [{ address: USDC, toBlock: "pending" }]],
    ["a topic that isn't 32 bytes", "eth_getLogs", [{ address: USDC, topics: ["0xaa"] }]],
    ["a logs block hash that isn't one", "eth_getLogs", [{ address: USDC, blockHash: "0x12" }]],
    ["a logs range from null", "eth_getLogs", [{ address: USDC, fromBlock: null }]],
    [
      "a null in a topic list",
      "eth_getLogs",
      [{ address: USDC, topics: [[`0x${"aa".repeat(32)}`, null]] }],
    ],

    [
      "topics that aren't a list",
      "eth_getLogs",
      [{ address: USDC, topics: `0x${"aa".repeat(32)}` }],
    ],
    ["a logs address that's a number", "eth_getLogs", [{ address: 5 }]],
    ["a logs filter that isn't an object", "eth_getLogs", ["bogus"]],
    ["a quantity with an uppercase 0X", "eth_estimateGas", [{ to: USDC, value: "0X1" }]],
    [
      "an EIP-1898 block with both a number and a hash",
      "eth_getBalance",
      [USDC, { blockNumber: "0x1", blockHash: `0x${"aa".repeat(32)}` }],
    ],
  ])("%s is refused as invalid params", async (_, method, params) => {
    const mock = createMockRpc();

    await mock.request({ method, params }).catch(() => {});
    expect(mock.history[0]?.outcome).toMatchObject({ type: "rpcError", code: -32602 });
  });

  test("what the spec allows is read: any case, a block hash, a whole null topic", async () => {
    const mock = createMockRpc({ blockNumber: 10n });
    mock.actions.getBalance().returns(1n);
    const block = await mock.request({ method: "eth_getBlockByNumber", params: ["0x5", false] });
    const hash =
      typeof block === "object" && block !== null && "hash" in block ? block.hash : undefined;

    await mock.request({ method: "eth_getBalance", params: [USDC, "0xA"] });
    await mock.request({ method: "eth_getBalance", params: [USDC, hash] });
    await mock.request({ method: "eth_getBalance", params: [USDC, { blockNumber: "0x7" }] });
    await mock.request({ method: "eth_getBalance", params: [USDC, { blockHash: hash }] });
    await mock
      .request({ method: "eth_getLogs", params: [{ address: USDC, topics: [null] }] })
      .catch(() => {});

    expect(mock.actions.getBalance.calls.map((call) => call.blockNumber)).toEqual([
      10n,
      5n,
      7n,
      5n,
    ]);
    expect(mock.history.at(-1)?.outcome.type).not.toBe("rpcError");
  });

  test("a null at the end of the params is a param left out", async () => {
    // As JSON writes viem's getFeeHistory without percentiles: [count, block, undefined].
    const mock = createMockRpc({ blockNumber: 10n });
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);

    await mock.request({ method: "eth_feeHistory", params: ["0x4", "latest", null] });
    await mock.request({ method: "eth_call", params: [{ to: USDC, data: "0x313ce567" }, null] });

    expect(mock.history.map((entry) => entry.outcome.type)).toEqual(["result", "result"]);
  });

  test("a raw method's params are its own: a null at the end stays", async () => {
    const mock = createMockRpc();
    mock.method("debug_custom", ["a", null]).returns(({ params }) => params);

    expect(await mock.request({ method: "debug_custom", params: ["a", null] })).toEqual([
      "a",
      null,
    ]);
  });

  test("an eth_call to null is a creation, which the mock doesn't run", async () => {
    // The spec allows `to: null`; without bytecode execution it's unsupported, not malformed.
    const mock = createMockRpc();

    await mock
      .request({ method: "eth_call", params: [{ to: null, data: "0x6080" }] })
      .catch(() => {});

    expect(mock.unhandled[0]?.error.shortMessage).toBe("eth_call without `to` is not supported.");
  });

  test("an eth_call without data isn't supported", async () => {
    const mock = createMockRpc();
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);

    await mock.request({ method: "eth_call", params: [{ to: USDC }] }).catch(() => {});

    expect(mock.unhandled[0]?.error.shortMessage).toBe("eth_call without `data` is not supported.");
  });

  test("an eth_call without params is refused as invalid params", async () => {
    const mock = createMockRpc();

    await mock.request({ method: "eth_call" }).catch(() => {});

    expect(mock.history[0]).toMatchObject({
      type: "call",
      outcome: { type: "rpcError", code: -32602 },
    });
  });

  test("an eth_call's data is read from the spec's input too", async () => {
    const mock = createMockRpc();
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);

    expect(
      await mock.request({ method: "eth_call", params: [{ to: USDC, input: "0x313ce567" }] }),
    ).toBe(toHex(6, { size: 32 }));
  });

  test("an eth_call's addresses are hex in any case: a wrong checksum is read, not refused", async () => {
    // USDC with one letter's case flipped.
    const badChecksum = "0xa0B86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    const mock = createMockRpc();
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);

    expect(
      await mock.request({
        method: "eth_call",
        params: [{ to: badChecksum, from: badChecksum, data: "0x313ce567" }],
      }),
    ).toBe(toHex(6, { size: 32 }));
    expect(mock.history[0]).toMatchObject({ type: "call", to: USDC });
    expect(mock.calls[0]).toMatchObject({ address: USDC, from: USDC });
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
    [{ blockNumber: 5 }, "createMockRpc()'s blockNumber must be a non-negative bigint; got 5."],
    [{ blockNumber: -1n }, "createMockRpc()'s blockNumber must be a non-negative bigint; got -1n."],
    [{ timestamp: 5 }, "createMockRpc()'s timestamp must be a non-negative bigint; got 5."],
    [{ timestamp: -1n }, "createMockRpc()'s timestamp must be a non-negative bigint; got -1n."],
    [
      { chain: { ...mainnet, blockTime: "x" } },
      "createMockRpc()'s chain.blockTime must be a non-negative integer; got x.",
    ],
    [
      { chain: { ...mainnet, blockTime: 1.5 } },
      "createMockRpc()'s chain.blockTime must be a non-negative integer; got 1.5.",
    ],
    [
      { chain: { ...mainnet, blockTime: -1 } },
      "createMockRpc()'s chain.blockTime must be a non-negative integer; got -1.",
    ],
  ])("%o is refused when the mock is created", (parameters, message) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what a JavaScript caller can pass
    expectThrows(MockSetupError, message, () => createMockRpc(parameters as never));
  });
});
