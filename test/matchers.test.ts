import {
  type Address,
  type ContractFunctionArgs,
  InvalidAddressError,
  erc20Abi,
  getAddress,
  isAddressEqual,
  parseAbi,
} from "viem";
import { describe, expect, test, vi } from "vite-plus/test";

import {
  MockSetupError,
  MockNotFoundError,
  MockResolverError,
  createMockRpc,
  match,
  testAddress,
} from "../src/index.js";
import { expectCause, hintsOf, lowercase, rejectionOf } from "./utils.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const alice = testAddress("alice");
const bob = testAddress("bob");
const carol = testAddress("carol");

// Generic ABIs for arrays, small integers, and overloads.
const registryAbi = parseAbi([
  "function totalOf(address[] owners) view returns (uint256)",
  "function feeOf(uint8 tier) view returns (uint256)",
]);
// The two-arg overload is listed first: viem falls back to the first overload.
const multiTokenAbi = parseAbi([
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function price(address token) view returns (uint256)",
  "function price(uint256 id) view returns (uint256)",
  "function quote(address token, bool exact) view returns (uint256)",
  "function quote(address token, uint256 amount) view returns (uint256)",
]);

// A generic order book, for structs: nested, in arrays, and as overloads.
const bookAbi = parseAbi([
  "struct Asset { address token; uint256 amount; }",
  "struct Order { address maker; Asset sell; Asset buy; uint64 expiry; }",
  "struct Bid { address bidder; uint256 price; }",
  "function filled(Order order) view returns (bool)",
  "function anyFilled(Order[] orders) view returns (bool)",
  "function place(Order order) view returns (uint256)",
  "function place(Bid bid) view returns (uint256)",
]);
type Order = ContractFunctionArgs<typeof bookAbi, "view", "filled">[0];
const order: Order = {
  maker: alice,
  sell: { token: USDC, amount: 100n },
  buy: { token: DAI, amount: 99n },
  expiry: 1_700_000_000n,
};

function setupBook() {
  const { mock, client } = setup();
  const book = mock.contract({ abi: bookAbi, address: DAI, name: "Book" });
  const filled = (args: Order) =>
    client.readContract({ abi: bookAbi, address: DAI, functionName: "filled", args: [args] });
  return { mock, client, book, filled };
}

function setup() {
  const mock = createMockRpc();
  const client = mock.publicClient();
  const usdc = mock.contract({ abi: erc20Abi, address: USDC, name: "USDC" });
  const balanceOf = (account: `0x${string}`) =>
    client.readContract({
      abi: erc20Abi,
      address: USDC,
      functionName: "balanceOf",
      args: [account],
    });
  const allowance = (owner: `0x${string}`, spender: `0x${string}`) =>
    client.readContract({
      abi: erc20Abi,
      address: USDC,
      functionName: "allowance",
      args: [owner, spender],
    });
  return { mock, client, usdc, balanceOf, allowance };
}

// Named functions: messages show a predicate by its function name.
function throwsBoom(): boolean {
  throw new Error("boom");
}
function isCarol(account: `0x${string}`) {
  return isAddressEqual(account, carol);
}

function setupOverloads() {
  const { mock, client } = setup();
  const token = mock.contract({ abi: multiTokenAbi, address: DAI });
  return { token, client };
}

