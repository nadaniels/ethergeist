import {
  BaseError,
  ContractFunctionExecutionError,
  createPublicClient,
  erc20Abi,
  getAddress,
  parseAbi,
} from "viem";
import { mainnet } from "viem/chains";
import { describe, expect, test } from "vite-plus/test";

import {
  MockNotFoundError,
  MockSetupError,
  createMockRpc,
  match,
  testAddress,
} from "../src/index.js";
import {
  expectCause,
  expectRejects,
  expectThrows,
  hintsOf,
  lowercase,
  rejectionOf,
} from "./utils.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const alice = testAddress("alice");
const bob = testAddress("bob");

function setup(parameters?: Parameters<typeof createMockRpc>[0]) {
  const mock = createMockRpc(parameters);
  const client = createPublicClient({
    chain: mainnet,
    transport: mock.transport(),
    // viem caches eth_blockNumber for `cacheTime`, which defaults from
    // `chain.blockTime` (4s on mainnet). Without this, `mock.mine()` is
    // invisible to `getBlockNumber`.
    cacheTime: 0,
  });
  return { mock, client };
}

function withToken() {
  const { mock, client } = setup();
  const usdc = mock.contract({ abi: erc20Abi, address: USDC });
  return { mock, client, usdc };
}

describe("block number", () => {
  test("returns the configured block and advances with mine()", async () => {
    const { mock, client } = setup({ blockNumber: 100n });
    expect(await client.getBlockNumber()).toBe(100n);
    mock.mine(5);
    expect(await client.getBlockNumber()).toBe(105n);
  });

  test("default client caching hides mined blocks", async () => {
    const mock = createMockRpc({ blockNumber: 100n });
    const client = createPublicClient({ chain: mainnet, transport: mock.transport() });
    expect(await client.getBlockNumber()).toBe(100n);
    mock.mine();
    expect(await client.getBlockNumber()).toBe(100n);
  });
});

