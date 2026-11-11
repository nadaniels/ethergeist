import { type Abi, type Address, erc20Abi, parseAbi } from "viem";
import { describe, expectTypeOf, test } from "vite-plus/test";

import {
  type CreateMockContractParameters,
  type MockBatch,
  type ContractDefaults,
  type MockFault,
  type MockNamespace,
  type MockOutcome,
  type MockRpc,
  type NodeErrorName,
  createMockRpc,
  match,
  testLog,
  zeroResult,
} from "../src/index.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const mock = createMockRpc();
const usdc = mock.contract({ abi: erc20Abi, address: USDC });
/** Registers a token with `defaults`, for what defaults take. */
const defaultsOf = (defaults: ContractDefaults<typeof erc20Abi>) =>
  createMockRpc().contract({ abi: erc20Abi, address: USDC, defaults });
/** Registers a preset contract, for what `mock.contract()` takes. */
const preset = <const abi extends Abi>(
  rpc: MockRpc,
  parameters: CreateMockContractParameters<abi>,
) => rpc.contract(parameters);

describe("async resolvers", () => {
  test("a resolver may return a promise of the right type", () => {
    const token = createMockRpc().contract({ abi: erc20Abi, address: USDC });
    token.read.decimals().returns(() => Promise.resolve(6));
    // @ts-expect-error -- an async resolver still resolves to a number
    token.read.decimals().returns(() => Promise.resolve("six"));
    createMockRpc()
      .actions.getBalance()
      .returns(() => Promise.resolve(1n));
  });
});

describe("presets", () => {
  test("a helper takes what mock.contract() takes, keeping the ABI", () => {
    const registered = preset(createMockRpc(), { abi: erc20Abi, address: USDC, name: "USDC" });
    expectTypeOf(registered.abi).toEqualTypeOf(erc20Abi);
    registered.read.decimals().returns(6);
    // @ts-expect-error -- the ABI's own functions only
    void registered.read.notAFunction;
  });
});

describe("names", () => {
  test("name is optional and readable back", () => {
    const named = createMockRpc().contract({ abi: erc20Abi, address: USDC, name: "USDC" });
    expectTypeOf(named.name).toEqualTypeOf<string | undefined>();
    // @ts-expect-error -- names are strings
    createMockRpc().contract({ abi: erc20Abi, address: USDC, name: 1 });
  });
});

describe("read", () => {
  test("exposes only read function names from the ABI", () => {
    expectTypeOf<keyof typeof usdc.read>().toEqualTypeOf<
      "allowance" | "balanceOf" | "decimals" | "name" | "symbol" | "totalSupply"
    >();

    // @ts-expect-error -- not on the ABI
    usdc.read.balanceOff();
    // @ts-expect-error -- transfer is nonpayable
    usdc.read.transfer();
  });

  test("args are typed per function", () => {
    usdc.read.balanceOf(["0x0000000000000000000000000000000000000001"]);
    usdc.read.allowance([USDC, USDC]);

    // @ts-expect-error -- balanceOf takes an address
    usdc.read.balanceOf([123n]);
    // @ts-expect-error -- allowance takes an owner and a spender
    usdc.read.allowance([USDC]);
    // @ts-expect-error -- decimals takes no args
    usdc.read.decimals([1n]);
  });

  test("returns() takes the function return type or a resolver", () => {
    usdc.read.balanceOf().returns(1n);
    usdc.read.decimals().returns(6);
    usdc.read.symbol().returns("USDC");

    usdc.read.balanceOf().returns((call) => {
      expectTypeOf(call.args).toEqualTypeOf<readonly [Address]>();
      expectTypeOf(call.blockNumber).toEqualTypeOf<bigint>();
      expectTypeOf(call.from).toEqualTypeOf<Address | undefined>();
      return 0n;
    });

    // @ts-expect-error -- balanceOf returns a bigint
    usdc.read.balanceOf().returns("lots");
    // @ts-expect-error -- a resolver returns balanceOf's bigint too
    usdc.read.balanceOf().returns(() => "lots");
  });
});

describe("calls()", () => {
  test("history args are typed per function", () => {
    expectTypeOf(usdc.read.balanceOf.calls[0]!.args).toEqualTypeOf<readonly [Address]>();
    expectTypeOf(usdc.read.allowance.calls[0]!.args).toEqualTypeOf<readonly [Address, Address]>();
  });
});

