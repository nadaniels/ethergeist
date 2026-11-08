import { createPublicClient, erc20Abi, parseAbi } from "viem";
import { describe, expect, test, vi } from "vite-plus/test";

import {
  MockCheckError,
  MockNotFoundError,
  MockSetupError,
  createMockRpc,
  testAddress,
} from "../src/index.js";
import { expectCause, expectThrows, hintsOf, rejectionOf } from "./utils.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const alice = testAddress("alice");
const bob = testAddress("bob");

/** One name, two functions: their calls are listed together, in order. */
const overloadedAbi = parseAbi([
  "function quote(uint256 amount) view returns (uint256)",
  "function quote(address token) view returns (uint256)",
]);

function setup(historyLimit?: number, debug?: (line: string) => void) {
  const mock = createMockRpc({
    blockNumber: 10n,
    ...(historyLimit === undefined ? {} : { historyLimit }),
    ...(debug ? { debug } : {}),
  });
  const client = createPublicClient({
    chain: mock.chain,
    cacheTime: 0,
    transport: mock.transport({ retryCount: 0 }),
  });
  const usdc = mock.contract({ abi: erc20Abi, address: USDC, name: "USDC" });
  const totalSupply = () =>
    client.readContract({ abi: erc20Abi, address: USDC, functionName: "totalSupply" });
  return { mock, client, usdc, totalSupply };
}

/** A request nothing answers, as a function for `poll`. */
const unanswered = (mock: ReturnType<typeof createMockRpc>) => () =>
  rejectionOf(mock.request({ method: "eth_unmocked" }));

/** Sends `count` requests, one at a time. */
async function poll(count: number, request: () => Promise<unknown>) {
  for (let i = 0; i < count; i += 1) await request();
}

