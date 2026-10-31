import { Log as OxLog } from "ox";
import {
  type Abi,
  type ContractEventName,
  type AbiEvent,
  type Address,
  type Hash,
  type RpcLog,
  decodeAbiParameters,
  getAddress,
  isHex,
  numberToHex,
  toEventSelector,
} from "viem";
import { blockHash, numberOfBlockHash } from "./blocks.js";
import { MockNotFoundError, MockRpcError } from "./errors.js";
import {
  type BuildLogParameters,
  type EmitOptions,
  type EmittedLog,
  type MockEventLog,
  buildLog,
} from "./events.js";
import { formatValue } from "./format.js";
import { placeLog } from "./receipts.js";
import { isPlainObject, lowercase, nodeAddress } from "./result.js";
import { testHash } from "./testValues.js";

/** A topic position in a filter: one hash, any of several, or `null` for any. */
export type LogsTopic = Hash | Hash[] | null;

/**
 * What a call to `getLogs` (or `getContractEvents`) asked for. Addresses are
 * checksummed and topics lowercase. A block range is resolved to numbers,
 * with tags as the current block; a `blockHash` query has no range.
 */
export type LogsCall = {
  address?: Address | Address[];
  topics: LogsTopic[];
  fromBlock?: bigint;
  toBlock?: bigint;
  blockHash?: Hash;
};

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

export function createLogStore(hooks: {
  /** The current block number. */
  blockNumber: () => bigint;
  /** Mines one block. */
  mine: () => void;
  /** Block `number`'s generated timestamp. */
  timestamp: (number: bigint) => bigint;
  /** Resolves a block parameter (tag or number) to a block number. */
  resolveBlock: (block: unknown) => bigint;
  /** Whether a contract is registered at `address`, which is checksummed. */
  isContract: (address: Address) => boolean;
  /** Whether the mock knows `address`: a contract, Multicall3, or an empty address. */
  isKnown: (address: Address) => boolean;
}) {
  const { blockNumber, mine, timestamp, resolveBlock, isContract, isKnown } = hooks;
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
      if (!isContract(getAddress(value.address)))
        throw new Error(
          `No mocked contract at ${value.address} to emit this log; register it with contract().`,
        );
    }
    if (emitOptions.mine === true && emitOptions.blockNumber !== undefined)
      throw new Error("emit() takes `mine` or `blockNumber`, not both.");
    if (emitOptions.mine === true) mine();

    const number = emitOptions.blockNumber ?? blockNumber();
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
      return Object.freeze({ ...log, blockTimestamp: timestamp(number) });
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

  /** `eth_getLogs` params as a call; a filter with both a block hash and a range is refused. */
  function decode([filter]: readonly unknown[]): LogsCall {
    const fields = isPlainObject(filter) ? filter : {};
    const call: LogsCall = { topics: [] };
    const { address } = fields;
    if (typeof address === "string") call.address = getAddress(address);
    if (Array.isArray(address))
      call.address = address.map((each: unknown) => getAddress(String(each)));
    if (Array.isArray(fields.topics))
      call.topics = fields.topics.map((topic: unknown) => decodeTopic(topic));
    if (fields.blockHash === undefined) {
      call.fromBlock = resolveBlock(fields.fromBlock);
      call.toBlock = resolveBlock(fields.toBlock);
    } else {
      if (fields.fromBlock !== undefined || fields.toBlock !== undefined)
        throw new MockRpcError(
          -32602,
          "invalid argument 0: cannot specify both BlockHash and FromBlock/ToBlock, choose one or the other",
        );
      if (isHex(fields.blockHash)) call.blockHash = fields.blockHash;
    }
    return call;
  }

  /**
   * The emitted logs a call asks for, sorted by block and log index. Errors
   * are reth's for the same filter; addresses the mock doesn't know are
   * reported as unmocked, since a real node would quietly answer `[]`.
   */
  function find(call: LogsCall): PlacedLog[] {
    if (call.topics.length > 4)
      throw new MockRpcError(-32602, "query exceeds the maximum of 4 topics");
    const head = blockNumber();
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
    const unknown = addresses.filter((address) => !isKnown(address));
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
    decode,
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
    ) => buildLog(parameters, hooks.blockNumber()),
    reset() {
      logs.length = 0;
    },
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