describe("match.any()", () => {
  test("matches any value at its position", async () => {
    const { usdc, allowance } = setup();
    usdc.read.allowance([alice, match.any()]).returns(7n);

    expect(await allowance(alice, bob)).toBe(7n);
    expect(await allowance(alice, carol)).toBe(7n);
    await expect(allowance(bob, alice)).rejects.toThrow("No mock for allowance");
  });

  test("ranks below exact values, and above args-less mocks", async () => {
    const { usdc, balanceOf } = setup();
    usdc.read.balanceOf([alice]).returns(1n);
    usdc.read.balanceOf([match.any()]).returns(2n);
    usdc.read.balanceOf().returns(3n);

    expect(await balanceOf(alice)).toBe(1n);
    expect(await balanceOf(bob)).toBe(2n);
  });

  test("works inside arrays", async () => {
    const { mock, client } = setup();
    const registry = mock.contract({ abi: registryAbi, address: DAI });
    registry.read.totalOf([[alice, match.any()]]).returns(5n);
    const totalOf = (owners: `0x${string}`[]) =>
      client.readContract({
        abi: registryAbi,
        address: DAI,
        functionName: "totalOf",
        args: [owners],
      });

    expect(await totalOf([alice, bob])).toBe(5n);
    // Arrays still match on length.
    await expect(totalOf([alice])).rejects.toThrow("No mock for totalOf");
  });
});

describe("match.where()", () => {
  test("matches when the predicate returns true, given the decoded value", async () => {
    const { mock, client, usdc, balanceOf } = setup();
    const seen: unknown[] = [];
    usdc.read
      .balanceOf([
        match.where((account) => {
          seen.push(account);
          return isAddressEqual(account, alice);
        }),
      ])
      .returns(1n);
    const registry = mock.contract({ abi: registryAbi, address: DAI });
    registry.read.feeOf([match.where((tier) => tier > 2)]).returns(30n);

    expect(await balanceOf(alice)).toBe(1n);
    await expect(balanceOf(bob)).rejects.toThrow("No mock for balanceOf");
    // Addresses arrive checksummed, and small integers as numbers, as viem decodes them.
    expect(seen).toEqual([getAddress(alice), getAddress(bob)]);
    expect(
      await client.readContract({
        abi: registryAbi,
        address: DAI,
        functionName: "feeOf",
        args: [3],
      }),
    ).toBe(30n);
  });

  test("ranks exact values first, then predicates, then any", async () => {
    const { usdc, allowance } = setup();
    usdc.read.allowance([match.any(), match.any()]).returns(1n);
    usdc.read.allowance([match.where(() => true), match.where(() => true)]).returns(2n);
    usdc.read.allowance([alice, match.any()]).returns(3n);

    // One exact value outranks any number of predicates.
    expect(await allowance(alice, bob)).toBe(3n);
    expect(await allowance(bob, alice)).toBe(2n);
  });

  test("among equally specific mocks, the most recent wins", async () => {
    const { usdc, allowance } = setup();
    usdc.read.allowance([alice, match.any()]).returns(1n);
    usdc.read.allowance([match.any(), bob]).returns(2n);

    expect(await allowance(alice, bob)).toBe(2n);
  });

  test("predicates of mocks that lose anyway don't run", async () => {
    const { usdc, balanceOf } = setup();
    const predicate = vi.fn(() => true);
    usdc.read.balanceOf([match.where(predicate)]).returns(1n);
    usdc.read.balanceOf([alice]).returns(2n);
    usdc.read.balanceOf([match.where(() => true)]).returns(3n);

    expect(await balanceOf(alice)).toBe(2n);
    // The newer, equally specific predicate is tried first and matches.
    expect(await balanceOf(bob)).toBe(3n);
    expect(predicate).not.toHaveBeenCalled();
  });

  test("a mock's exact values are checked before its predicates", async () => {
    const { usdc, allowance } = setup();
    const predicate = vi.fn(() => {
      throw new Error("ran");
    });
    // The predicate's position comes first, but `bob` doesn't match `carol`.
    usdc.read.allowance([match.where(predicate), bob]).returns(1n);
    usdc.read.allowance().returns(2n);

    expect(await allowance(alice, carol)).toBe(2n);
    expect(predicate).not.toHaveBeenCalled();
  });

  test("a predicate that throws is reported as unhandled, naming it", async () => {
    const { mock, usdc, balanceOf } = setup();
    usdc.read.balanceOf([match.where(throwsBoom)]).returns(1n);

    const error = expectCause(await rejectionOf(balanceOf(alice)), MockResolverError);
    expect(error.matcher).toBe("where(throwsBoom)");
    expect(error.shortMessage).toBe('Matcher where(throwsBoom) for "balanceOf" threw: boom');
    expect(mock.unhandled).toHaveLength(1);
    expect(mock.formatHistory({ builtIns: false })).toContain(
      "✗ matcher where(throwsBoom) threw: boom",
    );
  });
});

