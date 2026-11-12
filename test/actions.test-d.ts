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
  type LogsContext,
  type MockMethodBuilder,
  type ReservedMethod,
  type RpcValue,
  type SendTransactionCall,
  type StorageCall,
  createMockRpc,
  zeroResult,
  testAddress,
  testHash,
  testLog,
} from "../src/index.js";

const mock = createMockRpc();
const alice = testAddress("alice");
const usdc = mock.contract({ abi: erc20Abi, address: testAddress("usdc") });

describe("actions", () => {
  test("params are partial; any field can be pinned", () => {
    mock.actions.getBalance();
    mock.actions.getBalance({ address: alice });
    mock.actions.getBalance({ blockNumber: 5n });
    // @ts-expect-error -- not a field of the call
    mock.actions.getBalance({ owner: alice });
    // @ts-expect-error -- block numbers are bigints
    mock.actions.getBalance({ blockNumber: 5 });
  });

  test("returns take the action's viem type, zeroResult, or a resolver", () => {
    mock.actions.getBalance().returns(1n);
    mock.actions.getBalance().returns(zeroResult);
    mock.actions.getBalance().returns();
    mock.actions.getCode().returns("0x6080");
    // @ts-expect-error -- a balance is a bigint
    mock.actions.getBalance().returns("0x1");
    // @ts-expect-error -- code is hex
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
      { address: Address; blockNumber: bigint; blockTag?: BlockTag }[]
    >();
  });

  test("there's no reverts() on actions", () => {
    // @ts-expect-error -- node methods don't revert
    mock.actions.getBalance().reverts("nope");
  });
});

