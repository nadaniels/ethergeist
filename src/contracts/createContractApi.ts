import type { Abi, AbiFunction, Address } from "viem";

import { contractEvents, encodeEventLog } from "../logs/events.js";
import { withCalls } from "../mocking/handlers.js";
import { checkAmount, checkFields } from "../mocking/setupChecks.js";
import {
  type AddTransactionParameters,
  transactionHashHint,
} from "../transactions/addTransaction.js";
import type { MockCall, MockContract, MockNamespace, MockTaggedCall } from "./types.js";

/** Places a transaction: `mock.addTransaction()`. */
export type AddTransaction = (fields: AddTransactionParameters) => { logs: readonly unknown[] };

/** `contract.emit`'s options: `mock.addTransaction()`'s placement. */
const emitOptionNames = new Set(["blockNumber", "hash"]);
const emitOptionsHint =
  "Its options are blockNumber and hash; without blockNumber, it mines a new block.";

/**
 * A contract's public API, the `MockContract` mocks are registered on: its
 * namespaces, built from the ABI, each function sending its mocks to
 * `register`, and its events.
 */
export function createContractApi<const abi extends Abi>({
  abi,
  address,
  name,
  functions: { reads, writes, functionsIn, notInNamespaceError },
  register,
  calls,
  callsTo,
  addTransaction,
  assertAttached,
}: {
  abi: abi;
  address: Address;
  name: string | undefined;
  functions: {
    reads: readonly AbiFunction[];
    writes: readonly AbiFunction[];
    functionsIn: Record<MockNamespace, readonly AbiFunction[]>;
    notInNamespaceError: (namespace: MockNamespace, functionName: string) => Error;
  };
  register: (
    namespace: MockNamespace,
    functionName: string,
    args?: readonly unknown[],
    pins?: unknown,
  ) => unknown;
  /** The contract's calls in every namespace, tagged, as they arrive. */
  calls: () => readonly MockTaggedCall[];
  /** The calls a namespace's function received, every overload's. */
  callsTo: (namespace: MockNamespace, functionName: string) => MockCall[];
  /** Places a transaction: `mock.addTransaction()`. */
  addTransaction: AddTransaction;
  /** Throws if the contract was removed. */
  assertAttached: () => void;
}): MockContract<abi> {
  /**
   * A namespace's functions by name, each registering its mocks. Overloads
   * share one entry, as in viem's `getContract()`.
   */
  function buildNamespace(namespace: MockNamespace) {
    const entries: Record<string, unknown> = {};
    // `Object.hasOwn`, not `in`: an ABI function named `toString` or
    // `valueOf` would otherwise find `Object.prototype`'s and get no entry.
    for (const { name: functionName } of functionsIn[namespace]) {
      if (Object.hasOwn(entries, functionName)) continue;
      entries[functionName] = withCalls(
        (args?: readonly unknown[], pins?: unknown) =>
          register(namespace, functionName, args, pins),
        () => callsTo(namespace, functionName),
      );
    }
    // An untyped caller reaching for the other namespace's functions gets a
    // pointer to the right one, not "is not a function". Hidden from
    // `Object.keys`.
    for (const { name: functionName } of namespace === "read" ? writes : reads) {
      if (Object.hasOwn(entries, functionName)) continue;
      Object.defineProperty(entries, functionName, {
        value: () => {
          throw notInNamespaceError(namespace, functionName);
        },
      });
    }
    return entries;
  }

  const events = (abi as Abi).flatMap((item) => (item.type === "event" ? [item.name] : []));

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- built from the ABI at runtime, in the shape MockContract<abi> describes
  return {
    address,
    name,
    abi,
    get calls() {
      return [...calls()];
    },
    read: buildNamespace("read"),
    simulate: buildNamespace("simulate"),
    estimateGas: buildNamespace("estimateGas"),
    write: buildNamespace("write"),
    events: contractEvents({ abi, address }),
    emit: Object.fromEntries(
      events.map((eventName) => [
        eventName,
        (args?: unknown, options: unknown = {}) => {
          assertAttached();
          const log = encodeEventLog(abi, address, eventName, args);
          const checked = checkFields(
            options,
            "contract.emit's options",
            emitOptionNames,
            (field) => (field === "transactionHash" ? transactionHashHint : emitOptionsHint),
          );
          if (checked.blockNumber !== undefined)
            checkAmount(checked.blockNumber, "contract.emit's blockNumber");
          return addTransaction({ ...checked, logs: [log] }).logs[0];
        },
      ]),
    ),
  } as unknown as MockContract<abi>;
}
