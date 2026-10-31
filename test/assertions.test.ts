import { InvalidAddressError, createPublicClient, erc20Abi, getAddress, parseAbi } from "viem";
import { mainnet } from "viem/chains";
import { describe, expect, test } from "vite-plus/test";
import {
  MockNotFoundError,
  MockResolverError,
  createMockRpc,
  match,
  testAddress,
} from "../src/index.js";
import { expectCause, lowercase, rejectionOf } from "./utils.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const alice = testAddress("alice");
const bob = testAddress("bob");

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

describe("messages", () => {
  // A generic order book, for a struct arg.
  const bookAbi = parseAbi([
    "struct Order { address maker; uint256 amount; }",
    "function filled(Order order) view returns (bool)",
  ]);

  test("a contract's name shows next to its address", async () => {
    const { mock, balanceOf } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC, name: "USDC" });
    usdc.read.balanceOf([bob]).returns(1n);

    expect(usdc.name).toBe("USDC");
    const error = expectCause(await rejectionOf(balanceOf(alice)), MockNotFoundError);
    expect(error.message).toContain(
      `No mock for balanceOf(${getAddress(alice)}) on USDC (${USDC})`,
    );
    expect(() => {
      mock.assertAllUsed();
    }).toThrow(`balanceOf(${getAddress(bob)}) on USDC (${USDC})`);
    expect(() => mock.contract({ abi: erc20Abi, address: USDC })).toThrow(
      `A contract is already registered at USDC (${USDC})`,
    );
  });

  test("without a name, it's the address alone", () => {
    const { mock } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.balanceOf([bob]).returns(1n);

    expect(usdc.name).toBeUndefined();
    expect(() => {
      mock.assertAllUsed();
    }).toThrow(`balanceOf(${getAddress(bob)}) on ${USDC}`);
  });

  test("struct args are spelled out", () => {
    const { mock } = setup();
    mock
      .contract({ abi: bookAbi, address: DAI, name: "Book" })
      .read.filled([{ maker: alice, amount: 5n }])
      .returns(true);

    expect(() => {
      mock.assertAllUsed();
    }).toThrow(`filled({ maker: ${getAddress(alice)}, amount: 5n }) on Book`);
  });
});

describe("address args", () => {
  // A batch-balance view, for address arrays.
  const batchAbi = parseAbi(["function balancesOf(address[] owners) view returns (uint256[])"]);

  test("are checksummed at registration, so messages show them one way", () => {
    const { mock } = setup();
    const usdcLowercase = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    mock
      .contract({ abi: erc20Abi, address: USDC })
      .read.allowance([usdcLowercase, bob])
      .returns(1n);
    mock
      .contract({ abi: batchAbi, address: DAI })
      .read.balancesOf([[lowercase(alice), lowercase(bob)]])
      .returns([]);

    expect(() => {
      mock.assertAllUsed();
    }).toThrow(`allowance(${USDC}, ${getAddress(bob)})`);
    expect(() => {
      mock.assertAllUsed();
    }).toThrow(`balancesOf([${getAddress(alice)}, ${getAddress(bob)}])`);
  });

  test("a malformed one fails at registration", () => {
    const { mock } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });

    expect(() => usdc.read.balanceOf(["0x1234"])).toThrow(InvalidAddressError);
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
    }).toThrow(`balanceOf(${getAddress(bob)}) on ${USDC}`);
  });

  test("checks args-less mocks too: an override that never answered is dead", async () => {
    const { mock, balanceOf } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.balanceOf().fails("network");
    usdc.read.allowance().reverts("paused");
    usdc.read.decimals().returns(6);

    await rejectionOf(balanceOf(alice));
    let error: unknown;
    try {
      mock.assertAllUsed();
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("2 mock(s) never answered a call");
    expect(String(error)).toContain(`allowance(*) on ${USDC}`);
    expect(String(error)).toContain(`decimals(*) on ${USDC}`);
  });

  test("checks a fallback shadowed by a more specific mock", async () => {
    const { mock, balanceOf } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.balanceOf().returns(1n);
    usdc.read.balanceOf([alice]).returns(2n);

    await balanceOf(alice);
    expect(() => {
      mock.assertAllUsed();
    }).toThrow(`balanceOf(*) on ${USDC}`);
  });

  test("doesn't check defaults: they're fallbacks", () => {
    const { mock } = setup();
    mock.contract({
      abi: erc20Abi,
      address: USDC,
      defaults: { read: { decimals: 6, balanceOf: 0n } },
    });

    expect(() => {
      mock.assertAllUsed();
    }).not.toThrow();
  });

  test("doesn't check a mock still waiting for its answer", () => {
    const { mock } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).read.balanceOf();

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
    }).toThrow(`balanceOf(${getAddress(alice)})`);
  });
});

