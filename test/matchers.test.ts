import {
  type Address,
  BaseError,
  BlockNotFoundError,
  type ContractFunctionArgs,
  ContractFunctionExecutionError,
  InvalidAddressError,
  erc20Abi,
  erc4626Abi,
  erc721Abi,
  getAddress,
  isAddressEqual,
  pad,
  parseAbi,
} from "viem";
import { describe, expect, test, vi } from "vite-plus/test";

import {
  MockCheckError,
  MockSetupError,
  MockNotFoundError,
  MockResolverError,
  contractEvents,
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
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const alice = testAddress("alice");
const bob = testAddress("bob");
const carol = testAddress("carol");

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

const bookAbi = parseAbi([
  "struct Asset { address token; uint256 amount; }",
  "struct Order { address maker; Asset sell; Asset buy; uint64 expiry; }",
  "struct Bid { address bidder; uint256 price; }",
  "function filled(Order order) view returns (bool)",
  "function anyFilled(Order[] orders) view returns (bool)",
  "function place(Order order) view returns (uint256)",
  "function place(Bid bid) view returns (uint256)",
]);
// The two-arg `q` is listed first, and `nest(S)` before `nest(W)`: viem falls
// back to the first overload. A `bool` beside a list takes neither form of the
// other.
const fitOverloadsAbi = parseAbi([
  "struct S { address a; uint256 n; }",
  "struct W { S[] items; uint8 k; }",
  "function q(S s, uint256 k) view returns (uint256)",
  "function q(S s) view returns (uint256)",
  "function nest(S s) view returns (uint256)",
  "function nest(W w) view returns (uint256)",
  "function w(uint8 x) view returns (uint256)",
  "function w(uint256 x) view returns (uint256)",
  "function list(uint256[] xs) view returns (uint256)",
  "function list(bool b) view returns (uint256)",
  "function pair(uint256[2] xs) view returns (uint256)",
  "function pair(bool b) view returns (uint256)",
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

function setupFitOverloads() {
  const { mock, client } = setup();
  const token = mock.contract({ abi: fitOverloadsAbi, address: DAI });
  const read = (functionName: "q" | "nest" | "list" | "pair", args: readonly unknown[]) =>
    client.readContract({
      abi: fitOverloadsAbi,
      address: DAI,
      functionName,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- args for either overload
      args: args as never,
    });
  return { token, read };
}

describe("match.any()", () => {
  test("matches any value at its position", async () => {
    const { usdc, allowance } = setup();
    usdc.read.allowance([alice, match.any()]).returns(7n);

    expect(await allowance(alice, bob)).toBe(7n);
    expect(await allowance(alice, carol)).toBe(7n);
    await expectRejects(
      ContractFunctionExecutionError,
      "No mock for allowance",
      allowance(bob, alice),
    );
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
    await expectRejects(ContractFunctionExecutionError, "No mock for totalOf", totalOf([alice]));
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
    await expectRejects(ContractFunctionExecutionError, "No mock for balanceOf", balanceOf(bob));
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

    expect(await allowance(alice, bob)).toBe(3n);
    expect(await allowance(bob, alice)).toBe(2n);
  });

  test("a predicate outranks any, whichever is registered first", async () => {
    const { usdc, balanceOf } = setup();
    usdc.read.balanceOf([match.where(() => true)]).returns(1n);
    usdc.read.balanceOf([match.any()]).returns(2n);

    expect(await balanceOf(alice)).toBe(1n);
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

  test("an unused mock's listing checks exact values before its predicates, as matching does", async () => {
    const { mock, usdc, allowance } = setup();
    const isBob = vi.fn((owner: `0x${string}`) => owner === bob);
    // The predicate's position comes first, but `bob` doesn't match `carol`.
    usdc.read.allowance([match.where(isBob), bob]).returns(1n);
    await rejectionOf(allowance(alice, carol));

    expectThrows(MockCheckError, `allowance(…, ${carol})  ← spender didn't match`, () => {
      mock.assertAllUsed();
    });
    expect(isBob).not.toHaveBeenCalled();
  });

  test("an unused action mock's listing checks exact values before its predicates", async () => {
    const { mock, client } = setup();
    const isBob = vi.fn((address: `0x${string}`) => address === bob);
    mock.actions.getBalance({ address: match.where(isBob), blockNumber: 5n }).returns(1n);
    await rejectionOf(client.getBalance({ address: alice, blockNumber: 6n }));

    expectThrows(MockCheckError, "blockNumber didn't match", () => {
      mock.assertAllUsed();
    });
    expect(isBob).not.toHaveBeenCalled();
  });

  test("a predicate that throws while an unused mock's calls are listed counts as a mismatch", async () => {
    const { mock, usdc, allowance } = setup();
    // The exact values match, so the predicate runs: in matching, and again in the listing.
    usdc.read.allowance([match.where(throwsBoom), bob]).returns(1n);
    await rejectionOf(allowance(alice, bob));

    expectThrows(MockCheckError, `allowance(${alice}, …)  ← owner didn't match`, () => {
      mock.assertAllUsed();
    });
  });

  test("so does a whole-params predicate that throws", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance(match.where(throwsBoom)).returns(1n);
    await rejectionOf(client.getBalance({ address: alice }));

    expectThrows(
      MockCheckError,
      `getBalance({ address: ${getAddress(alice)}, blockNumber: 1n, blockTag: latest })  ← params didn't match`,
      () => {
        mock.assertAllUsed();
      },
    );
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
    await expectRejects(
      ContractFunctionExecutionError,
      "No mock for filled",
      filled({ ...order, maker: bob }),
    );
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
    await expectRejects(
      ContractFunctionExecutionError,
      "No mock for filled",
      filled({ ...order, buy: { token: DAI, amount: 1n } }),
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
    expectThrows(
      MockCheckError,
      `filled({ sell: { token: ${getAddress(alice)} }, … }) on Book`,
      () => {
        mock.assertAllUsed();
      },
    );
  });

  test("takes an object of fields", () => {
    expectThrows(
      MockSetupError,
      "match.partial() takes a struct's fields as an object; for arrays, use match.where().",
      // @ts-expect-error -- match.partial() takes a struct's fields, not an array
      () => match.partial<Order>([1n]),
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
    expectThrows(MockCheckError, `allowance(${getAddress(alice)}, any) on USDC (${USDC})`, () => {
      mock.assertAllUsed();
    });
  });
});

/**
 * The labels of predicates with exactly these sources, as `assertAllUsed()`
 * lists them.
 */
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

    expectThrows(
      MockCheckError,
      "  - getBalance(where(never))\n    received 1 call to getBalance:\n" +
        `      getBalance({ address: ${getAddress(alice)}, blockNumber: 1n, blockTag: latest })  ← params didn't match`,
      () => {
        mock.assertAllUsed();
      },
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
    expectThrows(MockCheckError, `allowance(${getAddress(alice)}, any)`, () => {
      mock.assertAllUsed();
    });
  });

  test("Jest and Vitest matchers are refused in args and params, pointing to match", () => {
    const { mock, usdc } = setup();

    // `expect.any()` is typed `any`, so it type-checks, but the mock can't run it.
    expectThrows(
      MockSetupError,
      "Args and params take the mock's own matchers, not Jest's or Vitest's (got Any<String>): " +
        "use match.any() or match.where(…) instead.",
      () => usdc.read.allowance([expect.any(String), bob]),
    );
    expectThrows(MockSetupError, "(got Anything)", () =>
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- typed `any`, as users meet it
      mock.actions.getBalance({ address: expect.anything() }),
    );
    // As the whole params too, before an action's own pin reshapes them.
    expectThrows(
      MockSetupError,
      "Args and params take the mock's own matchers, not Jest's or Vitest's (got a test runner matcher): " +
        "use match.any() or match.where(…) instead.",
      () =>
        // oxlint-disable-next-line typescript/no-unsafe-argument -- typed `any`, as users meet it
        mock.actions.sendTransaction(expect.objectContaining({ to: bob })),
    );
    expectThrows(MockSetupError, "(got a test runner matcher)", () =>
      // oxlint-disable-next-line typescript/no-unsafe-argument -- typed `any`, as users meet it
      mock.actions.estimateGas(expect.objectContaining({ to: bob })),
    );
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- typed `any`, as users meet it
    expect(() => mock.method("eth_custom", [{ nested: expect.any(Number) }])).toThrow(
      MockSetupError,
    );
    // On an overloaded function too, ahead of choosing an overload.
    const token = mock.contract({ abi: multiTokenAbi, address: DAI });
    expectThrows(MockSetupError, "(got Any<String>)", () =>
      token.read.balanceOf([expect.any(String)]),
    );
    // Other runners' matchers, like Jasmine's, have no name to show.
    const unnamed = { asymmetricMatch: () => true };
    expectThrows(MockSetupError, "(got a test runner matcher)", () =>
      // @ts-expect-error -- typed `any` where users meet it, as Jasmine's are
      usdc.read.allowance([unnamed, bob]),
    );
    // A call that throws registers nothing.
    expect(() => {
      mock.assertAllUsed();
    }).not.toThrow();
  });

  test("matchers can't be return values", async () => {
    const { usdc, balanceOf } = setup();
    const refused = expectThrows(
      MockSetupError,
      "match.any() can't go in read.balanceOf's answer; matchers only go in a mock's args, params and pins.",
      () => {
        usdc.read.balanceOf([alice]).returns(match.any());
      },
    );
    expect(refused.metaMessages).toBeUndefined();

    expectThrows(MockSetupError, "match.partial() can't go in read.balanceOf's answer", () => {
      // The types allow it: `partial` takes the resolver function's type from `.returns()`.
      usdc.read.balanceOf([alice]).returns(match.partial({}));
    });
    expectThrows(MockSetupError, "match.any() can't go in simulate.transfer's answer", () => {
      usdc.simulate.transfer([bob, 1n]).returns(match.any());
    });

    usdc.read.balanceOf([bob]).returns(() => match.any());
    const error = expectCause(await rejectionOf(balanceOf(bob)), MockResolverError);
    expect(error.shortMessage).toContain("matchers only go in a mock's args, params and pins");
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

  test("a miss names the mocks on the function's other overloads", async () => {
    const { token, client } = setupOverloads();
    token.read.balanceOf([alice, 1n]).returns(1n);

    const error = await rejectionOf(
      client.readContract({
        abi: multiTokenAbi,
        address: DAI,
        functionName: "balanceOf",
        args: [bob],
      }),
    );

    expect(expectCause(error, MockNotFoundError).metaMessages).toEqual([
      "No mocks registered for balanceOf(address).",
      "Mocks on balanceOf's other overloads, which don't answer this one:",
      `  balanceOf(${alice}, 1n)`,
    ]);
  });

  test("a miss lists its own overload's mocks, then the other overloads'", async () => {
    const { token, client } = setupOverloads();
    token.read.balanceOf([carol]).returns(1n);
    token.read.balanceOf([alice, 1n]).returns(1n);

    const error = await rejectionOf(
      client.readContract({
        abi: multiTokenAbi,
        address: DAI,
        functionName: "balanceOf",
        args: [bob],
      }),
    );

    expect(expectCause(error, MockNotFoundError).metaMessages).toEqual([
      "Registered:",
      `  balanceOf(${carol})  ← owner didn't match`,
      "Mocks on balanceOf's other overloads, which don't answer this one:",
      `  balanceOf(${alice}, 1n)`,
    ]);
  });

  test("a view overload's miss names the mocks on a nonpayable overload of its name", async () => {
    const { mock, client } = setup();
    const pairAbi = parseAbi([
      "function quote(uint256 amount) view returns (uint256)",
      "function quote(address token) returns (uint256)",
    ]);
    mock.contract({ abi: pairAbi, address: DAI }).simulate.quote([alice]).returns(1n);

    const error = await rejectionOf(
      client.readContract({ abi: pairAbi, address: DAI, functionName: "quote", args: [5n] }),
    );

    expect(expectCause(error, MockNotFoundError).metaMessages).toEqual([
      "No mocks registered for quote(uint256).",
      "Mocks on quote's other overloads, which don't answer this one:",
      `  quote(${alice}), a simulate mock`,
    ]);
  });

  test("an overload the exact args can't tell apart throws", () => {
    const { token } = setupOverloads();
    const error = expectThrows(
      MockSetupError,
      "Ambiguous overload for read.price(any): pin an arg that tells them apart.",
      () => token.read.price([match.any()]),
    );
    expect(error.metaMessages).toEqual(["It fits:", "  price(address)", "  price(uint256)"]);
  });

  test("a partial chooses the overload whose struct has its fields", async () => {
    const { book, client } = setupBook();
    // Only Order has `maker`.
    // @ts-expect-error -- a partial picks no overload of `place` in viem's types
    book.read.place([match.partial({ maker: alice })]).returns(1n);

    expect(
      await client.readContract({
        abi: bookAbi,
        address: DAI,
        functionName: "place",
        args: [order],
      }),
    ).toBe(1n);
  });

  test("a matcher in a struct fits its own field, so the struct chooses its overload", async () => {
    const { mock, client } = setup();
    // V2 adds a field, so a struct with fields left out would fit both.
    const swapAbi = parseAbi([
      "struct V1 { address tokenIn; uint256 amountIn; }",
      "struct V2 { address tokenIn; uint256 amountIn; uint256 deadline; }",
      "struct T { address a; address b; }",
      "struct S { address a; uint256 n; }",
      "function swap(V1 params) view returns (uint256)",
      "function swap(V2 params) view returns (uint256)",
      "function f(S s) view returns (uint256)",
      "function f(T t) view returns (uint256)",
    ]);
    const router = mock.contract({ abi: swapAbi, address: DAI });
    router.read.swap([{ tokenIn: match.any(), amountIn: 5n }]).returns(1n);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a struct as a list
    router.read.swap([[match.any(), 6n] as never]).returns(2n);
    router.read.f([{ a: alice, b: match.any() }]).returns(3n);

    const call = (functionName: "swap" | "f", index: number, args: readonly unknown[]) =>
      client.readContract({
        abi: [swapAbi[index]!],
        address: DAI,
        functionName,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- args for the overload at `index`
        args: args as never,
      });
    expect([
      await call("swap", 0, [{ tokenIn: alice, amountIn: 5n }]),
      await call("swap", 0, [{ tokenIn: alice, amountIn: 6n }]),
      await call("f", 3, [{ a: alice, b: bob }]),
    ]).toEqual([1n, 2n, 3n]);
  });

  test("a partial is never whole for a struct, so it doesn't choose between a struct and its superset", () => {
    const { mock } = setup();
    const swapAbi = parseAbi([
      "struct V1 { address tokenIn; uint256 amountIn; }",
      "struct V2 { address tokenIn; uint256 amountIn; uint256 deadline; }",
      "function swap(V1 params) view returns (uint256)",
      "function swap(V2 params) view returns (uint256)",
    ]);
    const router = mock.contract({ abi: swapAbi, address: DAI });

    const error = expectThrows(
      MockSetupError,
      `Ambiguous overload for read.swap({ tokenIn: ${alice}, amountIn: 5n, … }): ` +
        "pin an arg that tells them apart.",
      () => router.read.swap([match.partial({ tokenIn: alice, amountIn: 5n })]),
    );
    expect(error.metaMessages).toEqual([
      "It fits:",
      "  swap((address,uint256))",
      "  swap((address,uint256,uint256))",
    ]);
  });

  test("an args-less mock on an overloaded function throws", () => {
    const { token } = setupOverloads();
    const error = expectThrows(
      MockSetupError,
      "Ambiguous overload for read.balanceOf(*): pin args to choose one, e.g. [match.any()].",
      () => token.read.balanceOf(),
    );
    expect(error.metaMessages).toEqual([
      "Overloads:",
      "  balanceOf(address,uint256)",
      "  balanceOf(address)",
    ]);
  });

  test("an ABI that repeats a function, as two standards spread together, isn't an overload", async () => {
    const { mock, client } = setup();
    // erc4626Abi already has ERC-20's items; erc20Abi names transfer's params differently.
    const abi = [...erc4626Abi, ...erc20Abi];
    const vault = mock.contract({ abi, address: DAI });
    vault.read.balanceOf().returns(7n);
    vault.simulate.transfer().returns(true);

    expect(
      await client.readContract({ abi, address: DAI, functionName: "balanceOf", args: [alice] }),
    ).toBe(7n);
    const { result } = await client.simulateContract({
      abi,
      address: DAI,
      functionName: "transfer",
      args: [alice, 1n],
      account: alice,
    });
    expect(result).toBe(true);
    expect(vault.events.Transfer({ from: alice, to: alice, value: 1n })).toEqual(
      contractEvents({ abi, address: DAI }).Transfer({ from: alice, to: alice, value: 1n }),
    );
  });

  test("only true repeats are merged: other output names or mutability stay overloads", () => {
    const { mock } = setup();
    const outputs = mock.contract({
      abi: parseAbi([
        "function h() view returns (uint256 x, uint256 y)",
        "function h() view returns (uint256 p, uint256 q)",
      ]),
      address: DAI,
    });
    const mutability = mock.contract({
      abi: parseAbi(["function pay(uint256 a)", "function pay(uint256 b) payable"]),
      address: testAddress("pay"),
    });

    expectThrows(MockSetupError, "Ambiguous overload for read.h(*)", () => outputs.read.h());
    expectThrows(MockSetupError, "Ambiguous overload for simulate.pay(*)", () =>
      mutability.simulate.pay(),
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
    const error = expectThrows(MockSetupError, "No overload takes read.quote(any, five).", () =>
      // @ts-expect-error -- neither overload of `quote` takes a string second
      token.read.quote([match.any(), "five"]),
    );
    expect(error.metaMessages).toEqual([
      "Overloads:",
      "  quote(address,bool)",
      "  quote(address,uint256)",
    ]);
  });

  test("args the only overload of their count doesn't take are refused by the arg, not registered on the first", () => {
    const { token } = setupOverloads();
    const error = expectThrows(
      MockSetupError,
      "read.balanceOf's id must be a uint256; got five.",
      () =>
        // @ts-expect-error -- neither overload of `balanceOf` takes a string second
        token.read.balanceOf([alice, "five"]),
    );
    expect(error.metaMessages).toBeUndefined();
  });

  test("the only overload of the args' count is pinned as the only function", async () => {
    const { mock, client } = setup();
    const nft = mock.contract({ abi: erc721Abi, address: DAI });
    nft.simulate.safeTransferFrom([lowercase(alice), bob, 1n]).returns();

    await client.simulateContract({
      abi: erc721Abi,
      address: DAI,
      functionName: "safeTransferFrom",
      args: [alice, bob, 1n],
      account: alice,
    });
    expectThrows(InvalidAddressError, 'Address "0xA11CE" is invalid.', () =>
      nft.simulate.safeTransferFrom(["0xA11CE", bob, 1n]),
    );
    expectThrows(
      MockSetupError,
      `No overload takes simulate.safeTransferFrom(${alice}, ${bob}).`,
      // @ts-expect-error -- no overload takes two args
      () => nft.simulate.safeTransferFrom([alice, bob]),
    );
  });

  test("a struct with fields left out chooses the overload its fields fit", async () => {
    const { token, read } = setupFitOverloads();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a partial fixture, cast as tests write one
    token.read.q([{ a: alice } as never]).returns(1n);

    expect(await read("q", [{ a: alice, n: 7n }])).toBe(1n);
  });

  test("a struct with fields left out, beside a matcher, chooses the overload its fields fit", async () => {
    const { token, read } = setupFitOverloads();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a partial fixture, cast as tests write one
    token.read.q([{ a: alice } as never, match.any()]).returns(2n);

    expect(await read("q", [{ a: alice, n: 7n }, 3n])).toBe(2n);
  });

  test("a struct in a list inside a struct, with fields left out, chooses its overload", async () => {
    const { token, read } = setupFitOverloads();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a partial fixture, cast as tests write one
    token.read.nest([{ items: [{ a: alice }] } as never]).returns(3n);

    expect(await read("nest", [{ items: [{ a: alice, n: 7n }], k: 1 }])).toBe(3n);
  });

  test("a struct and a value in each other's place, or a key that isn't a field, fit no overload", () => {
    const { token } = setupFitOverloads();
    const error = expectThrows(MockSetupError, `No overload takes read.w({ a: ${alice} }).`, () =>
      // @ts-expect-error -- a struct where a uint goes
      token.read.w([{ a: alice }]),
    );
    expect(error.metaMessages).toEqual(["Overloads:", "  w(uint8)", "  w(uint256)"]);
    // `q(S)` is the only overload of one arg.
    expectThrows(MockSetupError, "read.q's s must be a tuple (address a, uint256 n); got 5n.", () =>
      // @ts-expect-error -- not a struct
      token.read.q([5n]),
    );
    const fieldError = expectThrows(
      MockSetupError,
      "amount isn't a field of read.q's s.",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- S has no amount
      () => token.read.q([{ a: alice, amount: 1n } as never]),
    );
    expect(fieldError.metaMessages).toEqual(["Its fields are address a and uint256 n."]);
  });

  test("a list fits when every element fits, and a fixed-size one by its size too", async () => {
    const { token, read } = setupFitOverloads();
    token.read.list([true]).returns(1n);
    token.read.list([[1n, 2n]]).returns(2n);
    token.read.pair([[1n, 2n]]).returns(3n);

    expect([
      await read("list", [true]),
      await read("list", [[1n, 2n]]),
      await read("pair", [[1n, 2n]]),
    ]).toEqual([1n, 2n, 3n]);
    expectThrows(MockSetupError, "No overload takes read.list([1n, x]).", () =>
      // @ts-expect-error -- a string in a list of uints
      token.read.list([[1n, "x"]]),
    );
    expectThrows(MockSetupError, "No overload takes read.pair([1n, 2n, 3n]).", () =>
      // @ts-expect-error -- pair takes two
      token.read.pair([[1n, 2n, 3n]]),
    );
  });

  test("an address fits in any case beside a matcher, and a string that isn't one fits no overload", async () => {
    const { token, client } = setupOverloads();
    const uppercase = `0x${alice.slice(2).toUpperCase()}` as const;
    token.read.balanceOf([uppercase, match.any()]).returns(1n);

    const balance = await client.readContract({
      abi: multiTokenAbi,
      address: DAI,
      functionName: "balanceOf",
      args: [alice, 5n],
    });
    expect(balance).toBe(1n);
    // Both overloads of `quote` take two args.
    expectThrows(MockSetupError, "No overload takes read.quote(0x1234, any).", () =>
      token.read.quote(["0x1234", match.any()]),
    );
  });

  test("a struct with fields left out that fits several overloads is ambiguous, not registered on the first", () => {
    const { mock } = setup();
    // The address overload first: viem falls back to it when no overload's
    // struct is whole.
    const quoteAbi = parseAbi([
      "struct Swap { address tokenIn; uint256 amountIn; }",
      "struct SwapPermit { address tokenIn; uint256 amountIn; uint256 deadline; bytes sig; }",
      "function quote(address token, uint256 amount) view returns (uint256)",
      "function quote(Swap swap) view returns (uint256)",
      "function quote(SwapPermit permit) view returns (uint256)",
    ]);
    const pairAbi = parseAbi([
      "struct S { address a; uint256 n; }",
      "struct T { address a; address b; }",
      "function f(S s) view returns (uint256)",
      "function f(T t) view returns (uint256)",
    ]);
    const router = mock.contract({ abi: quoteAbi, address: DAI });
    const pair = mock.contract({ abi: pairAbi, address: testAddress("pair") });

    const error = expectThrows(
      MockSetupError,
      `Ambiguous overload for read.quote({ tokenIn: ${alice} }): pin an arg that tells them apart.`,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a partial fixture, cast as tests write one
      () => router.read.quote([{ tokenIn: alice } as never]),
    );
    expect(error.metaMessages).toEqual([
      "It fits:",
      "  quote((address,uint256))",
      "  quote((address,uint256,uint256,bytes))",
    ]);
    expectThrows(
      MockSetupError,
      `Ambiguous overload for read.f({ a: ${alice} }): pin an arg that tells them apart.`,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a partial fixture, cast as tests write one
      () => pair.read.f([{ a: alice } as never]),
    );
    expectThrows(
      MockSetupError,
      "Ambiguous overload for read.f({}): pin an arg that tells them apart.",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a partial fixture, cast as tests write one
      () => pair.read.f([{} as never]),
    );
    // A call that throws registers nothing.
    expect(() => {
      mock.assertAllUsed();
    }).not.toThrow();
  });

  test("a struct that's whole for one of the overloads it fits chooses that one", async () => {
    const { mock, client } = setup();
    // `T` listed first: a mock on it would never answer `f(S)`.
    const pairAbi = parseAbi([
      "struct S { address a; }",
      "struct T { address a; address b; }",
      "function f(T t) view returns (uint256)",
      "function f(S s) view returns (uint256)",
    ]);
    mock
      .contract({ abi: pairAbi, address: DAI })
      .read.f([{ a: alice }])
      .returns(1n);

    expect(
      await client.readContract({
        abi: pairAbi,
        address: DAI,
        functionName: "f",
        args: [{ a: alice }],
      }),
    ).toBe(1n);
  });

  test("a whole struct beside a matcher chooses the overload it's whole for", async () => {
    const { mock, client } = setup();
    // V2 adds a field, so a V1 struct with fields left out would fit both.
    const routerAbi = parseAbi([
      "struct Params { address tokenIn; uint256 amountIn; }",
      "struct ParamsV2 { address tokenIn; uint256 amountIn; uint256 minOut; }",
      "function quote(Params p, uint256 deadline) view returns (uint256)",
      "function quote(ParamsV2 p, uint256 deadline) view returns (uint256)",
    ]);
    const params = { tokenIn: alice, amountIn: 5n };
    mock.contract({ abi: routerAbi, address: DAI }).read.quote([params, match.any()]).returns(1n);

    expect(
      await client.readContract({
        abi: routerAbi,
        address: DAI,
        functionName: "quote",
        args: [params, 9n],
      }),
    ).toBe(1n);
  });

  test("a struct written as a list fits by its elements, with an address in any case", async () => {
    const { mock, client } = setup();
    // Unnamed components, which viem decodes as a list.
    const tupleAbi = parseAbi([
      "function f((address,uint256) s) view returns (uint256)",
      "function f(uint256 x) view returns (uint256)",
    ]);
    const uppercase = `0x${alice.slice(2).toUpperCase()}` as const;
    const contract = mock.contract({ abi: tupleAbi, address: DAI });
    contract.read.f([[uppercase, 5n]]).returns(1n);

    expect(
      await client.readContract({
        abi: [tupleAbi[0]],
        address: DAI,
        functionName: "f",
        args: [[alice, 5n]],
      }),
    ).toBe(1n);
    expectThrows(MockSetupError, `No overload takes read.f([${uppercase}, 5n, 6n]).`, () =>
      // @ts-expect-error -- the struct has two fields
      contract.read.f([[uppercase, 5n, 6n]]),
    );
    expectThrows(MockSetupError, `No overload takes read.f([${uppercase}, x]).`, () =>
      // @ts-expect-error -- a string where a uint goes
      contract.read.f([[uppercase, "x"]]),
    );
  });

  test("a value the encoder would coerce fits no overload", () => {
    const { token } = setupFitOverloads();

    expectThrows(MockSetupError, "No overload takes read.w(5).", () =>
      // @ts-expect-error -- a string where a uint goes
      token.read.w(["5"]),
    );
    expectThrows(MockSetupError, "No overload takes read.w(true).", () =>
      // @ts-expect-error -- a bool where a uint goes
      token.read.w([true]),
    );
  });

  test("complete values choose a uint256, address or bytes32 overload by their type", async () => {
    const { mock, client } = setup();
    const lookupAbi = parseAbi([
      "function find(uint256 id) view returns (uint256)",
      "function find(address owner) view returns (uint256)",
      "function find(bytes32 key) view returns (uint256)",
    ]);
    const hash = `0x${"ab".repeat(32)}` as const;
    const registry = mock.contract({ abi: lookupAbi, address: DAI });
    registry.read.find([5n]).returns(1n);
    registry.read.find([alice]).returns(2n);
    registry.read.find([hash]).returns(3n);

    const find = (args: readonly [bigint] | readonly [`0x${string}`], index: number) =>
      client.readContract({
        abi: [lookupAbi[index]!],
        address: DAI,
        functionName: "find",
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- args for the overload at `index`
        args: args as never,
      });
    expect([await find([5n], 0), await find([alice], 1), await find([hash], 2)]).toEqual([
      1n,
      2n,
      3n,
    ]);
  });

  test("args that two overloads' types both take throw viem's own ambiguity error", () => {
    const { token } = setupFitOverloads();

    // viem doesn't export the class.
    const error = expectThrows(BaseError, "Found ambiguous types in overloaded ABI items.", () =>
      token.read.w([5n]),
    );
    expect(error.name).toBe("AbiItemAmbiguityError");
  });
});

describe("actions and raw methods", () => {
  test("a matcher can stand for all of an action's params, or a raw method's", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance(match.partial({ address: alice })).returns(1n);
    mock.actions.getCode(match.any()).returns("0x60");
    mock.actions
      .getStorageAt(
        match.where(
          (call) => call?.address !== undefined && isAddressEqual(call.address, bob),
          "isBob",
        ),
      )
      .returns(pad("0x3"));
    mock
      .method(
        "eth_custom",
        match.where((params) => params?.length === 2, "twoParams"),
      )
      .returns("0x1");

    expect(await client.getBalance({ address: alice })).toBe(1n);
    expect(await client.getCode({ address: bob })).toBe("0x60");
    expect(await client.getStorageAt({ address: bob, slot: "0x0" })).toBe(pad("0x3"));
    expect(await mock.request({ method: "eth_custom", params: ["0x1", "0x2"] })).toBe("0x1");

    const error = expectCause(
      await rejectionOf(client.getStorageAt({ address: alice, slot: "0x0" })),
      MockNotFoundError,
    );
    expect(hintsOf(error)).toBe("Registered:\n  getStorageAt(where(isBob))  ← params didn't match");
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
    await expectRejects(
      BlockNotFoundError,
      "could not be found",
      client.getBlock({ blockNumber: 2_000n }),
    );
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
