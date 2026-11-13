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

import { MockNotFoundError, createMockRpc, match, testAddress } from "../src/index.js";
import { expectCause, expectRejects, hintsOf, lowercase, rejectionOf } from "./utils.js";

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