describe("defaults", () => {
  test("keys are namespaced function names; values are typed resolvers", () => {
    mock.contract({
      abi: erc20Abi,
      address: USDC,
      defaults: {
        read: {
          decimals: 6,
          balanceOf: (call) => {
            expectTypeOf(call.args).toEqualTypeOf<readonly [Address]>();
            return 0n;
          },
        },
        simulate: {
          approve: true,
          transfer: ({ args, value }) => {
            expectTypeOf(args).toEqualTypeOf<readonly [Address, bigint]>();
            expectTypeOf(value).toEqualTypeOf<bigint>();
            return true;
          },
        },
      },
    });
  });

  test("functions must be in the right namespace", () => {
    mock.contract({
      abi: erc20Abi,
      address: USDC,
      // @ts-expect-error -- not a function on the ABI
      defaults: { read: { balanceOff: 0n } },
    });
    mock.contract({
      abi: erc20Abi,
      address: USDC,
      // @ts-expect-error -- nonpayable functions belong in simulate
      defaults: { read: { transfer: true } },
    });
    mock.contract({
      abi: erc20Abi,
      address: USDC,
      // @ts-expect-error -- view functions belong in read
      defaults: { simulate: { balanceOf: 0n } },
    });
    // @ts-expect-error -- functions go under a namespace, e.g. `read`
    mock.contract({ abi: erc20Abi, address: USDC, defaults: { decimals: 6 } });
  });

  test("values are checked against return types", () => {
    mock.contract({
      abi: erc20Abi,
      address: USDC,
      // @ts-expect-error -- decimals returns a number
      defaults: { read: { decimals: "six" } },
    });
    mock.contract({
      abi: erc20Abi,
      address: USDC,
      // @ts-expect-error -- transfer returns a boolean
      defaults: { simulate: { transfer: 1n } },
    });
  });
});

describe("reverts", () => {
  const erc721Abi = parseAbi([
    "function ownerOf(uint256 tokenId) view returns (address)",
    "error ERC721IncorrectOwner(address sender, uint256 tokenId, address owner)",
    "error EnforcedPause()",
  ]);
  const nft = mock.contract({ abi: erc721Abi, address: USDC });

  test("reverts() takes a reason, custom error, panic, raw data, or nothing", () => {
    nft.read.ownerOf().reverts();
    nft.read.ownerOf().reverts("ERC721: invalid token ID");
    nft.read.ownerOf().reverts({ errorName: "ERC721IncorrectOwner", args: [USDC, 1n, USDC] });
    nft.read.ownerOf().reverts({ errorName: "EnforcedPause" });
    nft.read.ownerOf().reverts({ panic: 0x11 });
    nft.read.ownerOf().reverts({ data: "0xdeadbeef" });

    // @ts-expect-error -- not an error on the ABI
    nft.read.ownerOf().reverts({ errorName: "Nope" });
    // @ts-expect-error -- args are required when the error has inputs
    nft.read.ownerOf().reverts({ errorName: "ERC721IncorrectOwner" });
    // @ts-expect-error -- the error takes an address, a uint256 and an address
    nft.read.ownerOf().reverts({ errorName: "ERC721IncorrectOwner", args: [1n, USDC, 1n] });
    // @ts-expect-error -- a revert spec takes one form: a panic or data, not both
    nft.read.ownerOf().reverts({ panic: 0x11, data: "0xdeadbeef" });
    // @ts-expect-error -- a revert spec takes one form: a custom error or a panic, not both
    nft.read.ownerOf().reverts({ errorName: "EnforcedPause", panic: 0x11 });
  });

  test("revert() in a resolver is typed against the ABI and returns never", () => {
    nft.read.ownerOf().returns(({ args: [tokenId], revert }) => {
      expectTypeOf(revert({ errorName: "EnforcedPause" })).toBeNever();
      // @ts-expect-error -- not an error on the ABI
      if (tokenId === 0n) revert({ errorName: "Nope" });
      return tokenId > 10n ? revert({ errorName: "EnforcedPause" }) : USDC;
    });
  });
});

