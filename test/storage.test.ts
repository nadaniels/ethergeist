import {
  type Hex,
  createPublicClient,
  erc20Abi,
  getAddress,
  keccak256,
  numberToHex,
  pad,
  slice,
  toHex,
  zeroHash,
} from "viem";
import { describe, expect, test } from "vite-plus/test";

import {
  MockNotFoundError,
  MockSetupError,
  createMockRpc,
  match,
  testAddress,
} from "../src/index.js";
import { expectCause, expectThrows, rejectionOf } from "./utils.js";

const proxy = testAddress("proxy");
const implementation = testAddress("implementation");
const one = pad("0x1", { size: 32 });

function setup() {
  const mock = createMockRpc({ blockNumber: 10n });
  const client = createPublicClient({
    chain: mock.chain,
    cacheTime: 0,
    transport: mock.transport({ retryCount: 0 }),
  });
  return { mock, client };
}

describe("getStorageAt", () => {
  test("answers a pinned slot, padded to 32 bytes as a node sends it", async () => {
    const { mock, client } = setup();
    mock.actions.getStorageAt({ address: proxy, slot: "0x0" }).returns("0x1");

    expect(await client.getStorageAt({ address: proxy, slot: "0x0" })).toBe(one);
    expect(mock.actions.getStorageAt.calls).toEqual([
      { address: proxy, slot: zeroHash, blockNumber: 10n, blockTag: "latest" },
    ]);
  });

  test("slots match as 32 bytes, however pins and requests write them", async () => {
    const { mock, client } = setup();
    mock.actions.getStorageAt({ address: proxy, slot: "0x0" }).returns("0x1");
    mock.actions.getStorageAt({ address: proxy, slot: one }).returns("0x2");

    expect(await client.getStorageAt({ address: proxy, slot: zeroHash })).toBe(one);
    expect(await client.getStorageAt({ address: proxy, slot: "0x1" })).toBe(
      pad("0x2", { size: 32 }),
    );
    expect(mock.actions.getStorageAt.calls.map((call) => call.slot)).toEqual([zeroHash, one]);
  });

  test("a request's slot matches in any case; a malformed pinned slot throws at registration", async () => {
    const { mock, client } = setup();
    mock.actions.getStorageAt({ address: proxy, slot: "0xab" }).returns("0x1");

    expect(await client.getStorageAt({ address: proxy, slot: "0xAB" })).toBe(one);
    expectThrows(MockSetupError, "A storage slot must be hex of up to 32 bytes", () =>
      mock.actions.getStorageAt({ slot: "0xzz" }),
    );
  });

  test("slot pins take matchers, which see the slot as 32 bytes", async () => {
    const { mock, client } = setup();
    mock.actions
      .getStorageAt({ slot: match.where((slot: Hex) => slot.endsWith("ff")) })
      .returns("0x1");
    mock.actions.getStorageAt({ address: proxy, slot: match.any() }).returns("0x2");

    expect(await client.getStorageAt({ address: testAddress("other"), slot: "0xff" })).toBe(one);
    expect(await client.getStorageAt({ address: proxy, slot: "0x5" })).toBe(
      pad("0x2", { size: 32 }),
    );
  });

  test("keeps the block tag, like the other actions at a block", async () => {
    const { mock, client } = setup();
    mock.actions.getStorageAt({ address: proxy }).returns("0x1");
    mock.actions.getStorageAt({ address: proxy, blockTag: "pending" }).returns("0x2");

    expect(await client.getStorageAt({ address: proxy, slot: "0x0" })).toBe(one);
    expect(await client.getStorageAt({ address: proxy, slot: "0x0", blockTag: "pending" })).toBe(
      pad("0x2", { size: 32 }),
    );
  });

  test("a proxy's EIP-1967 implementation slot", async () => {
    const { mock, client } = setup();
    const slot = numberToHex(BigInt(keccak256(toHex("eip1967.proxy.implementation"))) - 1n);
    mock.actions.getStorageAt({ address: proxy, slot }).returns(implementation);

    const value = await client.getStorageAt({ address: proxy, slot });

    expect(getAddress(slice(value!, 12))).toBe(implementation);
  });

  test("unmocked, an empty() address's storage is zero; other addresses aren't answered", async () => {
    const { mock, client } = setup();
    mock.empty(testAddress("empty"));
    const token = mock.contract({ abi: erc20Abi, address: testAddress("token") });

    expect(await client.getStorageAt({ address: testAddress("empty"), slot: "0x0" })).toBe(
      zeroHash,
    );
    for (const address of [token.address, testAddress("unknown")])
      expectCause(
        await rejectionOf(client.getStorageAt({ address, slot: "0x0" })),
        MockNotFoundError,
      );
    expect(mock.unhandled).toHaveLength(2);
    expect(mock.unhandled[0]!.error.message).toContain(
      "mock.actions.getStorageAt({ address, slot }).returns(…), or mock.empty(address)",
    );
  });

  test("slots and values are hex of up to 32 bytes; .returns() is zero", async () => {
    const { mock, client } = setup();

    const tooLong = `0x${"11".repeat(33)}` as const;
    expectThrows(
      MockSetupError,
      `A storage value must be hex of up to 32 bytes; got 33 bytes: ${tooLong}.`,
      () => {
        mock.actions.getStorageAt().returns(tooLong);
      },
    );
    expectThrows(MockSetupError, "A storage value must be hex of up to 32 bytes; got 1n.", () => {
      // @ts-expect-error storage is hex
      mock.actions.getStorageAt().returns(1n);
    });
    expectThrows(
      MockSetupError,
      `A storage slot must be hex of up to 32 bytes; got 33 bytes: ${tooLong}.`,
      () => mock.actions.getStorageAt({ slot: tooLong }),
    );
    // No pins: it answers every address and slot, with zero.
    mock.actions.getStorageAt().returns();
    expect(await client.getStorageAt({ address: proxy, slot: "0x0" })).toBe(zeroHash);
  });

  test("history shows it; method() refuses it", async () => {
    const { mock, client } = setup();
    mock.actions.getStorageAt().returns("0x1");

    await client.getStorageAt({ address: proxy, slot: "0x0" });

    expect(mock.formatHistory()).toBe(
      "#1 eth_getStorageAt getStorageAt({ address: 0x7D28…F91D, slot: 0x0000…0000, blockNumber: 10n, blockTag: latest }) → 0x0000…0001",
    );
    expectThrows(
      MockSetupError,
      '"eth_getStorageAt" has a typed mock: use mock.actions.getStorageAt().',
      () => mock.method("eth_getStorageAt"),
    );
  });
});