describe("getBlock", () => {
  test("pins a number, hash, or tag", () => {
    mock.actions.getBlock({ blockNumber: 1n });
    mock.actions.getBlock({ blockHash: "0x01" });
    mock.actions.getBlock({ blockTag: "finalized" });
    // @ts-expect-error -- not a block tag
    mock.actions.getBlock({ blockTag: "newest" });
  });

  test("returns a partial viem block, or null", () => {
    mock.actions.getBlock().returns({ timestamp: 1n, baseFeePerGas: null });
    mock.actions.getBlock().returns(null);
    mock.actions.getBlock().returns(({ blockNumber }) => ({ gasUsed: blockNumber }));
    // @ts-expect-error -- transactions are hashes
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
  test("returns a partial viem receipt with logs' content, or null", () => {
    mock.actions.getTransactionReceipt({ hash: "0x01" }).returns({ status: "reverted" });
    mock.actions.getTransactionReceipt().returns({ logs: [testLog("noise")] });
    // @ts-expect-error -- a receipt mock's logs are content: address, topics and data
    mock.actions.getTransactionReceipt().returns({ logs: [{ address: alice, data: "0x" }] });
    mock.actions.getTransactionReceipt().returns(null);
    // @ts-expect-error -- not a receipt status
    mock.actions.getTransactionReceipt().returns({ status: "failed" });
  });

  test("resolvers get the hash", () => {
    mock.actions.getTransactionReceipt().returns(({ hash }) => {
      expectTypeOf(hash).toEqualTypeOf<Hex>();
      return {};
    });
  });
});

describe("getStorageAt", () => {
  test("pins an address and slot, and answers hex", () => {
    mock.actions.getStorageAt({ address: alice, slot: "0x0", blockTag: "latest" }).returns("0x1");
    mock.actions.getStorageAt().returns(({ slot }) => slot);
    expectTypeOf(mock.actions.getStorageAt.calls).toEqualTypeOf<StorageCall[]>();
    // @ts-expect-error -- slots are hex
    mock.actions.getStorageAt({ slot: 0n });
    // @ts-expect-error -- storage is hex
    mock.actions.getStorageAt().returns(1n);
  });
});

describe("getTransaction", () => {
  test("takes the fields of its type, mined or pending, or null", () => {
    mock.actions.getTransaction({ hash: "0x01" }).returns({ type: "legacy", gasPrice: 1n });
    mock.actions.getTransaction().returns({ maxFeePerGas: 1n, blockNumber: null });
    mock.actions.getTransaction().returns(null);
    // @ts-expect-error -- legacy transactions have no max fee
    mock.actions.getTransaction().returns({ type: "legacy", maxFeePerGas: 1n });
    // @ts-expect-error -- a pending transaction has no block hash
    mock.actions.getTransaction().returns({ blockNumber: null, blockHash: "0x01" });
    // @ts-expect-error -- only a pending transaction has a null block hash
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

/** A reusable getLogs resolver, for what it can name. */
const firstLog = ({ logs }: LogsContext) => logs.slice(0, 1);

describe("getLogs", () => {
  test("pins the decoded filter", () => {
    mock.actions.getLogs({ address: usdc.address, fromBlock: 1n });
    mock.actions.getLogs({ address: [usdc.address], topics: [null] });
    // @ts-expect-error -- blocks are bigints
    mock.actions.getLogs({ fromBlock: "0x1" });
    mock.actions.getLogs({ fromBlock: 1n, toBlock: 5n });
    mock.actions.getLogs({ blockHash: testHash("block") });
    // @ts-expect-error -- a block hash takes no range
    mock.actions.getLogs({ blockHash: testHash("block"), fromBlock: 1n });
  });

  test("a call is a block range or a block hash", () => {
    mock.actions.getLogs().returns((context) => {
      if (context.blockHash === undefined) expectTypeOf(context.toBlock).toEqualTypeOf<bigint>();
      else expectTypeOf(context.toBlock).toEqualTypeOf<undefined>();
      return context.logs;
    });
    // Narrowing a destructured binding is its own TypeScript rule, and the
    // range cap relies on it.
    mock.actions.getLogs().returns(({ blockHash, toBlock, logs }) => {
      if (blockHash === undefined) expectTypeOf(toBlock).toEqualTypeOf<bigint>();
      else expectTypeOf(toBlock).toEqualTypeOf<undefined>();
      return logs;
    });
    mock.actions
      .getLogs()
      .returns(({ fromBlock = 0n, toBlock = 0n, logs }) => (toBlock - fromBlock > 5n ? [] : logs));
  });

  test("returns placed logs, or a resolver with the store's logs", () => {
    mock.actions.getLogs().returns([usdc.emit.Transfer({ from: alice, to: alice })]);
    mock.actions
      .getLogs()
      .returns([mock.buildLog(usdc.events.Approval({ owner: alice, spender: alice }))]);
    mock.actions.getLogs().returns((context) => {
      expectTypeOf(context.logs).toEqualTypeOf<EmittedLog[]>();
      expectTypeOf(context.fromBlock).toEqualTypeOf<bigint | undefined>();
      return context.logs.slice(0, 1);
    });
    // @ts-expect-error -- content isn't placed
    mock.actions.getLogs().returns([usdc.events.Transfer({ from: alice, to: alice })]);
    expectTypeOf(mock.actions.getLogs.calls).toEqualTypeOf<LogsCall[]>();
  });

  test("a reusable resolver names its context", () => {
    mock.actions.getLogs().returns(firstLog);
  });
});

describe("getGasPrice", () => {
  test("fee actions take no params and answer bigints", () => {
    mock.actions.getGasPrice().returns(1n);
    mock.actions.estimateMaxPriorityFeePerGas().once().returns(1n);
    mock.actions.getBlobBaseFee().returns(({ fail }) => fail({ status: 503 }));
    mock.actions.getGasPrice().returns();
    // @ts-expect-error -- there's nothing to pin
    mock.actions.getGasPrice({});
    // @ts-expect-error -- a gas price is a bigint, not hex
    mock.actions.getGasPrice().returns("0x1");
  });
});

describe("getTransactionCount", () => {
  test("transaction counts pin an address and tag, and answer numbers", () => {
    mock.actions.getTransactionCount({ address: alice, blockTag: "pending" }).returns(1);
    mock.actions.getTransactionCount().returns(({ address, blockTag, count }) => {
      expectTypeOf(address).toEqualTypeOf<Address>();
      expectTypeOf(blockTag).toEqualTypeOf<BlockTag | undefined>();
      expectTypeOf(count).toEqualTypeOf<number>();
      return count;
    });
    // @ts-expect-error -- viem's count is a number
    mock.actions.getTransactionCount().returns(1n);
  });
});

describe("estimateGas", () => {
  test("estimates pin a transaction, answer gas, and refuse by name", () => {
    mock.actions.estimateGas({ from: alice, to: alice, value: 1n, data: "0x" }).returns(21_000n);
    // @ts-expect-error -- the sender is `from`, as the request has it
    mock.actions.estimateGas({ account: alice });
    mock.actions.estimateGas().once().refuses("insufficientFunds");
    mock.actions.estimateGas().returns(({ maxFeePerGas, nonce, refuse }) => {
      expectTypeOf(maxFeePerGas).toEqualTypeOf<bigint | undefined>();
      expectTypeOf(nonce).toEqualTypeOf<number | undefined>();
      return refuse("feeCapTooLow");
    });
    mock.actions.estimateGas().fails({ status: 503 });
    mock.actions.estimateGas().returns(({ fail }) => fail("timeout"));
    expectTypeOf(mock.actions.estimateGas.calls).toEqualTypeOf<EstimateGasCall[]>();
    // @ts-expect-error -- an estimate is a bigint
    mock.actions.estimateGas().returns(21_000);
    // @ts-expect-error -- there's no zero estimate
    mock.actions.estimateGas().returns(zeroResult);
    // @ts-expect-error -- there's no default estimate either
    mock.actions.estimateGas().once().returns();
    mock.actions.estimateGas().refuses("gasExceedsAllowance");
    mock.actions.estimateGas().returns(({ refuse }) => refuse("gasExceedsAllowance"));
    // @ts-expect-error -- a refusal is `.refuses()`
    mock.actions.estimateGas().fails("gasExceedsAllowance");
    // @ts-expect-error -- and `refuse()` in a resolver
    mock.actions.estimateGas().returns(({ fail }) => fail("gasExceedsAllowance"));
    // @ts-expect-error -- `refuses()` takes no fault
    mock.actions.estimateGas().refuses("timeout");
    // @ts-expect-error -- an estimate doesn't check the nonce
    mock.actions.estimateGas().refuses("nonceTooLow");
    // @ts-expect-error -- an estimate reports too little gas as exceeding the allowance
    mock.actions.estimateGas().returns(({ refuse }) => refuse("intrinsicGasTooLow"));
    mock.actions.estimateGas({ to: alice }).reverts();
    mock.actions.estimateGas().reverts("paused");
    mock.actions.estimateGas().once().reverts({ panic: 0x11 });
    mock.actions.estimateGas().times(2).reverts({ data: "0xdeadbeef" });
    // @ts-expect-error -- without an ABI, there are no custom errors
    mock.actions.estimateGas().reverts({ errorName: "Paused" });
    // @ts-expect-error -- raw data is hex
    mock.actions.estimateGas().reverts({ data: "deadbeef" });
    mock.actions.estimateGas().returns(({ value, revert }) => (value > 0n ? revert("paused") : 1n));
    mock.actions.estimateGas().returns(({ revert }) => revert());
    mock.actions.estimateGas().returns(({ revert }) => revert({ panic: 0x11 }));
    mock.actions.estimateGas().returns(({ revert }) => revert({ data: "0xdeadbeef" }));
    // @ts-expect-error -- without an ABI, there are no custom errors
    mock.actions.estimateGas().returns(({ revert }) => revert({ errorName: "Paused" }));
    // @ts-expect-error -- a node doesn't refuse a balance read
    mock.actions.getBalance().refuses("insufficientFunds");
    mock.actions.getBalance().returns((context) => {
      expectTypeOf(context).not.toHaveProperty("refuse");
      return 1n;
    });
    // @ts-expect-error -- a refusal isn't a fault
    mock.actions.getBalance().fails("insufficientFunds");
  });
});

describe("sendTransaction", () => {
  test("sends pin a transaction and answer with what the chain did", () => {
    mock.actions.sendTransaction({ from: alice, to: null }).returns({ contractAddress: alice });
    // @ts-expect-error -- the sender is `from`, as the request has it
    mock.actions.sendTransaction({ account: alice });
    mock.actions.sendTransaction({ to: alice, value: 1n }).once().emits([]);
    mock.actions.sendTransaction().emits(testLog("noise"));
    mock.actions.sendTransaction().returns();
    mock.actions.sendTransaction().reverts("paused");
    mock.actions.sendTransaction().reverts({ panic: 0x11 });
    mock.actions.sendTransaction().refuses("insufficientFunds");
    mock.actions.sendTransaction().fails("network");
    mock.actions.sendTransaction().returns(({ from, to, nonce, type, refuse }) => {
      expectTypeOf(from).toEqualTypeOf<Address>();
      expectTypeOf(to).toEqualTypeOf<Address | null>();
      expectTypeOf(nonce).toEqualTypeOf<number | undefined>();
      expectTypeOf(type).toEqualTypeOf<"legacy" | "eip2930" | "eip1559" | "eip4844" | "eip7702">();
      if (nonce === 1) return refuse("tipAboveFeeCap");
      if (nonce === 2) return refuse("nonceTooHigh");
      return { status: "reverted" };
    });
    mock.actions.sendTransaction().refuses("nonceTooLow");
    mock.actions.sendTransaction().refuses("alreadyKnown");
    mock.actions.sendTransaction().once().refuses("intrinsicGasTooLow");
    // @ts-expect-error -- a refusal is `.refuses()`
    mock.actions.sendTransaction().fails("nonceTooLow");
    // @ts-expect-error -- and `refuse()` in a resolver
    mock.actions.sendTransaction().returns(({ fail }) => fail("nonceTooLow"));
    // @ts-expect-error -- a send with too little gas is mined, and runs out
    mock.actions.sendTransaction().refuses("gasExceedsAllowance");
    // @ts-expect-error -- nor can a resolver refuse a send with it
    mock.actions.sendTransaction().returns(({ refuse }) => refuse("gasExceedsAllowance"));
    mock.actions.sendTransaction().returns(() => {});
    mock.actions.sendTransaction().returns(({ from, value, revert }) => {
      if (value > 1n) revert("paused");
      return { logs: [usdc.events.Transfer({ from, to: alice, value }), testLog("noise")] };
    });
    mock.actions.sendTransaction().returns((context) => {
      expectTypeOf(context).not.toHaveProperty("emit");
    });
    // @ts-expect-error -- not a log: no address, topics or data
    mock.actions.sendTransaction().returns(() => ({ logs: [{ logIndex: 0 }] }));
    expectTypeOf(mock.actions.sendTransaction.calls).toEqualTypeOf<SendTransactionCall[]>();
    // @ts-expect-error -- a send mock answers with its outcome, not an ABI value
    mock.actions.sendTransaction().returns(true);
    // @ts-expect-error -- derived fields come from where it's mined
    mock.actions.sendTransaction().returns({ blockNumber: 1n });
    // @ts-expect-error -- without an ABI, there are no custom errors
    mock.actions.sendTransaction().reverts({ errorName: "Paused" });
  });
});

describe("getFeeHistory", () => {
  test("fee history pins the call's fields and answers partial histories", () => {
    mock.actions
      .getFeeHistory({ blockCount: 4, blockTag: "latest" })
      .returns({ gasUsedRatio: [0.5] });
    mock.actions.getFeeHistory().returns(({ blockNumber, rewardPercentiles }) => {
      expectTypeOf(blockNumber).toEqualTypeOf<bigint>();
      expectTypeOf(rewardPercentiles).toEqualTypeOf<readonly number[] | undefined>();
      return { oldestBlock: blockNumber, baseFeePerBlobGas: [1n] };
    });
    // @ts-expect-error -- a count is a number
    mock.actions.getFeeHistory({ blockCount: 4n });
    // @ts-expect-error -- rewards are lists of bigints, one per block
    mock.actions.getFeeHistory().returns({ reward: [1n] });
  });
});

/** Wrappers that pass a name on to `mock.method()`, as a test helper might. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the generic pass-through is the case under test
const passThrough = <name extends string>(name: name) =>
  // @ts-expect-error -- `name` may be a reserved method
  mock.method(name);
const excluding = <name extends string>(name: Exclude<name, ReservedMethod>) => mock.method(name);
type SomeMethods = "eth_getProof" | "eth_feeHistory";
const fromUnion = (name: SomeMethods) =>
  // @ts-expect-error -- `eth_feeHistory` has a typed mock
  mock.method(name);
const fromAllowed = (name: Exclude<SomeMethods, ReservedMethod>) => mock.method(name);

describe("method()", () => {
  test("answers with JSON-RPC values, not viem's types", () => {
    mock.method("eth_getBlockTransactionCountByNumber").returns("0x1");
    mock.method("eth_getProof").returns({ balance: "0x1", storageProof: [] });
    // @ts-expect-error -- JSON-RPC carries quantities as hex strings
    mock.method("eth_getBlockTransactionCountByNumber").returns(1n);
  });

  test("refuses a method a typed action or the mock itself answers", () => {
    // @ts-expect-error -- `mock.actions.getFeeHistory()` answers it
    mock.method("eth_feeHistory");
    // @ts-expect-error -- `mock.actions.sendTransaction()` answers it
    mock.method("eth_sendRawTransaction", ["0x"]);
    // @ts-expect-error -- a registered contract answers it
    mock.method("eth_call");
    const name: string = "eth_feeHistory";
    expectTypeOf(mock.method(name)).toEqualTypeOf<MockMethodBuilder>();
    expectTypeOf(mock.method("eth_newFilter")).toEqualTypeOf<MockMethodBuilder>();
  });

  test("a name passed on to it excludes the reserved methods", () => {
    expectTypeOf(passThrough("eth_getProof")).toEqualTypeOf<MockMethodBuilder>();
    expectTypeOf(excluding("eth_getProof")).toEqualTypeOf<MockMethodBuilder>();
    // @ts-expect-error -- `mock.actions.getBalance()` answers it
    excluding("eth_getBalance");
    expectTypeOf(fromUnion("eth_getProof")).toEqualTypeOf<MockMethodBuilder>();
    expectTypeOf(fromAllowed).parameter(0).toEqualTypeOf<"eth_getProof">();
  });

  test("resolvers get the raw params", () => {
    mock.method("eth_getProof").returns(({ method, params }) => {
      expectTypeOf(method).toEqualTypeOf<string>();
      expectTypeOf(params).toEqualTypeOf<readonly RpcValue[]>();
      return null;
    });
    mock.method("eth_getBlockTransactionCountByNumber").fails({ status: 429 });
  });
});

describe("getCode", () => {
  test("code is Hex", () => {
    mock.actions.getCode().returns(({ address }) => {
      expectTypeOf(address).toEqualTypeOf<Address>();
      return "0x" satisfies Hex;
    });
  });
});
