import { type Address, type Log, erc20Abi, parseAbi } from "viem";
import { describe, expectTypeOf, test } from "vite-plus/test";

import {
  type LogsCall,
  type MockEventArgs,
  type MockEventLog,
  type TransactionRecord,
  contractEvents,
  createMockRpc,
  testAddress,
  testHash,
} from "../src/index.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const alice = testAddress("alice");
const bob = testAddress("bob");

const shapesAbi = parseAbi([
  "struct Point { int256 x; int256 y; }",
  "struct Shape { Point origin; Point[] vertices; string label; }",
  "event ShapeAdded(uint256 indexed id, Shape shape)",
  "event Registered(string indexed name, address indexed owner)",
  "event Paused(address account)",
  "event Ping(uint256 a)",
  "event Ping(uint256 a, uint256 b)",
]);
const unnamedAbi = [
  {
    type: "event",
    name: "Unnamed",
    inputs: [
      { name: "", type: "address", indexed: true },
      { name: "", type: "uint256", indexed: false },
    ],
  },
] as const;

describe("MockEventArgs", () => {
  test("indexed args are required; the rest are optional", () => {
    expectTypeOf<MockEventArgs<typeof erc20Abi, "Transfer">>().toEqualTypeOf<
      { from: Address; to: Address } & { value?: bigint }
    >();
  });

  test("non-indexed structs are partial at any depth", () => {
    type Args = MockEventArgs<typeof shapesAbi, "ShapeAdded">;
    expectTypeOf<{
      id: 1n;
      shape: { origin: { y: 2n }; vertices: [{ x: 3n }] };
    }>().toExtend<Args>();
    expectTypeOf<{ shape: { label: "" } }>().not.toExtend<Args>();
  });

  test("indexed strings take the string, which the topic hashes", () => {
    type Args = MockEventArgs<typeof shapesAbi, "Registered">;
    expectTypeOf<Args["name"]>().toEqualTypeOf<string>();
    expectTypeOf<{ name: "alice"; owner: Address }>().toExtend<Args>();
    expectTypeOf<{ owner: Address }>().not.toExtend<Args>();
  });

  test("unnamed inputs are a complete tuple", () => {
    expectTypeOf<MockEventArgs<typeof unnamedAbi, "Unnamed">>().toEqualTypeOf<
      readonly [Address, bigint]
    >();
  });

  test("an overloaded event takes any overload's args", () => {
    type Args = MockEventArgs<typeof shapesAbi, "Ping">;
    expectTypeOf<{ a: 1n }>().toExtend<Args>();
    expectTypeOf<{ a: 1n; b: 2n }>().toExtend<Args>();
    expectTypeOf<{ a: "1" }>().not.toExtend<Args>();
  });
});

describe("contract.events", () => {
  const mock = createMockRpc();
  const usdc = mock.contract({ abi: erc20Abi, address: USDC });
  const shapes = mock.contract({ abi: shapesAbi, address: testAddress("shapes") });

  test("one function per event, returning the log's content", () => {
    expectTypeOf(
      usdc.events.Transfer({ from: alice, to: bob, value: 5n }),
    ).toEqualTypeOf<MockEventLog>();
    // @ts-expect-error -- `to` is indexed, so required
    usdc.events.Transfer({ from: alice, value: 5n });
    // @ts-expect-error -- not an arg of Transfer
    usdc.events.Transfer({ from: alice, to: bob, amount: 5n });
    // @ts-expect-error -- value is a bigint
    usdc.events.Transfer({ from: alice, to: bob, value: "5" });
    expectTypeOf(usdc.events).not.toHaveProperty("Swap");
    // @ts-expect-error -- args are required when an arg is indexed
    usdc.events.Transfer();
  });

  test("args are optional when none is indexed", () => {
    shapes.events.Paused();
    shapes.events.Paused({ account: alice });
  });

  test("goes into a mocked receipt's logs", () => {
    mock.actions
      .getTransactionReceipt()
      .returns({ logs: [usdc.events.Transfer({ from: alice, to: bob })] });
  });
});

