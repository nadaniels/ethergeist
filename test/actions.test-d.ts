import {
  type Address,
  type BlockTag,
  type Hex,
  type TransactionEIP1559,
  type TransactionEIP4844,
  type TransactionLegacy,
  erc20Abi,
} from "viem";
import { describe, expectTypeOf, test } from "vite-plus/test";
import {
  type EmittedLog,
  type EstimateGasCall,
  type LogsCall,
  type RpcValue,
  createMockRpc,
  zeroResult,
  testAddress,
} from "../src/index.js";

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

describe("getTransaction", () => {
  test("takes the fields of its type, mined or pending, or null", () => {
    mock.actions.getTransaction({ hash: "0x01" }).returns({ type: "legacy", gasPrice: 1n });
    mock.actions.getTransaction().returns({ maxFeePerGas: 1n, blockNumber: null });
    mock.actions.getTransaction().returns(null);
    // @ts-expect-error legacy transactions have no max fee
    mock.actions.getTransaction().returns({ type: "legacy", maxFeePerGas: 1n });
    // @ts-expect-error a pending transaction has no block hash
    mock.actions.getTransaction().returns({ blockNumber: null, blockHash: "0x01" });
    // @ts-expect-error only a pending transaction has a null block hash
    mock.actions.getTransaction().returns({ blockHash: null });
  });

  test("buildTransaction returns viem's transaction of that type", () => {
    expectTypeOf(mock.buildTransaction()).toEqualTypeOf<
      TransactionEIP1559<bigint, number, false>
    >();
    expectTypeOf(mock.buildTransaction({ type: "legacy" })).toEqualTypeOf<
      TransactionLegacy<bigint, number, false>
    >();
    expectTypeOf(mock.buildTransaction({ type: "eip4844", blockNumber: null })).toEqualTypeOf<
      TransactionEIP4844<bigint, number, true>
    >();
  });
});

describe("getLogs", () => {
  const usdc = mock.contract({ abi: erc20Abi, address: testAddress("usdc") });

  test("pins the decoded filter", () => {
    mock.actions.getLogs({ address: usdc.address, fromBlock: 1n });
    mock.actions.getLogs({ address: [usdc.address], topics: [null] });
    // @ts-expect-error blocks are bigints
    mock.actions.getLogs({ fromBlock: "0x1" });
  });

  test("returns placed logs, or a resolver with the store's logs", () => {
    mock.actions.getLogs().returns([usdc.emit.Transfer({ from: alice, to: alice })]);
    mock.actions.getLogs().returns([
      mock.buildLog({
        abi: erc20Abi,
        address: usdc.address,
        eventName: "Approval",
        args: { owner: alice, spender: alice },
      }),
    ]);
    mock.actions.getLogs().returns((context) => {
      expectTypeOf(context.logs).toEqualTypeOf<EmittedLog[]>();
      expectTypeOf(context.fromBlock).toEqualTypeOf<bigint | undefined>();
      return context.logs.slice(0, 1);
    });
    // @ts-expect-error content isn't placed
    mock.actions.getLogs().returns([usdc.events.Transfer({ from: alice, to: alice })]);
    expectTypeOf(mock.actions.getLogs.calls).toEqualTypeOf<LogsCall[]>();
  });

  test("fee actions take no params and answer bigints", () => {
    mock.actions.getGasPrice().returns(1n);
    mock.actions.estimateMaxPriorityFeePerGas().once().returns(1n);
    mock.actions.getBlobBaseFee().returns(({ fail }) => fail({ status: 503 }));
    mock.actions.getGasPrice().returns();
    // @ts-expect-error there's nothing to pin
    mock.actions.getGasPrice({});
    // @ts-expect-error a gas price is a bigint, not hex
    mock.actions.getGasPrice().returns("0x1");
  });

  test("transaction counts pin an address and tag, and answer numbers", () => {
    mock.actions.getTransactionCount({ address: alice, blockTag: "pending" }).returns(1);
    mock.actions.getTransactionCount().returns(({ address, blockTag }) => {
      expectTypeOf(address).toEqualTypeOf<Address>();
      expectTypeOf(blockTag).toEqualTypeOf<BlockTag | undefined>();
      return 0;
    });
    // @ts-expect-error viem's count is a number
    mock.actions.getTransactionCount().returns(1n);
  });

  test("estimates pin a transaction, answer gas, and fail with node errors by name", () => {
    mock.actions.estimateGas({ account: alice, to: alice, value: 1n, data: "0x" }).returns(21_000n);
    mock.actions.estimateGas().once().fails("insufficientFunds");
    mock.actions.estimateGas().returns(({ maxFeePerGas, nonce, fail }) => {
      expectTypeOf(maxFeePerGas).toEqualTypeOf<bigint | undefined>();
      expectTypeOf(nonce).toEqualTypeOf<number | undefined>();
      return fail("feeCapTooLow");
    });
    expectTypeOf(mock.actions.estimateGas.calls).toEqualTypeOf<EstimateGasCall[]>();
    // @ts-expect-error an estimate is a bigint
    mock.actions.estimateGas().returns(21_000);
    // @ts-expect-error there's no zero estimate
    mock.actions.estimateGas().returns(zeroResult);
    // @ts-expect-error not a node error
    mock.actions.estimateGas().fails("nonceTooLow");
    // @ts-expect-error a node doesn't refuse a balance read by name
    mock.actions.getBalance().fails("insufficientFunds");
  });

  test("fee history pins the call's fields and answers partial histories", () => {
    mock.actions
      .getFeeHistory({ blockCount: 4, blockTag: "latest" })
      .returns({ gasUsedRatio: [0.5] });
    mock.actions.getFeeHistory().returns(({ blockNumber, rewardPercentiles }) => {
      expectTypeOf(blockNumber).toEqualTypeOf<bigint>();
      expectTypeOf(rewardPercentiles).toEqualTypeOf<readonly number[] | undefined>();
      return { oldestBlock: blockNumber, baseFeePerBlobGas: [1n] };
    });
    // @ts-expect-error a count is a number
    mock.actions.getFeeHistory({ blockCount: 4n });
    // @ts-expect-error rewards are lists of bigints, one per block
    mock.actions.getFeeHistory().returns({ reward: [1n] });
  });
});

describe("method()", () => {
  test("answers with JSON-RPC values, not viem's types", () => {
    mock.method("eth_getBlockTransactionCountByNumber").returns("0x1");
    mock.method("eth_feeHistory").returns({ oldestBlock: "0x1", baseFeePerGas: ["0x1"] });
    // @ts-expect-error JSON-RPC carries quantities as hex strings
    mock.method("eth_getBlockTransactionCountByNumber").returns(1n);
  });

  test("resolvers get the raw params", () => {
    mock.method("eth_getStorageAt").returns(({ method, params }) => {
      expectTypeOf(method).toEqualTypeOf<string>();
      expectTypeOf(params).toEqualTypeOf<readonly RpcValue[]>();
      return null;
    });
    mock.method("eth_getBlockTransactionCountByNumber").fails({ status: 429 });
  });

  test("code is Hex", () => {
    mock.actions.getCode().returns(({ address }) => {
      expectTypeOf(address).toEqualTypeOf<Address>();
      return "0x" satisfies Hex;
    });
  });
});
