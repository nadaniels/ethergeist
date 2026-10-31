import { RpcRequestError, createPublicClient, parseGwei } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { type MockFees, createMockRpc } from "../src/index.js";
import { expectCause, rejectionOf } from "./utils.js";

function setup(fees: MockFees = {}) {
  const mock = createMockRpc({ blockNumber: 10n, fees });
  const client = createPublicClient({
    chain: mock.chain,
    cacheTime: 0,
    transport: mock.transport({ retryCount: 0 }),
  });
  return { mock, client };
}

describe("fees", () => {
  test("viem's fee estimates work unmocked, from whole-gwei defaults", async () => {
    const { mock, client } = setup();

    expect(await client.estimateFeesPerGas()).toEqual({
      maxFeePerGas: parseGwei("13"),
      maxPriorityFeePerGas: parseGwei("1"),
    });
    expect(await client.estimateFeesPerGas({ type: "legacy" })).toEqual({
      gasPrice: parseGwei("13.2"),
    });
    expect(() => {
      mock.assertNoUnhandled();
    }).not.toThrow();
  });

  test("the gas price is the base fee plus the tip, as reth suggests", async () => {
    const { client } = setup();

    expect(await client.getGasPrice()).toBe(parseGwei("11"));
    expect(await client.estimateMaxPriorityFeePerGas()).toBe(parseGwei("1"));
    expect((await client.getBlock()).baseFeePerGas).toBe(parseGwei("10"));
  });

  test("createMockRpc({ fees }) sets them; one left out keeps its default", async () => {
    const { client } = setup({ baseFeePerGas: parseGwei("50") });

    expect((await client.getBlock({ blockNumber: 3n })).baseFeePerGas).toBe(parseGwei("50"));
    expect(await client.getGasPrice()).toBe(parseGwei("51"));
    expect(await client.estimateFeesPerGas()).toEqual({
      maxFeePerGas: parseGwei("61"),
      maxPriorityFeePerGas: parseGwei("1"),
    });
  });

  test("zero fees are allowed; others that aren't fees throw", () => {
    expect(() =>
      createMockRpc({ fees: { baseFeePerGas: 0n, maxPriorityFeePerGas: 0n } }),
    ).not.toThrow();
    expect(() => createMockRpc({ fees: { baseFeePerGas: -1n } })).toThrow(
      "fees.baseFeePerGas can't be negative; got -1.",
    );
    // @ts-expect-error -- not a bigint
    expect(() => createMockRpc({ fees: { maxPriorityFeePerGas: 1 } })).toThrow(
      "fees.maxPriorityFeePerGas must be a bigint; got number.",
    );
  });

  test("the blob base fee is 1 wei, the minimum: generated blocks have no excess blob gas", async () => {
    const { client } = setup();

    expect(await client.getBlobBaseFee()).toBe(1n);
  });
});

/** An `eth_feeHistory` request as the node gets it. */
function feeHistoryRaw(mock: ReturnType<typeof setup>["mock"], params: unknown[]) {
  return mock.request({ method: "eth_feeHistory", params });
}

/** The RPC error a request rejects with, after checking it isn't counted as unhandled. */
async function refusal(mock: ReturnType<typeof setup>["mock"], promise: Promise<unknown>) {
  const error = expectCause(await rejectionOf(promise), RpcRequestError);
  expect(mock.unhandled).toEqual([]);
  return { code: error.code, message: error.details };
}

