import { type Address, erc20Abi, parseAbi } from "viem";
import { describe, expectTypeOf, test } from "vite-plus/test";
import { createMockRpc, match } from "../src/index.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

// A generic ABI for small integers and overloads.
const abi = parseAbi([
  "function feeOf(uint8 tier) view returns (uint256)",
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);
// A generic order book, for structs.
const bookAbi = parseAbi([
  "struct Asset { address token; uint256 amount; }",
  "struct Order { address maker; Asset sell; uint64 expiry; }",
  "function filled(Order order) view returns (bool)",
  "function anyFilled(Order[] orders) view returns (bool)",
  "function makers(address[] path) view returns (bool)",
]);

describe("matchers take the type of their position", () => {
  test("predicates get the field's type", () => {
    const mock = createMockRpc();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    const registry = mock.contract({ abi, address: USDC });

    usdc.read
      .allowance([
        USDC,
        match.where((spender) => {
          expectTypeOf(spender).toEqualTypeOf<Address>();
          return true;
        }),
      ])
      .returns(1n);
    registry.read
      .feeOf([
        match.where((tier) => {
          expectTypeOf(tier).toEqualTypeOf<number>();
          return tier > 1;
        }),
      ])
      .returns(1n);
  });

  test("return values are still checked", () => {
    const mock = createMockRpc();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });

    usdc.read.balanceOf([match.any()]).returns(1n);
    // @ts-expect-error -- balanceOf returns a bigint
    usdc.read.balanceOf([match.any()]).returns("1");
  });

  test("predicates must return a boolean", () => {
    const mock = createMockRpc();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });

    usdc.read.balanceOf([
      // @ts-expect-error -- a block body without `return` returns void
      match.where((owner) => {
        owner.startsWith("0x");
      }),
    ]);
  });

  test("overloads resolve by arg count", () => {
    const mock = createMockRpc();
    const token = mock.contract({ abi, address: USDC });

    token.read.balanceOf([match.any()]).returns(1n);
    token.read.balanceOf([match.any(), match.where((id) => id > 0n)]).returns(1n);
  });

  test("action and method params take matchers", () => {
    const mock = createMockRpc();

    mock.actions
      .getBalance({
        address: match.where((address) => {
          expectTypeOf(address).toEqualTypeOf<Address>();
          return true;
        }),
      })
      .returns(1n);
    mock.actions
      .getBlock({
        blockNumber: match.where((n) => {
          expectTypeOf(n).toEqualTypeOf<bigint>();
          return n > 5n;
        }),
      })
      .returns(null);
    mock.method("eth_getStorageAt", [match.any(), "0x00"]).returns(null);
  });
});

describe("match.partial()", () => {
  test("takes any subset of a struct's fields, at any depth", () => {
    const mock = createMockRpc();
    const book = mock.contract({ abi: bookAbi, address: USDC });

    book.read.filled([match.partial({ maker: USDC })]).returns(true);
    book.read.filled([match.partial({ sell: { amount: 5n } })]).returns(true);
    book.read.anyFilled([[match.partial({ expiry: 1n })]]).returns(true);
    book.read
      .filled([
        match.partial({
          sell: {
            amount: match.where((amount) => {
              expectTypeOf(amount).toEqualTypeOf<bigint>();
              return amount > 0n;
            }),
          },
        }),
      ])
      .returns(true);
  });

  test("rejects unknown fields and wrong types", () => {
    const mock = createMockRpc();
    const book = mock.contract({ abi: bookAbi, address: USDC });

    // @ts-expect-error -- Order has no `taker`
    book.read.filled([match.partial({ taker: USDC })]).returns(true);
    // @ts-expect-error -- `expiry` is a uint64: a bigint
    book.read.filled([match.partial({ expiry: "soon" })]).returns(true);
    // @ts-expect-error -- `filled` returns a bool
    book.read.filled([match.partial({ maker: USDC })]).returns(1n);
  });

  test("isn't for arrays", () => {
    const mock = createMockRpc();
    const book = mock.contract({ abi: bookAbi, address: USDC });

    // @ts-expect-error -- arrays match whole; use match.where()
    book.read.makers([match.partial([USDC])]).returns(true);
  });
});
