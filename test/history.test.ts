import {
  type BlockTag,
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  multicall3Abi,
  parseAbi,
  toHex,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { describe, expect, expectTypeOf, test, vi } from "vite-plus/test";

import {
  MockCheckError,
  MockSetupError,
  type MockHistoryEntry,
  type MockRpc,
  MockNotFoundError,
  MockResolverError,
  createMockRpc,
  match,
  testAddress,
  testLog,
} from "../src/index.js";
import { expectThrows, findCause, rejectionOf } from "./utils.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const NOWHERE = "0x000000000000000000000000000000000000dEaD";
const alice = testAddress("alice");
const signer = privateKeyToAccount(keccak256(toHex("signer")));

const tokenAbi = [...erc20Abi, ...parseAbi(["error EnforcedPause()"])];
const pairAbi = parseAbi([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function price() view returns (uint256, uint256)",
  "function deposit() payable",
]);

function setup({
  retryCount = 0,
  debug,
}: { retryCount?: number; debug?: (line: string) => void } = {}) {
  const mock = createMockRpc({ chain: base, blockNumber: 10n, ...(debug ? { debug } : {}) });
  const client = createPublicClient({
    chain: mock.chain,
    cacheTime: 0,
    transport: mock.transport({ retryCount }),
  });
  const read = (address: `0x${string}`, functionName: "decimals" | "symbol") =>
    client.readContract({ abi: tokenAbi, address, functionName });
  return { mock, client, read };
}

function isType<type extends MockHistoryEntry["type"]>(
  entry: MockHistoryEntry | undefined,
  type: type,
): entry is Extract<MockHistoryEntry, { type: type }> {
  return entry?.type === type;
}

/** The only entry, narrowed to `type`. */
function only<type extends MockHistoryEntry["type"]>(
  entries: MockHistoryEntry[],
  type: type,
): Extract<MockHistoryEntry, { type: type }> {
  expect(entries).toHaveLength(1);
  const [entry] = entries;
  if (!isType(entry, type)) throw new Error(`expected a ${type} entry, got ${entry?.type}`);
  return entry;
}

describe("history entries", () => {
  test("a contract call, with its result in viem's types", async () => {
    const { mock, read } = setup();
    mock.contract({ abi: tokenAbi, address: USDC, name: "USDC" }).read.decimals().returns(6);

    await read(USDC, "decimals");
    const entry = only(mock.history, "call");
    expect(entry.to).toBe(USDC);
    expect(entry.call).toMatchObject({
      address: USDC,
      name: "USDC",
      namespace: "read",
      call: { functionName: "decimals", args: [] },
      outcome: { type: "result", value: 6 },
    });
    expect(entry.outcome).toEqual({ type: "result", value: 6 });
    expect(entry.call?.abiItem).toMatchObject({ type: "function", name: "decimals" });
  });

  test("reverts are decoded: custom errors and reason strings", async () => {
    const { mock, read } = setup();
    const usdc = mock.contract({ abi: tokenAbi, address: USDC });
    usdc.read.decimals().reverts({ errorName: "EnforcedPause" });
    usdc.read.symbol().reverts("paused");

    await rejectionOf(read(USDC, "decimals"));
    await rejectionOf(read(USDC, "symbol"));
    expect(mock.history.map((e) => e.outcome)).toMatchObject([
      { type: "revert", errorName: "EnforcedPause", args: [] },
      { type: "revert", reason: "paused" },
    ]);
  });

  test("faults record where they came from; retries are separate entries", async () => {
    const { mock, read } = setup({ retryCount: 1 });
    mock.contract({ abi: tokenAbi, address: USDC }).read.decimals().fails({ status: 503 });
    mock.contract({ abi: tokenAbi, address: DAI }).read.decimals().returns(18);

    await rejectionOf(read(USDC, "decimals"));
    mock.failRequests("timeout", { times: 1 });
    await read(DAI, "decimals");

    expect(mock.history.map((e) => e.outcome)).toMatchObject([
      { type: "fault", fault: { status: 503 }, source: "mock" },
      { type: "fault", fault: { status: 503 }, source: "mock" },
      { type: "fault", fault: "timeout", source: "failRequests" },
      { type: "result", value: 18 },
    ]);
  });

  test("unhandled requests and resolver errors", async () => {
    const { mock, read } = setup();
    mock
      .contract({ abi: tokenAbi, address: USDC })
      .read.decimals()
      .returns(() => {
        throw new Error("boom");
      });

    await rejectionOf(read(USDC, "decimals"));
    await rejectionOf(read(DAI, "decimals"));
    const [threw, missing] = mock.history;
    expect(threw?.outcome.type === "unhandled" && threw.outcome.error).toBeInstanceOf(
      MockResolverError,
    );
    expect(missing).toMatchObject({
      type: "call",
      to: DAI,
      call: { address: DAI, namespace: undefined, call: undefined, outcome: { type: "unhandled" } },
    });
    expect(missing?.outcome.type === "unhandled" && missing.outcome.error).toBeInstanceOf(
      MockNotFoundError,
    );
  });

  test("a multicall lists each sub-call with its own outcome", async () => {
    const { mock, client } = setup();
    mock.contract({ abi: tokenAbi, address: USDC, name: "USDC" }).read.decimals().returns(6);
    mock.contract({ abi: tokenAbi, address: DAI }).read.decimals().reverts("paused");
    mock.empty(NOWHERE);

    await client.multicall({
      contracts: [
        { abi: tokenAbi, address: USDC, functionName: "decimals" },
        { abi: tokenAbi, address: DAI, functionName: "decimals" },
        { abi: tokenAbi, address: NOWHERE, functionName: "decimals" },
      ],
    });
    const entry = only(mock.history, "multicall");
    expect(entry.batchId).toBe(1);
    expect(entry.calls).toMatchObject([
      { name: "USDC", call: { functionName: "decimals" }, outcome: { type: "result", value: 6 } },
      { address: DAI, outcome: { type: "revert", reason: "paused" } },
      { address: NOWHERE, call: undefined, outcome: { type: "result", value: "0x" } },
    ]);
    expect(entry.outcome).toMatchObject({
      type: "result",
      value: [{ success: true }, { success: false }, { success: true }],
    });
  });

  test("actions record their call, and their value in viem's types", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: alice }).returns(5n);

    await client.getBalance({ address: alice });
    await client.getBlock();
    const [balance, block] = mock.history;
    expect(balance).toMatchObject({
      type: "action",
      action: "getBalance",
      call: { address: getAddress(alice), blockNumber: 10n },
      outcome: { type: "result", value: 5n },
    });
    expect(block).toMatchObject({
      type: "action",
      action: "getBlock",
      outcome: { type: "result", value: { number: 10n, timestamp: 1_700_000_000n } },
    });
  });

  test("raw methods and built-ins", async () => {
    const { mock, client } = setup();
    mock.method("eth_getBlockTransactionCountByNumber").returns("0x1");

    await client.getBlockTransactionCount();
    await client.getChainId();
    await client.getBlockNumber();
    expect(mock.history).toMatchObject([
      {
        type: "method",
        method: "eth_getBlockTransactionCountByNumber",
        outcome: { type: "result", value: "0x1" },
      },
      { type: "builtIn", method: "eth_chainId", outcome: { type: "result", value: base.id } },
      { type: "builtIn", method: "eth_blockNumber", outcome: { type: "result", value: 10n } },
    ]);
    expect(mock.history[0]).not.toHaveProperty("call");
  });

  test("an entry is pending until its answer arrives", async () => {
    const { mock, read } = setup();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    mock
      .contract({ abi: tokenAbi, address: USDC })
      .read.decimals()
      .returns(async () => {
        await gate;
        return 6;
      });

    const pending = read(USDC, "decimals");
    await Promise.resolve();
    expect(mock.history[0]?.outcome).toEqual({ type: "pending" });
    release();
    await pending;
    expect(mock.history[0]?.outcome).toEqual({ type: "result", value: 6 });
  });

  test("a pending entry already says what it asked", async () => {
    const { mock, read } = setup();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const usdc = mock.contract({ abi: tokenAbi, address: USDC, name: "USDC" });
    let mid: string | undefined;
    usdc.read.symbol().returns(async () => {
      mid = mock.formatHistory();
      await gate;
      return "USDC";
    });

    const pending = read(USDC, "symbol");
    await vi.waitFor(() => {
      expect(mid).toBeDefined();
    });
    release();
    await pending;
    expect(mid).toBe("#1 eth_call USDC.symbol() … pending");
  });

  test("clearCalls(), restore(), and reset() clear it", async () => {
    const { mock, read } = setup();
    mock.contract({ abi: tokenAbi, address: USDC }).read.decimals().returns(6);
    const baseline = mock.checkpoint();

    await read(USDC, "decimals");
    mock.clearCalls();
    expect(mock.history).toEqual([]);
    await read(USDC, "decimals");
    baseline.restore();
    expect(mock.history).toEqual([]);
    await read(USDC, "decimals");
    mock.reset();
    expect(mock.history).toEqual([]);
  });

  test("entries narrow on type and outcome.type", () => {
    const { mock } = setup();
    for (const entry of mock.history) {
      if (entry.type === "multicall") expectTypeOf(entry.calls).toBeArray();
      if (entry.type === "action" && entry.action === "getBalance")
        expectTypeOf(entry.call).toEqualTypeOf<
          { address: `0x${string}`; blockNumber: bigint; blockTag?: BlockTag } | undefined
        >();
      if (entry.outcome.type === "revert")
        expectTypeOf(entry.outcome.data).toEqualTypeOf<`0x${string}`>();
    }
  });
});

