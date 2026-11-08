import {
  type Address,
  ContractFunctionRevertedError,
  IntegerOutOfRangeError,
  createPublicClient,
  createWalletClient,
  encodeErrorResult,
  getAddress,
  parseAbi,
} from "viem";
import { mainnet } from "viem/chains";
import { describe, expect, test } from "vite-plus/test";

import {
  MockCheckError,
  MockResolverError,
  type MockRpc,
  MockSetupError,
  createMockRpc,
  match,
  testAddress,
} from "../src/index.js";
import { expectCause, expectThrows, findCause, rejectionOf } from "./utils.js";

const NFT = testAddress("nft");
const alice = testAddress("alice");

// OpenZeppelin ERC-721 with ERC-6093 custom errors and Pausable.
const erc721Abi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "error ERC721NonexistentToken(uint256 tokenId)",
  "error ERC721IncorrectOwner(address sender, uint256 tokenId, address owner)",
  "error EnforcedPause()",
]);

function setup() {
  const mock = createMockRpc();
  // Default retry settings on purpose: reverts must not be retried.
  const client = createPublicClient({ chain: mainnet, transport: mock.transport() });
  const nft = mock.contract({ abi: erc721Abi, address: NFT });
  const ownerOf = (tokenId: bigint) =>
    client.readContract({ abi: erc721Abi, address: NFT, functionName: "ownerOf", args: [tokenId] });
  return { mock, client, nft, ownerOf };
}

/** Resolves to the revert error viem surfaced, or fails if there wasn't one. */
async function revertOf(promise: Promise<unknown>) {
  return expectCause(await rejectionOf(promise), ContractFunctionRevertedError);
}

describe("reverts()", () => {
  test("a reason string decodes as Error(string)", async () => {
    const { nft, ownerOf } = setup();
    nft.read.ownerOf().reverts("ERC721: invalid token ID");

    const revert = await revertOf(ownerOf(1n));
    expect(revert.reason).toBe("ERC721: invalid token ID");
    expect(revert.data?.errorName).toBe("Error");
  });

  test("a custom error decodes with its args", async () => {
    const { nft, ownerOf } = setup();
    nft.read.ownerOf().reverts({ errorName: "ERC721NonexistentToken", args: [42n] });

    const revert = await revertOf(ownerOf(42n));
    expect(revert.data?.errorName).toBe("ERC721NonexistentToken");
    expect(revert.data?.args).toEqual([42n]);
  });

  test("a custom error without inputs needs no args", async () => {
    const { nft, ownerOf } = setup();
    nft.read.ownerOf().reverts({ errorName: "EnforcedPause" });

    const revert = await revertOf(ownerOf(1n));
    expect(revert.data?.errorName).toBe("EnforcedPause");
  });

  test("a panic code decodes to its reason", async () => {
    const { nft, ownerOf } = setup();
    nft.read.ownerOf().reverts({ panic: 0x11 });

    const revert = await revertOf(ownerOf(1n));
    expect(revert.data?.errorName).toBe("Panic");
    expect(revert.reason).toMatch(/overflow/u);
  });

  test("a panic code can be a bigint", async () => {
    const { nft, ownerOf } = setup();
    nft.read.ownerOf().reverts({ panic: 0x12n });

    const revert = await revertOf(ownerOf(1n));
    expect(revert.data?.errorName).toBe("Panic");
    expect(revert.reason).toMatch(/by zero/u);
  });

  test("an undefined panic or data is left out, so the custom error answers", async () => {
    const { nft, ownerOf } = setup();
    nft.read
      .ownerOf([1n])
      // @ts-expect-error -- an explicit undefined, allowed without exactOptionalPropertyTypes
      .reverts({ errorName: "ERC721NonexistentToken", args: [1n], panic: undefined });
    nft.read
      .ownerOf([2n])
      // @ts-expect-error -- an explicit undefined, allowed without exactOptionalPropertyTypes
      .reverts({ errorName: "ERC721NonexistentToken", args: [2n], data: undefined });

    expect((await revertOf(ownerOf(1n))).data?.args).toEqual([1n]);
    expect((await revertOf(ownerOf(2n))).data?.args).toEqual([2n]);
  });

  test("raw data passes through for errors not on the ABI", async () => {
    const { nft, ownerOf } = setup();
    const ownableAbi = parseAbi(["error OwnableUnauthorizedAccount(address account)"]);
    const data = encodeErrorResult({
      abi: ownableAbi,
      errorName: "OwnableUnauthorizedAccount",
      args: [alice],
    });
    nft.read.ownerOf().reverts({ data });

    const revert = await revertOf(ownerOf(1n));
    expect(revert.raw).toBe(data);
  });

  test("no argument is a bare revert", async () => {
    const { nft, ownerOf } = setup();
    nft.read.ownerOf().reverts();

    const revert = await revertOf(ownerOf(1n));
    expect(revert.data).toBeUndefined();
  });

  test("specificity applies: reverting for some args leaves others answering", async () => {
    const { nft, ownerOf } = setup();
    nft.read.ownerOf().returns(alice);
    nft.read.ownerOf([42n]).reverts({ errorName: "ERC721NonexistentToken", args: [42n] });

    expect(await ownerOf(1n)).toBe(getAddress(alice));
    await revertOf(ownerOf(42n));
  });

  test("simulateContract surfaces the same revert", async () => {
    const { client, nft } = setup();
    nft.read.ownerOf().reverts({ errorName: "EnforcedPause" });

    const revert = await revertOf(
      client.simulateContract({
        abi: erc721Abi,
        address: NFT,
        functionName: "ownerOf",
        args: [1n],
      }),
    );
    expect(revert.data?.errorName).toBe("EnforcedPause");
  });

  test("reverts are not retried", async () => {
    const { mock, nft, ownerOf } = setup();
    nft.read.ownerOf().reverts("nope");

    await revertOf(ownerOf(1n));
    expect(mock.history).toHaveLength(1);
  });
});