describe("faults", () => {
  test("fails() takes a MockFault", () => {
    usdc.read.decimals().fails({ status: 503, retryAfter: 1 });
    usdc.read.decimals().fails({ code: -32005, message: "limit exceeded" });
    usdc.read.decimals().fails("timeout");
    usdc.simulate.transfer().fails("network");

    // @ts-expect-error -- not a fault kind
    usdc.read.decimals().fails("offline");
  });

  test("simulate mocks refuse by name; reads don't", () => {
    usdc.simulate.transfer().refuses("insufficientFunds");
    usdc.simulate.approve().once().refuses("tipAboveFeeCap");
    usdc.simulate.transfer().returns(({ refuse }) => refuse("feeCapTooLow"));
    createMockRpc().contract({
      abi: erc20Abi,
      address: USDC,
      defaults: { simulate: { transfer: ({ refuse }) => refuse("insufficientFunds") } },
    });
    usdc.simulate.transfer().refuses("gasExceedsAllowance");
    usdc.simulate.transfer().returns(({ refuse }) => refuse("intrinsicGasTooLow"));

    // @ts-expect-error -- a node doesn't refuse a read
    usdc.read.decimals().refuses("insufficientFunds");
    usdc.read.decimals().returns((context) => {
      expectTypeOf(context).not.toHaveProperty("refuse");
      return 6;
    });
    defaultsOf({
      read: {
        decimals: (context) => {
          expectTypeOf(context).not.toHaveProperty("refuse");
          return 6;
        },
      },
    });
    // @ts-expect-error -- a call doesn't check the nonce
    usdc.simulate.transfer().refuses("nonceTooLow");
    // @ts-expect-error -- nor can a default refuse a call with a send's refusal
    defaultsOf({ simulate: { transfer: ({ refuse }) => refuse("alreadyKnown") } });
  });

  test("fails() and fail() take only faults, not a node's refusal", () => {
    // @ts-expect-error -- a refusal is `.refuses()`
    usdc.simulate.transfer().fails("insufficientFunds");
    // @ts-expect-error -- and `refuse()` in a resolver
    usdc.simulate.transfer().returns(({ fail }) => fail("feeCapTooLow"));
    // @ts-expect-error -- a refusal isn't a fault on a read either
    usdc.read.decimals().fails("insufficientFunds");
    // @ts-expect-error -- `refuses()` takes no fault
    usdc.simulate.transfer().refuses({ status: 503 });
    // @ts-expect-error -- nor does `refuse()`
    usdc.simulate.transfer().returns(({ refuse }) => refuse("timeout"));
  });

  test("history tells a refusal from a fault", () => {
    expectTypeOf<Extract<MockOutcome, { type: "refusal" }>>().toEqualTypeOf<{
      type: "refusal";
      name: NodeErrorName;
    }>();
    expectTypeOf<Extract<MockOutcome, { type: "fault" }>["fault"]>().toEqualTypeOf<MockFault>();
  });

  test("fail() and refuse() in a resolver return never", () => {
    usdc.read.decimals().returns(({ fail }) => {
      expectTypeOf(fail("timeout")).toBeNever();
      return 6;
    });
    usdc.simulate.transfer().returns(({ refuse }) => {
      expectTypeOf(refuse("insufficientFunds")).toBeNever();
      return true;
    });
  });
});

describe("simulate", () => {
  test("exposes only nonpayable and payable function names", () => {
    expectTypeOf<keyof typeof usdc.simulate>().toEqualTypeOf<
      "approve" | "transfer" | "transferFrom"
    >();

    // @ts-expect-error -- view functions live on read
    usdc.simulate.balanceOf();
  });

  test("args, returns, and resolver context are typed from the ABI", () => {
    usdc.simulate.transfer([USDC, 1n]).returns(true);
    usdc.simulate.transfer().returns(({ args, from, value }) => {
      expectTypeOf(args).toEqualTypeOf<readonly [Address, bigint]>();
      expectTypeOf(from).toEqualTypeOf<Address | undefined>();
      expectTypeOf(value).toEqualTypeOf<bigint>();
      return true;
    });

    // @ts-expect-error -- transfer's amount is a bigint
    usdc.simulate.transfer([USDC, "1"]);
    // @ts-expect-error -- transfer returns a boolean
    usdc.simulate.transfer().returns(1n);
  });

  test("functions without outputs return void", () => {
    const weth = mock.contract({
      abi: parseAbi(["function deposit() payable"]),
      address: USDC,
    });
    weth.simulate.deposit().returns(() => {});
    weth.simulate.deposit().returns(undefined);
  });

  test("history is typed per function", () => {
    expectTypeOf(usdc.simulate.transfer.calls[0]!.args).toEqualTypeOf<readonly [Address, bigint]>();
  });
});

