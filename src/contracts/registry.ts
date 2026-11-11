import { type Address, type Hex, getAddress } from "viem";

import { MockSetupError } from "../shared/errors.js";
import type { PartSnapshot } from "../shared/parts.js";
import type { InternalMockContract } from "./createMockContract.js";

/** What's registered at addresses: see `createRegistry`. */
export type Registry = ReturnType<typeof createRegistry>;

/** The hint for a contract registered twice. */
const earlierTest =
  "If an earlier test registered it, restore a checkpoint after each test, or call reset().";

/**
 * The addresses the mock knows: registered contracts, and addresses marked
 * empty (no code). Each address takes one registration. Lookups take
 * checksummed addresses.
 */
export function createRegistry({ multicallAddress }: { multicallAddress: Address | undefined }) {
  const contracts: InternalMockContract<any>[] = [];
  const emptyAddresses = new Set<Address>();
  /** Contracts the last `restore()` or `reset()` removed, for hints. */
  let removed = new Set<Address>();

  const contractAt = (address: Address) => contracts.find((contract) => contract.matches(address));

  /**
   * The code at `address` without a mock: placeholder code (`0xfe`) for a
   * registered contract or Multicall3, `0x` for an address marked empty, and
   * `undefined` for one the mock doesn't know.
   */
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
    isEmpty: (address: Address) => emptyAddresses.has(address),
    codeAt,
    /**
     * Throws if `address` (any casing) is already registered, as a contract
     * or empty.
     */
    assertUnregistered(address: Address) {
      const checksummed = getAddress(address);
      const existing = contractAt(checksummed);
      if (existing)
        throw new MockSetupError(`A contract is already registered at ${existing.label}.`, {
          metaMessages: ["Register it once with a combined ABI (abi: [...a, ...b]).", earlierTest],
        });
      if (emptyAddresses.has(checksummed))
        throw new MockSetupError(`${checksummed} is already registered as empty.`, {
          metaMessages: [earlierTest],
        });
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
     * Whether the last `restore()` or `reset()` removed a contract at
     * `address`, checksummed, and none is registered there since.
     */
    removedByLastRestore: (address: Address) =>
      removed.has(address) && contractAt(address) === undefined,
    /**
     * Saves the contracts, their mocks, and the empty addresses. `restore()`
     * removes contracts registered since, which then throw if used.
     */
    snapshot(): Required<PartSnapshot> {
      const count = contracts.length;
      const saved = contracts.map((contract) => contract.snapshot());
      const savedEmpty = new Set(emptyAddresses);
      return {
        restore() {
          removed = new Set(contracts.slice(count).map(({ contract }) => contract.address));
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
