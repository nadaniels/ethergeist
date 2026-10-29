import { type Address, type Hash, keccak256, toHex } from "viem";
import { privateKeyToAddress } from "viem/accounts";

// Deriving an address from a private key is slow-ish; labels repeat a lot.
const addresses = new Map<string, Address>();

/**
 * A stable, realistic-looking address for `label`: checksummed, the same in
 * every run, and distinct per label. Unlike random addresses, messages and
 * snapshots stay the same between runs; unlike `0x…0001`, it catches code
 * that compares addresses by case or sorts them. For several, number the
 * labels: `testAddress(\`user-${i}\`)`.
 *
 * It's the address of an account whose private key derives from the label,
 * so the same label can sign later.
 */
export function testAddress(label: string): Address {
  let address = addresses.get(label);
  if (address === undefined) {
    // Prefixed, so an address's key never equals `testHash()` of its label.
    address = privateKeyToAddress(keccak256(toHex(`test-account:${label}`)));
    addresses.set(label, address);
  }
  return address;
}

/** A stable 32-byte hash for `label` (a transaction or block hash): `keccak256` of the label. */
export function testHash(label: string): Hash {
  return keccak256(toHex(label));
}