describe("historyLimit", () => {
  test("keeps the last N of each record", async () => {
    const { mock, client, usdc, totalSupply } = setup(2);
    usdc.read.totalSupply().returns(1n);
    mock.actions.getBalance().returns(1n);
    usdc.estimateGas.transfer().returns(50_000n);

    await poll(3, totalSupply);
    await poll(3, () => client.getBalance({ address: alice }));
    await poll(3, () =>
      client.estimateContractGas({
        abi: erc20Abi,
        address: USDC,
        functionName: "transfer",
        args: [bob, 1n],
        account: alice,
      }),
    );
    await poll(3, unanswered(mock));

    expect(mock.history).toHaveLength(2);
    expect(mock.unhandled).toHaveLength(2);
    // Every namespace's calls share the list: the last 2 are the estimates.
    expect(mock.calls.map((call) => call.namespace)).toEqual(["estimateGas", "estimateGas"]);
    expect(usdc.calls.map((call) => call.namespace)).toEqual(["estimateGas", "estimateGas"]);
    expect(usdc.read.totalSupply.calls).toHaveLength(2);
    expect(usdc.estimateGas.transfer.calls).toHaveLength(2);
    expect(mock.actions.getBalance.calls).toHaveLength(2);
  });

  test("a busy function doesn't push out a quiet one's calls", async () => {
    const { client, usdc, totalSupply } = setup(2);
    usdc.read.totalSupply().returns(1n);
    usdc.read.allowance().returns(0n);

    await client.readContract({
      abi: erc20Abi,
      address: USDC,
      functionName: "allowance",
      args: [alice, bob],
    });
    await poll(5, totalSupply);

    expect(usdc.read.allowance.calls).toHaveLength(1);
    expect(usdc.calls.map((call) => call.functionName)).toEqual(["totalSupply", "totalSupply"]);
  });

  test("an overloaded name lists each overload's calls, in the order received", async () => {
    const { mock, client } = setup(2);
    const token = mock.contract({ abi: overloadedAbi, address: alice });
    token.read.quote([1n]).returns(1n);
    token.read.quote([bob]).returns(1n);
    token.read.quote([2n]).returns(1n);
    const quote = (args: readonly [bigint] | readonly [`0x${string}`]) =>
      client.readContract({ abi: overloadedAbi, address: alice, functionName: "quote", args });

    await quote([1n]);
    await quote([bob]);
    await quote([2n]);

    // Each overload is a function of its own, keeping its own last 2.
    expect(token.read.quote.calls.map((call) => call.args)).toEqual([[1n], [bob], [2n]]);
  });

  test("a name in both read and simulate lists each namespace's overloads apart", async () => {
    const { mock, client } = setup();
    const abi = parseAbi([
      "function quote(uint256 amount) view returns (uint256)",
      "function quote(address token) returns (uint256)",
    ]);
    const token = mock.contract({ abi, address: alice });
    token.read.quote().returns(1n);
    token.simulate.quote().returns(2n);

    await client.readContract({ abi, address: alice, functionName: "quote", args: [1n] });
    await client.simulateContract({ abi, address: alice, functionName: "quote", args: [bob] });

    expect(token.read.quote.calls.map((call) => call.args)).toEqual([[1n]]);
    expect(token.simulate.quote.calls.map((call) => call.args)).toEqual([[bob]]);
  });

  test("history keeps numbering, and says how many it dropped", async () => {
    const { mock, usdc, totalSupply } = setup(2);
    usdc.read.totalSupply().returns(1n);
    await poll(4, totalSupply);

    expect(mock.formatHistory()).toBe(
      [
        "(2 older requests dropped, past historyLimit)",
        "#3 eth_call USDC.totalSupply() → 1n",
        "#4 eth_call USDC.totalSupply() → 1n",
      ].join("\n"),
    );
  });

  test("debug lines keep their numbers", async () => {
    const lines: string[] = [];
    const { mock } = setup(1, (line) => {
      lines.push(line);
    });
    await poll(3, () => mock.request({ method: "eth_blockNumber" }));

    expect(lines.map((line) => line.split(" ")[0])).toEqual(["#1", "#2", "#3"]);
  });

  test("clearCalls() starts the numbering and the count over", async () => {
    const { mock, usdc, totalSupply } = setup(1);
    usdc.read.totalSupply().returns(1n);
    await poll(3, totalSupply);
    mock.clearCalls();
    await totalSupply();

    expect(mock.formatHistory()).toBe("#1 eth_call USDC.totalSupply() → 1n");
  });

  test("a retry still explains itself once its fault is dropped", async () => {
    const mock = createMockRpc({ blockNumber: 10n, historyLimit: 1 });
    const client = createPublicClient({
      chain: mock.chain,
      transport: mock.transport({ retryCount: 1 }),
    });
    mock.contract({ abi: erc20Abi, address: USDC }).read.totalSupply().once().fails("network");

    const error = expectCause(
      await rejectionOf(
        client.readContract({ abi: erc20Abi, address: USDC, functionName: "totalSupply" }),
      ),
      MockNotFoundError,
    );
    expect(hintsOf(error)).toContain("This is viem retrying after a `.once()`/`.times(n)` fault");
    expect(mock.formatHistory()).toContain("#2 eth_call (retry)");
  });

  test("checks count every request, and say which they list", async () => {
    const { mock } = setup(2);
    await poll(3, unanswered(mock));

    expectThrows(
      MockCheckError,
      "The mock couldn't answer 3 request(s) (the last 2 kept, past historyLimit):\n" +
        '  - RPC method "eth_unmocked" is not mocked (×2).\n' +
        '      Mock it with mock.method("eth_unmocked", …).returns(…).\n\n',
      () => {
        mock.assertNoUnhandled();
      },
    );
    expectThrows(
      MockCheckError,
      "Can't checkpoint: 3 request(s) (the last 2 kept, past historyLimit) since the last clear",
      () => mock.checkpoint(),
    );
  });

  test("a failed check's recent requests say some were dropped", async () => {
    const { mock } = setup(2);
    await poll(3, unanswered(mock));

    expectThrows(
      MockCheckError,
      "Last 2 requests (1 older request dropped, past historyLimit):\n" +
        "#2 eth_unmocked ✗ not mocked\n#3 eth_unmocked ✗ not mocked",
      () => {
        mock.assertNoUnhandled();
      },
    );
  });

  test("assertAllUsed() counts every call a mock's function received", async () => {
    const { mock, client, usdc } = setup(2);
    mock.actions.getBalance({ address: bob }).returns(1n);
    mock.actions.getBalance().returns(2n);
    usdc.read.balanceOf([bob]).returns(1n);
    usdc.read.balanceOf().returns(2n);
    await poll(3, () => client.getBalance({ address: alice }));
    await poll(3, () =>
      client.readContract({
        abi: erc20Abi,
        address: USDC,
        functionName: "balanceOf",
        args: [alice],
      }),
    );

    expectThrows(
      MockCheckError,
      /received 3 calls to balanceOf \(the last 2 kept, past historyLimit\):/u,
      () => {
        mock.assertAllUsed();
      },
    );
    expectThrows(
      MockCheckError,
      /received 3 calls to getBalance \(the last 2 kept, past historyLimit\):/u,
      () => {
        mock.assertAllUsed();
      },
    );
  });

  test("a multicall is one request but several calls", async () => {
    const mock = createMockRpc({ blockNumber: 10n, historyLimit: 2 });
    const client = createPublicClient({
      chain: mock.chain,
      batch: { multicall: true },
      transport: mock.transport({ retryCount: 0 }),
    });
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.balanceOf().returns(1n);
    const balanceOf = (account: `0x${string}`) =>
      client.readContract({
        abi: erc20Abi,
        address: USDC,
        functionName: "balanceOf",
        args: [account],
      });

    await Promise.all(([alice, bob, USDC] as const).map((account) => balanceOf(account)));

    expect(mock.history).toHaveLength(1);
    expect(mock.calls.map((call) => call.args[0])).toEqual([bob, USDC]);
  });

  test("restore() and reset() start the numbering over", async () => {
    const { mock, usdc, totalSupply } = setup(1);
    usdc.read.totalSupply().returns(1n);
    const checkpoint = mock.checkpoint();
    await poll(3, totalSupply);
    checkpoint.restore();
    await totalSupply();
    expect(mock.formatHistory()).toBe("#1 eth_call USDC.totalSupply() → 1n");

    await poll(2, () => mock.request({ method: "eth_blockNumber" }));
    mock.reset();
    await mock.request({ method: "eth_blockNumber" });
    expect(mock.formatHistory()).toBe("#1 eth_blockNumber → 10n");
  });

  test("a request in flight across a clear is logged without a number", async () => {
    const lines: string[] = [];
    const { mock, usdc, totalSupply } = setup(10, (line) => {
      lines.push(line);
    });
    let release: (() => void) | undefined;
    usdc.read.totalSupply().returns(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 1n;
    });

    const pending = totalSupply();
    await Promise.resolve();
    mock.clearCalls();
    await mock.request({ method: "eth_blockNumber" });
    release?.();
    await pending;

    expect(lines).toEqual(["#1 eth_blockNumber → 10n", "#– eth_call USDC.totalSupply() → 1n"]);
  });

  test("a concurrent identical request isn't a retry", async () => {
    const { mock, usdc, totalSupply } = setup(10);
    usdc.read.totalSupply().returns(1n);
    usdc.read.totalSupply().once().fails("network");

    await Promise.allSettled([totalSupply(), totalSupply()]);

    expect(mock.formatHistory()).not.toContain("(retry)");
  });

  test("a failed check's heading separates earlier requests from dropped ones", async () => {
    const mock = createMockRpc({ historyLimit: 4, historyOnFailure: 2 });
    await poll(6, unanswered(mock));

    expectThrows(
      MockCheckError,
      "Last 2 requests (2 earlier; see mock.formatHistory(); 2 before those dropped, past " +
        "historyLimit):\n#5 eth_unmocked",
      () => {
        mock.assertNoUnhandled();
      },
    );
  });

  test("a failed check says when only built-ins are left", async () => {
    const mock = createMockRpc({ historyLimit: 1 });
    await poll(2, unanswered(mock));
    await mock.request({ method: "eth_blockNumber" });

    expectThrows(
      MockCheckError,
      "Requests so far: only built-ins kept (2 older requests dropped, past historyLimit).",
      () => {
        mock.assertNoUnhandled();
      },
    );
  });

  test("defaults to 1,000, warning once when it first drops one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { mock } = setup();
      await poll(1002, () => mock.request({ method: "eth_blockNumber" }));

      expect(mock.history).toHaveLength(1000);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("createMockRpc({ historyLimit })");
    } finally {
      warn.mockRestore();
    }
  });

  test("a limit you choose never warns; Infinity keeps everything", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const capped = setup(1).mock;
      const everything = setup(Infinity).mock;
      await poll(1001, () => everything.request({ method: "eth_blockNumber" }));
      await poll(3, () => capped.request({ method: "eth_blockNumber" }));

      expect(everything.history).toHaveLength(1001);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("an invalid limit throws", () => {
    expectThrows(MockSetupError, "historyLimit keeps at least 1 entry per record", () =>
      createMockRpc({ historyLimit: 0 }),
    );
    expectThrows(
      MockSetupError,
      "createMockRpc()'s historyLimit must be a positive integer; got 2.5.",
      () => createMockRpc({ historyLimit: 2.5 }),
    );
  });
});
