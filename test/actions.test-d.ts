import type { Address, Hex } from "viem";
import { describe, expectTypeOf, test } from "vite-plus/test";
import { type RpcValue, createMockRpc, zeroResult, testAddress } from "../src/index.js";

const mock = createMockRpc();
const alice = testAddress("alice");

describe("actions", () => {
  test("params are partial; any field can be pinned", () => {
    mock.actions.getBalance();
    mock.actions.getBalance({ address: alice });
    mock.actions.getBalance({ blockNumber: 5n });
    // @ts-expect-error not a field of the call
    mock.actions.getBalance({ owner: alice });
    // @ts-expect-error block numbers are bigints
    mock.actions.getBalance({ blockNumber: 5 });
  });

  test("returns take the action's viem type, zeroResult, or a resolver", () => {
    mock.actions.getBalance().returns(1n);
    mock.actions.getBalance().returns(zeroResult);
    mock.actions.getBalance().returns();
    mock.actions.getCode().returns("0x6080");
    // @ts-expect-error a balance is a bigint
    mock.actions.getBalance().returns("0x1");
    // @ts-expect-error code is hex
    mock.actions.getCode().returns("6080");
  });

  test("resolvers get the typed call and fail()", () => {
    mock.actions.getBalance().returns(({ address, blockNumber, fail }) => {
      expectTypeOf(address).toEqualTypeOf<Address>();
      expectTypeOf(blockNumber).toEqualTypeOf<bigint>();
      expectTypeOf(fail("timeout")).toBeNever();
      return 1n;
    });
  });

  test("calls are typed", () => {
    expectTypeOf(mock.actions.getBalance.calls).toEqualTypeOf<
      { address: Address; blockNumber: bigint }[]
    >();
  });

  test("there's no reverts() on actions", () => {
    // @ts-expect-error node methods don't revert
    mock.actions.getBalance().reverts("nope");
  });
});

describe("getBlock", () => {
  test("pins a number, hash, or tag", () => {
    mock.actions.getBlock({ blockNumber: 1n });
    mock.actions.getBlock({ blockHash: "0x01" });
    mock.actions.getBlock({ blockTag: "finalized" });
    // @ts-expect-error not a block tag
    mock.actions.getBlock({ blockTag: "newest" });
  });

  test("returns a partial viem block, or null", () => {
    mock.actions.getBlock().returns({ timestamp: 1n, baseFeePerGas: null });
    mock.actions.getBlock().returns(null);
    mock.actions.getBlock().returns(({ blockNumber }) => ({ gasUsed: blockNumber }));
    // @ts-expect-error transactions are hashes
    mock.actions.getBlock().returns({ transactions: [{ hash: "0x01" }] });
  });

  test("calls carry how the block was asked for", () => {
    expectTypeOf(mock.actions.getBlock.calls[0]!).toEqualTypeOf<{
      blockNumber: bigint;
      blockHash?: Hex;
      blockTag?: "latest" | "earliest" | "pending" | "safe" | "finalized";
      includeTransactions: boolean;
    }>();
  });
});

describe("getTransactionReceipt", () => {
  test("returns a partial viem receipt with partial logs, or null", () => {
    mock.actions.getTransactionReceipt({ hash: "0x01" }).returns({ status: "reverted" });
    mock.actions.getTransactionReceipt().returns({ logs: [{ address: alice, data: "0x" }] });
    mock.actions.getTransactionReceipt().returns(null);
    // @ts-expect-error not a receipt status
    mock.actions.getTransactionReceipt().returns({ status: "failed" });
  });

  test("resolvers get the hash", () => {
    mock.actions.getTransactionReceipt().returns(({ hash }) => {
      expectTypeOf(hash).toEqualTypeOf<Hex>();
      return {};
    });
  });
});

describe("method()", () => {
  test("answers with JSON-RPC values, not viem's types", () => {
    mock.method("eth_gasPrice").returns("0x1");
    mock.method("eth_feeHistory").returns({ oldestBlock: "0x1", baseFeePerGas: ["0x1"] });
    // @ts-expect-error JSON-RPC carries quantities as hex strings
    mock.method("eth_gasPrice").returns(1n);
  });

  test("resolvers get the raw params", () => {
    mock.method("eth_getStorageAt").returns(({ method, params }) => {
      expectTypeOf(method).toEqualTypeOf<string>();
      expectTypeOf(params).toEqualTypeOf<readonly RpcValue[]>();
      return null;
    });
    mock.method("eth_gasPrice").fails({ status: 429 });
  });

  test("code is Hex", () => {
    mock.actions.getCode().returns(({ address }) => {
      expectTypeOf(address).toEqualTypeOf<Address>();
      return "0x" satisfies Hex;
    });
  });
});