describe("balanceOf", () => {
  test("returns a mocked value for specific args", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.balanceOf([alice]).returns(500_000000n);

    const balance = await client.readContract({
      abi: erc20Abi,
      address: USDC,
      functionName: "balanceOf",
      args: [alice],
    });
    expect(balance).toBe(500_000000n);
  });

  test("stores and retrieves multiple calls", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.balanceOf([alice]).returns(1n);
    usdc.read.balanceOf([bob]).returns(2n);

    const read = (account: `0x${string}`) =>
      client.readContract({
        abi: erc20Abi,
        address: USDC,
        functionName: "balanceOf",
        args: [account],
      });
    const balanceAlice = await read(alice);
    const balanceBob = await read(bob);
    expect(balanceAlice).toBe(1n);
    expect(balanceBob).toBe(2n);
  });

  test("falls back to an args-less mock; most recent of equal specificity wins", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.balanceOf().returns(0n);
    usdc.read.balanceOf([alice]).returns(1n);
    usdc.read.balanceOf([alice]).returns(2n);

    const read = (account: `0x${string}`) =>
      client.readContract({
        abi: erc20Abi,
        address: USDC,
        functionName: "balanceOf",
        args: [account],
      });
    expect(await read(alice)).toBe(2n);
    expect(await read(bob)).toBe(0n);
  });

  test("specific args win over a broader mock registered later", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.balanceOf([alice]).returns(9n);
    usdc.read.balanceOf().returns(1n);

    const read = (account: `0x${string}`) =>
      client.readContract({
        abi: erc20Abi,
        address: USDC,
        functionName: "balanceOf",
        args: [account],
      });
    expect(await read(alice)).toBe(9n);
    expect(await read(bob)).toBe(1n);
  });

  test("more pinned-down args win: allowance(alice, bob) over allowance()", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.allowance([alice, bob]).returns(5n);
    usdc.read.allowance().returns(0n);

    const allowance = (owner: `0x${string}`, spender: `0x${string}`) =>
      client.readContract({
        abi: erc20Abi,
        address: USDC,
        functionName: "allowance",
        args: [owner, spender],
      });
    expect(await allowance(alice, bob)).toBe(5n);
    expect(await allowance(bob, alice)).toBe(0n);
  });

  test("matches addresses case-insensitively", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({
      abi: erc20Abi,
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    });
    usdc.read.balanceOf([lowercase(alice)]).returns(7n);

    expect(
      await client.readContract({
        abi: erc20Abi,
        address: USDC,
        functionName: "balanceOf",
        args: [alice],
      }),
    ).toBe(7n);
  });

  test("resolver functions see args and block (balance-at-block)", async () => {
    const { mock, client } = setup({ blockNumber: 10n });
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.balanceOf().returns(({ blockNumber }) => (blockNumber >= 10n ? 100n : 50n));

    const read = (blockNumber?: bigint) =>
      client.readContract({
        abi: erc20Abi,
        address: USDC,
        functionName: "balanceOf",
        args: [alice],
        ...(blockNumber === undefined ? {} : { blockNumber }),
      });
    expect(await read()).toBe(100n);
    expect(await read(5n)).toBe(50n);
  });

  test("records decoded calls", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.balanceOf().returns(0n);

    await client.readContract({
      abi: erc20Abi,
      address: USDC,
      functionName: "balanceOf",
      args: [alice],
    });
    const calls = usdc.read.balanceOf.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([getAddress(alice)]);
  });

  test("function names that shadow object/function builtins work", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.name().returns("USD Coin");

    expect(await client.readContract({ abi: erc20Abi, address: USDC, functionName: "name" })).toBe(
      "USD Coin",
    );
    expect(usdc.read.name.calls).toHaveLength(1);
  });

  test("function names inherited from Object.prototype get mocks too", async () => {
    const { mock, client } = setup();
    const abi = parseAbi(["function toString(uint256) view returns (string)"]);
    const token = mock.contract({ abi, address: USDC });
    // Lint reads `token.read.toString()` as `Object.prototype`'s method, so
    // the registrar is destructured.
    const { toString: mockToString } = token.read;
    mockToString().returns("7");

    expect(
      await client.readContract({ abi, address: USDC, functionName: "toString", args: [7n] }),
    ).toBe("7");
  });

  test("unmocked calls fail once, loudly, without retries", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.balanceOf([bob]).returns(0n);

    const error = expectCause(
      await rejectionOf(
        client.readContract({
          abi: erc20Abi,
          address: USDC,
          functionName: "balanceOf",
          args: [alice],
        }),
      ),
      BaseError,
    );
    expect(error.message).toContain(`No mock for balanceOf(${getAddress(alice)})`);
    expect(hintsOf(expectCause(error, MockNotFoundError))).toBe(
      `Registered:\n  balanceOf(${getAddress(bob)})  ← account didn't match`,
    );
    expect(mock.history).toHaveLength(1);
  });

  test("a function not on the contract's ABI isn't answered, and isn't a call", async () => {
    const { mock, client } = setup();
    const owned = mock.contract({
      abi: parseAbi(["function owner() view returns (address)"]),
      address: USDC,
      name: "Owned",
    });

    const error = await rejectionOf(
      client.readContract({ abi: erc20Abi, address: USDC, functionName: "decimals" }),
    );

    expect(expectCause(error, MockNotFoundError).shortMessage).toBe(
      `No function with selector 0x313ce567 on mocked contract Owned (${USDC}).`,
    );
    expect(mock.unhandled).toHaveLength(1);
    expect(owned.calls).toEqual([]);
    expect(mock.calls).toEqual([]);
  });

  test("the miss names the first arg that differs, by its ABI name", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.allowance([alice, bob]).returns(1n);
    usdc.read.allowance([bob, match.any()]).returns(2n);

    const error = await rejectionOf(
      client.readContract({
        abi: erc20Abi,
        address: USDC,
        functionName: "allowance",
        args: [alice, alice],
      }),
    );
    expect(hintsOf(expectCause(error, MockNotFoundError))).toBe(
      [
        "Registered:",
        `  allowance(${getAddress(alice)}, ${getAddress(bob)})  ← spender didn't match`,
        `  allowance(${getAddress(bob)}, any)  ← owner didn't match`,
      ].join("\n"),
    );
  });

  test("the miss numbers an unnamed arg from 1", async () => {
    const { mock, client } = setup();
    const pairAbi = parseAbi(["function rate(address, address) view returns (uint256)"]);
    const pair = mock.contract({ abi: pairAbi, address: USDC });
    pair.read.rate([alice, bob]).returns(1n);

    const error = await rejectionOf(
      client.readContract({
        abi: pairAbi,
        address: USDC,
        functionName: "rate",
        args: [alice, alice],
      }),
    );

    expect(hintsOf(expectCause(error, MockNotFoundError))).toBe(
      `Registered:\n  rate(${alice}, ${bob})  ← arg 2 didn't match`,
    );
  });

  test("a mock without an answer doesn't answer", async () => {
    const { mock, client } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).read.balanceOf([alice]);

    await rejectionOf(
      client.readContract({
        abi: erc20Abi,
        address: USDC,
        functionName: "balanceOf",
        args: [alice],
      }),
    );
    expect(mock.unhandled[0]?.error).toBeInstanceOf(MockNotFoundError);
    expect(hintsOf(mock.unhandled[0]?.error)).toBe(
      `Registered:\n  balanceOf(${getAddress(alice)}) without an answer`,
    );
  });

  test("a resolver can throw MockNotFoundError to leave a call unanswered", async () => {
    const { mock, client } = setup();
    mock
      .contract({ abi: erc20Abi, address: USDC })
      .read.balanceOf()
      .returns(({ args: [owner] }) => {
        if (owner === alice) return 1n;
        throw new MockNotFoundError(`No balance for ${owner}.`);
      });

    await rejectionOf(
      client.readContract({ abi: erc20Abi, address: USDC, functionName: "balanceOf", args: [bob] }),
    );
    expect(mock.unhandled[0]?.error).toBeInstanceOf(MockNotFoundError);
    expect(mock.unhandled[0]?.error.shortMessage).toBe(`No balance for ${bob}.`);
  });

  test("a mock without an answer steps aside for one with an answer", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.balanceOf().returns(5n);
    usdc.read.balanceOf([alice]);

    expect(
      await client.readContract({
        abi: erc20Abi,
        address: USDC,
        functionName: "balanceOf",
        args: [alice],
      }),
    ).toBe(5n);
  });
});

