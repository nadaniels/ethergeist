import type { Abi, AbiFunction, Address } from "viem";

import { type EmitOptions, contractEvents, encodeEventLog } from "../logs/events.js";
import { withCalls } from "../mocking/handlers.js";
import { MockSetupError } from "../shared/errors.js";
import type { AddTransactionParameters } from "../transactions/addTransaction.js";
import type { MockCall, MockContract, MockNamespace, MockTaggedCall } from "./types.js";

/** Puts a transaction on the rpc's chain: its `addTransaction`. */
export type AddTransaction = (fields: AddTransactionParameters) => { logs: readonly unknown[] };

/** `contract.emit`'s options, its placement. */
const emitOptionNames = new Set(["blockNumber", "transactionHash"]);

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
  addTransaction,
  assertAttached,
}: {
  abi: abi;
  address: Address;
  name: string | undefined;
  functions: {
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
  /** Puts a transaction on the rpc's chain. */
  addTransaction: AddTransaction;
  /** Throws if the contract was removed. */
  assertAttached: () => void;
}): MockContract<abi> {
  // Overloads share one entry, as in viem's `getContract`.
  function buildNamespace(namespace: MockNamespace) {
    const entries: Record<string, unknown> = {};
    for (const { name: functionName } of functionsIn[namespace]) {
      if (functionName in entries) continue;
      entries[functionName] = withCalls(
        (args?: readonly unknown[], pins?: unknown) =>
          register(namespace, functionName, args, pins),
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
    write: buildNamespace("write"),
    events: contractEvents({ abi, address }),
    emit: Object.fromEntries(
      events.map((eventName) => [
        eventName,
        (args?: unknown, options: EmitOptions = {}) => {
          assertAttached();
          const log = encodeEventLog(abi, address, eventName, args);
          const unknown = Object.keys(options).find((key) => !emitOptionNames.has(key));
          if (unknown !== undefined)
            throw new MockSetupError(`contract.emit has no option ${unknown}.`, {
              metaMessages: [
                "Its options are blockNumber and transactionHash; without blockNumber, it mines a new block.",
              ],
            });
          const { blockNumber, transactionHash: hash } = options;
          return addTransaction({
            logs: [log],
            ...(blockNumber !== undefined && { blockNumber }),
            ...(hash !== undefined && { hash }),
          }).logs[0];
        },
      ]),
    ),
  } as unknown as MockContract<abi>;
}