/** `assertAllUsed()`'s message, or `""` if it passed. */
function unusedMessage(mock: ReturnType<typeof setup>["mock"]) {
  try {
    mock.assertAllUsed();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

describe("assertAllUsed(): what the function received instead", () => {
  test("each call the function received, with the first arg that didn't match", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC, name: "USDC" });
    usdc.read.allowance([alice, bob]).returns(1n);
    usdc.read.allowance().returns(0n);

    await client.readContract({
      abi: erc20Abi,
      address: USDC,
      functionName: "allowance",
      args: [alice, DAI],
    });
    expect(unusedMessage(mock)).toBe(
      [
        "1 mock(s) never answered a call:",
        `  - allowance(${getAddress(alice)}, ${getAddress(bob)}) on USDC (${USDC})`,
        "    received 1 call to allowance:",
        `      allowance(…, ${DAI})  ← spender didn't match`,
        "",
        "Requests so far:",
        "#1 eth_call USDC.allowance(0xa41f…2D9e, 0x6B17…1d0F) → 0n",
      ].join("\n"),
    );
  });

  test("or that it received none", () => {
    const { mock } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).read.balanceOf([alice]).returns(1n);

    expect(unusedMessage(mock)).toContain(
      `balanceOf(${getAddress(alice)}) on ${USDC}\n    received no calls to balanceOf`,
    );
  });

  test("a call that matched was answered by another mock", async () => {
    const { mock, balanceOf } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.balanceOf().returns(1n);
    usdc.read.balanceOf([alice]).returns(2n);

    await balanceOf(alice);
    expect(unusedMessage(mock)).toContain(
      `      balanceOf(${getAddress(alice)})  ← matches; another mock answered it`,
    );
  });

  test("shows the first 3 calls and counts the rest", async () => {
    const { mock, balanceOf } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.balanceOf([bob]).returns(1n);
    usdc.read.balanceOf().returns(0n);

    await Promise.all(Array.from({ length: 5 }, () => balanceOf(alice)));
    const message = unusedMessage(mock);
    expect(message).toContain("received 5 calls to balanceOf:");
    expect(message.match(/account didn't match/gu)).toHaveLength(3);
    expect(message).toContain("      …and 2 more");
  });

  test("unnamed inputs are numbered; other overloads' calls are left out", async () => {
    const { mock, client } = setup();
    // ERC-1155-style overloads, with an unnamed input.
    const abi = parseAbi([
      "function balanceOf(address, uint256 id) view returns (uint256)",
      "function balanceOf(address owner) view returns (uint256)",
    ]);
    const token = mock.contract({ abi, address: DAI });
    token.read.balanceOf([bob, 1n]).returns(1n);
    token.read.balanceOf([match.any(), match.any()]).returns(0n);
    token.read.balanceOf([match.any()]).returns(0n);

    await client.readContract({ abi, address: DAI, functionName: "balanceOf", args: [alice, 1n] });
    await client.readContract({ abi, address: DAI, functionName: "balanceOf", args: [alice] });
    const message = unusedMessage(mock);
    expect(message).toContain("received 1 call to balanceOf:");
    expect(message).toContain(`balanceOf(${getAddress(alice)}, …)  ← arg 1 didn't match`);
  });

  test("actions name the field; raw methods number the param", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: bob }).returns(1n);
    mock.actions.getBalance().returns(0n);
    mock.method("eth_getProof", [USDC, ["0x1"]]).returns({});
    mock.method("eth_getProof").returns({});

    await client.getBalance({ address: alice });
    await client.getProof({ address: USDC, storageKeys: ["0x2"] });
    const message = unusedMessage(mock);
    expect(message).toContain(
      `getBalance({ address: ${getAddress(bob)} })\n    received 1 call to getBalance:\n` +
        `      getBalance({ address: ${getAddress(alice)}, … })  ← address didn't match`,
    );
    expect(message).toContain("← address didn't match");
    expect(message).toContain("eth_getProof(…, [0x2], …)  ← param 2 didn't match");
  });
});

/** The first stack frame of what `check` throws. */
function topFrame(check: () => void) {
  try {
    check();
  } catch (error) {
    const stack = error instanceof Error ? (error.stack ?? "") : "";
    return stack.split("\n").find((line) => line.trim().startsWith("at ")) ?? "";
  }
  return "";
}

describe("failed checks' stacks", () => {
  test("start at the caller, not in the mock", async () => {
    const { mock, balanceOf } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).read.balanceOf([bob]).returns(1n);
    const baseline = mock.checkpoint();
    mock.contract({ abi: erc20Abi, address: DAI }).read.balanceOf([bob]).returns(1n);
    await rejectionOf(balanceOf(alice));

    expect(
      topFrame(() => {
        mock.assertAllUsed();
      }),
    ).toContain("assertions.test.ts");
    expect(
      topFrame(() => {
        mock.assertNoUnhandled();
      }),
    ).toContain("assertions.test.ts");
    expect(
      topFrame(() => {
        mock.checkpoint();
      }),
    ).toContain("assertions.test.ts");
    expect(
      topFrame(() => {
        baseline.restore({ assertAllUsed: true });
      }),
    ).toContain("assertions.test.ts");
  });
});