describe("a request's entry says what it asked from the moment it arrives", () => {
  test("a failRequests() outage that never recovers shows each request's call, though no mock received it", async () => {
    const mock = createMockRpc({ chain: base, blockNumber: 10n });
    const client = mock.publicClient({ retryCount: 2 });
    const usdc = mock.contract({ abi: tokenAbi, address: USDC, name: "USDC" });
    usdc.read.balanceOf().returns(5n);
    usdc.estimateGas.transfer().returns(65_000n);
    usdc.write.transfer().returns();
    mock.actions.getBalance().returns(1n);
    const transfer = { abi: tokenAbi, functionName: "transfer", args: [alice, 1n] } as const;
    const raw = await signer.signTransaction({
      to: USDC,
      data: encodeFunctionData(transfer),
      gas: 100_000n,
      maxFeePerGas: 1n,
      chainId: base.id,
    });
    mock.failRequests("timeout");

    const balanceOf = {
      abi: tokenAbi,
      address: USDC,
      functionName: "balanceOf",
      args: [alice],
    } as const;
    await rejectionOf(client.readContract(balanceOf));
    await rejectionOf(client.getBalance({ address: alice }));
    await rejectionOf(client.multicall({ contracts: [balanceOf, balanceOf], allowFailure: false }));
    await rejectionOf(client.estimateContractGas({ ...transfer, address: USDC, account: alice }));
    await rejectionOf(client.sendRawTransaction({ serializedTransaction: raw }));
    await rejectionOf(
      mock.request({
        method: "eth_sendTransaction",
        params: [{ from: alice, to: USDC, data: encodeFunctionData(transfer) }],
      }),
    );

    // viem retries each read twice; it never retries a send.
    expect(mock.formatHistory().split("\n")).toEqual([
      "#1 eth_call USDC.balanceOf(0xa41f…2D9e) ✗ fault: timeout (failRequests)",
      "#2 eth_call USDC.balanceOf(0xa41f…2D9e) (retry) ✗ fault: timeout (failRequests)",
      "#3 eth_call USDC.balanceOf(0xa41f…2D9e) (retry) ✗ fault: timeout (failRequests)",
      '#4 eth_getBalance getBalance({ address: 0xa41f…2D9e, blockNumber: 10n, blockTag: "latest" }) ✗ fault: timeout (failRequests)',
      '#5 eth_getBalance getBalance({ address: 0xa41f…2D9e, blockNumber: 10n, blockTag: "latest" }) (retry) ✗ fault: timeout (failRequests)',
      '#6 eth_getBalance getBalance({ address: 0xa41f…2D9e, blockNumber: 10n, blockTag: "latest" }) (retry) ✗ fault: timeout (failRequests)',
      "#7 eth_call multicall, batch 1 (2 calls) ✗ fault: timeout (failRequests)",
      "   ├ USDC.balanceOf(0xa41f…2D9e) – not reached",
      "   └ USDC.balanceOf(0xa41f…2D9e) – not reached",
      "#8 eth_call multicall, batch 2 (2 calls) (retry) ✗ fault: timeout (failRequests)",
      "   ├ USDC.balanceOf(0xa41f…2D9e) – not reached",
      "   └ USDC.balanceOf(0xa41f…2D9e) – not reached",
      "#9 eth_call multicall, batch 3 (2 calls) (retry) ✗ fault: timeout (failRequests)",
      "   ├ USDC.balanceOf(0xa41f…2D9e) – not reached",
      "   └ USDC.balanceOf(0xa41f…2D9e) – not reached",
      "#10 eth_estimateGas estimateGas USDC.transfer(0xa41f…2D9e, 1n) ✗ fault: timeout (failRequests)",
      "#11 eth_estimateGas estimateGas USDC.transfer(0xa41f…2D9e, 1n) (retry) ✗ fault: timeout (failRequests)",
      "#12 eth_estimateGas estimateGas USDC.transfer(0xa41f…2D9e, 1n) (retry) ✗ fault: timeout (failRequests)",
      "#13 eth_sendRawTransaction write USDC.transfer(0xa41f…2D9e, 1n) ✗ fault: timeout (failRequests)",
      "#14 eth_sendTransaction write USDC.transfer(0xa41f…2D9e, 1n) ✗ fault: timeout (failRequests)",
    ]);
    const [call, balance, batch, estimate, rawSend, send] = [0, 3, 6, 9, 12, 13].map(
      (i) => mock.history[i],
    );
    expect(isType(call, "call") && call.call).toMatchObject({
      call: { functionName: "balanceOf", args: [alice] },
      outcome: { type: "notReached" },
    });
    expect(call).not.toHaveProperty("contract");
    expect(balance).not.toHaveProperty("contract");
    expect(isType(balance, "action") && balance.call).toEqual({
      address: alice,
      blockNumber: 10n,
      blockTag: "latest",
    });
    expect(isType(batch, "multicall") && batch.calls).toMatchObject([
      { call: { functionName: "balanceOf" }, outcome: { type: "notReached" } },
      { call: { functionName: "balanceOf" }, outcome: { type: "notReached" } },
    ]);
    expect(isType(estimate, "action") && estimate.contract).toMatchObject({
      namespace: "estimateGas",
      call: { functionName: "transfer", from: alice },
      outcome: { type: "notReached" },
    });
    expect(isType(rawSend, "action") && rawSend.contract).toMatchObject({
      namespace: "write",
      call: { functionName: "transfer", from: signer.address },
      outcome: { type: "notReached" },
    });
    expect(isType(send, "action") && send.contract).toMatchObject({
      namespace: "write",
      call: { functionName: "transfer", from: alice },
      outcome: { type: "notReached" },
    });
    expect(isType(send, "action") && send.call).toMatchObject({ from: alice, to: USDC });
    expect(mock.history.map(({ outcome }) => outcome)).toEqual(
      Array.from({ length: 14 }, () => ({
        type: "fault",
        fault: "timeout",
        source: "failRequests",
      })),
    );
    expect(mock.calls).toEqual([]);
    expect(usdc.calls).toEqual([]);
    expect(usdc.read.balanceOf.calls).toEqual([]);
    expect(usdc.estimateGas.transfer.calls).toEqual([]);
    expect(usdc.write.transfer.calls).toEqual([]);
    expect(mock.actions.getBalance.calls).toEqual([]);
    expect(mock.actions.estimateGas.calls).toEqual([]);
    expect(mock.actions.sendTransaction.calls).toEqual([]);
    expect(mock.transactions).toEqual([]);
  });

  test("a faulted raw send's line is decoded as soon as the request is made", async () => {
    const { mock } = setup();
    mock.contract({ abi: tokenAbi, address: USDC, name: "USDC" });
    const raw = await signer.signTransaction({
      to: USDC,
      data: encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [alice, 1n] }),
      gas: 100_000n,
      maxFeePerGas: 1n,
      chainId: base.id,
    });
    mock.failRequests("timeout", { times: 1 });

    const sent = mock.request({ method: "eth_sendRawTransaction", params: [raw] });
    const line = mock.formatHistory();
    await rejectionOf(sent);

    expect(line).toBe(
      "#1 eth_sendRawTransaction write USDC.transfer(0xa41f…2D9e, 1n) ✗ fault: timeout (failRequests)",
    );
  });

  test("a batch that fails partway shows every sub-call, those after the failure not reached", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: tokenAbi, address: USDC, name: "USDC" });
    usdc.read.decimals().returns(6);
    usdc.read.totalSupply().returns(100n);
    const call = (functionName: "decimals" | "symbol" | "totalSupply") =>
      ({ abi: tokenAbi, address: USDC, functionName }) as const;

    await rejectionOf(
      client.multicall({
        contracts: [call("decimals"), call("symbol"), call("totalSupply")],
        allowFailure: false,
      }),
    );

    expect(mock.formatHistory()).toBe(
      [
        "#1 eth_call multicall, batch 1 (3 calls) ✗ not mocked",
        "   ├ USDC.decimals() → 6",
        "   ├ USDC.symbol() ✗ not mocked",
        "   └ USDC.totalSupply() – not reached",
      ].join("\n"),
    );
    expect(only(mock.history, "multicall").calls[2]?.outcome).toEqual({ type: "notReached" });
    expect(usdc.calls.map(({ functionName }) => functionName)).toEqual(["decimals", "symbol"]);
  });

  test("a sub-call that reverts fails a batch that doesn't allow it, and the rest aren't reached", async () => {
    const { mock } = setup();
    const usdc = mock.contract({ abi: tokenAbi, address: USDC, name: "USDC" });
    usdc.read.decimals().reverts("paused");
    usdc.read.symbol().returns("USDC");

    // viem's multicall() lets every sub-call fail, so it's encoded by hand.
    await rejectionOf(strictBatch(mock, ["decimals", "symbol"]));

    expect(mock.formatHistory()).toBe(
      [
        '#1 eth_call multicall, batch 1 (2 calls) ✗ reverted: "Multicall3: call failed"',
        '   ├ USDC.decimals() ✗ reverted: "paused"',
        "   └ USDC.symbol() – not reached",
      ].join("\n"),
    );
    expect(usdc.calls.map(({ functionName }) => functionName)).toEqual(["decimals"]);
  });

  test("a refused eth_call keeps the address it's to, and one to Multicall3 is a batch without an id", async () => {
    const { mock } = setup();
    mock.contract({ abi: tokenAbi, address: USDC, name: "USDC" });
    const multicall3 = base.contracts.multicall3.address;

    // The block tag is malformed, so the params are refused.
    const refused = (to: string) =>
      rejectionOf(mock.request({ method: "eth_call", params: [{ to, data: "0x" }, "latest!"] }));
    await refused(USDC.toLowerCase());
    await refused(multicall3);
    await rejectionOf(mock.request({ method: "eth_call", params: [{ data: "0x12" }, "latest"] }));

    expect(mock.history).toMatchObject([
      { type: "call", to: USDC, call: undefined, outcome: { type: "rpcError", code: -32602 } },
      { type: "multicall", batchId: undefined, calls: [], outcome: { type: "rpcError" } },
      { type: "call", to: undefined, call: undefined, outcome: { type: "unhandled" } },
    ]);
    const [toUsdc, toMulticall3, noTo] = mock.formatHistory().split("\n");
    expect(toUsdc).toMatch(`#1 eth_call ${USDC} ✗ rpc error -32602: invalid params`);
    expect(toMulticall3).toMatch("#2 eth_call multicall ✗ rpc error -32602: invalid params");
    expect(noTo).toBe("#3 eth_call (no to) ✗ not mocked");
  });

  test("no settled entry holds a pending record, however its request ended", async () => {
    const mock = createMockRpc({ chain: base, blockNumber: 10n });
    const client = mock.publicClient({ retryCount: 0 });
    const usdc = mock.contract({ abi: tokenAbi, address: USDC, name: "USDC" });
    usdc.read.decimals().returns(6);
    usdc.read.symbol().reverts("paused");
    usdc.read.totalSupply().fails({ status: 503 });
    usdc.read.name().returns(() => {
      throw new Error("resolver broke");
    });
    usdc.estimateGas.transfer().returns(65_000n);
    usdc.write.transfer([alice, 1n]).returns({});
    usdc.write.transfer([alice, 2n]).returns({ status: "reverted" });
    mock.empty(NOWHERE);
    const read = (functionName: "decimals" | "symbol" | "totalSupply" | "name" | "balanceOf") =>
      functionName === "balanceOf"
        ? ({ abi: tokenAbi, address: USDC, functionName, args: [alice] } as const)
        : ({ abi: tokenAbi, address: USDC, functionName } as const);
    const transfer = (amount: bigint) =>
      ({ abi: tokenAbi, functionName: "transfer", args: [alice, amount] }) as const;
    const send = (amount: bigint) =>
      mock.request({
        method: "eth_sendTransaction",
        params: [{ from: alice, to: USDC, data: encodeFunctionData(transfer(amount)) }],
      });

    await Promise.allSettled([
      ...(["decimals", "symbol", "totalSupply", "name", "balanceOf"] as const).map((name) =>
        client.readContract(read(name)),
      ),
      client.call({ to: NOWHERE, data: "0x12345678" }),
      client.call({ to: DAI, data: "0x12345678" }),
      client.multicall({ contracts: [read("decimals"), read("symbol")] }),
      client.multicall({ contracts: [read("decimals"), read("totalSupply"), read("symbol")] }),
      strictBatch(mock, ["symbol", "decimals"]),
      client.estimateContractGas({ ...transfer(1n), address: USDC, account: alice }),
      client.estimateContractGas({ ...transfer(3n), address: USDC }),
      send(1n),
      send(2n),
      send(3n),
      mock.request({ method: "eth_getBalance", params: ["0x12", "latest"] }),
    ]);
    mock.failRequests("timeout");
    await Promise.allSettled([
      client.readContract(read("decimals")),
      client.multicall({ contracts: [read("decimals"), read("symbol")] }),
      client.estimateContractGas({ ...transfer(1n), address: USDC, account: alice }),
      send(1n),
    ]);

    const records = mock.history.flatMap((entry) => {
      if (entry.type === "call") return entry.call ? [entry.call] : [];
      if (entry.type === "multicall") return entry.calls;
      if (entry.type === "action") return entry.contract ? [entry.contract] : [];
      return [];
    });
    expect(new Set(records.map(({ outcome }) => outcome.type))).toEqual(
      new Set(["result", "revert", "fault", "unhandled", "notReached"]),
    );
    expect(new Set(mock.history.map(({ outcome }) => outcome.type))).toEqual(
      new Set(["result", "revert", "fault", "unhandled", "rpcError"]),
    );
  });

  test("a faulted eth_call to an empty() or unregistered address shows the address, not reached", async () => {
    const { mock, client } = setup();
    mock.empty(NOWHERE);
    mock.failRequests("timeout");

    await rejectionOf(client.call({ to: NOWHERE, data: "0x12345678" }));
    await rejectionOf(client.call({ to: DAI, data: "0x12345678" }));

    expect(mock.history.map((entry) => isType(entry, "call") && entry.call)).toEqual(
      [NOWHERE, DAI].map((address) => ({
        address,
        name: undefined,
        namespace: undefined,
        abiItem: undefined,
        call: undefined,
        outcome: { type: "notReached" },
      })),
    );
    expect(mock.formatHistory().split("\n")).toEqual([
      "#1 eth_call 0x0000…dEaD ✗ fault: timeout (failRequests)",
      "#2 eth_call 0x6B17…1d0F ✗ fault: timeout (failRequests)",
    ]);
  });

  test("a faulted request reaches no mock: no predicate runs", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: tokenAbi, address: USDC, name: "USDC" });
    const holder = vi.fn((address: `0x${string}`) => address === alice);
    usdc.read.balanceOf([match.where(holder)]).returns(5n);
    mock.actions.getBalance({ address: match.where(holder) }).returns(1n);
    mock.failRequests("timeout");

    await rejectionOf(
      client.readContract({
        abi: tokenAbi,
        address: USDC,
        functionName: "balanceOf",
        args: [alice],
      }),
    );
    await rejectionOf(client.getBalance({ address: alice }));

    expect(holder).not.toHaveBeenCalled();
  });

  test("a fault wins over params that can't be read, which show as sent", async () => {
    const { mock } = setup();
    mock.failRequests("timeout", { times: 1 });

    await rejectionOf(mock.request({ method: "eth_getBalance", params: ["0x12", "latest"] }));
    await rejectionOf(mock.request({ method: "eth_getBalance", params: ["0x12", "latest"] }));

    expect(mock.formatHistory().split("\n")).toEqual([
      '#1 eth_getBalance(0x12, "latest") ✗ fault: timeout (failRequests)',
      '#2 eth_getBalance(0x12, "latest") (retry) ✗ rpc error -32602: invalid params: expected an address; got 0x12',
    ]);
  });
});

