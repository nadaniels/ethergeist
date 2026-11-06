import {
  type Abi,
  type AbiEvent,
  type Address,
  type Hash,
  decodeAbiParameters,
  toEventSelector,
} from "viem";

import { type ResolveBlock, addressParam, hashParam } from "../chain/params.js";
import { formatValue } from "../mocking/format.js";
import { MockRpcError, invalidParams } from "../shared/errors.js";
import { isPlainObject, lowercase } from "../shared/values.js";

/**
 * A topic position in a `getLogs` filter: one hash, any of several, or `null`
 * for any.
 */
export type LogsTopic = Hash | Hash[] | null;

/**
 * What a call to viem's `getLogs()` or `getContractEvents()` asked for: a
 * block range, or a block hash.
 */
export type LogsCall = {
  /**
   * The address it asked for logs from, or the addresses, checksummed; left
   * out for any.
   */
  address?: Address | Address[];
  /**
   * The topics it asked for, position by position, lowercase: see
   * `LogsTopic`. `[]` for any.
   */
  topics: LogsTopic[];
  /**
   * The range's first block, or the current block when the filter gives
   * none. A tag resolves to the current block, or `0n` for `"earliest"`.
   * Left out for a block hash.
   */
  fromBlock?: bigint;
  /** The range's last block, resolved as `fromBlock` is. */
  toBlock?: bigint;
  /** The block it asked for by hash, lowercase, in place of a range. */
  blockHash?: Hash;
};

/**
 * `eth_getLogs` params as a call, with `resolveBlock` turning a range's tags
 * into numbers. A filter with both a block hash and a range is refused.
 */
export function decodeLogsCall([filter]: readonly unknown[], resolveBlock: ResolveBlock): LogsCall {
  if (filter !== undefined && !isPlainObject(filter))
    throw invalidParams(`expected a filter object; got ${formatValue(filter)}`);
  const fields = filter ?? {};
  const call: LogsCall = { topics: [] };
  const { address, topics } = fields;
  if (Array.isArray(address)) call.address = address.map((each: unknown) => addressParam(each));
  else if (address !== undefined && address !== null) call.address = addressParam(address);
  if (Array.isArray(topics)) call.topics = topics.map((topic: unknown) => decodeTopic(topic));
  else if (topics !== undefined && topics !== null)
    throw invalidParams(`expected a list of topics; got ${formatValue(topics)}`);
  if (fields.blockHash === undefined) {
    // The spec's range takes no `pending`.
    if (fields.fromBlock === "pending" || fields.toBlock === "pending")
      throw invalidParams("a log range can't be pending");
    call.fromBlock = resolveBlock(fields.fromBlock, "numberOrTag");
    call.toBlock = resolveBlock(fields.toBlock, "numberOrTag");
  } else {
    if (fields.fromBlock !== undefined || fields.toBlock !== undefined)
      throw new MockRpcError(
        -32602,
        "invalid argument 0: cannot specify both BlockHash and FromBlock/ToBlock, choose one or the other",
      );
    call.blockHash = hashParam(fields.blockHash);
  }
  return call;
}

/**
 * A filter's topic: one hash, any of several, or `null` for any; each hash is
 * 32 bytes.
 */
function decodeTopic(topic: unknown): LogsTopic {
  if (topic === null) return null;
  return Array.isArray(topic) ? topic.map((each: unknown) => hashParam(each)) : hashParam(topic);
}

/**
 * Whether a log's topics match a filter's, as geth and reth 2.8 match them:
 * position by position, `null` or `[]` matching anything, an array matching
 * any of its hashes. A filter longer than the log's topics never matches it.
 */
export function topicsMatch(filter: readonly LogsTopic[], topics: readonly Hash[]): boolean {
  if (filter.length > topics.length) return false;
  return filter.every((wanted, i) => {
    if (wanted === null || (Array.isArray(wanted) && wanted.length === 0)) return true;
    const topic = topics[i];
    if (topic === undefined) return false;
    const lower = lowercase(topic);
    return Array.isArray(wanted) ? wanted.includes(lower) : wanted === lower;
  });
}

/**
 * A `getLogs` call as history shows it: the address (a contract's name where
 * it has one), the event and the indexed args its topics ask for (decoded
 * with the registered contracts' ABIs, as hex otherwise), and the blocks.
 */
export function describeLogsCall(
  call: LogsCall,
  contracts: readonly { address: Address; name: string | undefined; abi: Abi }[],
): string {
  const nameOf = (address: Address) =>
    contracts.find((contract) => contract.address === address)?.name ??
    formatValue(address, { short: true });
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

/**
 * A filter's topics for history: the event and the indexed args they ask
 * for when they ask for one known event, the events' names for several, and
 * the hex otherwise.
 */
function describeTopics(topics: readonly LogsTopic[], contracts: readonly { abi: Abi }[]): string {
  const events = contracts.flatMap(({ abi }) =>
    abi.filter((item): item is AbiEvent => item.type === "event" && item.anonymous !== true),
  );
  const eventFor = (selector: Hash) => events.find((event) => toEventSelector(event) === selector);
  const [first, ...rest] = topics;
  const selectors = first === null || first === undefined ? [] : [first].flat();
  const matched = selectors.map((selector) => eventFor(selector));
  const [event] = matched;
  if (
    selectors.length === 0 ||
    matched.some((abiEvent) => abiEvent === undefined) ||
    event === undefined
  )
    return `topics: ${formatValue(topics, { short: true })}`;
  if (matched.length > 1) return matched.map((abiEvent) => abiEvent!.name).join(" | ");

  const indexed = event.inputs.filter((input) => input.indexed === true);
  const args = rest.flatMap((topic, i) => {
    const input = indexed[i];
    if (topic === null || input === undefined) return [];
    const values = [topic].flat().map((hash) => {
      if (input.type === "string" || input.type === "bytes" || input.type.endsWith("]"))
        return formatValue(hash, { short: true });
      const [value] = decodeAbiParameters([input], hash);
      return formatValue(value, { short: true });
    });
    return values.length === 0 ? [] : [`${input.name ?? `arg ${i + 1}`}: ${values.join(" | ")}`];
  });
  return `${event.name}(${args.join(", ")})`;
}
