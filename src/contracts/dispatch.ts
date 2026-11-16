import { type Address, type Hex, getAddress, isAddress } from "viem";

import { transactionParam } from "../chain/params.js";
import type { ChainState } from "../chain/state.js";
import { errorOutcome } from "../mocking/outcomes.js";
import { MockNotFoundError, removedContractLines } from "../shared/errors.js";
import { isNonArrayObject } from "../shared/values.js";
import { answerAggregate3, decodeAggregate3, unsupportedMulticallError } from "./multicall.js";
import type { Registry } from "./registry.js";
import type { CallAsked, CallContext, CallReading, MockCallRecord, Reporter } from "./types.js";

/** `eth_call` routing: see `createDispatch`. */
export type Dispatcher = ReturnType<typeof createDispatch>;

type EthCallReading = { asked: CallAsked; answer: (report: Reporter) => Promise<Hex> };

/**
 * `eth_call` requests, answered by the contract registered at their address,
 * by Multicall3 (each sub-call answered in turn), or by an address marked
 * empty, which answers with no data, as a node does.
 */
export function createDispatch({ state, registry }: { state: ChainState; registry: Registry }) {
  /** Multicall batch ids, which count up across requests. */
  let batchCount = 0;

  /**
   * `target` is checksummed, as the lookups compare it: a request's by
   * `transactionParam`, a sub-call's by viem's decoding.
   */
  function callTo(target: Address, data: Hex, context: CallContext): CallReading {
    // Only a sub-call gets here with Multicall3's address: a request's own
    // call to it is read as a batch.
    if (target === state.multicallAddress)
      return unmockedCall(target, context, () => unsupportedMulticallError(target, data));
    const contract = registry.contractAt(target);
    if (contract) return contract.callOf(data, context);
    if (registry.isEmpty(target))
      return {
        record: addressRecord(target),
        answer(report) {
          report({ type: "result", value: "0x" }, context.batch?.index);
          return Promise.resolve("0x");
        },
      };
    return unmockedCall(
      target,
      context,
      () =>
        new MockNotFoundError(`No mocked contract at ${target}.`, {
          metaMessages: [
            `Call data: ${data}`,
            "Register it with contract(), or mark it empty() for an address without code.",
            ...(registry.removedByLastRestore(target) ? removedContractLines : []),
          ],
        }),
    );
  }

  /** Throws for any call but `aggregate3`, before it takes a batch id. */
  function readBatch(address: Address, data: Hex, context: CallContext): EthCallReading {
    const decoded = decodeAggregate3(address, data);
    const batchId = ++batchCount;
    const subCalls = decoded.map(({ target, allowFailure, callData }, index) => {
      const { record, answer } = callTo(target, callData, {
        ...context,
        from: address,
        value: 0n,
        batch: { id: batchId, index, from: context.from },
      });
      return { allowFailure, record, answer };
    });
    return {
      asked: { type: "multicall", batchId, calls: subCalls.map(({ record }) => record) },
      answer: (report) => answerAggregate3(subCalls, report),
    };
  }

  return {
    /**
     * Never throws: the answer refuses params that don't decode, and what it
     * asks still says where it's to and whether it's a batch.
     */
    read(params: unknown): EthCallReading {
      const list: readonly unknown[] = Array.isArray(params) ? params : [];
      const [given, block] = list;
      // Read before the params are checked, so a refused call still says
      // where it was to. Once they're checked, it's the same address.
      const to = toOf(given);
      const isBatch = to !== undefined && to === state.multicallAddress;
      try {
        const { to: target, from, value, data } = transactionParam(given);
        if (!data) throw new MockNotFoundError("eth_call without `data` is not supported.");
        // A `to` of `null` is a creation, as the spec allows: unsupported, not
        // malformed.
        if (!target)
          throw new MockNotFoundError("eth_call without `to` is not supported.", {
            metaMessages: [
              "Deployless calls (including deployless multicall) need bytecode execution. " +
                "Give the client's chain a Multicall3 address, or use `mock.publicClient()`.",
            ],
          });
        const context = { from, value, blockNumber: state.resolveBlock(block), batch: undefined };
        if (isBatch) return readBatch(target, data, context);
        const { record, answer } = callTo(target, data, context);
        return { asked: { type: "call", to: target, call: record }, answer };
      } catch (error) {
        return {
          asked: isBatch
            ? { type: "multicall", batchId: undefined, calls: [] }
            : { type: "call", to, call: undefined },
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- it's what reading threw
          answer: () => Promise.reject(error),
        };
      }
    },
    /** Saves the batch count, so batch ids go back on `restore()`. */
    snapshot() {
      const saved = batchCount;
      return {
        restore() {
          batchCount = saved;
        },
      };
    },
  };
}

/** `errorFor` builds the error only when the call is answered. */
function unmockedCall(
  target: Address,
  context: CallContext,
  errorFor: () => MockNotFoundError,
): CallReading {
  return {
    record: addressRecord(target),
    answer(report) {
      const error = errorFor();
      report(errorOutcome(error), context.batch?.index);
      return Promise.reject(error);
    },
  };
}

const addressRecord = (target: Address): MockCallRecord => ({
  address: target,
  name: undefined,
  namespace: undefined,
  abiItem: undefined,
  call: undefined,
  outcome: { type: "pending" },
});

/** Checksummed, without refusing anything: `undefined` for a non-address. */
function toOf(given: unknown): Address | undefined {
  const to = isNonArrayObject(given) ? given.to : undefined;
  return typeof to === "string" && isAddress(to, { strict: false }) ? getAddress(to) : undefined;
}