/** An `aggregate3` call of USDC's `functions`, none allowed to fail. */
function strictBatch(mock: MockRpc, functions: ("decimals" | "symbol")[]) {
  const calls = functions.map(
    (functionName) =>
      ({
        target: USDC,
        allowFailure: false,
        callData: encodeFunctionData({ abi: tokenAbi, functionName }),
      }) as const,
  );
  const data = encodeFunctionData({
    abi: multicall3Abi,
    functionName: "aggregate3",
    args: [calls],
  });
  return mock.request({
    method: "eth_call",
    params: [{ to: base.contracts.multicall3.address, data }, "latest"],
  });
}

describe("formatHistory()", () => {
  test("a string is quoted, with its own quotes escaped; hex stays bare", async () => {
    const { mock, read } = setup();
    const usdc = mock.contract({ abi: tokenAbi, address: USDC, name: "USDC" });
    usdc.read.symbol().returns("USDC");
    usdc.read.decimals().reverts('not "owner"');

    await read(USDC, "symbol");
    await rejectionOf(read(USDC, "decimals"));

    expect(mock.formatHistory()).toBe(
      [
        '#1 eth_call USDC.symbol() → "USDC"',
        '#2 eth_call USDC.decimals() ✗ reverted: "not \\"owner\\""',
      ].join("\n"),
    );
  });

  test("one line per request, and per multicall sub-call", async () => {
    const { mock, client, read } = setup({ retryCount: 1 });
    const usdc = mock.contract({ abi: tokenAbi, address: USDC, name: "USDC" });
    usdc.read.decimals().returns(6);
    usdc.read.balanceOf([alice]).returns(5n);
    usdc.read.symbol().fails({ status: 503 });
    mock
      .contract({ abi: tokenAbi, address: DAI })
      .read.decimals()
      .reverts({ errorName: "EnforcedPause" });
    mock.actions.getBalance().returns(10n ** 18n);

    await read(USDC, "decimals");
    await client.multicall({
      contracts: [
        { abi: tokenAbi, address: USDC, functionName: "balanceOf", args: [alice] },
        { abi: tokenAbi, address: DAI, functionName: "decimals" },
      ],
    });
    await rejectionOf(read(USDC, "symbol"));
    await client.getBalance({ address: alice });
    await rejectionOf(client.getBlockTransactionCount());
    await client.getBlockNumber();

    expect(mock.formatHistory()).toBe(
      [
        "#1 eth_call USDC.decimals() → 6",
        "#2 eth_call multicall, batch 1 (2 calls)",
        "   ├ USDC.balanceOf(0xa41f…2D9e) → 5n",
        "   └ 0x6B17…1d0F.decimals() ✗ reverted: EnforcedPause()",
        "#3 eth_call USDC.symbol() ✗ fault: HTTP 503",
        "#4 eth_call USDC.symbol() (retry) ✗ fault: HTTP 503",
        '#5 eth_getBalance getBalance({ address: 0xa41f…2D9e, blockNumber: 10n, blockTag: "latest" }) → 1000000000000000000n',
        '#6 eth_getBlockTransactionCountByNumber("latest") ✗ not mocked',
        "#7 eth_blockNumber → 10n",
      ].join("\n"),
    );
  });

  test("a request repeated after a fault is a retry, bigint params included", async () => {
    const { mock } = setup();
    mock.method("x_y").returns(1);
    mock.failRequests("timeout", { times: 1 });
    const request = { method: "x_y", params: [1n] };

    await rejectionOf(mock.request(request));
    expect(await mock.request(request)).toBe(1);
    expect(mock.formatHistory()).toContain("#2 x_y(1n) (retry) → 1");
  });

  test("a retry is marked just before its outcome, on every kind of line", async () => {
    const { mock, client, read } = setup({ retryCount: 1 });
    const usdc = mock.contract({ abi: tokenAbi, address: USDC, name: "USDC" });
    mock.method("eth_getBlockTransactionCountByNumber").once().fails("timeout");
    mock.method("eth_getBlockTransactionCountByNumber").returns("0x1");
    usdc.read.symbol().once().fails("timeout");
    usdc.read.symbol().returns("USDC");
    mock.actions.getBalance().once().fails("timeout");
    mock.actions.getBalance().returns(5n);
    usdc.read.decimals().returns(6);
    usdc.estimateGas.transfer().once().fails("timeout");
    usdc.estimateGas.transfer().returns(65_000n);
    mock.actions.getLogs().once().fails("timeout");
    mock.actions.getLogs().returns([]);

    await client.getBlockTransactionCount();
    await read(USDC, "symbol");
    await client.getBalance({ address: alice });
    mock.failRequests("timeout", { times: 1 });
    await client.multicall({
      contracts: [
        { abi: tokenAbi, address: USDC, functionName: "symbol" },
        { abi: tokenAbi, address: USDC, functionName: "decimals" },
      ],
    });
    const transfer = { abi: tokenAbi, functionName: "transfer", args: [alice, 1n] } as const;
    await client.estimateContractGas({ ...transfer, address: USDC, account: alice });
    await client.getLogs({ address: USDC });
    mock.failRequests("timeout", { times: 2 });
    await rejectionOf(client.call({ to: NOWHERE, data: "0x12" }));

    expect(mock.formatHistory()).toBe(
      [
        '#1 eth_getBlockTransactionCountByNumber("latest") ✗ fault: timeout',
        '#2 eth_getBlockTransactionCountByNumber("latest") (retry) → 0x1',
        "#3 eth_call USDC.symbol() ✗ fault: timeout",
        '#4 eth_call USDC.symbol() (retry) → "USDC"',
        '#5 eth_getBalance getBalance({ address: 0xa41f…2D9e, blockNumber: 10n, blockTag: "latest" }) ✗ fault: timeout',
        '#6 eth_getBalance getBalance({ address: 0xa41f…2D9e, blockNumber: 10n, blockTag: "latest" }) (retry) → 5n',
        "#7 eth_call multicall, batch 1 (2 calls) ✗ fault: timeout (failRequests)",
        "   ├ USDC.symbol() – not reached",
        "   └ USDC.decimals() – not reached",
        "#8 eth_call multicall, batch 2 (2 calls) (retry)",
        '   ├ USDC.symbol() → "USDC"',
        "   └ USDC.decimals() → 6",
        "#9 eth_estimateGas estimateGas USDC.transfer(0xa41f…2D9e, 1n) ✗ fault: timeout",
        "#10 eth_estimateGas estimateGas USDC.transfer(0xa41f…2D9e, 1n) (retry) → 65000n",
        "#11 eth_getLogs getLogs(USDC, block 10n) ✗ fault: timeout",
        "#12 eth_getLogs getLogs(USDC, block 10n) (retry) → 0 logs",
        "#13 eth_call 0x0000…dEaD ✗ fault: timeout (failRequests)",
        "#14 eth_call 0x0000…dEaD (retry) ✗ fault: timeout (failRequests)",
      ].join("\n"),
    );
  });

  test("an action without its call prints its params as sent, and a batch never read no count", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance().returns(5n);
    const multicall3 = base.contracts.multicall3.address;

    await rejectionOf(mock.request({ method: "eth_getBalance", params: ["0x12", "latest"] }));
    mock.failRequests("timeout", { times: 2 });
    // Its call is read as it arrives, before the fault fails it.
    await rejectionOf(client.getBalance({ address: alice }));
    await rejectionOf(mock.request({ method: "eth_sendRawTransaction", params: ["0x02f8"] }));
    await rejectionOf(
      mock.request({ method: "eth_call", params: [{ to: multicall3, data: "0xzz" }, "latest"] }),
    );
    const getBlockNumber = encodeFunctionData({
      abi: parseAbi(["function getBlockNumber() view returns (uint256)"]),
      functionName: "getBlockNumber",
    });
    await rejectionOf(client.call({ to: multicall3, data: getBlockNumber }));

    expect(mock.formatHistory().split("\n")).toEqual([
      '#1 eth_getBalance(0x12, "latest") ✗ rpc error -32602: invalid params: expected an address; got 0x12',
      '#2 eth_getBalance getBalance({ address: 0xa41f…2D9e, blockNumber: 10n, blockTag: "latest" }) ✗ fault: timeout (failRequests)',
      "#3 eth_sendRawTransaction(0x02f8) ✗ fault: timeout (failRequests)",
      '#4 eth_call multicall ✗ rpc error -32602: invalid params: expected hex data for `data`; got "0xzz"',
      "#5 eth_call multicall ✗ not mocked",
    ]);
  });

  test("a request still pending prints what's known of it", async () => {
    const { mock, client } = setup();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const usdc = mock.contract({ abi: tokenAbi, address: USDC, name: "USDC" });
    usdc.read.decimals().returns(async () => {
      await gate;
      return 6;
    });
    mock.actions.getBalance().returns(async () => {
      await gate;
      return 5n;
    });
    usdc.estimateGas.transfer().returns(async () => {
      await gate;
      return 65_000n;
    });
    mock.empty(NOWHERE);
    const decimals = (address: `0x${string}`) =>
      ({ abi: tokenAbi, address, functionName: "decimals" }) as const;

    const balance = client.getBalance({ address: alice });
    const batch = client.multicall({
      contracts: [decimals(USDC), decimals(NOWHERE), decimals(DAI)],
    });
    const estimate = client.estimateContractGas({
      abi: tokenAbi,
      address: USDC,
      functionName: "transfer",
      args: [alice, 1n],
      account: alice,
    });
    await vi.waitFor(() => {
      expect(mock.history.filter((entry) => entry.type !== "builtIn")).toHaveLength(3);
    });
    expect(mock.formatHistory({ builtIns: false }).split("\n")).toEqual([
      '#1 eth_getBalance getBalance({ address: 0xa41f…2D9e, blockNumber: 10n, blockTag: "latest" }) … pending',
      "#2 eth_call multicall, batch 1 (3 calls) … pending",
      "   ├ USDC.decimals() … pending",
      "   ├ 0x0000…dEaD … pending",
      "   └ 0x6B17…1d0F … pending",
      "#3 eth_estimateGas estimateGas USDC.transfer(0xa41f…2D9e, 1n) … pending",
    ]);
    const pendingEstimate = mock.history.find((entry) => entry.method === "eth_estimateGas");
    expect(isType(pendingEstimate, "action") && pendingEstimate.contract?.outcome).toEqual({
      type: "pending",
    });
    release();
    await Promise.all([balance, batch, estimate]);
  });

  test("builtIns: false leaves out eth_chainId and eth_blockNumber, keeping numbers", async () => {
    const { mock, client } = setup();
    mock.method("eth_getBlockTransactionCountByNumber").returns("0x1");

    await client.getBlockNumber();
    await client.getBlockTransactionCount();
    expect(mock.formatHistory({ builtIns: false })).toBe(
      '#2 eth_getBlockTransactionCountByNumber("latest") → 0x1',
    );
  });

  test("a failed check's recent requests leave out built-ins, keeping numbers", async () => {
    const { mock, client } = setup();

    await client.getBlockNumber();
    await rejectionOf(client.getBlockTransactionCount());
    expectThrows(
      MockCheckError,
      'Requests so far:\n#2 eth_getBlockTransactionCountByNumber("latest") ✗ not mocked',
      () => {
        mock.assertNoUnhandled();
      },
    );
  });

  test("blocks and receipts are summarized", async () => {
    const { mock, client } = setup();
    mock.actions.getTransactionReceipt().returns({ logs: [testLog("noise", { address: USDC })] });

    await client.getBlock();
    await client.getTransactionReceipt({ hash: zeroHash });
    expect(mock.formatHistory()).toBe(
      [
        '#1 eth_getBlockByNumber getBlock({ blockNumber: 10n, blockTag: "latest", includeTransactions: false }) → block 10n, timestamp 1700000000n',
        "#2 eth_getTransactionReceipt getTransactionReceipt({ hash: 0x0000…0000 }) → success, block 10n, 1 log(s)",
      ].join("\n"),
    );
  });

  test("named outputs show by name; functions without outputs say so", async () => {
    const { mock, client } = setup();
    const pair = mock.contract({ abi: pairAbi, address: DAI, name: "Pair" });
    pair.read.getReserves().returns({ reserve0: 5n, reserve1: 7n });
    pair.read.price().returns([1n, 2n]);
    pair.simulate.deposit().returns();

    await client.readContract({ abi: pairAbi, address: DAI, functionName: "getReserves" });
    await client.readContract({ abi: pairAbi, address: DAI, functionName: "price" });
    await client.simulateContract({ abi: pairAbi, address: DAI, functionName: "deposit" });
    expect(mock.formatHistory({ builtIns: false })).toBe(
      [
        "#1 eth_call Pair.getReserves() → { reserve0: 5n, reserve1: 7n, blockTimestampLast: 0 }",
        "#2 eth_call Pair.price() → [1n, 2n]",
        "#3 eth_call Pair.deposit() → (no outputs)",
      ].join("\n"),
    );
    // The value stays what viem returns: a tuple.
    expect(mock.history[0]?.outcome).toEqual({ type: "result", value: [5n, 7n, 0] });
    expect(mock.history.map((entry) => entry.type === "call" && entry.call?.namespace)).toEqual([
      "read",
      "read",
      "simulate",
    ]);
  });

  test("a multicall of one says 1 call", async () => {
    const { mock, client } = setup();
    mock.contract({ abi: tokenAbi, address: USDC, name: "USDC" }).read.decimals().returns(6);

    await client.multicall({
      contracts: [{ abi: tokenAbi, address: USDC, functionName: "decimals" }],
    });
    expect(mock.formatHistory({ builtIns: false })).toContain("multicall, batch 1 (1 call)");
  });

  test("resolver errors show what threw", async () => {
    const { mock, read } = setup();
    mock
      .contract({ abi: tokenAbi, address: USDC, name: "USDC" })
      .read.decimals()
      .returns(() => {
        throw new Error("boom");
      });

    await rejectionOf(read(USDC, "decimals"));
    expect(mock.formatHistory()).toBe("#1 eth_call USDC.decimals() ✗ resolver threw: boom");
  });
});