describe("estimateGas", () => {
  const token = createMockRpc().contract({
    abi: parseAbi([
      "function transfer(address to, uint256 amount) returns (bool)",
      "function balanceOf(address owner) view returns (uint256)",
      "error Paused(address by)",
    ]),
    address: USDC,
    defaults: { estimateGas: { transfer: ({ refuse }) => refuse("insufficientFunds") } },
  });

  test("takes write functions' args and answers gas", () => {
    token.estimateGas.transfer([USDC, 1n]).returns(65_000n);
    token.estimateGas.transfer().once().refuses("feeCapTooLow");
    token.estimateGas.transfer().fails({ status: 503 });
    token.estimateGas.transfer().returns(({ args, from }) => {
      expectTypeOf(args).toEqualTypeOf<readonly [Address, bigint]>();
      expectTypeOf(from).toEqualTypeOf<Address | undefined>();
      return 65_000n;
    });
    token.estimateGas.transfer().reverts({ errorName: "Paused", args: [USDC] });
    expectTypeOf(token.estimateGas.transfer.calls[0]!.args).toEqualTypeOf<
      readonly [Address, bigint]
    >();

    // @ts-expect-error -- an estimate is gas, not the function's return type
    token.estimateGas.transfer().returns(true);
    // @ts-expect-error -- transfer takes an address and a bigint
    token.estimateGas.transfer(["0x1"]);
    // @ts-expect-error -- not an error on the ABI
    token.estimateGas.transfer().reverts({ errorName: "Nope" });
    token.estimateGas.transfer().refuses("gasExceedsAllowance");
    // @ts-expect-error -- a refusal is `.refuses()`
    token.estimateGas.transfer().fails("gasExceedsAllowance");
    // @ts-expect-error -- and `refuse()` in a resolver
    token.estimateGas.transfer().returns(({ fail }) => fail("gasExceedsAllowance"));
    // @ts-expect-error -- an estimate doesn't check the nonce
    token.estimateGas.transfer().refuses("nonceTooHigh");
    // @ts-expect-error -- nor can a resolver refuse an estimate with it
    token.estimateGas.transfer().returns(({ refuse }) => refuse("nonceTooLow"));
    // @ts-expect-error -- an estimate reports too little gas as exceeding the allowance
    token.estimateGas.transfer().returns(({ refuse }) => refuse("intrinsicGasTooLow"));
    // @ts-expect-error -- nor can a default, with a send's refusal
    defaultsOf({ estimateGas: { transfer: ({ refuse }) => refuse("alreadyKnown") } });
    // @ts-expect-error -- viem doesn't estimate a view
    token.estimateGas.balanceOf; // oxlint-disable-line typescript/no-unused-expressions -- a type test
  });
});

describe("write", () => {
  const token = createMockRpc().contract({
    abi: parseAbi([
      "function transfer(address to, uint256 amount) returns (bool)",
      "function balanceOf(address owner) view returns (uint256)",
      "event Transfer(address indexed from, address indexed to, uint256 value)",
      "error Paused(address by)",
    ]),
    address: USDC,
    defaults: { write: { transfer: ({ refuse }) => refuse("insufficientFunds") } },
  });

  test("takes write functions' args and answers with the outcome", () => {
    token.write.transfer([USDC, 1n]).returns();
    token.write.transfer().returns({ status: "reverted", gasUsed: 21_000n });
    token.write.transfer().emits([token.events.Transfer({ from: USDC, to: USDC, value: 1n })]);
    token.write.transfer().emits(token.events.Transfer({ from: USDC, to: USDC, value: 1n }));
    // @ts-expect-error -- not a log: no address, topics or data
    token.write.transfer().emits({ logIndex: 0 });
    token.write.transfer().once().refuses("insufficientFunds");
    token.write.transfer().fails("timeout");
    token.write.transfer().reverts({ errorName: "Paused", args: [USDC] });
    token.write.transfer().returns(({ args, from, revert }) => {
      expectTypeOf(args).toEqualTypeOf<readonly [Address, bigint]>();
      expectTypeOf(from).toEqualTypeOf<Address>();
      if (args[1] > 5n) revert({ errorName: "Paused", args: [from] });
      return {
        logs: [token.events.Transfer({ from, to: args[0], value: args[1] }), testLog("noise")],
      };
    });
    token.write.transfer().returns((context) => {
      expectTypeOf(context).not.toHaveProperty("emit");
    });
    // @ts-expect-error -- not a log: no address, topics or data
    token.write.transfer().returns(() => ({ logs: [{ logIndex: 0 }] }));
    token.write.transfer().returns(() => Promise.resolve({ logs: [] }));
    expectTypeOf(token.write.transfer.calls[0]!.from).toEqualTypeOf<Address>();

    // @ts-expect-error -- a `write` mock answers with its outcome; the return value goes on simulate
    token.write.transfer().returns(true);
    // @ts-expect-error -- the block comes from where it's mined
    token.write.transfer().returns({ blockNumber: 1n });
    // @ts-expect-error -- not an error on the ABI
    token.write.transfer().reverts({ errorName: "Nope" });
    token.write.transfer().refuses("nonceTooLow");
    token.write.transfer().refuses("alreadyKnown");
    token.write.transfer().returns(({ refuse }) => refuse("nonceTooHigh"));
    token.write.transfer().returns(({ refuse }) => refuse("intrinsicGasTooLow"));
    // @ts-expect-error -- a refusal is `.refuses()`
    token.write.transfer().fails("nonceTooLow");
    // @ts-expect-error -- and `refuse()` in a resolver
    token.write.transfer().returns(({ fail }) => fail("nonceTooLow"));
    // @ts-expect-error -- a send with too little gas is mined, and runs out
    token.write.transfer().refuses("gasExceedsAllowance");
    // @ts-expect-error -- nor can a resolver refuse a send with it
    token.write.transfer().returns(({ refuse }) => refuse("gasExceedsAllowance"));
    // @ts-expect-error -- nor can a default refuse a send with it
    defaultsOf({ write: { transfer: ({ refuse }) => refuse("gasExceedsAllowance") } });
    // @ts-expect-error -- a view isn't sent
    token.write.balanceOf; // oxlint-disable-line typescript/no-unused-expressions -- a type test
    createMockRpc().contract({
      abi: erc20Abi,
      address: USDC,
      // @ts-expect-error -- a default is an outcome too
      defaults: { write: { transfer: true } },
    });
  });
});

