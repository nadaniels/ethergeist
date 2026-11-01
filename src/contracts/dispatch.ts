import { type Address, type Hex, getAddress, hexToBigInt, isAddress, isHex } from "viem";

import type { ChainState } from "../chain/state.js";
import { formatValue } from "../mocking/format.js";
import { errorOutcome } from "../mocking/outcomes.js";
import { MockNotFoundError, invalidParams } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import { resolveMulticall } from "./multicall.js";
import type { Registry } from "./registry.js";
import type { Reporter, CallContext } from "./types.js";

/** An `eth_call`'s transaction, its fields checked; refused as invalid params if malformed. */
function callTransaction(given: unknown) {
  if (!isPlainObject(given))
    throw invalidParams(`expected a transaction object; got ${formatValue(given)}`);
  const field = <type>(name: string, is: (value: unknown) => value is type, expected: string) => {
    const value = given[name];
    if (value === undefined) return undefined;
    if (!is(value))
      throw invalidParams(`expected ${expected} for \`${name}\`; got ${formatValue(value)}`);
    return value;
  };
  return {
    to: field("to", isAddressValue, "an address"),
    from: field("from", isAddressValue, "an address"),
    value: field("value", isHexValue, "a quantity"),
    data: field("data", isHexValue, "hex data"),
    input: field("input", isHexValue, "hex data"),
  };
}

const isHexValue = (value: unknown): value is Hex => isHex(value);

const isAddressValue = (value: unknown): value is Address =>
  typeof value === "string" && isAddress(value, { strict: false });

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
      const list: readonly unknown[] = Array.isArray(params) ? params : [];
      const [given, block] = list;
      const tx = callTransaction(given);
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
