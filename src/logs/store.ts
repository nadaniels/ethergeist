import { Log as OxLog } from "ox";
import {
  type Abi,
  type ContractEventName,
  type Hash,
  type RpcLog,
  getAddress,
  numberToHex,
} from "viem";

import { blockHash, numberOfBlockHash } from "../chain/blocks.js";
import { placeLog } from "../chain/receipts.js";
import type { ChainState } from "../chain/state.js";
import type { Registry } from "../contracts/registry.js";
import { MockNotFoundError, MockRpcError } from "../shared/errors.js";
import { testHash } from "../shared/testValues.js";
import { isPlainObject, nodeAddress } from "../shared/values.js";
import {
  type BuildLogParameters,
  type EmitOptions,
  type EmittedLog,
  type MockEventLog,
  buildLog,
} from "./events.js";
import { type LogsCall, decodeLogsCall, describeLogsCall, topicsMatch } from "./filter.js";

/** A placed log: viem's, with the block's timestamp, as reth includes it. */
type PlacedLog = EmittedLog & { readonly blockTimestamp: bigint };

/** Fields a placed log has, which `emit` takes from its options instead. */
const positionFields = [
  "blockHash",
  "blockNumber",
  "transactionHash",
  "transactionIndex",
  "logIndex",
] as const;

export type LogStore = ReturnType<typeof createLogStore>;

/**
 * Emitted logs, which answer `eth_getLogs`: placed in blocks of `state`, by
 * contracts in `registry`, and found by filters as a node finds them.
 */
export function createLogStore({
  state,
  registry,
}: {
  state: ChainState;
  registry: Pick<Registry, "codeAt" | "isContract">;
}) {
  const logs: PlacedLog[] = [];

  /** Places one transaction's logs, returning one for one and an array for an array. */
  function emit(log: MockEventLog, options?: EmitOptions): EmittedLog;
  function emit(logs: readonly MockEventLog[], options?: EmitOptions): EmittedLog[];
  function emit(
    given: MockEventLog | readonly MockEventLog[],
    options?: EmitOptions,
  ): EmittedLog | EmittedLog[] {
    if (isLogList(given)) return place(given, options);
    return place([given], options)[0]!;
  }

  /** One transaction's logs, placed in a block; see `EmitOptions`. */
  function place(values: readonly MockEventLog[], emitOptions: EmitOptions = {}): PlacedLog[] {
    if (values.length === 0) throw new Error("emit() requires at least one log.");
    for (const value of values) {
      if (positionFields.some((field) => field in value))
        throw new Error(
          "emit() places logs itself, but this one already has a position (e.g. from " +
            "mock.buildLog()). Pass a log from contract.events, and set its block or transaction " +
            "in emit()'s options.",
        );
      if (!registry.isContract(getAddress(value.address)))
        throw new Error(
          `No mocked contract at ${value.address} to emit this log; register it with contract().`,
        );
    }
    if (emitOptions.mine === true && emitOptions.blockNumber !== undefined)
      throw new Error("emit() takes `mine` or `blockNumber`, not both.");
    if (emitOptions.mine === true) state.mine();

    const number = emitOptions.blockNumber ?? state.blockNumber;
    const inBlock = logs.filter((log) => log.blockNumber === number);
    const last = inBlock.at(-1);
    const { transactionHash, transactionIndex } = transactionFor(number, inBlock, emitOptions);
    // A transaction appended to keeps counting from its last log.
    const firstIndex = last === undefined ? 0 : last.logIndex + 1;
    // Frozen, topics too, so changing one throws instead of changing what getLogs answers.
    const placed = values.map((value, i) => {
      const log = placeLog(value, {
        blockHash: blockHash(number),
        blockNumber: number,
        transactionHash,
        transactionIndex,
        logIndex: firstIndex + i,
      });
      Object.freeze(log.topics);
      return Object.freeze({ ...log, blockTimestamp: state.timestampAt(number) });
    });
    logs.push(...placed);
    return placed;
  }

  /** The transaction new logs in block `number` belong to: an existing one, or the next. */
  function transactionFor(
    number: bigint,
    inBlock: readonly PlacedLog[],
    { transactionHash, transactionIndex }: EmitOptions,
  ): { transactionHash: Hash; transactionIndex: number } {
    const last = inBlock.at(-1);
    const existing =
      transactionHash === undefined
        ? undefined
        : logs.find((log) => log.transactionHash.toLowerCase() === transactionHash.toLowerCase());
    if (existing !== undefined) {
      if (existing.blockNumber !== number)
        throw new Error(
          `Transaction ${transactionHash} is in block ${existing.blockNumber}; ` +
            "a transaction's logs are all in one block.",
        );
      if (existing.transactionIndex !== last?.transactionIndex)
        throw new Error(
          `Transaction ${transactionHash} isn't the last in block ${number}; logs can only ` +
            "be added to a block's last transaction.",
        );
      if (transactionIndex !== undefined && transactionIndex !== existing.transactionIndex)
        throw new Error(
          `Transaction ${transactionHash} has index ${existing.transactionIndex}, not ${transactionIndex}.`,
        );
      return {
        transactionHash: existing.transactionHash,
        transactionIndex: existing.transactionIndex,
      };
    }

    const next = last === undefined ? 0 : last.transactionIndex + 1;
    if (transactionIndex !== undefined && transactionIndex < next)
      throw new Error(
        `Transaction index ${transactionIndex} in block ${number} isn't after the block's ` +
          `last transaction (${next - 1}); emit a block's transactions in order.`,
      );
    const index = transactionIndex ?? next;
    return {
      transactionHash: transactionHash ?? testHash(`tx:${number}:${index}`),
      transactionIndex: index,
    };
  }

  /**
   * The emitted logs a call asks for, sorted by block and log index. Errors
   * are reth's for the same filter; addresses the mock doesn't know are
   * reported as unmocked, since a real node would quietly answer `[]`.
   */
  function find(call: LogsCall): PlacedLog[] {
    if (call.topics.length > 4)
      throw new MockRpcError(-32602, "query exceeds the maximum of 4 topics");
    const head = state.blockNumber;
    let from: bigint;
    let to: bigint;
    if (call.blockHash === undefined) {
      from = call.fromBlock ?? head;
      to = call.toBlock ?? head;
      if (from > head || to > head)
        throw new MockRpcError(-32602, "block range extends beyond current head block");
      if (from > to) throw new MockRpcError(-32602, "invalid block range params");
    } else {
      const number = numberOfBlockHash(call.blockHash);
      if (number === undefined || number > head)
        throw new MockRpcError(-32000, `block not found: ${call.blockHash.slice(2)}`);
      from = number;
      to = number;
    }

    const addresses = call.address === undefined ? [] : [call.address].flat();
    const unknown = addresses.filter((address) => registry.codeAt(address) === undefined);
    if (unknown.length > 0)
      throw new MockNotFoundError(`No mocked contract at ${unknown.join(", ")}.`, {
        details:
          "Logs come only from registered contracts: register it with contract(), or mark it " +
          "empty() for an address without code.",
      });

    return logs
      .filter(
        (log) =>
          log.blockNumber >= from &&
          log.blockNumber <= to &&
          (addresses.length === 0 || addresses.includes(getAddress(log.address))) &&
          topicsMatch(call.topics, log.topics),
      )
      .toSorted((a, b) =>
        a.blockNumber === b.blockNumber
          ? a.logIndex - b.logIndex
          : a.blockNumber < b.blockNumber
            ? -1
            : 1,
      );
  }

  return {
    emit,
    decode: (params: readonly unknown[]) => decodeLogsCall(params, state.resolveBlock),
    find,
    toRpc,
    describe: describeLogsCall,
    /** Every placed log, by block and log index. */
    get logs(): PlacedLog[] {
      return logs.toSorted((a, b) =>
        a.blockNumber === b.blockNumber
          ? a.logIndex - b.logIndex
          : a.blockNumber < b.blockNumber
            ? -1
            : 1,
      );
    },
    /** A finished log, in the current block unless given; see `buildLog`. */
    buildLog: <const abi extends Abi, eventName extends ContractEventName<abi>>(
      parameters: BuildLogParameters<abi, eventName>,
    ) => buildLog(parameters, state.blockNumber),
    /** Saves the logs emitted so far; `restore()` removes later ones. */
    checkpoint() {
      const count = logs.length;
      return {
        restore() {
          logs.length = count;
        },
      };
    },
  };
}

