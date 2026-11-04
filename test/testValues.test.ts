import {
  type Address,
  InvalidAddressError,
  createPublicClient,
  erc20Abi,
  getAddress,
  isAddress,
  isAddressEqual,
  isHash,
  keccak256,
  parseEventLogs,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vite-plus/test";

import {
  MockSetupError,
  contractEvents,
  createMockRpc,
  testAddress,
  testHash,
  testLog,
} from "../src/index.js";
import { expectThrows, lowercase } from "./utils.js";

describe("testAddress()", () => {
  test("is checksummed, and the same for a label in every run", () => {
    const alice = testAddress("alice");

    // Pinned: changing the derivation would change every user's addresses.
    expect(alice).toBe("0xa41f98f81FdB6dcd9a7911C2C17Ef18804Ce2D9e");
    expect(isAddress(alice, { strict: true })).toBe(true);
    expect(alice).toBe(getAddress(alice));
    expect(testAddress("alice")).toBe(alice);
  });

  test("is distinct per label", () => {
    const users = Array.from({ length: 50 }, (_, i) => testAddress(`user-${i + 1}`));
    expect(new Set(users).size).toBe(50);
    expect(testAddress("Alice")).not.toBe(testAddress("alice"));
  });

  test("is the address of an account whose key derives from the label", () => {
    const account = privateKeyToAccount(keccak256(toHex("test-account:alice")));
    expect(account.address).toBe(testAddress("alice"));
    // The key isn't the label's testHash().
    expect(keccak256(toHex("test-account:alice"))).not.toBe(testHash("alice"));
  });
});

describe("testHash()", () => {
  test("is the label's keccak256: 32 bytes, the same in every run", () => {
    expect(testHash("swap-1")).toBe(
      "0x8a85960603c54036ffd97be643ef730d11ab409cd465adf4e30e06fcd087097a",
    );
    expect(testHash("swap-1")).toBe(keccak256(toHex("swap-1")));
    expect(isHash(testHash("swap-1"))).toBe(true);
    expect(testHash("swap-2")).not.toBe(testHash("swap-1"));
  });
});

describe("testLog()", () => {
  test("is a log matching no event, the same for a label in every run", () => {
    expect(testLog("noise")).toEqual({
      address: testAddress("noise"),
      topics: [testHash("Unknown(noise)")],
      data: "0x",
    });
    expect(testLog("noise")).toEqual(testLog("noise"));
    expect(testLog("noise")).not.toEqual(testLog("other"));
  });

  test("goes into a receipt beside real events, which decode without it", async () => {
    const mock = createMockRpc();
    const client = createPublicClient({ chain: mock.chain, transport: mock.transport() });
    const hash = testHash("mixed");
    const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    const transfer = contractEvents({ abi: erc20Abi, address: USDC }).Transfer({
      from: testAddress("alice"),
      to: testAddress("bob"),
    });
    // An unknown event at a contract the code does know.
    const unknownAtUsdc = testLog("noise-at-usdc", { address: USDC });
    mock.actions
      .getTransactionReceipt({ hash })
      .returns({ logs: [testLog("noise"), transfer, unknownAtUsdc] });

    const { logs } = await client.getTransactionReceipt({ hash });
    expect(logs).toHaveLength(3);
    expect(isAddressEqual(logs[2]!.address, USDC)).toBe(true);
    expect(parseEventLogs({ abi: erc20Abi, logs }).map((log) => log.logIndex)).toEqual([1]);
  });

  test("takes any valid address, checksummed; the label still picks the topic", () => {
    const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

    expect(testLog("noise", { address: usdc })).toEqual({
      ...testLog("noise"),
      address: getAddress(usdc),
    });
    expect(() => testLog("noise", { address: "0x1234" })).toThrow(InvalidAddressError);
  });

  test("emits at any address, like any log, but not one marked empty()", () => {
    const mock = createMockRpc();
    const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    mock.contract({ abi: erc20Abi, address: USDC });
    mock.empty(testAddress("empty"));

    expect(mock.emit(testLog("noise", { address: USDC })).topics).toEqual([
      testHash("Unknown(noise)"),
    ]);
    expect(mock.emit(testLog("noise")).address).toBe(lowercase(testAddress("noise")));
    expectThrows(MockSetupError, "is marked empty()", () => mock.emit(testLog("empty")));
  });
});
