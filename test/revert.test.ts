import {
  type Address,
  ContractFunctionRevertedError,
  createPublicClient,
  encodeErrorResult,
  getAddress,
  parseAbi,
} from "viem";
import { mainnet } from "viem/chains";
import { describe, expect, test } from "vite-plus/test";
import { MockResolverError, createMockRpc } from "../src/index.js";
import { expectCause, findCause, rejectionOf } from "./utils.js";

const NFT = "0x0000000000000000000000000000000000000721";
const alice = "0x00000000000000000000000000000000000a11ce";

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
    expect(mock.requests).toHaveLength(1);
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
    expect(mock.requests).toHaveLength(1);
  });
});
