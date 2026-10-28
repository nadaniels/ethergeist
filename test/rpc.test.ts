import { InvalidAddressError, createPublicClient, erc20Abi, getAddress, parseAbi } from "viem";
import { base, mainnet } from "viem/chains";
import { describe, expect, test } from "vite-plus/test";
import { MockNotFoundError, createMockRpc } from "../src/index.js";
import { expectCause, rejectionOf } from "./utils.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const usdcLowercase = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const alice = "0x00000000000000000000000000000000000a11ce";

// OpenZeppelin's Ownable, to combine with an ERC-20 at one address.
const ownableAbi = parseAbi(["function owner() view returns (address)"]);

function setup({ batch = false }: { batch?: boolean } = {}) {
  const mock = createMockRpc({ blockNumber: 100n });
  const client = createPublicClient({
    chain: mainnet,
    transport: mock.transport(),
    cacheTime: 0,
    ...(batch ? { batch: { multicall: true } } : {}),
  });
  const decimals = (address: `0x${string}`) =>
    client.readContract({ abi: erc20Abi, address, functionName: "decimals" });
  return { mock, client, decimals };
}

describe("registration", () => {
  test("a second registration at the same address throws", () => {
    const { mock } = setup();
    mock.contract({ abi: erc20Abi, address: USDC });

    expect(() => mock.contract({ abi: ownableAbi, address: usdcLowercase })).toThrow(
      `A contract is already registered at ${usdcLowercase}`,
    );
  });

  test("a malformed address is rejected at registration", () => {
    const { mock } = setup();
    expect(() => mock.contract({ abi: erc20Abi, address: "0x1234" })).toThrow(InvalidAddressError);
  });

  test("one registration with a combined ABI answers both", async () => {
    const { mock, client, decimals } = setup();
    const usdc = mock.contract({ abi: [...erc20Abi, ...ownableAbi], address: USDC });
    usdc.read.decimals().returns(6);
    usdc.read.owner().returns(alice);

    expect(await decimals(USDC)).toBe(6);
    expect(
      await client.readContract({ abi: ownableAbi, address: USDC, functionName: "owner" }),
    ).toBe(getAddress(alice));
    expect(usdc.calls.map((c) => c.functionName)).toEqual(["decimals", "owner"]);
  });
});

describe("rpc.calls", () => {
  test("logs calls across contracts in order, with their address", async () => {
    const { mock, decimals } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);
    mock.contract({ abi: erc20Abi, address: DAI }).read.decimals().returns(18);

    await decimals(DAI);
    await decimals(USDC);
    await decimals(DAI);

    expect(mock.calls.map((c) => [c.address, c.functionName])).toEqual([
      [DAI, "decimals"],
      [USDC, "decimals"],
      [DAI, "decimals"],
    ]);
  });

  test("addresses are checksummed, whatever case was registered", async () => {
    const { mock, decimals } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: usdcLowercase });
    usdc.read.decimals().returns(6);

    await decimals(USDC);
    expect(usdc.address).toBe(USDC);
    expect(mock.calls[0]?.address).toBe(USDC);
    expect(usdc.calls[0]?.address).toBe(USDC);
  });

  test("keeps batch order for multicall sub-calls", async () => {
    const { mock, client } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);
    mock.contract({ abi: erc20Abi, address: DAI }).read.decimals().returns(18);

    await client.multicall({
      contracts: [
        { abi: erc20Abi, address: DAI, functionName: "decimals" },
        { abi: erc20Abi, address: USDC, functionName: "decimals" },
      ],
    });

    expect(mock.calls.map((c) => [c.address, c.batch?.index])).toEqual([
      [DAI, 0],
      [USDC, 1],
    ]);
  });

  test("contract.calls carries the address too", async () => {
    const { mock, decimals } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.decimals().returns(6);

    await decimals(USDC);
    expect(usdc.calls[0]?.address).toBe(USDC);
  });

  test("returned logs are copies", async () => {
    const { mock, decimals } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);
    await decimals(USDC);

    mock.calls.length = 0;
    mock.requests.length = 0;
    expect(mock.calls).toHaveLength(1);
    expect(mock.requests).toHaveLength(1);
  });
});

describe("clearCalls()", () => {
  test("clears history but keeps mocks and the block number", async () => {
    const { mock, decimals } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.decimals().returns(6);
    mock.mine(5n);
    await decimals(USDC);

    mock.clearCalls();
    expect(mock.calls).toEqual([]);
    expect(mock.requests).toEqual([]);
    expect(usdc.calls).toEqual([]);
    expect(usdc.read.decimals.calls).toEqual([]);
    expect(mock.blockNumber).toBe(105n);

    expect(await decimals(USDC)).toBe(6);
    expect(usdc.calls).toHaveLength(1);
  });
});

describe("reset()", () => {
  test("removes contracts and history and restores the starting block", async () => {
    const { mock, client, decimals } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);
    mock.mine(5n);
    await decimals(USDC);

    mock.reset();
    expect(mock.calls).toEqual([]);
    expect(mock.requests).toEqual([]);
    expect(mock.blockNumber).toBe(100n);
    expect(await client.getBlockNumber()).toBe(100n);

    const error = expectCause(await rejectionOf(decimals(USDC)), MockNotFoundError);
    expect(error.message).toContain(`No mocked contract at ${USDC}`);
  });

  test("frees the address for a new registration", async () => {
    const { mock, decimals } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);

    mock.reset();
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(18);
    expect(await decimals(USDC)).toBe(18);
  });

  test("handles from before the reset no longer answer", async () => {
    const { mock, decimals } = setup();
    const stale = mock.contract({ abi: erc20Abi, address: USDC });

    mock.reset();
    stale.read.decimals().returns(6);
    expectCause(await rejectionOf(decimals(USDC)), MockNotFoundError);
  });

  test("batch ids start over", async () => {
    const { mock, client } = setup();
    const register = () => {
      mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);
    };
    const batchId = async () => {
      await client.multicall({
        contracts: [{ abi: erc20Abi, address: USDC, functionName: "decimals" }],
      });
      return mock.calls.at(-1)?.batch?.id;
    };

    register();
    const first = await batchId();
    mock.reset();
    register();
    expect(await batchId()).toBe(first);
  });
});

describe("chainId", () => {
  test("matches what eth_chainId answers", async () => {
    const mock = createMockRpc({ chain: base });
    const client = createPublicClient({ transport: mock.transport() });

    expect(mock.chainId).toBe(8453);
    expect(await client.getChainId()).toBe(8453);
  });
});