function decodeTopic(topic: unknown): LogsTopic {
  if (isHex(topic)) return lowercase(topic);
  if (Array.isArray(topic))
    return topic.filter((each) => isHex(each)).map((each) => lowercase(each));
  return null;
}

/**
 * Whether a log's topics match a filter's, as geth and reth 2.8 match them:
 * position by position, `null` or `[]` matching anything, an array matching
 * any of its hashes. A filter longer than the log's topics never matches it.
 */
function topicsMatch(filter: readonly LogsTopic[], topics: readonly Hash[]): boolean {
  if (filter.length > topics.length) return false;
  return filter.every((wanted, i) => {
    if (wanted === null || (Array.isArray(wanted) && wanted.length === 0)) return true;
    const topic = topics[i];
    if (topic === undefined) return false;
    const lower = lowercase(topic);
    return Array.isArray(wanted) ? wanted.includes(lower) : wanted === lower;
  });
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

/**
 * A `getLogs` call for history: the address (a contract's name where it has
 * one), the event and the indexed args its topics ask for (decoded with the
 * registered contracts' ABIs, as hex otherwise), and the blocks.
 */
function describeLogsCall(
  call: LogsCall,
  contracts: readonly { address: Address; name: string | undefined; abi: Abi }[],
): string {
  const nameOf = (address: Address) =>
    contracts.find((c) => c.address === address)?.name ?? formatValue(address, { short: true });
  const parts: string[] = [];
  if (call.address !== undefined)
    parts.push(
      Array.isArray(call.address)
        ? `[${call.address.map((each) => nameOf(each)).join(", ")}]`
        : nameOf(call.address),
    );
  if (call.topics.length > 0) parts.push(describeTopics(call.topics, contracts));
  if (call.blockHash !== undefined)
    parts.push(`block ${formatValue(call.blockHash, { short: true })}`);
  else if (call.fromBlock === call.toBlock) parts.push(`block ${call.fromBlock}`);
  else parts.push(`blocks ${call.fromBlock}–${call.toBlock}`);
  return `getLogs(${parts.join(", ")})`;
}

function describeTopics(topics: readonly LogsTopic[], contracts: readonly { abi: Abi }[]): string {
  const events = contracts.flatMap(({ abi }) =>
    abi.filter((item): item is AbiEvent => item.type === "event" && item.anonymous !== true),
  );
  const eventFor = (selector: Hash) => events.find((event) => toEventSelector(event) === selector);
  const [first, ...rest] = topics;
  const selectors = first === null || first === undefined ? [] : [first].flat();
  const matched = selectors.map((selector) => eventFor(selector));
  // Indexed args decode only when the topics ask for one known event.
  const [event] = matched;
  if (selectors.length === 0 || matched.some((e) => e === undefined) || event === undefined)
    return `topics: ${formatValue(topics, { short: true })}`;
  if (matched.length > 1) return matched.map((e) => e!.name).join(" | ");

  const indexed = event.inputs.filter((input) => input.indexed === true);
  const args = rest.flatMap((topic, i) => {
    const input = indexed[i];
    if (topic === null || input === undefined) return [];
    const values = [topic].flat().map((hash) => {
      // Indexed strings, bytes, structs, and arrays are hashes; the rest decode.
      if (input.type === "string" || input.type === "bytes" || input.type.endsWith("]"))
        return formatValue(hash, { short: true });
      const [value] = decodeAbiParameters([input], hash);
      return formatValue(value, { short: true });
    });
    return values.length === 0 ? [] : [`${input.name ?? `arg ${i + 1}`}: ${values.join(" | ")}`];
  });
  return `${event.name}(${args.join(", ")})`;
}
