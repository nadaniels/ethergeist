import { getAddress, isAddress, isHash, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vite-plus/test";
import { testAddress, testHash } from "../src/index.js";

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