describe("contractEvents()", () => {
  const usdc = contractEvents({ abi: erc20Abi, address: USDC });

  test("the same typed events as a registered contract's", () => {
    expectTypeOf(usdc).toEqualTypeOf(
      createMockRpc().contract({ abi: erc20Abi, address: USDC }).events,
    );
    expectTypeOf(usdc.Transfer({ from: alice, to: bob, value: 5n })).toEqualTypeOf<MockEventLog>();
    // @ts-expect-error -- `to` is indexed, so required
    usdc.Transfer({ from: alice, value: 5n });
    expectTypeOf(usdc).not.toHaveProperty("Swap");
  });
});

describe("mock.buildLog()", () => {
  test("infers the event from the ABI and returns a viem log", () => {
    const mock = createMockRpc();
    const log = mock.buildLog({
      abi: erc20Abi,
      address: USDC,
      eventName: "Transfer",
      args: { from: alice, to: bob, value: 5n },
      blockNumber: 7n,
    });
    expectTypeOf(log).toEqualTypeOf<Log<bigint, number, false>>();

    mock.buildLog({ abi: shapesAbi, address: USDC, eventName: "Paused" });
    // @ts-expect-error -- args are required when an arg is indexed
    mock.buildLog({ abi: erc20Abi, address: USDC, eventName: "Transfer" });
    // @ts-expect-error -- `to` is indexed, so required
    mock.buildLog({ abi: erc20Abi, address: USDC, eventName: "Transfer", args: { from: alice } });
  });
});

describe("emit", () => {
  const mock = createMockRpc();
  const usdc = mock.contract({ abi: erc20Abi, address: USDC });
  const shapes = mock.contract({ abi: shapesAbi, address: testAddress("shapes") });

  test("contract.emit takes the event's args, then options, and returns the placed log", () => {
    expectTypeOf(usdc.emit.Transfer({ from: alice, to: bob }, { blockNumber: 3n })).toEqualTypeOf<
      Readonly<Log<bigint, number, false>>
    >();
    shapes.emit.Paused();
    shapes.emit.Paused(undefined, { blockNumber: 3n });
    // @ts-expect-error -- `to` is indexed, so required
    usdc.emit.Transfer({ from: alice });
    // @ts-expect-error -- not an option
    usdc.emit.Transfer({ from: alice, to: bob }, { logIndex: 2 });
    // @ts-expect-error -- gone: a plain emit mines a new block
    usdc.emit.Transfer({ from: alice, to: bob }, { mine: true });
    // @ts-expect-error -- gone: a block's transactions have no holes
    usdc.emit.Transfer({ from: alice, to: bob }, { transactionIndex: 1 });
    // @ts-expect-error -- a transaction's hash is hash; transactionHash is a log's
    mock.addTransaction({ transactionHash: testHash("x") });
    // @ts-expect-error -- deploys aren't supported
    mock.addTransaction({ to: null });
  });

  test("contract.emit returns its log, and mock.addTransaction its record", () => {
    const log = usdc.events.Transfer({ from: alice, to: bob });
    const emitted = usdc.emit.Transfer({ from: alice, to: bob });
    expectTypeOf(emitted).toEqualTypeOf<Readonly<Log<bigint, number, false>>>();
    expectTypeOf(mock.addTransaction({ logs: [log, log] })).toEqualTypeOf<TransactionRecord>();
    expectTypeOf(mock.addTransaction().logs).toEqualTypeOf<
      readonly Readonly<Log<bigint, number, false>>[]
    >();
    // Read-only, yet it goes wherever a log does, e.g. a mocked receipt.
    mock.actions.getTransactionReceipt().returns({ logs: [emitted] });
  });

  test("history entries for getLogs carry the decoded filter", () => {
    const [entry] = mock.history;
    if (entry?.type === "action" && entry.action === "getLogs")
      expectTypeOf(entry.call).toEqualTypeOf<LogsCall | undefined>();
  });
});
