import { BaseError, createPublicClient, erc20Abi, getAddress, parseAbi } from "viem";
import { mainnet } from "viem/chains";
import { describe, expect, test } from "vite-plus/test";
import { MockNotFoundError, createMockRpc } from "../src/index.js";
import { expectCause, rejectionOf } from "./utils.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const alice = "0x00000000000000000000000000000000000a11ce";
const bob = "0x0000000000000000000000000000000000000b0b";

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

describe("block number", () => {
  test("returns the configured block and advances with mine()", async () => {
    const { mock, client } = setup({ blockNumber: 100n });
    expect(await client.getBlockNumber()).toBe(100n);
    mock.mine(5n);
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
    usdc.read.balanceOf(["0x00000000000000000000000000000000000A11CE"]).returns(7n);

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
    expect(error.message).toContain(`balanceOf(${getAddress(bob)})`);
    expectCause(error, MockNotFoundError);
    expect(mock.requests).toHaveLength(1);
  });
});

describe("string args", () => {
  // A name registry keyed by plain strings.
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
    // @ts-expect-error the types want a number for uint32; a loosely typed helper might not
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
    // @ts-expect-error the types want a bigint for uint256
    nft.read.ownerOf([42]).returns(alice);

    expect(
      await client.readContract({ abi, address: USDC, functionName: "ownerOf", args: [42n] }),
    ).toBe(getAddress(alice));
  });

  test("different values still don't match", async () => {
    const { mock, client } = setup();
    const nft = mock.contract({ abi, address: USDC });
    // @ts-expect-error the types want a bigint for uint256
    nft.read.ownerOf([42]).returns(alice);

    expectCause(
      await rejectionOf(
        client.readContract({ abi, address: USDC, functionName: "ownerOf", args: [43n] }),
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

    // Closures over test state are the store, for now.
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

    await expect(
      client.readContract({ abi: erc20Abi, address: USDC, functionName: "symbol" }),
    ).rejects.toThrow('No mocks registered for "symbol"');
  });
});