describe("the args count", () => {
  const anyValue = "Use match.any() for each arg that can be any value.";

  test("a list shorter than the function's args is refused, pointing to match.any()", () => {
    const { mock, usdc } = withToken();

    const error = expectThrows(MockSetupError, "read.allowance takes 2 args; got 1.", () =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a short list, cast as tests write one
      usdc.read.allowance([alice] as never),
    );
    expect(error.metaMessages).toEqual([anyValue]);
    expect(
      expectThrows(MockSetupError, "read.balanceOf takes 1 arg; got 0.", () =>
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an empty list, cast as tests write one
        usdc.read.balanceOf([] as never),
      ).metaMessages,
    ).toEqual([anyValue]);
    expectThrows(MockSetupError, "simulate.transfer takes 2 args; got 1.", () =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a short list, cast as tests write one
      usdc.simulate.transfer([bob] as never),
    );
    // A call that throws registers nothing.
    expect(() => {
      mock.assertAllUsed();
    }).not.toThrow();
  });

  test("a list longer than the function's args is refused", () => {
    const { usdc } = withToken();

    const error = expectThrows(MockSetupError, "read.balanceOf takes 1 arg; got 2.", () =>
      // @ts-expect-error -- balanceOf takes one arg
      usdc.read.balanceOf([alice, bob]),
    );
    expect(error.metaMessages).toBeUndefined();
    expectThrows(MockSetupError, "read.totalSupply takes no args; got 1.", () =>
      // @ts-expect-error -- totalSupply takes no args
      usdc.read.totalSupply([alice]),
    );
  });

  test("args that aren't a list are refused, for one overload or several", () => {
    const { mock, usdc } = withToken();
    const overloaded = mock.contract({
      abi: parseAbi([
        "function balanceOf(address owner) view returns (uint256)",
        "function balanceOf(address owner, uint256 id) view returns (uint256)",
      ]),
      address: bob,
    });

    // `match.any()` takes the args' type, so it type-checks.
    const error = expectThrows(
      MockSetupError,
      "read.allowance's args must be a list; got any.",
      () => {
        // oxlint-disable-next-line typescript/no-confusing-void-expression -- match.any() takes the args' type, which includes void
        usdc.read.allowance(match.any());
      },
    );
    expect(error.metaMessages).toEqual([
      "Wrap them in a list, or leave them out to match any args.",
    ]);
    expectThrows(MockSetupError, `read.balanceOf's args must be a list; got ${alice}.`, () =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a bare address, cast as tests write one
      usdc.read.balanceOf(alice as never),
    );
    const overloadedError = expectThrows(
      MockSetupError,
      "read.balanceOf's args must be a list; got any.",
      () => {
        // oxlint-disable-next-line typescript/no-confusing-void-expression -- match.any() takes the args' type, which includes void
        overloaded.read.balanceOf(match.any());
      },
    );
    // Args left out don't choose an overload.
    expect(overloadedError.metaMessages).toEqual([
      "Wrap them in a list, e.g. [match.any()], to choose an overload.",
    ]);
    expectThrows(MockSetupError, `read.balanceOf's args must be a list; got ${alice}.`, () =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a bare address, cast as tests write one
      overloaded.read.balanceOf(alice as never),
    );
  });

  test("an empty list for a function without args answers", async () => {
    const { client, usdc } = withToken();
    usdc.read.totalSupply([]).returns(5n);

    expect(
      await client.readContract({ abi: erc20Abi, address: USDC, functionName: "totalSupply" }),
    ).toBe(5n);
  });

  test("args left out and defaults aren't counted", async () => {
    const { mock, client, usdc } = withToken();
    usdc.read.allowance().returns(1n);
    mock.contract({ abi: erc20Abi, address: bob, defaults: { read: { allowance: 2n } } });

    const allowance = (address: `0x${string}`) =>
      client.readContract({
        abi: erc20Abi,
        address,
        functionName: "allowance",
        args: [alice, bob],
      });
    expect([await allowance(USDC), await allowance(bob)]).toEqual([1n, 2n]);
  });
});

