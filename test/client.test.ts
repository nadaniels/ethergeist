import { defineChain, erc20Abi, multicall3Abi } from "viem";
import { base, mainnet } from "viem/chains";
import { describe, expect, test } from "vite-plus/test";
import { createMockRpc, multicall3Address } from "../src/index.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const customMulticall = "0x0000000000000000000000000000000000ca11ca";

// A chain whose Multicall3 isn't at the canonical address.
const customChain = defineChain({
  id: 999_999,
  name: "Custom",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },
  contracts: { multicall3: { address: customMulticall } },
});

function withUsdc(mock: ReturnType<typeof createMockRpc>) {
  mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);
  return mock;
}

const decimalsCall = { abi: erc20Abi, address: USDC, functionName: "decimals" } as const;

describe("publicClient()", () => {
  test("reads and multicalls work with no other setup", async () => {
    const mock = withUsdc(createMockRpc());
    const client = mock.publicClient();

    expect(await client.readContract(decimalsCall)).toBe(6);
    expect(await client.multicall({ contracts: [decimalsCall], allowFailure: false })).toEqual([6]);
    expect(await client.getChainId()).toBe(mock.chainId);
  });

  test("mined blocks show up immediately", async () => {
    const mock = createMockRpc({ blockNumber: 10n });
    const client = mock.publicClient();

    expect(await client.getBlockNumber()).toBe(10n);
    mock.mine();
    expect(await client.getBlockNumber()).toBe(11n);
  });

  test("options pass through, including batching", async () => {
    const mock = withUsdc(createMockRpc());
    const client = mock.publicClient({ batch: { multicall: true } });

    await Promise.all([client.readContract(decimalsCall), client.readContract(decimalsCall)]);
    expect(mock.requests.filter((r) => r.method === "eth_call")).toHaveLength(1);
  });

  test("defaults to mainnet", async () => {
    const mock = createMockRpc();

    expect(mock.chain.id).toBe(mainnet.id);
    expect(await mock.publicClient().getChainId()).toBe(mainnet.id);
  });
});

describe("createMockRpc({ chain })", () => {
  test("takes the chain id and Multicall3 address from the chain", async () => {
    const mock = withUsdc(createMockRpc({ chain: base }));
    const client = mock.publicClient();

    expect(mock.chainId).toBe(8453);
    expect(client.chain.id).toBe(8453);
    expect(await client.getChainId()).toBe(8453);
    expect(await client.multicall({ contracts: [decimalsCall], allowFailure: false })).toEqual([6]);
  });

  test("a non-canonical Multicall3 is answered at the chain's address", async () => {
    const mock = withUsdc(createMockRpc({ chain: customChain }));

    const results = await mock
      .publicClient()
      .multicall({ contracts: [decimalsCall], allowFailure: false });
    expect(results).toEqual([6]);
    expect(mock.requests.at(-1)?.params).toMatchObject([{ to: customMulticall }, "latest"]);
  });

  test("a chain without Multicall3 gets the mock's", async () => {
    const { contracts: _, ...bare } = customChain;
    const mock = withUsdc(createMockRpc({ chain: bare }));

    expect(mock.chain.contracts?.multicall3?.address).toBe(multicall3Address);
    expect(
      await mock.publicClient().multicall({ contracts: [decimalsCall], allowFailure: false }),
    ).toEqual([6]);
  });

  test("a chain's own Multicall3 isn't answered at the canonical address", async () => {
    const mock = createMockRpc({ chain: customChain });

    await expect(
      mock.publicClient().readContract({
        abi: multicall3Abi,
        address: multicall3Address,
        functionName: "getCurrentBlockTimestamp",
      }),
    ).rejects.toThrow(`No mocked contract at ${multicall3Address}`);
  });
});