describe("debug", () => {
  test("a function gets each line as its request finishes, with the entry", async () => {
    const lines: string[] = [];
    const entries: MockHistoryEntry[] = [];
    const mock = createMockRpc({
      debug: (line, entry) => {
        lines.push(line);
        entries.push(entry);
      },
    });
    mock.contract({ abi: tokenAbi, address: USDC, name: "USDC" }).read.decimals().returns(6);

    await mock
      .publicClient()
      .readContract({ abi: tokenAbi, address: USDC, functionName: "decimals" });
    expect(lines).toEqual(["#1 eth_call USDC.decimals() → 6"]);
    expect(entries[0]?.type).toBe("call");
  });

  test("true logs with console.log", async () => {
    const logged: unknown[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logged.push(...args);
    };
    try {
      const mock = createMockRpc({ debug: true });
      await mock.publicClient().getChainId();
    } finally {
      console.log = original;
    }
    expect(logged).toEqual([`#1 eth_chainId → 1`]);
  });

  test("false logs nothing, and the request is answered and recorded as without it", async () => {
    const mock = createMockRpc({ debug: false });
    const logged: unknown[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logged.push(...args);
    };
    try {
      expect(await mock.publicClient().getChainId()).toBe(1);
    } finally {
      console.log = original;
    }
    expect(logged).toEqual([]);
    expect(mock.history.map((entry) => entry.outcome)).toEqual([{ type: "result", value: 1 }]);
  });

  test("a function that throws fails the request once, as setup, not as the mock's bug", async () => {
    const mock = createMockRpc({
      debug: () => {
        throw new Error("boom");
      },
    });

    const error = await rejectionOf(mock.publicClient().getChainId());

    expect(findCause(error, MockSetupError)?.shortMessage).toBe("The debug function threw: boom");
    expect(mock.history.map((entry) => entry.outcome.type)).toEqual(["result"]);
    expect(mock.unhandled).toEqual([]);

    // A request it couldn't answer is still counted.
    await rejectionOf(mock.publicClient().getBlockTransactionCount());
    expect(mock.unhandled.map(({ method }) => method)).toEqual([
      "eth_getBlockTransactionCountByNumber",
    ]);
  });
});

