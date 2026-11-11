import {
  type Address,
  InvalidAddressError,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  getAddress,
  parseAbi,
} from "viem";
import { mainnet } from "viem/chains";
import { describe, expect, test } from "vite-plus/test";

import {
  MockCheckError,
  MockNotFoundError,
  type MockRpc,
  MockResolverError,
  MockSetupError,
  createMockRpc,
  match,
  testAddress,
} from "../src/index.js";
import { expectCause, expectThrows, lowercase, rejectionOf } from "./utils.js";

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

/** The app's wallet client, for a node's account. */
const walletFor = (mock: MockRpc, account: Address) =>
  createWalletClient({ account, chain: mock.chain, transport: mock.transport({ retryCount: 0 }) });

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

    expectThrows(MockCheckError, /couldn't answer 1 request.*No mock for balanceOf/su, () => {
      mock.assertNoUnhandled();
    });
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

    expectThrows(MockCheckError, `No mock for symbol() on ${USDC}`, () => {
      mock.assertNoUnhandled();
    });
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
    expectThrows(MockCheckError, "fixture bug", () => {
      mock.assertNoUnhandled();
    });
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

/** `assertNoUnhandled()`'s list: its short message, without the recent requests. */
function unhandledList(mock: ReturnType<typeof setup>["mock"]): string {
  try {
    mock.assertNoUnhandled();
  } catch (error) {
    if (error instanceof MockCheckError) return error.shortMessage;
    throw error;
  }
  return expect.unreachable("expected assertNoUnhandled() to throw");
}

