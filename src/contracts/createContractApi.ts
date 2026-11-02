import type { Abi, AbiFunction, Address } from "viem";

import {
  type EmitOptions,
  type MockEventLog,
  contractEvents,
  encodeEventLog,
} from "../logs/events.js";
import { withCalls } from "../mocking/handlers.js";
import type { Namespace } from "./functions.js";
import type { MockCall, MockContract } from "./types.js";

/**
 * A contract's public API, the `MockContract` mocks are registered on: its
 * namespaces, built from the ABI, each function sending its mocks to
 * `register`, and its events.
 */
export function createContractApi<const abi extends Abi>({
  abi,
  address,
  name,
  functions: { functionsIn, notInNamespaceError },
  register,
  calls,
  callsTo,
  emit,
  assertAttached,
}: {
  abi: abi;
  address: Address;
  name: string | undefined;
  functions: {
    functionsIn: Record<Namespace, readonly AbiFunction[]>;
    notInNamespaceError: (namespace: Namespace, functionName: string) => Error;
  };
  register: (namespace: Namespace, functionName: string, args?: readonly unknown[]) => unknown;
  /** The contract's `eth_call`s, as they arrive. */
  calls: () => readonly MockCall[];
  /** The calls a namespace's function received, every overload's. */
  callsTo: (namespace: Namespace, functionName: string) => MockCall[];
  /** Places a transaction's logs in the rpc's log store. */
  emit: (logs: readonly MockEventLog[], options?: EmitOptions) => readonly unknown[];
  /** Throws if the contract was removed. */
  assertAttached: () => void;
}): MockContract<abi> {
  // Overloads share one entry, as in viem's `getContract`.
  function buildNamespace(namespace: Namespace) {
    const entries: Record<string, unknown> = {};
    for (const { name: functionName } of functionsIn[namespace]) {
      if (functionName in entries) continue;
      entries[functionName] = withCalls(
        (args?: readonly unknown[]) => register(namespace, functionName, args),
        () => callsTo(namespace, functionName),
      );
    }
    // Untyped callers reaching for the other namespace's functions get a pointer
    // to the right one instead of "is not a function". Hidden from Object.keys.
    for (const { name: functionName } of functionsIn[namespace === "read" ? "simulate" : "read"]) {
      if (functionName in entries) continue;
      Object.defineProperty(entries, functionName, {
        value: () => {
          throw notInNamespaceError(namespace, functionName);
        },
      });
    }
    return entries;
  }

  const events = (abi as Abi).flatMap((item) => (item.type === "event" ? [item.name] : []));

  // Built from the ABI at runtime; `MockContract<abi>` describes the same shape.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime-built typed facade
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
    events: contractEvents({ abi, address }),
    emit: Object.fromEntries(
      events.map((eventName) => [
        eventName,
        (args?: unknown, options?: EmitOptions) => {
          assertAttached();
          return emit([encodeEventLog(abi, address, eventName, args)], options)[0];
        },
      ]),
    ),
  } as unknown as MockContract<abi>;
}
