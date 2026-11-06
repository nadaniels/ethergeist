import { type Address, type Log, erc20Abi, parseAbi } from "viem";
import { describe, expectTypeOf, test } from "vite-plus/test";

import {
  type LogsCall,
  type EventArgs,
  type MockEventLog,
  type TransactionRecord,
  contractEvents,
  createMockRpc,
  testAddress,
  testHash,
  testLog,
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

describe("EventArgs", () => {
  test("indexed args are required; the rest are optional", () => {
    expectTypeOf<EventArgs<typeof erc20Abi, "Transfer">>().toEqualTypeOf<
      { from: Address; to: Address } & { value?: bigint }
    >();
  });

  test("non-indexed structs are partial at any depth", () => {
    type Args = EventArgs<typeof shapesAbi, "ShapeAdded">;
    expectTypeOf<{
      id: 1n;
      shape: { origin: { y: 2n }; vertices: [{ x: 3n }] };
    }>().toExtend<Args>();
    expectTypeOf<{ shape: { label: "" } }>().not.toExtend<Args>();
  });

  test("indexed strings take the string, which the topic hashes", () => {
    type Args = EventArgs<typeof shapesAbi, "Registered">;
    expectTypeOf<Args["name"]>().toEqualTypeOf<string>();
    expectTypeOf<{ name: "alice"; owner: Address }>().toExtend<Args>();
    expectTypeOf<{ owner: Address }>().not.toExtend<Args>();
  });

  test("unnamed inputs are a complete tuple", () => {
    expectTypeOf<EventArgs<typeof unnamedAbi, "Unnamed">>().toEqualTypeOf<
      readonly [Address, bigint]
    >();
  });

  test("an overloaded event takes any overload's args", () => {
    type Args = EventArgs<typeof shapesAbi, "Ping">;
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

  test("goes into a mocked receipt's logs, an added transaction's and a built receipt's", () => {
    mock.actions
      .getTransactionReceipt()
      .returns({ logs: [usdc.events.Transfer({ from: alice, to: bob })] });
    mock.addTransaction({ logs: [usdc.events.Transfer({ from: alice, to: bob })] });
    mock.buildReceipt({ logs: [usdc.events.Transfer({ from: alice, to: bob })] });
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
  test("takes a log's content and its placement, and returns a viem log", () => {
    const mock = createMockRpc();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    const log = mock.buildLog(usdc.events.Transfer({ from: alice, to: bob, value: 5n }), {
      blockNumber: 7n,
      transactionHash: testHash("x"),
      transactionIndex: 1,
      logIndex: 2,
    });
    expectTypeOf(log).toEqualTypeOf<Log<bigint, number, false>>();

    mock.buildLog(testLog("noise"));
    mock.buildLog(contractEvents({ abi: shapesAbi, address: USDC }).Paused());
    // @ts-expect-error -- content, not an event's parameters
    mock.buildLog({ abi: erc20Abi, address: USDC, eventName: "Transfer" });
    // @ts-expect-error -- a log's transaction is `transactionHash`
    mock.buildLog(testLog("noise"), { hash: testHash("x") });
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
    usdc.emit.Transfer({ from: alice, to: bob }, { blockNumber: 3n, hash: testHash("x") });
    // @ts-expect-error -- a transaction's hash is `hash`, as in `mock.addTransaction()`
    usdc.emit.Transfer({ from: alice, to: bob }, { transactionHash: testHash("x") });
    // @ts-expect-error -- `to` is indexed, so required
    usdc.emit.Transfer({ from: alice });
    // @ts-expect-error -- an emit has no `logIndex` option
    usdc.emit.Transfer({ from: alice, to: bob }, { logIndex: 2 });
    // @ts-expect-error -- a plain emit mines a new block, so there's no `mine` option
    usdc.emit.Transfer({ from: alice, to: bob }, { mine: true });
    // @ts-expect-error -- a block's transactions have no holes, so there's no `transactionIndex` option
    usdc.emit.Transfer({ from: alice, to: bob }, { transactionIndex: 1 });
    // @ts-expect-error -- a transaction's hash is `hash`; `transactionHash` is a log's
    mock.addTransaction({ transactionHash: testHash("x") });
    // @ts-expect-error -- `mock.addTransaction()` doesn't place a deployment
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
    // Read-only, yet it goes wherever a placed log does, e.g. a getLogs mock's answer.
    mock.actions.getLogs().returns([emitted]);
  });

  test("history entries for getLogs carry the decoded filter", () => {
    const [entry] = mock.history;
    if (entry?.type === "action" && entry.action === "getLogs")
      expectTypeOf(entry.call).toEqualTypeOf<LogsCall | undefined>();
  });
});