describe("match.partial()", () => {
  test("matches a struct on the fields given, ignoring the rest", async () => {
    const { book, filled } = setupBook();
    book.read.filled([match.partial({ maker: alice })]).returns(true);

    expect(await filled(order)).toBe(true);
    await expect(filled({ ...order, maker: bob })).rejects.toThrow("No mock for filled");
  });

  test("works at depth, with matchers as field values", async () => {
    const { book, filled } = setupBook();
    book.read
      .filled([
        match.partial({
          sell: { token: USDC },
          buy: { amount: match.where((amount) => amount > 50n) },
        }),
      ])
      .returns(true);

    expect(await filled(order)).toBe(true);
    await expect(filled({ ...order, buy: { token: DAI, amount: 1n } })).rejects.toThrow(
      "No mock for filled",
    );
  });

  test("works on structs inside arrays", async () => {
    const { client, book } = setupBook();
    book.read
      .anyFilled([[match.partial({ maker: alice }), match.partial({ maker: bob })]])
      .returns(true);

    const anyFilled = await client.readContract({
      abi: bookAbi,
      address: DAI,
      functionName: "anyFilled",
      args: [[order, { ...order, maker: bob }]],
    });
    expect(anyFilled).toBe(true);
  });

  test("ranks by what its fields pin", async () => {
    const { book, filled } = setupBook();
    book.read.filled([order]).returns(false);
    book.read.filled([match.partial({ maker: alice, expiry: order.expiry })]).returns(true);
    book.read.filled([match.partial({ maker: match.where(() => true) })]).returns(false);
    book.read.filled([match.partial({ maker: alice })]).returns(false);

    // The exact struct pins 6 values; the two-field partial outranks the rest.
    expect(await filled(order)).toBe(false);
    expect(await filled({ ...order, sell: { token: DAI, amount: 1n } })).toBe(true);
  });

  test("exact addresses inside are validated and checksummed", () => {
    const { mock, book } = setupBook();
    expect(() => book.read.filled([match.partial({ maker: "0x1234" })])).toThrow(
      InvalidAddressError,
    );

    // Pinned args are only visible in messages: `alice` was checksummed.
    book.read.filled([match.partial({ sell: { token: lowercase(alice) } })]).returns(true);
    expect(() => {
      mock.assertAllUsed();
    }).toThrow(`filled({ sell: { token: ${getAddress(alice)} }, … }) on Book`);
  });

  test("takes an object of fields", () => {
    // @ts-expect-error -- arrays aren't structs
    expect(() => match.partial<Order>([1n])).toThrow(
      "match.partial() takes a struct's fields as an object; for arrays, use match.where().",
    );
  });
});

describe("messages", () => {
  test("matchers are named in registered lists and unused mocks", async () => {
    const { mock, usdc, balanceOf } = setup();
    usdc.read.balanceOf([match.where(isCarol)]).returns(1n);
    usdc.read.balanceOf([match.where(() => false)]).returns(2n);
    usdc.read.balanceOf([match.where(() => false, "isTreasury")]).returns(3n);
    usdc.read
      .balanceOf([
        match.where((account) => isAddressEqual(account, carol) || isAddressEqual(account, bob)),
      ])
      .returns(4n);
    usdc.read.allowance([alice, match.any()]).returns(4n);

    const error = expectCause(await rejectionOf(balanceOf(alice)), MockNotFoundError);
    expect(hintsOf(error)).toBe(
      [
        "Registered:",
        "  balanceOf(where(isCarol))  ← account didn't match",
        "  balanceOf(where(() => false))  ← account didn't match",
        "  balanceOf(where(isTreasury))  ← account didn't match",
        // Unnamed: the source on one line, cut to 60 characters.
        "  balanceOf(where((account) => isAddressEqual(account, carol) || isAddressEqu…))  ← account didn't match",
      ].join("\n"),
    );
    // Matchers are pinned args, so unused ones are reported, `any` included.
    expect(() => {
      mock.assertAllUsed();
    }).toThrow(`allowance(${getAddress(alice)}, any) on USDC (${USDC})`);
  });
});