describe("returns: named outputs and partial structs", () => {
  const feed = mock.contract({
    abi: parseAbi([
      "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
      "function getRoundData(uint80 roundId) view returns (uint80, int256, uint256, uint256, uint80)",
    ]),
    address: USDC,
  });
  const store = mock.contract({
    abi: parseAbi([
      "struct Position { address owner; uint256 amount; }",
      "function position(uint256 id) view returns (Position)",
    ]),
    address: USDC,
  });

  test("named outputs accept a partial object of the right types", () => {
    feed.read.latestRoundData().returns({ answer: 1n, updatedAt: 2n });
    feed.read.latestRoundData().returns({});
    feed.read.latestRoundData().returns(() => ({ answer: 1n }));

    // @ts-expect-error -- latestRoundData has no `answr` output
    feed.read.latestRoundData().returns({ answr: 1n });
    // @ts-expect-error -- `answer` is a bigint
    feed.read.latestRoundData().returns({ answer: "1" });
    // @ts-expect-error -- nor can a resolver return an `answr` output
    feed.read.latestRoundData().returns(() => ({ answr: 1n }));
  });

  test("the tuple form must be complete", () => {
    feed.read.latestRoundData().returns([1n, 2n, 3n, 4n, 5n]);

    // @ts-expect-error -- latestRoundData returns five values
    feed.read.latestRoundData().returns([1n, 2n]);
  });

  test("unnamed outputs only take the tuple form", () => {
    feed.read.getRoundData().returns([1n, 2n, 3n, 4n, 5n]);

    // @ts-expect-error -- getRoundData's outputs are unnamed, so it takes a tuple
    feed.read.getRoundData().returns({ answer: 1n });
  });

  test("struct returns accept partial objects but not unknown fields", () => {
    store.read.position().returns({ amount: 1n });
    store.read.position().returns({});

    // @ts-expect-error -- the struct has no `ownr` field
    store.read.position().returns({ ownr: USDC });
    // @ts-expect-error -- `amount` is a bigint
    store.read.position().returns({ amount: "1" });
  });
});