describe("getFeeHistory", () => {
  test("answers for generated blocks: base fees from `fees`, and zero rewards as they're empty", async () => {
    const { client } = setup();

    expect(await client.getFeeHistory({ blockCount: 2, rewardPercentiles: [25, 75] })).toEqual({
      baseFeePerGas: [parseGwei("10"), parseGwei("10"), parseGwei("10")],
      gasUsedRatio: [0, 0],
      oldestBlock: 9n,
      reward: [
        [0n, 0n],
        [0n, 0n],
      ],
    });
  });

  test("in reth's shape: blob fields too, one more base fee than blocks (the next block's)", async () => {
    const { mock } = setup();

    expect(await feeHistoryRaw(mock, ["0x2", "latest", [50]])).toEqual({
      baseFeePerGas: ["0x2540be400", "0x2540be400", "0x2540be400"],
      gasUsedRatio: [0, 0],
      baseFeePerBlobGas: ["0x1", "0x1", "0x1"],
      blobGasUsedRatio: [0, 0],
      oldestBlock: "0x9",
      reward: [["0x0"], ["0x0"]],
    });
  });

  test("percentiles decide reward: none leaves it out, an empty list gives empty ones", async () => {
    const { mock } = setup();

    expect(await feeHistoryRaw(mock, [2, "latest"])).not.toHaveProperty("reward");
    expect(await feeHistoryRaw(mock, ["0x2", "latest", []])).toMatchObject({ reward: [[], []] });
  });

  test("the count stops at block 0, and at 1024 blocks", async () => {
    const { mock, client } = setup();
    mock.mine(2000n);

    const early = await client.getFeeHistory({
      blockCount: 20,
      blockNumber: 3n,
      rewardPercentiles: [],
    });
    expect(early.oldestBlock).toBe(0n);
    expect(early.gasUsedRatio).toHaveLength(4);
    const long = await client.getFeeHistory({ blockCount: 2000, rewardPercentiles: [] });
    expect(long.gasUsedRatio).toHaveLength(1024);
    expect(long.baseFeePerGas).toHaveLength(1025);
  });

  test("a count of 0 has two fields, as on reth, which viem's formatter can't read", async () => {
    const { mock, client } = setup();

    expect(await feeHistoryRaw(mock, ["0x0", "latest", []])).toEqual({
      gasUsedRatio: [],
      oldestBlock: "0x0",
    });
    // viem maps baseFeePerGas, which reth leaves out.
    await expect(client.getFeeHistory({ blockCount: 0, rewardPercentiles: [] })).rejects.toThrow(
      TypeError,
    );
  });

  test("a newest block past the head is refused, in reth's words", async () => {
    const { mock, client } = setup();

    expect(
      await refusal(
        mock,
        client.getFeeHistory({ blockCount: 2, blockNumber: 12n, rewardPercentiles: [] }),
      ),
    ).toEqual({ code: -32602, message: "request beyond head block: requested 12, head 10" });
  });

  test("percentiles out of order or past 100 are refused", async () => {
    const { mock, client } = setup();

    for (const rewardPercentiles of [[75, 25], [101], [-1]])
      expect(
        // oxlint-disable-next-line eslint/no-await-in-loop -- one case at a time
        await refusal(mock, client.getFeeHistory({ blockCount: 1, rewardPercentiles })),
      ).toEqual({ code: -32602, message: "invalid reward percentiles" });
    await expect(
      client.getFeeHistory({ blockCount: 1, rewardPercentiles: [50, 50] }),
    ).resolves.toBeDefined();
  });

  test("a mock's fields merge over the generated history", async () => {
    const { mock, client } = setup();
    mock.actions
      .getFeeHistory({ blockCount: 2 })
      .returns({ gasUsedRatio: [0.5, 0.9], reward: [[parseGwei("2")], [parseGwei("3")]] });

    expect(await client.getFeeHistory({ blockCount: 2, rewardPercentiles: [50] })).toEqual({
      baseFeePerGas: [parseGwei("10"), parseGwei("10"), parseGwei("10")],
      gasUsedRatio: [0.5, 0.9],
      oldestBlock: 9n,
      reward: [[parseGwei("2")], [parseGwei("3")]],
    });
    expect(mock.actions.getFeeHistory.calls).toEqual([
      { blockCount: 2, blockNumber: 10n, blockTag: "latest", rewardPercentiles: [50] },
    ]);
  });

  test("a mock answers before the refusals", async () => {
    const { mock, client } = setup();
    mock.actions.getFeeHistory().returns(({ blockNumber }) => ({ oldestBlock: blockNumber }));

    const history = await client.getFeeHistory({
      blockCount: 1,
      blockNumber: 50n,
      rewardPercentiles: [],
    });
    expect(history.oldestBlock).toBe(50n);
  });

  test("a mock's fields must have viem's types", () => {
    const { mock } = setup();

    expect(() => {
      // @ts-expect-error -- base fees are bigints
      mock.actions.getFeeHistory().returns({ baseFeePerGas: ["0x1"] });
    }).toThrow("A fee history's baseFeePerGas must be bigints.");
    expect(() => {
      // @ts-expect-error -- not a field
      mock.actions.getFeeHistory().returns({ baseFee: [1n] });
    }).toThrow('A fee history has no field "baseFee".');
  });

  test("history shows the call and the answer in viem's types", async () => {
    const { mock, client } = setup();

    await client.getFeeHistory({ blockCount: 1, rewardPercentiles: [] });
    expect(mock.history[0]).toMatchObject({
      type: "action",
      action: "getFeeHistory",
      outcome: {
        type: "result",
        value: { oldestBlock: 10n, baseFeePerGas: [parseGwei("10"), parseGwei("10")] },
      },
    });
  });
});