/** The labels of predicates with exactly these sources, as `assertAllUsed()` lists them. */
function labelsOf(sources: readonly string[]) {
  const { mock, usdc } = setup();
  for (const source of sources) {
    // oxlint-disable-next-line typescript/no-implied-eval, typescript/no-unsafe-type-assertion -- builds a function with exactly this source; it's never called
    const make = new Function(`return ${source}`) as () => (value: `0x${string}`) => boolean;
    usdc.read.balanceOf([match.where(make())]).returns(1n);
  }
  let message = "";
  try {
    mock.assertAllUsed();
  } catch (error) {
    message = String(error);
  }
  return [...message.matchAll(/balanceOf\(where\((.*)\)\) on/gu)].map((m) => m[1]);
}

/** A predicate that counts its calls and answers `result`. */
function counted(result: boolean, label: string) {
  const calls: unknown[] = [];
  return {
    calls,
    matcher: match.where((value: Address) => {
      calls.push(value);
      return result;
    }, label),
  };
}
const allowance = (client: ReturnType<typeof setup>["client"]) =>
  client.readContract({
    abi: erc20Abi,
    address: USDC,
    functionName: "allowance",
    args: [alice, alice],
  });

describe("a miss's reasons", () => {
  test("name the predicate that said no, run only while matching", async () => {
    const { usdc, client } = setup();
    const yes = counted(true, "yes");
    const no = counted(false, "no");
    usdc.read.allowance([yes.matcher, no.matcher]).returns(1n);
    // An exact value that differs rules a mock out before any predicate runs.
    usdc.read.allowance([bob, no.matcher]).returns(2n);

    const error = expectCause(await rejectionOf(allowance(client)), MockNotFoundError);
    expect(hintsOf(error)).toBe(
      [
        "Registered:",
        "  allowance(where(yes), where(no))  ← spender didn't match",
        `  allowance(${getAddress(bob)}, where(no))  ← owner didn't match`,
      ].join("\n"),
    );
    // Once each, for the one mock in contention; none for the message.
    expect([yes.calls.length, no.calls.length]).toEqual([1, 1]);
  });

  test("a used-up mock, or one without an answer, says so, and still which arg differs", async () => {
    const { usdc, balanceOf } = setup();
    const never = counted(false, "never");
    usdc.read.balanceOf([bob]).once().returns(1n);
    await balanceOf(bob);
    usdc.read.balanceOf([carol]);
    // Not in contention, so its predicate isn't run, and no reason is guessed for it.
    usdc.read.balanceOf([never.matcher]);

    const error = expectCause(await rejectionOf(balanceOf(alice)), MockNotFoundError);
    expect(hintsOf(error)).toBe(
      [
        "Registered:",
        `  balanceOf(${getAddress(bob)}) once, used up  ← account didn't match`,
        `  balanceOf(${getAddress(carol)}) without an answer  ← account didn't match`,
        "  balanceOf(where(never)) without an answer",
      ].join("\n"),
    );
    expect(never.calls).toHaveLength(0);
  });

  test("a predicate inside a struct names the struct's arg", async () => {
    const { book, filled } = setupBook();
    book.read
      .filled([match.partial({ sell: { token: USDC, amount: match.where(() => false) } })])
      .returns(true);
    book.read.filled([match.partial({ maker: bob })]).returns(true);

    const error = expectCause(await rejectionOf(filled(order)), MockNotFoundError);
    // One for the nested predicate, one for the exact field that differs.
    expect(hintsOf(error)).toBe(
      [
        "Registered:",
        `  filled({ sell: { token: ${USDC}, amount: where(() => false) }, … })  ← order didn't match`,
        `  filled({ maker: ${getAddress(bob)}, … })  ← order didn't match`,
      ].join("\n"),
    );
  });

  test("an estimate's miss says which arg differs", async () => {
    const { usdc, client } = setup();
    usdc.estimateGas.transfer([bob, 1n]).returns(50_000n);

    const error = expectCause(
      await rejectionOf(
        client.estimateContractGas({
          abi: erc20Abi,
          address: USDC,
          functionName: "transfer",
          args: [bob, 2n],
          account: alice,
        }),
      ),
      MockNotFoundError,
    );
    expect(hintsOf(error)).toBe(
      `Registered:\n  transfer(${getAddress(bob)}, 1n)  ← amount didn't match`,
    );
  });

  test("a raw method's miss names the param by position", async () => {
    const { mock } = setup();
    mock.method("eth_custom", ["0x1", match.where(() => false, "no")]).returns("0x");

    const error = expectCause(
      await rejectionOf(mock.request({ method: "eth_custom", params: ["0x1", "0x2"] })),
      MockNotFoundError,
    );
    expect(hintsOf(error)).toBe(
      "Registered:\n  eth_custom(0x1, where(no))  ← param 2 didn't match",
    );
  });

  test("assertAllUsed() shows the whole call a whole-params matcher didn't match", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance(match.where(() => false, "never")).returns(0n);
    mock.actions.getBalance().returns(1n);
    await client.getBalance({ address: alice });

    expect(() => {
      mock.assertAllUsed();
    }).toThrow(
      "  - getBalance(where(never))\n    received 1 call to getBalance:\n" +
        `      getBalance({ address: ${getAddress(alice)}, blockNumber: 1n, blockTag: latest })  ← params didn't match`,
    );
  });
});