describe("the args' types", () => {
  const typesAbi = parseAbi([
    "struct Swap { address tokenIn; uint256 amountIn; }",
    "struct Route { Swap[] swaps; uint8 hops; }",
    "function quote(Swap swap) view returns (uint256)",
    "function route(Route route) view returns (uint256)",
    "function pay((address,uint256) payment) view returns (uint256)",
    "function e(uint256 x) view returns (uint256)",
    "function e(Swap swap) view returns (uint256)",
    "function lookup(string name) view returns (uint256)",
    "function verify(bytes sig) view returns (uint256)",
    "function digest(bytes32 hash) view returns (uint256)",
    "function delta(int256 change) view returns (uint256)",
    "function level(uint8 tier) view returns (uint256)",
    "function tilt(int8 angle) view returns (uint256)",
    "function batch(Swap[] swaps) view returns (uint256)",
    "function sum(uint256[] ids) view returns (uint256)",
    "function pairs(Swap[2] swaps) view returns (uint256)",
    "function proofs(uint256[2][] points) view returns (uint256)",
    "function tens(uint8[10] digits) view returns (uint256)",
    "function sigs(bytes[] sigs) view returns (uint256)",
    "function pays((address,uint256)[] payments) view returns (uint256)",
  ]);

  function withRouter() {
    const { mock, client } = setup();
    const router = mock.contract({ abi: typesAbi, address: bob });
    const read = (
      functionName:
        | "quote"
        | "route"
        | "pay"
        | "e"
        | "verify"
        | "digest"
        | "delta"
        | "level"
        | "tilt"
        | "proofs"
        | "tens",
      args: readonly unknown[],
    ) =>
      client.readContract({
        abi: typesAbi,
        address: bob,
        functionName,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- args for any of the three
        args: args as never,
      });
    return { mock, client, router, read };
  }

  test("an arg that doesn't fit its input is refused, by its ABI name or position", () => {
    const { mock, usdc } = withToken();
    // As solc writes an unnamed input; `parseAbi` leaves its name out.
    const nftAbi = [
      {
        type: "function",
        name: "ownerOf",
        stateMutability: "view",
        inputs: [{ type: "uint256", name: "" }],
        outputs: [{ type: "address", name: "" }],
      },
    ] as const;
    const nft = mock.contract({ abi: nftAbi, address: bob });

    const error = expectThrows(
      MockSetupError,
      "simulate.transfer's amount must be a uint256; got a lot.",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fixture of the wrong type, cast as tests write one
      () => usdc.simulate.transfer([bob, "a lot" as never]),
    );
    expect(error.metaMessages).toBeUndefined();
    expectThrows(MockSetupError, "read.balanceOf's account must be an address; got 5n.", () =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fixture of the wrong type, cast as tests write one
      usdc.read.balanceOf([5n as never]),
    );
    expectThrows(MockSetupError, "read.ownerOf's arg 1 must be a uint256; got a lot.", () =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fixture of the wrong type, cast as tests write one
      nft.read.ownerOf(["a lot" as never]),
    );
    // A call that throws registers nothing.
    expect(() => {
      mock.assertAllUsed();
    }).not.toThrow();
  });

  test("a struct's field or a list's element that doesn't fit is refused by its path", () => {
    const { router } = withRouter();

    const error = expectThrows(
      MockSetupError,
      "read.route's route.swaps[0].amountIn must be a uint256; got a lot.",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fixture of the wrong type, cast as tests write one
      () => router.read.route([{ swaps: [{ amountIn: "a lot" }] } as never]),
    );
    expect(error.metaMessages).toBeUndefined();
    expectThrows(MockSetupError, "read.sum's ids[2] must be a uint256; got x.", () =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fixture of the wrong type, cast as tests write one
      router.read.sum([[1n, 2n, "x" as never]]),
    );
    expectThrows(MockSetupError, "read.pay's payment[1] must be a uint256; got x.", () =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fixture of the wrong type, cast as tests write one
      router.read.pay([[alice, "x" as never]]),
    );
  });

  test("a key that isn't a struct's field is refused by the struct's path", () => {
    const { router } = withRouter();

    const error = expectThrows(MockSetupError, "fee isn't a field of read.quote's swap.", () =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Swap has no fee
      router.read.quote([{ tokenIn: alice, fee: 1n } as never]),
    );
    expect(error.metaMessages).toEqual(["Its fields are address tokenIn and uint256 amountIn."]);
    expectThrows(MockSetupError, "fee isn't a field of read.quote's swap.", () =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Swap has no fee
      router.read.quote([{ tokenIn: match.any(), fee: 1n } as never]),
    );
    expectThrows(MockSetupError, "read.quote's swap.amountIn must be a uint256; got x.", () =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fixture of the wrong type, cast as tests write one
      router.read.quote([match.partial({ amountIn: "x" as never })]),
    );
    const nested = expectThrows(
      MockSetupError,
      "fee isn't a field of read.route's route.swaps[1].",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Swap has no fee
      () => router.read.route([{ swaps: [{ tokenIn: alice }, { fee: 1n }] } as never]),
    );
    expect(nested.metaMessages).toEqual(["Its fields are address tokenIn and uint256 amountIn."]);

    const { mock } = withRouter();
    const orderAbi = parseAbi([
      "struct Order { address maker; uint256 amount; bool buy; }",
      "function place(Order order) view returns (uint256)",
    ]);
    const book = mock.contract({ abi: orderAbi, address: alice });
    const three = expectThrows(MockSetupError, "fee isn't a field of read.place's order.", () =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Order has no fee
      book.read.place([{ maker: alice, fee: 1n } as never]),
    );
    expect(three.metaMessages).toEqual([
      "Its fields are address maker, uint256 amount and bool buy.",
    ]);
  });

  test("a value given for a whole struct, or a list of them, is refused, showing the struct's fields", () => {
    const { router } = withRouter();

    const named = expectThrows(
      MockSetupError,
      "read.quote's swap must be a tuple (address tokenIn, uint256 amountIn); got 5n.",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fixture of the wrong type, cast as tests write one
      () => router.read.quote([5n as never]),
    );
    expect(named.metaMessages).toBeUndefined();
    expectThrows(
      MockSetupError,
      "read.route's route must be a tuple " +
        "((address tokenIn, uint256 amountIn)[] swaps, uint8 hops); got 5n.",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fixture of the wrong type, cast as tests write one
      () => router.read.route([5n as never]),
    );
    // Only an object for a struct viem decodes as a list gets a hint.
    const unnamed = expectThrows(
      MockSetupError,
      "read.pay's payment must be a tuple (address, uint256); got [5n].",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fixture of the wrong type, cast as tests write one
      () => router.read.pay([[5n] as never]),
    );
    expect(unnamed.metaMessages).toBeUndefined();
    const list = expectThrows(
      MockSetupError,
      "read.pays's payments must be a list of tuples (address, uint256); got { a: 1n }.",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fixture of the wrong type, cast as tests write one
      () => router.read.pays([{ a: 1n } as never]),
    );
    expect(list.metaMessages).toBeUndefined();
    const value = expectThrows(
      MockSetupError,
      "read.sum's ids must be a uint256[]; got { a: 1n }.",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fixture of the wrong type, cast as tests write one
      () => router.read.sum([{ a: 1n } as never]),
    );
    expect(value.metaMessages).toBeUndefined();
  });

  test("a struct with named fields written as a list answers the app's call, for one overload or several", async () => {
    const { router, read } = withRouter();
    // viem's types take a struct as an object, where a JSON ABI's take either.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a struct as a list
    router.read.quote([[alice, 5n] as never]).returns(1n);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a struct as a list
    router.read.e([[alice, 3n] as never]).returns(2n);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a struct as a list
    router.read.route([{ swaps: [[alice, match.any()] as never], hops: 2 }]).returns(3n);

    expect([
      await read("quote", [{ tokenIn: alice, amountIn: 5n }]),
      await read("quote", [[alice, 5n]]),
      await read("e", [{ tokenIn: alice, amountIn: 3n }]),
      await read("e", [[alice, 3n]]),
      await read("route", [{ swaps: [{ tokenIn: alice, amountIn: 7n }], hops: 2 }]),
    ]).toEqual([1n, 1n, 2n, 2n, 3n]);
  });

  test("a struct with named fields written as a list of the wrong length is refused", () => {
    const { router } = withRouter();

    expectThrows(
      MockSetupError,
      `read.quote's swap must be a tuple (address tokenIn, uint256 amountIn); got [${alice}].`,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a struct as a short list
      () => router.read.quote([[alice] as never]),
    );
  });

  test("a value the encoder would coerce is refused", () => {
    const { mock, usdc } = withToken();
    const router = mock.contract({ abi: typesAbi, address: bob });

    for (const [value, shown] of [
      ["5", "5"],
      ["0x05", "0x05"],
      [true, "true"],
      [[5n], "[5n]"],
    ] as const)
      expectThrows(
        MockSetupError,
        `simulate.transfer's amount must be a uint256; got ${shown}.`,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fixture of the wrong type, cast as tests write one
        () => usdc.simulate.transfer([bob, value as never]),
      );
    expectThrows(MockSetupError, "read.lookup's name must be a string; got 5n.", () =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fixture of the wrong type, cast as tests write one
      router.read.lookup([5n as never]),
    );
    expectThrows(MockSetupError, "read.verify's sig must be bytes; got hello.", () =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fixture of the wrong type, cast as tests write one
      router.read.verify(["hello" as never]),
    );
  });

  test("a list of bytes reads as bytes, as bytes does", () => {
    const { router } = withRouter();

    expectThrows(MockSetupError, "read.sigs's sigs must be bytes[]; got 5n.", () =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fixture of the wrong type, cast as tests write one
      router.read.sigs([5n as never]),
    );
  });

  test("hex of an odd length is refused for bytes", () => {
    const { router } = withRouter();

    // viem pads it to whole bytes, so the call's bytes never equal it.
    expectThrows(MockSetupError, "read.verify's sig must be bytes; got 0xabc.", () =>
      router.read.verify(["0xabc"]),
    );
  });

  test("a bare uint or int in a JSON ABI is 256 bits", async () => {
    const { mock, client } = setup();
    // As a hand-written JSON ABI can write them; `parseAbi` adds the size.
    const jsonAbi = [
      {
        type: "function",
        name: "scale",
        stateMutability: "view",
        inputs: [
          { type: "uint", name: "amount" },
          { type: "int", name: "change" },
        ],
        outputs: [{ type: "uint256", name: "" }],
      },
    ] as const;
    const contract = mock.contract({ abi: jsonAbi, address: USDC });
    contract.read.scale([2n ** 255n, -(2n ** 255n)]).returns(1n);

    expect(
      await client.readContract({
        abi: jsonAbi,
        address: USDC,
        functionName: "scale",
        args: [2n ** 255n, -(2n ** 255n)],
      }),
    ).toBe(1n);
    expectThrows(MockSetupError, "read.scale's amount must be a uint; got -1n.", () =>
      contract.read.scale([-1n, 0n]),
    );
    expectThrows(MockSetupError, `read.scale's change must be an int; got ${2n ** 255n}n.`, () =>
      contract.read.scale([0n, 2n ** 255n]),
    );
  });

  test("an integer outside its type's range, or bytesN of the wrong size or not hex, is refused", () => {
    const { router } = withRouter();

    for (const [call, message] of [
      [() => router.read.level([256]), "read.level's tier must be a uint8; got 256."],
      [() => router.read.tilt([128]), "read.tilt's angle must be an int8; got 128."],
      [() => router.read.tilt([-129]), "read.tilt's angle must be an int8; got -129."],
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fixture of the wrong type, cast as tests write one
      [() => router.read.delta([1.5 as never]), "read.delta's change must be an int256; got 1.5."],
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fixture of the wrong type, cast as tests write one
      [() => router.read.delta(["5" as never]), "read.delta's change must be an int256; got 5."],
      [() => router.read.digest(["0xabcd"]), "read.digest's hash must be a bytes32; got 0xabcd."],
      [
        () => router.read.digest([`0x${"zz".repeat(32)}`]),
        `read.digest's hash must be a bytes32; got 0x${"zz".repeat(32)}.`,
      ],
    ] as const)
      expectThrows(MockSetupError, message, call);
  });

  test("a list of structs that doesn't fit reads as a list of tuples", () => {
    const { router } = withRouter();

    expectThrows(
      MockSetupError,
      "read.batch's swaps must be a list of tuples (address tokenIn, uint256 amountIn); got 5n.",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fixture of the wrong type, cast as tests write one
      () => router.read.batch([5n as never]),
    );
    expectThrows(
      MockSetupError,
      "read.batch's swaps[0].amountIn must be a uint256; got a lot.",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fixture of the wrong type, cast as tests write one
      () => router.read.batch([[{ amountIn: "a lot" } as never]]),
    );
    expectThrows(
      MockSetupError,
      "read.pairs's swaps must be a list of 2 tuples (address tokenIn, uint256 amountIn); got [].",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fixture of the wrong size, cast as tests write one
      () => router.read.pairs([[] as never]),
    );
  });

  test("a fixed-size list has its size at each depth, of any number of digits", async () => {
    const { router, read } = withRouter();
    const digits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
    router.read.proofs([[[1n, 2n]]]).returns(1n);
    router.read.tens([digits]).returns(2n);

    expect([await read("proofs", [[[1n, 2n]]]), await read("tens", [digits])]).toEqual([1n, 2n]);
    expectThrows(MockSetupError, "read.proofs's points[1] must be a uint256[2]; got [3n].", () =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fixture of the wrong size, cast as tests write one
      router.read.proofs([[[1n, 2n], [3n] as never]]),
    );
    expectThrows(
      MockSetupError,
      "read.tens's digits must be a uint8[10]; got [0, 1, 2, 3, 4, 5, 6, 7, 8].",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fixture of the wrong size, cast as tests write one
      () => router.read.tens([digits.slice(0, 9) as never]),
    );
  });

  test("a struct with some fields unnamed written as a list stays a list, as viem decodes it", async () => {
    const { mock, client } = setup();
    // A hand-written JSON ABI can name some fields and not others.
    const mixedAbi = [
      {
        type: "function",
        name: "pay",
        stateMutability: "view",
        inputs: [
          {
            type: "tuple",
            name: "payment",
            components: [
              { type: "address", name: "to" },
              { type: "uint256", name: "" },
            ],
          },
        ],
        outputs: [{ type: "uint256", name: "" }],
      },
    ] as const;
    const contract = mock.contract({ abi: mixedAbi, address: USDC });
    contract.read.pay([[alice, 5n]]).returns(1n);

    expect(
      await client.readContract({
        abi: mixedAbi,
        address: USDC,
        functionName: "pay",
        args: [[alice, 5n]],
      }),
    ).toBe(1n);
    const error = expectThrows(
      MockSetupError,
      `read.pay's payment must be a tuple (address to, uint256); got { to: ${alice} }.`,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- viem decodes this struct as a list
      () => contract.read.pay([{ to: alice } as never]),
    );
    expect(error.metaMessages).toEqual([
      "Write it as a list, [address to, uint256]: viem decodes a struct as an object only " +
        "when every field has a name.",
    ]);
  });

  test("hex in any case, integer numbers, zero and an integer type's bounds still answer", async () => {
    const { router, read } = withRouter();
    const hash = `0x${"ab".repeat(32)}` as const;
    router.read.verify(["0xABcd"]).returns(1n);
    router.read.digest([`0x${"AB".repeat(32)}`]).returns(2n);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a number where viem's types take a bigint
    router.read.delta([-5 as never]).returns(3n);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a number where viem's types take a bigint
    router.read.delta([-0 as never]).returns(4n);
    router.read.level([255]).returns(5n);
    router.read.tilt([-128]).returns(6n);
    router.read.tilt([127]).returns(7n);

    expect([
      await read("verify", ["0xabcd"]),
      await read("digest", [hash]),
      await read("delta", [-5n]),
      await read("delta", [0n]),
      await read("level", [255]),
      await read("tilt", [-128]),
      await read("tilt", [127]),
    ]).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n]);
  });

  test("an unnamed tuple as a list, a partial struct and a matcher anywhere still answer", async () => {
    const { mock, client, router, read } = withRouter();
    // As solc writes a tuple's unnamed fields: named "", where `parseAbi`
    // leaves the name out.
    const solcAbi = [
      {
        type: "function",
        name: "pay",
        stateMutability: "view",
        inputs: [
          {
            type: "tuple",
            name: "payment",
            components: [
              { type: "address", name: "" },
              { type: "uint256", name: "" },
            ],
          },
        ],
        outputs: [{ type: "uint256", name: "" }],
      },
    ] as const;
    mock
      .contract({ abi: solcAbi, address: USDC })
      .read.pay([[alice, 5n]])
      .returns(4n);
    router.read.pay([[alice, 5n]]).returns(1n);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a partial fixture, cast as tests write one
    router.read.quote([{ tokenIn: alice } as never]).returns(2n);
    router.read
      .route([{ swaps: [match.partial({ tokenIn: alice })], hops: match.any() }])
      .returns(3n);

    expect([
      await read("pay", [[alice, 5n]]),
      await read("quote", [{ tokenIn: alice, amountIn: 7n }]),
      await read("route", [{ swaps: [{ tokenIn: alice, amountIn: 7n }], hops: 2 }]),
      await client.readContract({
        abi: solcAbi,
        address: USDC,
        functionName: "pay",
        args: [[alice, 5n]],
      }),
    ]).toEqual([1n, 2n, 3n, 4n]);
  });
});