function setupWith(historyOnFailure?: number | false) {
  const mock = createMockRpc(historyOnFailure === undefined ? {} : { historyOnFailure });
  const client = mock.publicClient();
  const usdc = mock.contract({ abi: tokenAbi, address: USDC, name: "USDC" });
  const decimals = () =>
    client.readContract({ abi: tokenAbi, address: USDC, functionName: "decimals" });
  return { mock, client, usdc, decimals };
}

/** The message `check` throws with, or `""`. */
function messageOf(check: () => void) {
  try {
    check();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

describe("historyOnFailure", () => {
  test("a failed check ends with the requests so far, without built-ins", async () => {
    const { mock, client, usdc, decimals } = setupWith();
    usdc.read.decimals().returns(6);
    usdc.read.symbol().returns("USDC");

    await client.getBlockNumber();
    await decimals();
    expect(
      messageOf(() => {
        mock.assertAllUsed();
      }),
    ).toBe(
      [
        "1 mock(s) answered no call:",
        `  - read.symbol(*) on USDC (${USDC})`,
        "    received no calls to read.symbol",
        "",
        "Requests so far:",
        "#2 eth_call USDC.decimals() → 6",
      ].join("\n"),
    );
  });

  test("shows the last 10 by default, numbered as in formatHistory()", async () => {
    const { mock, usdc, decimals } = setupWith();
    usdc.read.decimals().returns(6);
    usdc.read.symbol().returns("USDC");

    await Promise.all(Array.from({ length: 12 }, () => decimals()));
    const message = messageOf(() => {
      mock.assertAllUsed();
    });
    expect(message).toContain("Last 10 requests (2 earlier; see mock.formatHistory()):\n#3 ");
    expect(message).toMatch(/#12 eth_call USDC\.decimals\(\) → 6$/u);
    expect(message).not.toContain("#2 ");
  });

  test("takes a count, or false to leave it out", async () => {
    const short = setupWith(1);
    short.usdc.read.decimals().returns(6);
    await short.decimals();
    await short.decimals();
    expect(
      messageOf(() => {
        short.mock.assertAllUsed();
      }),
    ).toBe("");
    short.usdc.read.symbol().returns("USDC");
    expect(
      messageOf(() => {
        short.mock.assertAllUsed();
      }),
    ).toContain("Last request (1 earlier; see mock.formatHistory()):\n#2 eth_call");

    const off = setupWith(false);
    off.usdc.read.symbol().returns("USDC");
    await rejectionOf(off.decimals());
    expect(
      messageOf(() => {
        off.mock.assertNoUnhandled();
      }),
    ).not.toContain("Requests");
    expect(() => createMockRpc({ historyOnFailure: -1 })).toThrow(MockSetupError);
  });

  test("0 leaves it out, as false does", async () => {
    const { mock, usdc, decimals } = setupWith(0);
    usdc.read.symbol().returns("USDC");
    await rejectionOf(decimals());

    expect(
      messageOf(() => {
        mock.assertNoUnhandled();
      }),
    ).not.toContain("Requests");
  });

  test("restore() shows the history it's about to clear", async () => {
    const { mock, usdc, decimals } = setupWith();
    const baseline = mock.checkpoint();
    usdc.read.symbol().returns("USDC");
    await rejectionOf(decimals());

    const message = messageOf(() => {
      baseline.restore({ assertNoUnhandled: true, assertAllUsed: true });
    });
    expect(message).toContain("Requests so far:\n#1 eth_call USDC.decimals() ✗ not mocked");
    expect(mock.history).toEqual([]);
  });

  test("assertNoUnhandled() and checkpoint() show it too", async () => {
    const { mock, decimals } = setupWith();
    await rejectionOf(decimals());

    expect(
      messageOf(() => {
        mock.assertNoUnhandled();
      }),
    ).toContain("Requests so far:\n#1 eth_call USDC.decimals() ✗ not mocked");
    expect(
      messageOf(() => {
        mock.checkpoint();
      }),
    ).toContain("Requests so far:");
  });

  test("a retry at the start of the window is still marked", async () => {
    const { mock, usdc, decimals } = setupWith(1);
    usdc.read.decimals().returns(6);
    usdc.read.decimals().once().fails("network");
    usdc.read.symbol().returns("USDC");

    await decimals();
    expect(
      messageOf(() => {
        mock.assertAllUsed();
      }),
    ).toContain("#2 eth_call USDC.decimals() (retry) → 6");
  });

  test("no requests, no section", () => {
    const { mock, usdc } = setupWith();
    usdc.read.symbol().returns("USDC");

    expect(
      messageOf(() => {
        mock.assertAllUsed();
      }),
    ).not.toContain("Requests");
  });
});
