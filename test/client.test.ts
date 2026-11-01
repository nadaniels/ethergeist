import { ChainDoesNotSupportContract, defineChain, erc20Abi, multicall3Abi } from "viem";
import { base, mainnet } from "viem/chains";
import { describe, expect, test } from "vite-plus/test";

import { createMockRpc, testAddress } from "../src/index.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const customMulticall = testAddress("custom-multicall");

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

  test("transport options are a second argument, e.g. no retries", async () => {
    const mock = createMockRpc();
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().fails({ status: 503 });
    const ethCalls = () => mock.requests.filter((r) => r.method === "eth_call");

    await mock
      .publicClient(undefined, { retryCount: 0 })
      .readContract(decimalsCall)
      .catch(() => {});
    expect(ethCalls()).toHaveLength(1);
    await mock
      .publicClient()
      .readContract(decimalsCall)
      .catch(() => {});
    // One attempt plus viem's default 3 retries.
    expect(ethCalls()).toHaveLength(5);
  });

  test("transport options merge over the transport's defaults, as client options do", () => {
    const client = createMockRpc().publicClient({ cacheTime: 10 }, { retryCount: 2 });

    expect(client.transport.retryCount).toBe(2);
    expect(client.transport.retryDelay).toBe(0);
    expect(client.cacheTime).toBe(10);
    expect(client.pollingInterval).toBe(50);
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

  test("a chain without Multicall3 can't multicall, as in viem", async () => {
    const { contracts: _, ...bare } = customChain;
    const mock = withUsdc(createMockRpc({ chain: bare }));

    expect(mock.chain.contracts?.multicall3).toBeUndefined();
    await expect(
      mock.publicClient().multicall({ contracts: [decimalsCall], allowFailure: false }),
    ).rejects.toThrow(ChainDoesNotSupportContract);
  });

  test("on a chain without Multicall3, a call without a target isn't a multicall", async () => {
    const { contracts: _, ...bare } = customChain;
    const mock = createMockRpc({ chain: bare });

    await mock.request({ method: "eth_call", params: [{ data: "0x" }, "latest"] }).catch(() => {});
    expect(mock.history[0]?.type).toBe("call");
  });

  test("a chain's own Multicall3 isn't answered at the canonical address", async () => {
    const mock = createMockRpc({ chain: customChain });

    await expect(
      mock.publicClient().readContract({
        abi: multicall3Abi,
        address: mainnet.contracts.multicall3.address,
        functionName: "getCurrentBlockTimestamp",
      }),
    ).rejects.toThrow(`No mocked contract at ${mainnet.contracts.multicall3.address}`);
  });
});
