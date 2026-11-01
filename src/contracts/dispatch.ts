import { type Address, type Hex, getAddress, hexToBigInt } from "viem";

import type { ChainState } from "../chain/state.js";
import { errorOutcome } from "../history/outcomes.js";
import type { Reporter } from "../history/types.js";
import { MockNotFoundError } from "../shared/errors.js";
import { resolveMulticall } from "./multicall.js";
import type { Registry } from "./registry.js";
import type { CallContext } from "./types.js";

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

  function dispatch(
    to: Address,
    data: Hex,
    context: CallContext,
    report: Reporter = {},
  ): Promise<Hex> {
    // Checksummed once here; lookups below compare checksummed addresses.
    const target = getAddress(to);
    if (target === state.multicallAddress) {
      const batchId = ++batchCount;
      report.batch?.(batchId);
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
      return contract.resolve(data, context, (record) => report.call?.(record, context));
    const unknown = { address: target, name: undefined, abiItem: undefined, call: undefined };
    // A real node answers a call to an address without code with empty data.
    if (registry.isEmpty(target)) {
      report.call?.({ ...unknown, outcome: { type: "result", value: "0x" } }, context);
      return Promise.resolve("0x");
    }
    const error = new MockNotFoundError(`No mocked contract at ${to}.`, {
      details:
        `Call data: ${data}\n` +
        "Register it with contract(), or mark it empty() for an address without code.",
    });
    report.call?.({ ...unknown, outcome: errorOutcome(error) }, context);
    throw error;
  }

  return {
    /** Answers an `eth_call` request; `report` hears each contract call and batch. */
    call(params: unknown, report: Reporter): Promise<Hex> {
      // JSON-RPC params arrive untyped; this is the shape viem sends for eth_call.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- untyped JSON-RPC boundary
      const [tx, block] = params as [
        { to?: Address; from?: Address; value?: Hex; data?: Hex; input?: Hex },
        unknown,
      ];
      const data = tx.data ?? tx.input;
      if (!data) throw new MockNotFoundError("eth_call without `data` is not supported.");
      if (!tx.to)
        throw new MockNotFoundError("eth_call without `to` is not supported.", {
          details:
            "Deployless calls (including deployless multicall) need bytecode execution. " +
            "Give the client's chain a Multicall3 address, or use `mock.publicClient()`.",
        });

      return dispatch(
        tx.to,
        data,
        {
          from: tx.from,
          value: tx.value ? hexToBigInt(tx.value) : 0n,
          blockNumber: state.resolveBlock(block),
          batch: undefined,
        },
        report,
      );
    },
    /** Saves the batch count, so batch ids go back on `restore()`. */
    checkpoint() {
      const saved = batchCount;
      return {
        restore() {
          batchCount = saved;
        },
      };
    },
  };
}