describe("predicate labels from source", () => {
  // How each tool's compiled modules read back an imported `isAddressEqual`.
  const modules = {
    vite: "__vite_ssr_import_0__",
    babel: "_viem",
    typescript: "viem_1",
    esbuild: "import_viem",
    webpack: "viem__WEBPACK_IMPORTED_MODULE_0__",
    rolldown: "viem",
  };

  test("calls lose the module object, whichever tool compiled them", () => {
    const sources = Object.values(modules).map((m) => `(a) => (0, ${m}.isAddressEqual)(a, x)`);
    expect(labelsOf(sources)).toEqual(
      Object.values(modules).map(() => "(a) => isAddressEqual(a, x)"),
    );
  });

  test("other references lose only prefixes no one writes by hand", () => {
    const sources = Object.values(modules).map((m) => `(a) => [a].some(${m}.isAddressEqual)`);
    expect(labelsOf([...sources, "(order) => order.maker === x"])).toEqual([
      "(a) => [a].some(isAddressEqual)",
      // Babel's, TypeScript's and Rolldown's look like real code, so they stay.
      "(a) => [a].some(_viem.isAddressEqual)",
      "(a) => [a].some(viem_1.isAddressEqual)",
      "(a) => [a].some(isAddressEqual)",
      "(a) => [a].some(isAddressEqual)",
      "(a) => [a].some(viem.isAddressEqual)",
      "(order) => order.maker === x",
    ]);
  });
});

