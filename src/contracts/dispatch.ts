import type { Address, Hex } from "viem";

import { transactionParam } from "../chain/params.js";
import type { ChainState } from "../chain/state.js";
import { errorOutcome } from "../mocking/outcomes.js";
import { MockNotFoundError, removedContractLines } from "../shared/errors.js";
import { resolveMulticall } from "./multicall.js";
import type { Registry } from "./registry.js";
import type { Reporter, CallContext } from "./types.js";

/** `eth_call` routing: see `createDispatch`. */
export type Dispatcher = ReturnType<typeof createDispatch>;

/**
 * `eth_call` requests, answered by the contract registered at their address,
 * by Multicall3 (each sub-call dispatched in turn), or by an address marked
 * empty, which answers with no data, as a node does.
 */
export function createDispatch({ state, registry }: { state: ChainState; registry: Registry }) {
  /** Multicall batch ids, which count up across requests. */
  let batchCount = 0;

  /**
   * Answers a call to `target`, which is checksummed, as the lookups compare
   * it: a request's by `transactionParam`, a sub-call's by viem's decoding.
   */
  function dispatch(
    target: Address,
    data: Hex,
    context: CallContext,
    report: Reporter,
  ): Promise<Hex> {
    if (target === state.multicallAddress) {
      const batchId = ++batchCount;
      report.batch(batchId);
      return resolveMulticall(data, {
        address: state.multicallAddress,
        batchId,
        context,
        dispatch: (subTarget, subData, subContext) =>
          dispatch(subTarget, subData, subContext, report),
      });
    }

    const contract = registry.contractAt(target);
    if (contract)
      return contract.resolve(data, context, (record) => {
        report.call(record, context);
      });
    const unknown = {
      address: target,
      name: undefined,
      namespace: undefined,
      abiItem: undefined,
      call: undefined,
    };
    if (registry.isEmpty(target)) {
      report.call({ ...unknown, outcome: { type: "result", value: "0x" } }, context);
      return Promise.resolve("0x");
    }
    const error = new MockNotFoundError(`No mocked contract at ${target}.`, {
      metaMessages: [
        `Call data: ${data}`,
        "Register it with contract(), or mark it empty() for an address without code.",
        ...(registry.removedByLastRestore(target) ? removedContractLines : []),
      ],
    });
    report.call({ ...unknown, outcome: errorOutcome(error) }, context);
    throw error;
  }

  return {
    /**
     * Answers an `eth_call` request; `report` hears each contract call and
     * batch.
     */
    call(params: unknown, report: Reporter): Promise<Hex> {
      const list: readonly unknown[] = Array.isArray(params) ? params : [];
      const [given, block] = list;
      const { to, from, value, data } = transactionParam(given);
      if (!data) throw new MockNotFoundError("eth_call without `data` is not supported.");
      // A `to` of `null` is a creation, as the spec allows: unsupported, not
      // malformed.
      if (!to)
        throw new MockNotFoundError("eth_call without `to` is not supported.", {
          metaMessages: [
            "Deployless calls (including deployless multicall) need bytecode execution. " +
              "Give the client's chain a Multicall3 address, or use `mock.publicClient()`.",
          ],
        });

      return dispatch(
        to,
        data,
        {
          from,
          value,
          blockNumber: state.resolveBlock(block),
          batch: undefined,
        },
        report,
      );
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