describe("revert() in a resolver", () => {
  test("reverts conditionally on args", async () => {
    const { nft, ownerOf } = setup();
    const owners = new Map<bigint, Address>([[1n, alice]]);
    nft.read
      .ownerOf()
      .returns(
        ({ args: [tokenId], revert }) =>
          owners.get(tokenId) ?? revert({ errorName: "ERC721NonexistentToken", args: [tokenId] }),
      );

    expect(await ownerOf(1n)).toBe(getAddress(alice));
    const revert = await revertOf(ownerOf(2n));
    expect(revert.data?.args).toEqual([2n]);
  });
});

describe("resolvers that throw", () => {
  test("surface as a MockResolverError with the cause, not a revert, without retries", async () => {
    const { mock, nft, ownerOf } = setup();
    nft.read.ownerOf().returns(() => {
      throw new Error("fixture bug");
    });

    const error = await rejectionOf(ownerOf(1n));
    expect(findCause(error, ContractFunctionRevertedError)).toBeUndefined();
    const resolverError = expectCause(error, MockResolverError);
    expect(resolverError).toBeInstanceOf(MockResolverError);
    expect(resolverError.message).toContain('Mock resolver for "ownerOf" threw: fixture bug');
    expect(resolverError.cause).toMatchObject({ message: "fixture bug" });
    expect(mock.history).toHaveLength(1);
  });
});