describe("registration", () => {
  test("exact addresses next to matchers are still validated and checksummed", () => {
    const { mock, usdc } = setup();
    expect(() => usdc.read.allowance(["0x1234", match.any()])).toThrow(InvalidAddressError);

    usdc.read.allowance([lowercase(alice), match.any()]).returns(1n);
    // The pinned args are only visible in messages: `alice` was checksummed.
    expect(() => {
      mock.assertAllUsed();
    }).toThrow(`allowance(${getAddress(alice)}, any)`);
  });

  test("Jest and Vitest matchers are refused in args and params, pointing to match", () => {
    const { mock, usdc } = setup();

    // `expect.any()` is typed `any`, so it type-checks, but the mock can't run it.
    expect(() => usdc.read.allowance([expect.any(String), bob])).toThrow(
      "Args and params take the mock's own matchers, not Jest's or Vitest's (got Any<String>): " +
        "use match.any() or match.where(…) instead.",
    );
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- typed `any`, as users meet it
    expect(() => mock.actions.getBalance({ address: expect.anything() })).toThrow("(got Anything)");
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- typed `any`, as users meet it
    expect(() => mock.method("eth_custom", [{ nested: expect.any(Number) }])).toThrow(
      MockSetupError,
    );
    // A call that throws registers nothing.
    expect(() => {
      mock.assertAllUsed();
    }).not.toThrow();
  });

  test("matchers can't be return values", async () => {
    const { usdc, balanceOf } = setup();
    expect(() => {
      usdc.read.balanceOf([alice]).returns(match.any());
    }).toThrow("match.any() can't go in return values; matchers only go in args and params.");

    expect(() => {
      // The types allow it: `partial` takes the resolver function's type from `.returns()`.
      usdc.read.balanceOf([alice]).returns(match.partial({}));
    }).toThrow("match.partial() can't go in return values");

    usdc.read.balanceOf([bob]).returns(() => match.any());
    const error = expectCause(await rejectionOf(balanceOf(bob)), MockResolverError);
    expect(error.shortMessage).toContain("matchers only go in args and params");
  });
});

describe("overloads", () => {
  test("with matchers, an overload is chosen by arg count", async () => {
    const { token, client } = setupOverloads();
    token.read.balanceOf([match.any()]).returns(1n);

    const balance = await client.readContract({
      abi: multiTokenAbi,
      address: DAI,
      functionName: "balanceOf",
      args: [alice],
    });
    expect(balance).toBe(1n);
  });

  test("with matchers, an overload is chosen by its exact args' types", async () => {
    const { token, client } = setupOverloads();
    token.read.quote([match.any(), 5n]).returns(2n);

    const quote = await client.readContract({
      abi: multiTokenAbi,
      address: DAI,
      functionName: "quote",
      args: [alice, 5n],
    });
    expect(quote).toBe(2n);
  });

  test("an overload the exact args can't tell apart throws", () => {
    const { token } = setupOverloads();
    expect(() => token.read.price([match.any()])).toThrow(
      [
        "Ambiguous overload for price(any): pin an arg that tells them apart.",
        "",
        "It fits:",
        "  price(address)",
        "  price(uint256)",
      ].join("\n"),
    );
  });

  test("partials don't tell overloads apart, even by field names", () => {
    const { book } = setupBook();
    // Only Order has `maker`, but partials are skipped when choosing an overload.
    // @ts-expect-error -- the types can't pick the overload either
    expect(() => book.read.place([match.partial({ maker: alice })])).toThrow(
      `Ambiguous overload for place({ maker: ${alice}, … })`,
    );
  });

  test("an args-less mock on an overloaded function throws", () => {
    const { token } = setupOverloads();
    expect(() => token.read.balanceOf()).toThrow(
      [
        "Ambiguous overload for balanceOf(*): pin args to choose one, e.g. [match.any()].",
        "",
        "Overloads:",
        "  balanceOf(address,uint256)",
        "  balanceOf(address)",
      ].join("\n"),
    );
  });

  test("defaults for an overloaded function answer every overload", async () => {
    const { mock, client } = setup();
    mock.contract({ abi: multiTokenAbi, address: DAI, defaults: { read: { balanceOf: 7n } } });

    const one = await client.readContract({
      abi: multiTokenAbi,
      address: DAI,
      functionName: "balanceOf",
      args: [alice],
    });
    const two = await client.readContract({
      abi: multiTokenAbi,
      address: DAI,
      functionName: "balanceOf",
      args: [alice, 1n],
    });
    expect([one, two]).toEqual([7n, 7n]);
  });

  test("args no overload takes throw", () => {
    const { token } = setupOverloads();
    // @ts-expect-error -- neither overload of `quote` takes a string second
    expect(() => token.read.quote([match.any(), "five"])).toThrow(
      'No overload of "quote" takes quote(any, five).',
    );
  });
});

