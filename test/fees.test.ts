import { createPublicClient, parseGwei } from "viem";
import { describe, expect, test } from "vite-plus/test";
import { type MockFees, createMockRpc } from "../src/index.js";

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
