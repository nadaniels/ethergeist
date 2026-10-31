import { type Address, type Hex, getAddress } from "viem";
import type { PartCheckpoint } from "../shared/parts.js";
import type { InternalMockContract } from "../contract.js";

/** What's registered at addresses: see `createRegistry`. */
export type Registry = ReturnType<typeof createRegistry>;

/**
 * The addresses the mock knows: registered contracts, and addresses marked
 * empty (no code). Each address takes one registration. Lookups take
 * checksummed addresses.
 */
export function createRegistry({ multicallAddress }: { multicallAddress: Address }) {
  const contracts: InternalMockContract<any>[] = [];
  const emptyAddresses = new Set<Address>();

  const contractAt = (address: Address) => contracts.find((c) => c.matches(address));

  /** Code at an address the mock knows without a mock: placeholder code for contracts, none for empty. */
  function codeAt(address: Address): Hex | undefined {
    if (address === multicallAddress || contractAt(address)) return "0xfe";
    if (emptyAddresses.has(address)) return "0x";
    return undefined;
  }

  return {
    /** Every registered contract, in registration order. */
    contracts: contracts as readonly InternalMockContract<any>[],
    /** The contract registered at `address`, if any. */
    contractAt,
    isContract: (address: Address) => contractAt(address) !== undefined,
    isEmpty: (address: Address) => emptyAddresses.has(address),
    codeAt,
    /** Throws if `address` (any casing) is already registered, as a contract or empty. */
    assertUnregistered(address: Address) {
      const checksummed = getAddress(address);
      const existing = contractAt(checksummed);
      if (existing)
        throw new Error(
          `A contract is already registered at ${existing.label}. ` +
            "Register it once with a " +
            "combined ABI (abi: [...a, ...b]). If an earlier test registered it, restore " +
            "a checkpoint after each test, or call reset().",
        );
      if (emptyAddresses.has(checksummed))
        throw new Error(
          `${checksummed} is already registered as empty. If an earlier test registered it, ` +
            "restore a checkpoint after each test, or call reset().",
        );
    },
    add(contract: InternalMockContract<any>) {
      contracts.push(contract);
    },
    /** Marks `address` as having no code; it must be checksummed. */
    markEmpty(address: Address) {
      emptyAddresses.add(address);
    },
    clearCalls() {
      for (const contract of contracts) contract.clearCalls();
    },
    unusedMocks: () => contracts.flatMap((contract) => contract.unusedMocks()),
    /**
     * Saves the contracts, their mocks, and the empty addresses. `restore()`
     * removes contracts registered since, which then throw if used.
     */
    checkpoint(): Required<PartCheckpoint> {
      const count = contracts.length;
      const saved = contracts.map((contract) => contract.checkpoint());
      const savedEmpty = new Set(emptyAddresses);
      return {
        restore() {
          for (const contract of contracts.slice(count)) contract.detach();
          contracts.length = count;
          for (const each of saved) each.restore();
          emptyAddresses.clear();
          for (const address of savedEmpty) emptyAddresses.add(address);
        },
        /** Mocks registered since that never answered, except defaults. */
        unusedSince: () => [
          ...saved.flatMap((each) => each.unusedSince()),
          ...contracts.slice(count).flatMap((contract) => contract.unusedMocks()),
        ],
      };
    },
  };
}