describe("string args", () => {
  const registryAbi = parseAbi(["function lookup(string name) view returns (address)"]);
  const lookup = (client: ReturnType<typeof setup>["client"], name: string) =>
    client.readContract({ abi: registryAbi, address: USDC, functionName: "lookup", args: [name] });

  test("match exactly, case included", async () => {
    const { mock, client } = setup();
    mock.contract({ abi: registryAbi, address: USDC }).read.lookup(["USDC"]).returns(alice);

    expect(await lookup(client, "USDC")).toBe(getAddress(alice));
    expectCause(await rejectionOf(lookup(client, "usdc")), MockNotFoundError);
  });

  test("hex strings still match in any case", async () => {
    const { mock, client } = setup();
    mock.contract({ abi: registryAbi, address: USDC }).read.lookup(["0xABCD"]).returns(alice);

    expect(await lookup(client, "0xabcd")).toBe(getAddress(alice));
  });
});

describe("number and bigint args", () => {
  // OpenZeppelin ERC20Votes (uint32 position: a number) and ERC-721 (uint256 id: a bigint).
  const abi = parseAbi([
    "function checkpoints(address account, uint32 pos) view returns (uint48 key, uint208 value)",
    "function ownerOf(uint256 tokenId) view returns (address)",
  ]);

  test("a bigint registered for a small integer matches the decoded number", async () => {
    const { mock, client } = setup();
    const votes = mock.contract({ abi, address: USDC });
    // @ts-expect-error -- a uint32 takes a number
    votes.read.checkpoints([alice, 3n]).returns({ value: 7n });

    const [, value] = await client.readContract({
      abi,
      address: USDC,
      functionName: "checkpoints",
      args: [alice, 3],
    });
    expect(value).toBe(7n);
  });

  test("a number registered for a wide integer matches the decoded bigint", async () => {
    const { mock, client } = setup();
    const nft = mock.contract({ abi, address: USDC });
    // @ts-expect-error -- a uint256 takes a bigint
    nft.read.ownerOf([42]).returns(alice);

    expect(
      await client.readContract({ abi, address: USDC, functionName: "ownerOf", args: [42n] }),
    ).toBe(getAddress(alice));
  });

  test("different values still don't match", async () => {
    const { mock, client } = setup();
    const contract = mock.contract({ abi, address: USDC });
    // @ts-expect-error -- a uint256 takes a bigint
    contract.read.ownerOf([42]).returns(alice);
    // @ts-expect-error -- a uint32 takes a number
    contract.read.checkpoints([alice, 3n]).returns({ value: 7n });

    expectCause(
      await rejectionOf(
        client.readContract({ abi, address: USDC, functionName: "ownerOf", args: [43n] }),
      ),
      MockNotFoundError,
    );
    expectCause(
      await rejectionOf(
        client.readContract({ abi, address: USDC, functionName: "checkpoints", args: [alice, 4] }),
      ),
      MockNotFoundError,
    );
  });
});

