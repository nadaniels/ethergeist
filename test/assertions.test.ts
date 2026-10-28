import { InvalidAddressError, createPublicClient, erc20Abi, parseAbi } from "viem";
import { mainnet } from "viem/chains";
import { describe, expect, test } from "vite-plus/test";
import { MockResolverError, createMockRpc } from "../src/index.js";
import { expectCause, rejectionOf } from "./utils.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const alice = "0x00000000000000000000000000000000000a11ce";
const bob = "0x0000000000000000000000000000000000000b0b";

function setup() {
  const mock = createMockRpc();
  const client = createPublicClient({ chain: mainnet, transport: mock.transport() });
  const balanceOf = (owner: `0x${string}`, address: `0x${string}` = USDC) =>
    client.readContract({ abi: erc20Abi, address, functionName: "balanceOf", args: [owner] });
  return { mock, client, balanceOf };
}

describe("assertNoUnhandled()", () => {
  test("passes when every request was answered, including reverts", async () => {
    const { mock, balanceOf } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.balanceOf([alice]).returns(1n);
    usdc.read.balanceOf([bob]).reverts("blocked");

    await balanceOf(alice);
    await balanceOf(bob).catch(() => {});
    expect(() => {
      mock.assertNoUnhandled();
    }).not.toThrow();
  });

  test("catches a missing mock the code under test swallowed", async () => {
    const { mock, balanceOf } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).read.balanceOf([alice]).returns(1n);

    // App code with a fallback hides the error from the test.
    const balance = await balanceOf(bob).catch(() => 0n);
    expect(balance).toBe(0n);

    expect(() => {
      mock.assertNoUnhandled();
    }).toThrow(/couldn't answer 1 request.*No mock for balanceOf/su);
  });

  test("catches a missing mock inside a multicall that allows failure", async () => {
    const { mock, client } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);

    const results = await client.multicall({
      contracts: [
        { abi: erc20Abi, address: USDC, functionName: "decimals" },
        { abi: erc20Abi, address: USDC, functionName: "symbol" },
      ],
    });
    expect(results.every((r) => r.status === "failure")).toBe(true);

    expect(() => {
      mock.assertNoUnhandled();
    }).toThrow(`No mock for symbol() on ${USDC}`);
  });

  test("catches a resolver that threw", async () => {
    const { mock, balanceOf } = setup();
    mock
      .contract({ abi: erc20Abi, address: USDC })
      .read.balanceOf()
      .returns(() => {
        throw new Error("fixture bug");
      });

    await balanceOf(alice).catch(() => {});
    expect(() => {
      mock.assertNoUnhandled();
    }).toThrow("fixture bug");
  });

  test("records the request that failed, even with others in flight", async () => {
    const { mock, balanceOf } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).read.balanceOf().returns(1n);

    await Promise.allSettled([balanceOf(alice, DAI), balanceOf(alice), balanceOf(bob)]);

    const [entry, ...rest] = mock.unhandled;
    expect(rest).toEqual([]);
    expect(entry?.method).toBe("eth_call");
    expect(entry?.params).toMatchObject([{ to: DAI }, expect.anything()]);
    expect(entry?.error.shortMessage).toContain(`No mocked contract at ${DAI}`);
  });

  test("clearCalls() and reset() clear the record", async () => {
    const { mock, balanceOf } = setup();
    await balanceOf(alice).catch(() => {});
    mock.clearCalls();
    expect(() => {
      mock.assertNoUnhandled();
    }).not.toThrow();

    await balanceOf(alice).catch(() => {});
    mock.reset();
    expect(() => {
      mock.assertNoUnhandled();
    }).not.toThrow();
  });
});

describe("unencodable returns", () => {
  // OpenZeppelin's Ownable.
  const ownableAbi = parseAbi(["function owner() view returns (address)"]);
  // USDC with its checksum broken, which viem refuses to encode.
  const badChecksum = "0xa0B86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

  test("a resolver's value is a resolver error, recorded and not retried", async () => {
    const { mock, client } = setup();
    mock
      .contract({ abi: ownableAbi, address: USDC })
      .read.owner()
      .returns(() => badChecksum);

    const error = await rejectionOf(
      client.readContract({ abi: ownableAbi, address: USDC, functionName: "owner" }),
    );
    expectCause(error, MockResolverError);
    expect(mock.requests).toHaveLength(1);
    expect(() => {
      mock.assertNoUnhandled();
    }).toThrow("owner");
  });

  test("a static value is rejected at registration", () => {
    const { mock } = setup();
    const owner = mock.contract({ abi: ownableAbi, address: USDC }).read.owner();

    expect(() => {
      owner.returns(badChecksum);
    }).toThrow(InvalidAddressError);
  });
});

describe("assertAllUsed()", () => {
  test("passes when every mock with args answered a call", async () => {
    const { mock, balanceOf } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.balanceOf([alice]).returns(1n);
    usdc.read.balanceOf([bob]).reverts("blocked");

    await balanceOf(alice);
    await balanceOf(bob).catch(() => {});
    expect(() => {
      mock.assertAllUsed();
    }).not.toThrow();
  });

  test("catches a mock with wrong args hidden by a broader one", async () => {
    const { mock, balanceOf } = setup();
    const usdc = mock.contract({
      abi: erc20Abi,
      address: USDC,
      defaults: { read: { balanceOf: 0n } },
    });
    // Meant for alice, but registered for bob: alice silently gets the default.
    usdc.read.balanceOf([bob]).returns(500n);

    expect(await balanceOf(alice)).toBe(0n);
    expect(() => {
      mock.assertAllUsed();
    }).toThrow(`balanceOf(${bob}) on ${USDC}`);
  });

  test("doesn't check args-less mocks or defaults", () => {
    const { mock } = setup();
    const usdc = mock.contract({
      abi: erc20Abi,
      address: USDC,
      defaults: { read: { decimals: 6 } },
    });
    usdc.read.balanceOf().returns(0n);

    expect(() => {
      mock.assertAllUsed();
    }).not.toThrow();
  });

  test("counts calls inside a multicall", async () => {
    const { mock, client } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).read.balanceOf([alice]).returns(1n);

    await client.multicall({
      contracts: [{ abi: erc20Abi, address: USDC, functionName: "balanceOf", args: [alice] }],
    });
    expect(() => {
      mock.assertAllUsed();
    }).not.toThrow();
  });

  test("clearCalls() resets usage", async () => {
    const { mock, balanceOf } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).read.balanceOf([alice]).returns(1n);
    await balanceOf(alice);

    mock.clearCalls();
    expect(() => {
      mock.assertAllUsed();
    }).toThrow(`balanceOf(${alice})`);
  });
});