describe("setFees()", () => {
  test("changes the fees from the current block on; earlier blocks keep theirs", async () => {
    const { mock, client } = setup();
    mock.setFees({ baseFeePerGas: parseGwei("50") });

    expect((await client.getBlock()).baseFeePerGas).toBe(parseGwei("50"));
    expect((await client.getBlock({ blockNumber: 9n })).baseFeePerGas).toBe(parseGwei("10"));
    expect(await client.getGasPrice()).toBe(parseGwei("51"));
    expect(await client.estimateFeesPerGas()).toEqual({
      maxFeePerGas: parseGwei("61"),
      maxPriorityFeePerGas: parseGwei("1"),
    });
    mock.mine();
    expect((await client.getBlock()).baseFeePerGas).toBe(parseGwei("50"));
  });

  test("fees left out stay as they are", async () => {
    const { mock, client } = setup({ baseFeePerGas: parseGwei("20") });
    mock.setFees({ maxPriorityFeePerGas: parseGwei("3") });

    expect(await client.estimateMaxPriorityFeePerGas()).toBe(parseGwei("3"));
    expect(await client.getGasPrice()).toBe(parseGwei("23"));
  });

  test("a fee history shows each block's fees", async () => {
    const { mock, client } = setup();
    mock.mine();
    mock.setFees({ baseFeePerGas: parseGwei("50") });
    mock.mine();

    const history = await client.getFeeHistory({ blockCount: 3, rewardPercentiles: [] });
    expect(history.oldestBlock).toBe(10n);
    // one base fee per block (10–12), plus the next block (13)
    expect(history.baseFeePerGas).toEqual([
      parseGwei("10"),
      parseGwei("50"),
      parseGwei("50"),
      parseGwei("50"),
    ]);
  });

  test("a second change in the same block replaces the first", async () => {
    const { mock, client } = setup();
    mock.setFees({ baseFeePerGas: parseGwei("50") });
    mock.setFees({ baseFeePerGas: parseGwei("60") });

    expect((await client.getBlock()).baseFeePerGas).toBe(parseGwei("60"));
    expect((await client.getBlock({ blockNumber: 9n })).baseFeePerGas).toBe(parseGwei("10"));
  });

  test("restore() undoes changes since the checkpoint, and reset() all of them", async () => {
    const { mock, client } = setup();
    mock.setFees({ baseFeePerGas: parseGwei("20") });
    const baseline = mock.checkpoint();
    mock.setFees({ baseFeePerGas: parseGwei("90") });

    baseline.restore();
    expect(await client.getGasPrice()).toBe(parseGwei("21"));
    mock.reset();
    expect(await client.getGasPrice()).toBe(parseGwei("11"));
  });

  test("setFees() rejects invalid fees, as in createMockRpc({ fees })", () => {
    const { mock } = setup();

    expect(() => {
      mock.setFees({ baseFeePerGas: -1n });
    }).toThrow("fees.baseFeePerGas can't be negative; got -1.");
  });
});

describe("mocking fee answers", () => {
  test("mocked fee answers take precedence over `fees`", async () => {
    const { mock, client } = setup();
    mock.actions.getGasPrice().returns(parseGwei("3"));
    mock.actions.estimateMaxPriorityFeePerGas().returns(parseGwei("2"));
    mock.actions.getBlobBaseFee().returns(5n);

    expect(await client.getGasPrice()).toBe(parseGwei("3"));
    expect(await client.estimateMaxPriorityFeePerGas()).toBe(parseGwei("2"));
    expect(await client.getBlobBaseFee()).toBe(5n);
    expect(mock.actions.getGasPrice.calls).toHaveLength(1);
    expect(mock.actions.getGasPrice.calls[0]).toEqual({});
  });

  test("viem falls back when the priority fee fails: gas price minus base fee", async () => {
    const { mock, client } = setup();
    mock.actions.estimateMaxPriorityFeePerGas().fails({ code: -32601 });
    mock.actions.getGasPrice().returns(parseGwei("14"));

    expect(await client.estimateMaxPriorityFeePerGas()).toBe(parseGwei("4"));
    expect(mock.history.map((entry) => entry.method)).toEqual([
      "eth_maxPriorityFeePerGas",
      "eth_getBlockByNumber",
      "eth_gasPrice",
    ]);
  });

  test("history shows them by action name, without params", async () => {
    const { mock, client } = setup();

    await client.getGasPrice();
    expect(mock.formatHistory()).toBe("#1 eth_gasPrice getGasPrice() → 11000000000n");
  });

  test("they're typed actions, so method() refuses them", () => {
    const { mock } = setup();

    expect(() => mock.method("eth_gasPrice")).toThrow("use mock.actions.getGasPrice()");
    expect(() => mock.method("eth_maxPriorityFeePerGas")).toThrow(
      "use mock.actions.estimateMaxPriorityFeePerGas()",
    );
    expect(() => mock.method("eth_blobBaseFee")).toThrow("use mock.actions.getBlobBaseFee()");
  });

  test("answers must be bigints", () => {
    const { mock } = setup();

    expect(() => {
      // @ts-expect-error -- hex isn't a viem-typed gas price
      mock.actions.getGasPrice().returns("0x1");
    }).toThrow("A gas price must be a bigint; got string.");
  });
});