describe("assertNoUnhandled(): what each miss shows", () => {
  const vaultAbi = parseAbi(["function previewRedeem(uint256 shares) view returns (uint256)"]);

  test("a contract near-miss lists what was registered, each with the arg it missed on", async () => {
    const { mock, client } = setup();
    const vault = mock.contract({ abi: vaultAbi, address: DAI, name: "Vault" });
    vault.read.previewRedeem([2n * 10n ** 18n]).returns(1n);
    vault.read.previewRedeem([5n]).returns(1n);

    await rejectionOf(
      client.readContract({
        abi: vaultAbi,
        address: DAI,
        functionName: "previewRedeem",
        args: [3_900_000n],
      }),
    );
    expect(unhandledList(mock)).toBe(
      "The mock couldn't answer 1 request(s):\n" +
        `  - No mock for previewRedeem(3900000n) on Vault (${DAI}).\n` +
        "      Registered:\n" +
        "        previewRedeem(2000000000000000000n)  ← shares didn't match\n" +
        "        previewRedeem(5n)  ← shares didn't match",
    );
  });

  test("an action near-miss, and a repeated miss listed once with its count", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: bob }).returns(1n);

    await rejectionOf(client.getBalance({ address: alice }));
    await rejectionOf(client.getBalance({ address: alice }));
    expect(unhandledList(mock)).toBe(
      "The mock couldn't answer 2 request(s):\n" +
        `  - No mock for getBalance({ address: ${alice}, blockNumber: 1n, blockTag: latest }) (×2).\n` +
        "      Registered:\n" +
        `        getBalance({ address: ${getAddress(bob)} })  ← address didn't match`,
    );
  });

  test("misses group only when their hints match too, in the order first seen", async () => {
    const { mock, client, balanceOf } = setup();
    mock.actions.getBalance({ address: bob }).returns(1n);

    await rejectionOf(client.getBalance({ address: alice }));
    await rejectionOf(balanceOf(alice));
    mock.actions.getBalance({ address: DAI }).returns(1n);
    await rejectionOf(client.getBalance({ address: alice }));
    await rejectionOf(balanceOf(alice));
    const miss = `  - No mock for getBalance({ address: ${alice}, blockNumber: 1n, blockTag: latest }).`;
    expect(unhandledList(mock)).toBe(
      "The mock couldn't answer 4 request(s):\n" +
        `${miss}\n` +
        "      Registered:\n" +
        `        getBalance({ address: ${getAddress(bob)} })  ← address didn't match\n` +
        `  - No mocked contract at ${USDC} (×2).\n` +
        `      Call data: 0x70a08231000000000000000000000000${alice.slice(2).toLowerCase()}\n` +
        "      Register it with contract(), or mark it empty() for an address without code.\n" +
        `${miss}\n` +
        "      Registered:\n" +
        `        getBalance({ address: ${getAddress(bob)} })  ← address didn't match\n` +
        `        getBalance({ address: ${DAI} })  ← address didn't match`,
    );
  });

  test("a raw method says how to mock it", async () => {
    const { mock } = setup();

    await rejectionOf(mock.request({ method: "eth_getProof", params: [alice, [], "latest"] }));
    expect(unhandledList(mock)).toBe(
      "The mock couldn't answer 1 request(s):\n" +
        '  - RPC method "eth_getProof" is not mocked.\n' +
        '      Mock it with mock.method("eth_getProof", …).returns(…).',
    );
  });

  test("a long list of what was registered shows the first 3 and counts the rest", async () => {
    const { mock, balanceOf } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    for (const name of ["a", "b", "c", "d", "e"])
      usdc.read.balanceOf([testAddress(name)]).returns(1n);

    await rejectionOf(balanceOf(alice));
    const registered = ["a", "b", "c"].map(
      (name) => `        balanceOf(${getAddress(testAddress(name))})  ← account didn't match\n`,
    );
    expect(unhandledList(mock)).toBe(
      "The mock couldn't answer 1 request(s):\n" +
        `  - No mock for balanceOf(${alice}) on ${USDC}.\n` +
        "      Registered:\n" +
        registered.join("") +
        "        … 2 more",
    );
  });

  test("misses that differ only past the cut are listed once: they read the same", async () => {
    const { mock, balanceOf } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    for (const name of ["a", "b", "c"]) usdc.read.balanceOf([testAddress(name)]).returns(1n);
    usdc.read
      .balanceOf([testAddress("d")])
      .once()
      .returns(1n);

    // The 4th mock's line changes once it's used up, past the 3 shown.
    await rejectionOf(balanceOf(alice));
    await balanceOf(testAddress("d"));
    await rejectionOf(balanceOf(alice));
    expect(unhandledList(mock)).toContain(`  - No mock for balanceOf(${alice}) on ${USDC} (×2).\n`);
  });

  test("an estimate's lists are cut each on its own; a list of 3 isn't cut", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    for (const name of ["a", "b", "c"])
      usdc.estimateGas.transfer([testAddress(name), 1n]).returns(1n);
    for (const name of ["a", "b", "c", "d"]) usdc.write.transfer([testAddress(name), 1n]);

    await rejectionOf(
      client.estimateContractGas({
        abi: erc20Abi,
        address: USDC,
        functionName: "transfer",
        args: [alice, 1n],
        account: bob,
      }),
    );
    const list = unhandledList(mock);
    expect(list).toContain("      Registered:\n");
    expect(list).toContain("      Write mocks, which imply the estimate of a send they match:\n");
    expect(list.match(/recipient didn't match/gu)).toHaveLength(6);
    expect(list.match(/… \d+ more/gu)).toEqual(["… 1 more"]);
    expect(list.endsWith("        … 1 more")).toBe(true);
  });

  test("a resolver's cause's hints show whole: only the mock's own lists are cut", async () => {
    const { mock, client, balanceOf } = setup();
    mock
      .contract({ abi: erc20Abi, address: USDC })
      .read.balanceOf()
      .returns(async () => {
        // A resolver that reads another, unmocked contract: viem's error lists the call.
        await client.call({ account: alice, to: DAI, data: "0x313ce567", value: 1n, gas: 1000n });
        return 1n;
      });

    await rejectionOf(balanceOf(alice));
    const list = unhandledList(mock);
    expect(list).toContain('  - Mock resolver for "balanceOf" threw:');
    expect(list).toMatch(/^ {8}data: +0x313ce567$/mu);
    expect(list).toMatch(/^ {8}gas: +1000$/mu);
    expect(list).not.toContain("more");
  });

  test("a grouped miss without a closing period gets its count at the end", async () => {
    const { mock, balanceOf } = setup();
    mock
      .contract({ abi: erc20Abi, address: USDC })
      .read.balanceOf()
      .returns(() => {
        throw new Error("fixture bug");
      });

    await rejectionOf(balanceOf(alice));
    await rejectionOf(balanceOf(alice));
    expect(unhandledList(mock)).toBe(
      "The mock couldn't answer 2 request(s):\n" +
        '  - Mock resolver for "balanceOf" threw: fixture bug (×2)',
    );
  });

  test("a miss without hints is its line alone", async () => {
    const { mock, balanceOf } = setup();
    mock
      .contract({ abi: erc20Abi, address: USDC })
      .read.balanceOf()
      .returns(() => {
        throw new Error("fixture bug");
      });

    await rejectionOf(balanceOf(alice));
    expect(unhandledList(mock)).toBe(
      "The mock couldn't answer 1 request(s):\n" +
        '  - Mock resolver for "balanceOf" threw: fixture bug',
    );
  });
});