describe("contract.calls", () => {
  test("is a union over every function, discriminated by functionName", () => {
    const call = usdc.calls[0]!;
    expectTypeOf(call.functionName).toEqualTypeOf<
      | "allowance"
      | "balanceOf"
      | "decimals"
      | "name"
      | "symbol"
      | "totalSupply"
      | "approve"
      | "transfer"
      | "transferFrom"
    >();
    if (call.functionName === "allowance")
      expectTypeOf(call.args).toEqualTypeOf<readonly [Address, Address]>();
    if (call.functionName === "transfer")
      expectTypeOf(call.args).toEqualTypeOf<readonly [Address, bigint]>();
  });

  test("calls carry batch info", () => {
    expectTypeOf(usdc.calls[0]!.batch).toEqualTypeOf<MockBatch | undefined>();
  });

  test("calls are tagged with their namespace; a function's own aren't", () => {
    expectTypeOf<MockNamespace>().toEqualTypeOf<"read" | "simulate" | "estimateGas" | "write">();
    expectTypeOf(usdc.calls[0]!.namespace).toEqualTypeOf<MockNamespace>();
    expectTypeOf(mock.calls[0]!.namespace).toEqualTypeOf<MockNamespace>();
    expectTypeOf(usdc.read.balanceOf.calls[0]!).not.toHaveProperty("namespace");
    expectTypeOf(usdc.estimateGas.transfer.calls[0]!).not.toHaveProperty("namespace");
    expectTypeOf(usdc.write.transfer.calls[0]!).not.toHaveProperty("namespace");
  });
});

describe("rpc", () => {
  test("MockRpc is the type createMockRpc returns", () => {
    expectTypeOf(mock).toEqualTypeOf<MockRpc>();
  });

  test("calls are untyped across contracts but carry the address", () => {
    const call = mock.calls[0]!;
    expectTypeOf(call.address).toEqualTypeOf<Address>();
    expectTypeOf(call.args).toEqualTypeOf<readonly unknown[]>();
    expectTypeOf(usdc.calls[0]!.address).toEqualTypeOf<Address>();
  });
});

describe("zeroResult", () => {
  const weth = mock.contract({ abi: parseAbi(["function deposit() payable"]), address: USDC });

  test("is accepted wherever a return value is", () => {
    usdc.read.balanceOf().returns(zeroResult);
    usdc.simulate.transfer().returns(zeroResult);
    weth.simulate.deposit().returns(zeroResult);
    usdc.read.balanceOf().returns(({ args: [owner] }) => (owner === USDC ? 1n : zeroResult));
    mock.contract({
      abi: erc20Abi,
      address: USDC,
      defaults: { read: { decimals: zeroResult }, simulate: { approve: zeroResult } },
    });
  });

  test(".returns() takes no argument, but undefined only where there are no outputs", () => {
    usdc.read.balanceOf().returns();
    weth.simulate.deposit().returns();
    weth.simulate.deposit().returns(undefined);

    // @ts-expect-error -- balanceOf has an output
    usdc.read.balanceOf().returns(undefined);
  });
});

describe("pins: fn(args, { from, value })", () => {
  const vaultAbi = parseAbi([
    "function deposit() payable",
    "function withdraw(uint256 amount)",
    "function withdraw(uint256 amount, address to)",
  ]);
  const vault = createMockRpc().contract({ abi: vaultAbi, address: USDC });

  test("from on every namespace, as an address or a matcher", () => {
    usdc.read.balanceOf([USDC], { from: USDC });
    usdc.simulate.transfer(undefined, { from: match.any() });
    usdc.estimateGas.transfer([USDC, 1n], { from: USDC });
    usdc.write.transfer(undefined, { from: match.where((from) => from !== USDC) });
    // @ts-expect-error -- from is an address
    usdc.read.balanceOf([USDC], { from: 1n });
    // @ts-expect-error -- a call pins only `from` and `value`
    usdc.write.transfer(undefined, { account: USDC });
  });

  test("value only on a payable function", () => {
    vault.write.deposit([], { value: 1n });
    vault.simulate.deposit(undefined, { from: USDC, value: 1n });
    vault.estimateGas.deposit([], { value: match.where((value) => value > 0n, "positive") });
    // @ts-expect-error -- withdraw is nonpayable
    vault.write.withdraw([1n], { value: 1n });
    // @ts-expect-error -- views take no value
    usdc.read.balanceOf([USDC], { value: 0n });
  });

  test("on an overloaded name, value is typed if any overload is payable", () => {
    const mixed = createMockRpc().contract({
      abi: parseAbi(["function f(uint256) payable", "function f(uint256, address)"]),
      address: USDC,
    });
    mixed.write.f([1n], { value: 1n });
    mixed.write.f([1n], { value: match.where((value) => value > 0n, "positive") });
    mixed.estimateGas.f([1n], { value: match.any() });
    // Typed by name: only the runtime refuses the nonpayable overload's value.
    mixed.write.f([1n, USDC], { value: 1n });
  });

  test("an ABI without literal types takes value anywhere; the runtime refuses it", () => {
    const loose: Abi = vaultAbi;
    const token = createMockRpc().contract({ abi: loose, address: USDC });
    token.write.withdraw?.([1n], { value: 1n });
  });
});
