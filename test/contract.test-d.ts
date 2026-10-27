import { type Address, erc20Abi, parseAbi } from "viem";
import { describe, expectTypeOf, test } from "vite-plus/test";
import { createMockRpc } from "../src/index.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const mock = createMockRpc();
const usdc = mock.contract({ abi: erc20Abi, address: USDC });

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
