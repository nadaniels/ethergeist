import {
  ChainDoesNotSupportContract,
  ContractFunctionExecutionError,
  defineChain,
  erc20Abi,
  getAddress,
  multicall3Abi,
} from "viem";
import { base, mainnet } from "viem/chains";
import { describe, expect, test } from "vite-plus/test";

import { createMockRpc, testAddress } from "../src/index.js";
import { expectRejects } from "./utils.js";

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
    expect(await client.getChainId()).toBe(mock.chain.id);
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
    expect(mock.history.filter((r) => r.method === "eth_call")).toHaveLength(1);
  });

  test("retryCount goes to the transport, e.g. no retries", async () => {
    const mock = createMockRpc();
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().fails({ status: 503 });
    const ethCalls = () => mock.history.filter((r) => r.method === "eth_call");

    await mock
      .publicClient({ retryCount: 0 })
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

  test("retry options merge over the transport's defaults, beside the client's", () => {
    const client = createMockRpc().publicClient({ cacheTime: 10, retryCount: 2 });

    expect(client.transport.retryCount).toBe(2);
    expect(client.transport.retryDelay).toBe(0);
    expect(client.cacheTime).toBe(10);
    expect(client.pollingInterval).toBe(50);
  });

  test("retry options left undefined keep the defaults", () => {
    const client = createMockRpc().publicClient({ retryCount: undefined, retryDelay: undefined });

    expect(client.transport.retryCount).toBe(3);
    expect(client.transport.retryDelay).toBe(0);
  });

  test("client options left undefined keep the defaults", async () => {
    const mock = createMockRpc({ blockNumber: 10n });
    const client = mock.publicClient({ cacheTime: undefined, pollingInterval: undefined });

    expect(client.cacheTime).toBe(0);
    expect(client.pollingInterval).toBe(50);
    expect(await client.getBlockNumber()).toBe(10n);
    mock.mine();
    expect(await client.getBlockNumber()).toBe(11n);
  });

  test("key and name are the client's, not the transport's", () => {
    const client = createMockRpc().publicClient({ key: "app", name: "App Client" });

    expect([client.key, client.name]).toEqual(["app", "App Client"]);
    expect([client.transport.key, client.transport.name]).toEqual(["custom", "Custom Provider"]);
  });

  test("retryDelay goes to the transport", () => {
    expect(createMockRpc().publicClient({ retryDelay: 5 }).transport.retryDelay).toBe(5);
  });

  test("defaults to mainnet", async () => {
    const mock = createMockRpc();

    expect(mock.chain.id).toBe(mainnet.id);
    expect(await mock.publicClient().getChainId()).toBe(mainnet.id);
  });
});

describe("transport()", () => {
  test("retries without waiting, unless retryDelay is given", () => {
    const mock = createMockRpc();
    const delayOf = (config?: Parameters<typeof mock.transport>[0]) =>
      mock.transport(config)({}).config.retryDelay;

    expect(delayOf()).toBe(0);
    expect(delayOf({ retryDelay: undefined })).toBe(0);
    expect(delayOf({ retryDelay: 5 })).toBe(5);
  });
});

describe("createMockRpc({ chain })", () => {
  test("takes the chain id and Multicall3 address from the chain", async () => {
    const mock = withUsdc(createMockRpc({ chain: base }));
    const client = mock.publicClient();

    expect(mock.chain.id).toBe(8453);
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
    expect(mock.history.at(-1)?.params).toMatchObject([{ to: customMulticall }, "latest"]);
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

    await expectRejects(
      ContractFunctionExecutionError,
      `No mocked contract at ${getAddress(mainnet.contracts.multicall3.address)}`,
      mock.publicClient().readContract({
        abi: multicall3Abi,
        address: mainnet.contracts.multicall3.address,
        functionName: "getCurrentBlockTimestamp",
      }),
    );
  });
});
