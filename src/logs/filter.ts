import {
  type Abi,
  type AbiEvent,
  type Address,
  type Hash,
  decodeAbiParameters,
  getAddress,
  isHex,
  toEventSelector,
} from "viem";

import { formatValue } from "../mocking/format.js";
import { MockRpcError } from "../shared/errors.js";
import { isPlainObject, lowercase } from "../shared/values.js";

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

/**
 * `eth_getLogs` params as a call, with `resolveBlock` turning a range's tags
 * into numbers. A filter with both a block hash and a range is refused.
 */
export function decodeLogsCall(
  [filter]: readonly unknown[],
  resolveBlock: (block: unknown) => bigint,
): LogsCall {
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
 * A `getLogs` call for history: the address (a contract's name where it has
 * one), the event and the indexed args its topics ask for (decoded with the
 * registered contracts' ABIs, as hex otherwise), and the blocks.
 */
export function describeLogsCall(
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
