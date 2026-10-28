import type { Address, Hex } from "viem";
import { describe, expectTypeOf, test } from "vite-plus/test";
import { type RpcValue, createMockRpc, zeroResult } from "../src/index.js";

const mock = createMockRpc();
const alice = "0x00000000000000000000000000000000000a11ce";

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