describe("unencodable returns", () => {
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
    expect(mock.history).toHaveLength(1);
    expectThrows(MockCheckError, "owner", () => {
      mock.assertNoUnhandled();
    });
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
    expectThrows(MockCheckError, `balanceOf(${getAddress(bob)}) on USDC (${USDC})`, () => {
      mock.assertAllUsed();
    });
    expectThrows(MockSetupError, `A contract is already registered at USDC (${USDC})`, () =>
      mock.contract({ abi: erc20Abi, address: USDC }),
    );
  });

  test("without a name, it's the address alone", () => {
    const { mock } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.balanceOf([bob]).returns(1n);

    expect(usdc.name).toBeUndefined();
    expectThrows(MockCheckError, `balanceOf(${getAddress(bob)}) on ${USDC}`, () => {
      mock.assertAllUsed();
    });
  });

  test("struct args are spelled out", () => {
    const { mock } = setup();
    mock
      .contract({ abi: bookAbi, address: DAI, name: "Book" })
      .read.filled([{ maker: alice, amount: 5n }])
      .returns(true);

    expectThrows(
      MockCheckError,
      `filled({ maker: ${getAddress(alice)}, amount: 5n }) on Book`,
      () => {
        mock.assertAllUsed();
      },
    );
  });
});

describe("address args", () => {
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

    expectThrows(MockCheckError, `allowance(${USDC}, ${getAddress(bob)})`, () => {
      mock.assertAllUsed();
    });
    expectThrows(MockCheckError, `balancesOf([${getAddress(alice)}, ${getAddress(bob)}])`, () => {
      mock.assertAllUsed();
    });
  });

  test("are checksummed inside a struct given as a tuple", () => {
    const { mock } = setup();
    // Unnamed fields, so the struct is a tuple, as viem types and decodes it.
    const quoteAbi = parseAbi(["function quote((address, uint256) leg) view returns (uint256)"]);
    mock
      .contract({ abi: quoteAbi, address: DAI })
      .read.quote([[lowercase(alice), 5n]])
      .returns(1n);

    expectThrows(MockCheckError, `quote([${getAddress(alice)}, 5n])`, () => {
      mock.assertAllUsed();
    });
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
    expectThrows(MockCheckError, `balanceOf(${getAddress(bob)}) on ${USDC}`, () => {
      mock.assertAllUsed();
    });
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
    expect(String(error)).toContain("2 mock(s) answered no call");
    expect(String(error)).toContain(`allowance(*) reverts on ${USDC}`);
    expect(String(error)).toContain(`decimals(*) on ${USDC}`);
  });

  test("checks a fallback shadowed by a more specific mock", async () => {
    const { mock, balanceOf } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.read.balanceOf().returns(1n);
    usdc.read.balanceOf([alice]).returns(2n);

    await balanceOf(alice);
    expectThrows(MockCheckError, `balanceOf(*) on ${USDC}`, () => {
      mock.assertAllUsed();
    });
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

  test("reports a mock registered without an answer, and how to give it one", () => {
    const { mock } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).read.balanceOf();

    const message = unusedMessage(mock);
    expect(message).toContain(
      `  - balanceOf(*) without an answer on ${USDC}\n` +
        "    give it one with .returns(), .reverts() or .fails(), or don't register it",
    );
    expect(message).not.toContain("received no calls");
  });

  test("reports an action mock registered without an answer, not the calls it matched", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: alice });
    await client.getBalance({ address: alice }).catch(() => {});

    const message = unusedMessage(mock);
    expect(message).toContain(
      `  - getBalance({ address: ${getAddress(alice)} }) without an answer\n` +
        "    give it one with .returns() or .fails(), or don't register it",
    );
    expect(message).not.toContain("another mock answered it");
  });

  test("an estimate or send mock without an answer can also be given .reverts() or .refuses()", () => {
    const { mock } = setup();
    mock.actions.estimateGas({ to: USDC });
    mock.actions.sendTransaction({ to: USDC });

    const message = unusedMessage(mock);
    expect(message).toContain(
      `  - estimateGas({ to: ${USDC} }) without an answer\n` +
        "    give it one with .returns(), .reverts(), .fails() or .refuses(), or don't register it",
    );
    expect(message).toContain(
      `  - sendTransaction({ to: ${USDC} }) without an answer\n` +
        "    give it one with .returns(), .reverts(), .fails() or .refuses(), or don't register it",
    );
  });

  test("a contract's simulate, estimateGas or write mock without an answer can also be given .refuses()", () => {
    const { mock } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    usdc.simulate.transfer();
    usdc.estimateGas.approve();
    usdc.write.transferFrom();

    const message = unusedMessage(mock);
    for (const functionName of ["transfer", "approve", "transferFrom"])
      expect(message).toContain(
        `  - ${functionName}(*) without an answer on ${USDC}\n` +
          "    give it one with .returns(), .reverts(), .fails() or .refuses(), or don't register it",
      );
  });

  test("says that an unused mock reverts or fails", () => {
    const { mock } = setup();
    mock.contract({ abi: erc20Abi, address: USDC }).write.transfer().once().reverts();
    mock.actions.getBalance().fails("timeout");

    const message = unusedMessage(mock);
    expect(message).toContain(`  - transfer(*) reverts once on ${USDC}\n`);
    expect(message).toContain("  - getBalance(*) fails\n");
  });

  test("a raw method mock without an answer can't be given .reverts()", () => {
    const { mock } = setup();
    mock.method("eth_getProof");

    expect(unusedMessage(mock)).toContain(
      "give it one with .returns() or .fails(), or don't register it",
    );
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
    expectThrows(MockCheckError, `balanceOf(${getAddress(alice)})`, () => {
      mock.assertAllUsed();
    });
  });

  test("clearCalls() resets action usage too", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: alice }).returns(1n);
    await client.getBalance({ address: alice });

    mock.clearCalls();
    expectThrows(MockCheckError, `getBalance({ address: ${getAddress(alice)} })`, () => {
      mock.assertAllUsed();
    });
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
        "1 mock(s) answered no call:",
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

  test("an args-less action mock matched a call another mock answered", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance().returns(1n);
    mock.actions.getBalance({ address: alice }).returns(2n);

    await client.getBalance({ address: alice });
    expect(unusedMessage(mock)).toContain(
      `      getBalance({ address: ${alice}, blockNumber: 1n, blockTag: latest })  ← matches; another mock answered it`,
    );
  });

  const contractsFunctionReason =
    /← matches; it's to a registered contract's function, which action mocks don't answer\n/gu;
  const transferArgs = {
    abi: erc20Abi,
    address: USDC,
    functionName: "transfer",
    args: [bob, 5n],
    account: alice,
  } as const;

  test("an action mock matched sends of a registered contract's function, missed and answered", async () => {
    const { mock } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    mock.actions.sendTransaction({ to: USDC }).returns({});
    mock.actions.sendTransaction({ to: DAI }).returns({});
    const wallet = walletFor(mock, alice);

    expectCause(await rejectionOf(wallet.writeContract(transferArgs)), MockNotFoundError);
    usdc.write.transfer().returns({});
    await wallet.writeContract(transferArgs);

    const message = unusedMessage(mock);
    expect(message).toContain(`  - sendTransaction({ to: ${USDC} })\n`);
    expect(message.match(contractsFunctionReason)).toHaveLength(2);
    expect(message.match(/← to didn't match\n/gu)).toHaveLength(2);
  });

  test("an action mock matched estimates of a registered contract's function, missed and implied by its write mock", async () => {
    const { mock, client } = setup();
    const usdc = mock.contract({ abi: erc20Abi, address: USDC });
    mock.actions.estimateGas().returns(80_000n);

    expectCause(await rejectionOf(client.estimateContractGas(transferArgs)), MockNotFoundError);
    usdc.write.transfer().returns({});
    expect(await client.estimateContractGas(transferArgs)).toBe(100_000n);

    const message = unusedMessage(mock);
    expect(message).toContain("  - estimateGas(*)\n    received 2 calls to estimateGas:\n");
    expect(message.match(contractsFunctionReason)).toHaveLength(2);
  });

  test("data sent to a registered contract that isn't one of its functions is the actions': another mock answered it", async () => {
    const { mock, client } = setup();
    mock.contract({ abi: erc20Abi, address: USDC });
    mock.actions.estimateGas().returns(50_000n);
    mock.actions.estimateGas({ to: USDC }).returns(60_000n);
    mock.actions.sendTransaction().returns({});
    mock.actions.sendTransaction({ to: USDC }).returns({});
    const notOnTheAbi = { account: alice, to: USDC, data: "0xdeadbeef" } as const;

    await client.estimateGas(notOnTheAbi);
    await walletFor(mock, alice).sendTransaction(notOnTheAbi);

    const message = unusedMessage(mock);
    expect(message).toContain("  - estimateGas(*)\n");
    expect(message).toContain("  - sendTransaction(*)\n");
    expect(message.match(/← matches; another mock answered it\n/gu)).toHaveLength(2);
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
    expect(message).toContain("      … 2 more");
  });

  test("unnamed inputs are numbered; other overloads' calls are left out", async () => {
    const { mock, client } = setup();
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