describe("actions and raw methods", () => {
  test("a matcher can stand for all of an action's params, or a raw method's", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance(match.partial({ address: alice })).returns(1n);
    mock.actions.getCode(match.any()).returns("0x60");
    mock.actions
      .getTransactionCount(
        match.where(
          (call) => call?.address !== undefined && isAddressEqual(call.address, bob),
          "isBob",
        ),
      )
      .returns(3);
    mock
      .method(
        "eth_custom",
        match.where((params) => params?.length === 2, "twoParams"),
      )
      .returns("0x1");

    expect(await client.getBalance({ address: alice })).toBe(1n);
    expect(await client.getCode({ address: bob })).toBe("0x60");
    expect(await client.getTransactionCount({ address: bob })).toBe(3);
    expect(await mock.request({ method: "eth_custom", params: ["0x1", "0x2"] })).toBe("0x1");

    // When one doesn't match, it's all of the params that didn't.
    const error = expectCause(
      await rejectionOf(client.getTransactionCount({ address: alice })),
      MockNotFoundError,
    );
    expect(hintsOf(error)).toBe(
      "Registered:\n  getTransactionCount(where(isBob))  ← params didn't match",
    );
  });

  test("action params take matchers", async () => {
    const { mock, client } = setup();
    mock.actions
      .getBalance({ address: match.where((address) => isAddressEqual(address, alice)) })
      .returns(5n);
    mock.actions.getBalance().returns(0n);
    mock.actions.getBlock({ blockNumber: match.where((n) => n > 1_000n) }).returns(null);

    expect(await client.getBalance({ address: alice })).toBe(5n);
    expect(await client.getBalance({ address: bob })).toBe(0n);
    await expect(client.getBlock({ blockNumber: 2_000n })).rejects.toThrow("could not be found");
  });

  test("raw method params take matchers", async () => {
    const { mock, client } = setup();
    mock.method("eth_getProof", [match.any(), ["0x1"]]).returns({ balance: "0x2a" });

    expect((await client.getProof({ address: USDC, storageKeys: ["0x1"] })).balance).toBe(42n);
  });

  test("a throwing predicate in an action is reported as unhandled", async () => {
    const { mock, client } = setup();
    mock.actions
      .getBalance({
        address: match.where(() => {
          throw new Error("boom");
        }, "broken"),
      })
      .returns(5n);

    const error = expectCause(
      await rejectionOf(client.getBalance({ address: alice })),
      MockResolverError,
    );
    expect(error.shortMessage).toBe('Matcher where(broken) for "getBalance" threw: boom');
    expect(mock.unhandled).toHaveLength(1);
  });
});

describe("multicall", () => {
  test("sub-calls match matchers", async () => {
    const { client, usdc } = setup();
    usdc.read.balanceOf([match.any()]).returns(9n);

    const results = await client.multicall({
      contracts: [
        { abi: erc20Abi, address: USDC, functionName: "balanceOf", args: [alice] },
        { abi: erc20Abi, address: USDC, functionName: "balanceOf", args: [bob] },
      ],
      allowFailure: false,
    });
    expect(results).toEqual([9n, 9n]);
  });
});