function isLogList(
  given: MockEventLog | readonly MockEventLog[],
): given is readonly MockEventLog[] {
  return Array.isArray(given);
}

function toRpcLog(log: EmittedLog): RpcLog {
  const { blockTimestamp } = log;
  return {
    // ox types a log's topics as non-empty, but a LOG0 log has none; it passes them through.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ox's type is narrower than its runtime
    ...OxLog.toRpc({ ...log, address: nodeAddress(log.address) } as OxLog.Log),
    ...(typeof blockTimestamp === "bigint" ? { blockTimestamp: numberToHex(blockTimestamp) } : {}),
  };
}

/** Fields a placed log has, with the types viem gives them. */
const placedFields = {
  blockHash: "string",
  blockNumber: "bigint",
  transactionHash: "string",
  transactionIndex: "number",
  logIndex: "number",
} as const;

/**
 * Logs a `getLogs` mock answered with, in JSON-RPC form. They must be placed
 * (from `emit()` or `mock.buildLog()`): content alone has no block or transaction.
 */
function toRpc(value: unknown): RpcLog[] {
  if (!Array.isArray(value))
    throw new TypeError(`getLogs answers a list of logs; got ${typeof value}.`);
  return value.map((log: unknown, i) => {
    const placed =
      isPlainObject(log) &&
      Object.entries(placedFields).every(([field, type]) => typeof log[field] === type);
    if (!placed)
      throw new TypeError(
        `getLogs answers placed logs, e.g. from emit() or mock.buildLog(); log ${i} has no position.`,
      );
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked above
    return toRpcLog(log as unknown as EmittedLog);
  });
}