describe("defaults", () => {
  test("answers reads from a defaults object", async () => {
    const { mock, client } = setup();
    const balances: Record<string, bigint> = { [getAddress(alice)]: 500n };
    mock.contract({
      abi: erc20Abi,
      address: USDC,
      defaults: {
        read: {
          decimals: 6,
          symbol: "USDC",
          balanceOf: ({ args: [owner] }) => balances[owner] ?? 0n,
        },
      },
    });

    const read = <functionName extends "decimals" | "symbol">(functionName: functionName) =>
      client.readContract({ abi: erc20Abi, address: USDC, functionName });
    expect(await read("decimals")).toBe(6);
    expect(await read("symbol")).toBe("USDC");

    const balanceOf = (account: `0x${string}`) =>
      client.readContract({
        abi: erc20Abi,
        address: USDC,
        functionName: "balanceOf",
        args: [account],
      });
    expect(await balanceOf(alice)).toBe(500n);
    expect(await balanceOf(bob)).toBe(0n);

    balances[getAddress(bob)] = 3n;
    expect(await balanceOf(bob)).toBe(3n);
  });

  test("an args-less read mock replaces the default", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({
      abi: erc20Abi,
      address: USDC,
      defaults: { read: { balanceOf: 0n } },
    });

    const balanceOf = (account: `0x${string}`) =>
      client.readContract({
        abi: erc20Abi,
        address: USDC,
        functionName: "balanceOf",
        args: [account],
      });
    expect(await balanceOf(alice)).toBe(0n);

    // Same specificity as the default (any args), registered later, so it wins.
    usdc.read.balanceOf().returns(1n);
    expect(await balanceOf(alice)).toBe(1n);
  });

  test("a read mock with args wins over the default only for those args", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({
      abi: erc20Abi,
      address: USDC,
      defaults: { read: { balanceOf: 0n } },
    });
    usdc.read.balanceOf([alice]).returns(9n);

    const balanceOf = (account: `0x${string}`) =>
      client.readContract({
        abi: erc20Abi,
        address: USDC,
        functionName: "balanceOf",
        args: [account],
      });
    expect(await balanceOf(alice)).toBe(9n);
    expect(await balanceOf(bob)).toBe(0n);
  });

  test("functions missing from defaults still fail loudly", async () => {
    const { mock, client } = setup();
    mock.contract({ abi: erc20Abi, address: USDC, defaults: { read: { decimals: 6 } } });

    await expectRejects(
      ContractFunctionExecutionError,
      'No mocks registered for "symbol"',
      client.readContract({ abi: erc20Abi, address: USDC, functionName: "symbol" }),
    );
  });
});