describe("a revert spec is checked at .reverts(), on every builder", () => {
  const tokenAbi = parseAbi([
    "function transfer(address to, uint256 value) returns (bool)",
    "function ownerOf(uint256 tokenId) view returns (address)",
    "error Failed(uint256 code)",
  ]);
  const builders = {
    read: (mock: MockRpc) => mock.contract({ abi: tokenAbi, address: NFT }).read.ownerOf(),
    simulate: (mock: MockRpc) => mock.contract({ abi: tokenAbi, address: NFT }).simulate.transfer(),
    estimateGas: (mock: MockRpc) =>
      mock.contract({ abi: tokenAbi, address: NFT }).estimateGas.transfer(),
    write: (mock: MockRpc) => mock.contract({ abi: tokenAbi, address: NFT }).write.transfer(),
    "actions.sendTransaction": (mock: MockRpc) => mock.actions.sendTransaction(),
    "actions.estimateGas": (mock: MockRpc) => mock.actions.estimateGas(),
  };
  const refused = "A revert spec has no reason, errorName, panic or data";
  const unencodable = "A revert was given a value it can't encode";

  for (const [name, register] of Object.entries(builders))
    test.each([
      ["null", null, MockSetupError, `${refused}; got null.`],
      ["an empty object", {}, MockSetupError, `${refused}; got {  }.`],
      ["a number", 5, MockSetupError, `${refused}; got 5.`],
      [
        "a panic code that isn't an integer",
        { panic: 1.5 },
        MockSetupError,
        `${unencodable}: The number 1.5 cannot be converted to a BigInt`,
      ],
      [
        "a panic code that's a string",
        { panic: "" },
        MockSetupError,
        "A revert's panic must be a number or bigint; got .",
      ],
      [
        "a panic code that's a boolean",
        { panic: true },
        MockSetupError,
        "A revert's panic must be a number or bigint; got true.",
      ],
      [
        "data that isn't hex",
        { data: "0xzz" },
        MockSetupError,
        "A revert's data must be hex; got 0xzz.",
      ],
      [
        "a panic and data",
        { panic: 1, data: "0x12" },
        MockSetupError,
        "A revert spec takes one of data, panic, or errorName; got data and panic.",
      ],
      [
        "an errorName and a panic",
        { errorName: "EnforcedPause", panic: 1 },
        MockSetupError,
        "A revert spec takes one of data, panic, or errorName; got panic and errorName.",
      ],
      [
        "args with a panic",
        { panic: 1, args: [] },
        MockSetupError,
        "A revert spec takes one of data, panic, or errorName; got panic and args.",
      ],
      [
        "a matcher in an error's args, as if it matched any",
        { errorName: "Failed", args: [match.any()] },
        MockSetupError,
        "match.any() can't go in a revert spec; matchers only go in a mock's args, params and pins.",
      ],
      [
        "a negative panic code, as viem refuses it",
        { panic: -1 },
        IntegerOutOfRangeError,
        'Number "-1"',
      ],
    ] as const)(`${name}: refuses %s, leaving it without an answer`, (_, spec, type, message) => {
      const mock = createMockRpc();
      const builder = register(mock);

      expectThrows(type, message, () => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what the types rule out
        builder.reverts(spec as never);
      });
      expectThrows(MockCheckError, "without an answer", () => {
        mock.assertAllUsed();
      });
    });

  test.each(["read", "simulate", "estimateGas", "write"] as const)(
    "%s: refuses an error's args that don't encode, as the mock's error",
    (namespace) => {
      const mock = createMockRpc();
      const builder = builders[namespace](mock);

      expectThrows(MockSetupError, `${unencodable}: Cannot convert x to a BigInt`, () => {
        // @ts-expect-error -- `code` is a uint256: a bigint
        builder.reverts({ errorName: "Failed", args: ["x"] });
      });
    },
  );

  // A JSON-imported ABI is typed loosely, so its revert specs aren't checked against the error.
  test.each(["read", "simulate", "estimateGas", "write"] as const)(
    "%s: refuses an error's args that don't match its inputs, too few or too many",
    (namespace) => {
      const mock = createMockRpc();
      const builder = builders[namespace](mock);

      for (const [args, got] of [
        [undefined, 0],
        [[], 0],
        [[1n, 2n], 2],
      ] as const) {
        const error = expectThrows(
          MockSetupError,
          `A revert of Failed takes 1 arg; got ${got}.`,
          () => {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what the types rule out
            builder.reverts({ errorName: "Failed", args } as never);
          },
        );
        expect(error.metaMessages).toEqual(["Failed(uint256 code)"]);
      }
    },
  );

  test("an error's arg count names each of its forms once, and named args as given", () => {
    const failed = parseAbi(["error Failed(uint256 code)", "error Failed()"]);
    // Combined ABIs often declare the same error twice.
    const abi = [...tokenAbi, ...failed, ...failed];
    const read = createMockRpc().contract({ abi, address: NFT }).read.ownerOf();

    const twoArgs = expectThrows(
      MockSetupError,
      "A revert of Failed takes 0 or 1 args; got 2.",
      () => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what the types rule out
        read.reverts({ errorName: "Failed", args: [1n, 2n] } as never);
      },
    );
    expect(twoArgs.metaMessages).toEqual(["Failed()", "Failed(uint256 code)"]);
    expectThrows(MockSetupError, "A revert's args must be a list; got { code: 1n }.", () => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what the types rule out
      read.reverts({ errorName: "Failed", args: { code: 1n } } as never);
    });
  });

  test("a resolver's revert() with a spec the types rule out throws the mock's error, sends too", async () => {
    const { mock, nft, ownerOf } = setup();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what the types rule out
    nft.read.ownerOf().returns(({ revert }) => revert(null as never));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what the types rule out
    mock.actions.sendTransaction().returns(({ revert }) => revert({} as never));
    const wallet = createWalletClient({
      account: alice,
      chain: mainnet,
      transport: mock.transport({ retryCount: 0 }),
    });

    expectCause(await rejectionOf(ownerOf(1n)), MockSetupError);
    expectCause(await rejectionOf(wallet.sendTransaction({ to: alice })), MockSetupError);
  });
});
