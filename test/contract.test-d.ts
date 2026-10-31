import { type Address, erc20Abi, parseAbi } from "viem";
import { describe, expectTypeOf, test } from "vite-plus/test";

import { type MockBatch, type MockRpc, createMockRpc, zeroResult } from "../src/index.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const mock = createMockRpc();
const usdc = mock.contract({ abi: erc20Abi, address: USDC });

describe("async resolvers", () => {
  test("a resolver may return a promise of the right type", () => {
    const token = createMockRpc().contract({ abi: erc20Abi, address: USDC });
    token.read.decimals().returns(() => Promise.resolve(6));
    // @ts-expect-error still the function's return type
    token.read.decimals().returns(() => Promise.resolve("six"));
    createMockRpc()
      .actions.getBalance()
      .returns(() => Promise.resolve(1n));
  });
});

describe("names", () => {
  test("name is optional and readable back", () => {
    const named = createMockRpc().contract({ abi: erc20Abi, address: USDC, name: "USDC" });
    expectTypeOf(named.name).toEqualTypeOf<string | undefined>();
    // @ts-expect-error names are strings
    createMockRpc().contract({ abi: erc20Abi, address: USDC, name: 1 });
  });
});

describe("read", () => {
  test("exposes only read function names from the ABI", () => {
    expectTypeOf<keyof typeof usdc.read>().toEqualTypeOf<
      "allowance" | "balanceOf" | "decimals" | "name" | "symbol" | "totalSupply"
    >();

    // @ts-expect-error not on the ABI
    usdc.read.balanceOff();
    // @ts-expect-error write functions are excluded
    usdc.read.transfer();
  });

  test("args are typed per function", () => {
    usdc.read.balanceOf(["0x0000000000000000000000000000000000000001"]);
    usdc.read.allowance([USDC, USDC]);

    // @ts-expect-error wrong arg type
    usdc.read.balanceOf([123n]);
    // @ts-expect-error wrong arity
    usdc.read.allowance([USDC]);
    // @ts-expect-error takes no args
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

    // @ts-expect-error wrong return type
    usdc.read.balanceOf().returns("lots");
    // @ts-expect-error resolver returns wrong type
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
      // @ts-expect-error not a function on the ABI
      defaults: { read: { balanceOff: 0n } },
    });
    mock.contract({
      abi: erc20Abi,
      address: USDC,
      // @ts-expect-error nonpayable functions belong in simulate
      defaults: { read: { transfer: true } },
    });
    mock.contract({
      abi: erc20Abi,
      address: USDC,
      // @ts-expect-error view functions belong in read
      defaults: { simulate: { balanceOf: 0n } },
    });
    // @ts-expect-error the flat form is gone; functions go under a namespace
    mock.contract({ abi: erc20Abi, address: USDC, defaults: { decimals: 6 } });
  });

  test("values are checked against return types", () => {
    mock.contract({
      abi: erc20Abi,
      address: USDC,
      // @ts-expect-error wrong return type
      defaults: { read: { decimals: "six" } },
    });
    mock.contract({
      abi: erc20Abi,
      address: USDC,
      // @ts-expect-error wrong return type
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

    // @ts-expect-error not an error on the ABI
    nft.read.ownerOf().reverts({ errorName: "Nope" });
    // @ts-expect-error args are required when the error has inputs
    nft.read.ownerOf().reverts({ errorName: "ERC721IncorrectOwner" });
    // @ts-expect-error wrong arg types
    nft.read.ownerOf().reverts({ errorName: "ERC721IncorrectOwner", args: [1n, USDC, 1n] });
  });

  test("revert() in a resolver is typed against the ABI and returns never", () => {
    nft.read.ownerOf().returns(({ args: [tokenId], revert }) => {
      expectTypeOf(revert({ errorName: "EnforcedPause" })).toBeNever();
      // @ts-expect-error not an error on the ABI
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

    // @ts-expect-error not a fault kind
    usdc.read.decimals().fails("offline");
  });

  test("simulate mocks also take a node's refusal by name; reads don't", () => {
    usdc.simulate.transfer().fails("insufficientFunds");
    usdc.simulate.approve().once().fails("tipAboveFeeCap");
    usdc.simulate.transfer().returns(({ fail }) => fail("feeCapTooLow"));
    createMockRpc().contract({
      abi: erc20Abi,
      address: USDC,
      defaults: { simulate: { transfer: ({ fail }) => fail("insufficientFunds") } },
    });

    // @ts-expect-error a node doesn't refuse a read by name
    usdc.read.decimals().fails("insufficientFunds");
    // @ts-expect-error nor in a resolver
    usdc.read.decimals().returns(({ fail }) => fail("insufficientFunds"));
    // @ts-expect-error not a node error
    usdc.simulate.transfer().fails("nonceTooLow");
  });

  test("fail() in a resolver returns never", () => {
    usdc.read.decimals().returns(({ fail }) => {
      expectTypeOf(fail("timeout")).toBeNever();
      return 6;
    });
  });
});

describe("simulate", () => {
  test("exposes only nonpayable and payable function names", () => {
    expectTypeOf<keyof typeof usdc.simulate>().toEqualTypeOf<
      "approve" | "transfer" | "transferFrom"
    >();

    // @ts-expect-error view functions live on read
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

    // @ts-expect-error wrong arg type
    usdc.simulate.transfer([USDC, "1"]);
    // @ts-expect-error wrong return type
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
    defaults: { estimateGas: { transfer: ({ fail }) => fail("insufficientFunds") } },
  });

  test("takes write functions' args and answers gas", () => {
    token.estimateGas.transfer([USDC, 1n]).returns(65_000n);
    token.estimateGas.transfer().once().fails("feeCapTooLow");
    token.estimateGas.transfer().returns(({ args, from }) => {
      expectTypeOf(args).toEqualTypeOf<readonly [Address, bigint]>();
      expectTypeOf(from).toEqualTypeOf<Address | undefined>();
      return 65_000n;
    });
    token.estimateGas.transfer().reverts({ errorName: "Paused", args: [USDC] });
    expectTypeOf(token.estimateGas.transfer.calls[0]!.args).toEqualTypeOf<
      readonly [Address, bigint]
    >();

    // @ts-expect-error an estimate is gas, not the function's return type
    token.estimateGas.transfer().returns(true);
    // @ts-expect-error args are the function's
    token.estimateGas.transfer(["0x1"]);
    // @ts-expect-error not an error on the ABI
    token.estimateGas.transfer().reverts({ errorName: "Nope" });
    // @ts-expect-error viem estimates only writes
    token.estimateGas.balanceOf; // oxlint-disable-line typescript/no-unused-expressions -- a type test
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

    // @ts-expect-error unknown output name
    feed.read.latestRoundData().returns({ answr: 1n });
    // @ts-expect-error wrong type for a named output
    feed.read.latestRoundData().returns({ answer: "1" });
    // @ts-expect-error unknown output name from a resolver
    feed.read.latestRoundData().returns(() => ({ answr: 1n }));
  });

  test("the tuple form must be complete", () => {
    feed.read.latestRoundData().returns([1n, 2n, 3n, 4n, 5n]);

    // @ts-expect-error missing elements
    feed.read.latestRoundData().returns([1n, 2n]);
  });

  test("unnamed outputs only take the tuple form", () => {
    feed.read.getRoundData().returns([1n, 2n, 3n, 4n, 5n]);

    // @ts-expect-error no names to key by
    feed.read.getRoundData().returns({ answer: 1n });
  });

  test("struct returns accept partial objects but not unknown fields", () => {
    store.read.position().returns({ amount: 1n });
    store.read.position().returns({});

    // @ts-expect-error unknown field
    store.read.position().returns({ ownr: USDC });
    // @ts-expect-error wrong field type
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

  test("chainId is a number", () => {
    expectTypeOf(mock.chainId).toEqualTypeOf<number>();
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

    // @ts-expect-error balanceOf has an output
    usdc.read.balanceOf().returns(undefined);
  });
});
