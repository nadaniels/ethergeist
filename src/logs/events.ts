import { AbiEvent as OxAbiEvent } from "ox";
import {
  type Abi,
  type AbiEvent,
  type AbiParameter,
  type AbiParameterToPrimitiveType,
  type Address,
  type ContractEventName,
  type Hash,
  type Hex,
  type Log,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  isHash,
  isHex,
  zeroHash,
} from "viem";

import { blockHash } from "../chain/blocks.js";
import { nodeHash } from "../chain/hashes.js";
import { placeLog } from "../chain/receipts.js";
import type { ChainState } from "../chain/state.js";
import { formatCall, formatValue } from "../mocking/format.js";
import { assertNoMatchers } from "../mocking/matching.js";
import {
  type AllNamed,
  type PartialStructs,
  fillZeros,
  withoutRepeats,
} from "../shared/abiValues.js";
import { MockSetupError, refuseUnencodable } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";

/**
 * A log's content: who emitted it, its topics and its data, from
 * `contract.events`, `contractEvents()` or `testLog()`. It has no position:
 * the send, transaction, receipt or `mock.buildLog()` it goes to places it.
 */
export type MockEventLog = {
  /** The emitting contract, checksummed. */
  address: Address;
  /**
   * Its topics: an event's selector (none for an anonymous event), then its
   * indexed args. `testLog()`'s one topic matches no event.
   */
  topics: [Hex, ...Hex[]] | [];
  /** Its data: an event's non-indexed args, ABI-encoded. */
  data: Hex;
};

/**
 * Where `mock.buildLog()` places a log, in a log's own field names: its
 * block, its transaction, and its place in them.
 */
export type LogPlacement = {
  /** Its block. Defaults to the current block. */
  blockNumber?: bigint;
  /** Its transaction's hash. Defaults to the zero hash. */
  transactionHash?: Hash;
  /** Its transaction's index in the block. Defaults to `0`. */
  transactionIndex?: number;
  /**
   * Its index in the block, across every transaction's logs.
   * `mock.buildLog()` doesn't count it: give it to match a block with other
   * logs before it. Defaults to `0`.
   */
  logIndex?: number;
};

const placementFields = new Set(["blockNumber", "transactionHash", "transactionIndex", "logIndex"]);
const placementHint =
  "Its fields are blockNumber, transactionHash, transactionIndex and logIndex; left out, the " +
  "current block and zeros.";

/** Fields a placed log has, which a transaction gives the logs it places. */
const positionFields = [
  "blockHash",
  "blockNumber",
  "blockTimestamp",
  "transactionHash",
  "transactionIndex",
  "logIndex",
] as const;

/**
 * Whether `log` is already placed, e.g. by `mock.buildLog()`: a log is placed
 * only once.
 */
export const isPlaced = (log: object) => positionFields.some((field) => field in log);

const logsHint = "Logs come from contract.events, contractEvents() or testLog().";

/**
 * A log's content fields: content from `contract.events`, `contractEvents()`
 * or `testLog()` has no others.
 */
const contentFields = new Set(["address", "topics", "data"]);

/**
 * Refuses `log` unless it's a log's content, naming it `name` ("A send's
 * log 0"): an address, hex data, and at most four 32-byte topics, with no
 * other fields. Content that isn't one would fail where it's placed, as the
 * mock's bug, or place an empty log. Placed logs are left to the caller,
 * which says who places them.
 */
function refuseNonLog(log: unknown, name: string): asserts log is MockEventLog {
  const refuse = (problem: string) =>
    new MockSetupError(`${name} ${problem}.`, { metaMessages: [logsHint] });
  if (
    !isPlainObject(log) ||
    typeof log.address !== "string" ||
    (log.topics !== undefined && !Array.isArray(log.topics))
  )
    throw refuse(`isn't a log; got ${formatValue(log)}`);
  // getAddress validates it; it's checksummed or lowercased where it's placed.
  getAddress(log.address);
  if (isPlaced(log)) return;
  const field = Object.keys(log).find((key) => !contentFields.has(key));
  if (field !== undefined)
    throw refuse(`has no field ${field}; a log's content is its address, topics and data`);
  if (log.data !== undefined && (typeof log.data !== "string" || !isHex(log.data)))
    throw refuse(`has data that isn't hex; got ${formatValue(log.data)}`);
  const topics: readonly unknown[] = log.topics ?? [];
  const index = topics.findIndex((topic) => typeof topic !== "string" || !isHash(topic));
  if (index !== -1)
    throw refuse(`has a topic that isn't a 32-byte hash; got ${formatValue(topics[index])}`);
  if (topics.length > 4) throw refuse(`has ${topics.length} topics; a log has at most 4`);
}

/** Refuses `logs` unless it's a list of logs, for `subject` ("A send's"). */
export function refuseNonLogs(
  logs: unknown,
  subject: string,
): asserts logs is readonly MockEventLog[] {
  if (!Array.isArray(logs))
    throw new MockSetupError(`${subject} logs must be a list; got ${formatValue(logs)}.`);
  logs.forEach((log: unknown, index: number) => {
    refuseNonLog(log, `${subject} log ${index}`);
  });
}

/**
 * An event input's value: an indexed one's in full, a non-indexed one's
 * with its structs' fields optional.
 */
type EventInputValue<input extends AbiParameter> = input extends { indexed: true }
  ? AbiParameterToPrimitiveType<input>
  : PartialStructs<AbiParameterToPrimitiveType<input>>;

/**
 * An event's args from its inputs: by name when every input has one, with
 * indexed ones required; otherwise every arg, in order.
 */
type EventInputsArgs<inputs extends readonly AbiParameter[]> =
  AllNamed<inputs> extends true
    ? {
        [
          input in inputs[number] as input extends { indexed: true }
            ? input["name"] & string
            : never
        ]: EventInputValue<input>;
      } & {
        [
          input in inputs[number] as input extends { indexed: true }
            ? never
            : input["name"] & string
        ]?: EventInputValue<input>;
      }
    : { readonly [index in keyof inputs]: EventInputValue<inputs[index]> };

/**
 * An event's args, as `contract.events`, `contract.emit` and the events
 * `contractEvents()` returns take them. Indexed args are required, since
 * filters match on them and a zero would quietly miss. The rest may be left
 * out, at any depth of a struct, and are filled with zeros, as in
 * `.returns()`. An event with unnamed inputs takes every arg, in order. An
 * overloaded event takes the args of any of its overloads.
 */
export type EventArgs<
  abi extends Abi,
  eventName extends ContractEventName<abi>,
  event = Extract<abi[number], { type: "event"; name: eventName }>,
> = event extends AbiEvent ? EventInputsArgs<event["inputs"]> : never;

/** Whether every field of `value` may be left out. */
type AllOptional<value> = Partial<value> extends value ? true : false;

/**
 * `args` as a parameter: optional when the event's args may all be left
 * out.
 */
export type EventArgsParameter<abi extends Abi, eventName extends ContractEventName<abi>> =
  AllOptional<EventArgs<abi, eventName>> extends true
    ? [args?: EventArgs<abi, eventName>]
    : [args: EventArgs<abi, eventName>];

/**
 * A contract's events by name, each building the log content its args would
 * emit: `contract.events`, and what `contractEvents()` returns.
 */
export type MockContractEvents<abi extends Abi> = {
  [eventName in ContractEventName<abi>]: (
    ...args: EventArgsParameter<abi, eventName>
  ) => MockEventLog;
};

/**
 * A placed log, as `mock.logs` lists it and a `getLogs` mock answers with
 * it. The chain's are frozen: each is the mock's own copy, so changing it
 * throws. Spread one to make a changed copy.
 */
export type EmittedLog = Readonly<Log<bigint, number, false>>;

/**
 * `log`'s content as a complete viem log, placed at `placement`: the same
 * placement as a transaction's logs, without the chain counting it. The
 * block is `chain`'s current one unless given, its hash and timestamp are
 * the mock's generated ones, and other position fields left out are zero.
 * Content already placed is refused, as everywhere that places logs.
 */
export function buildLog(
  log: MockEventLog,
  placement: LogPlacement,
  chain: Pick<ChainState, "blockNumber" | "timestampAt">,
): Log<bigint, number, false> {
  refuseNonLog(log, "mock.buildLog()'s content");
  if (isPlaced(log))
    throw new MockSetupError(
      "mock.buildLog() places a log's content, but this log already has a position.",
      {
        metaMessages: [
          "Pass a log from contract.events, contractEvents() or testLog(), and its position " +
            "as buildLog()'s placement.",
        ],
      },
    );
  if (!isPlainObject(placement))
    throw new MockSetupError(
      `mock.buildLog() takes its placement as an object; got ${formatValue(placement)}.`,
      { metaMessages: [placementHint] },
    );
  const unknown = Object.keys(placement).find((key) => !placementFields.has(key));
  if (unknown !== undefined)
    throw new MockSetupError(`mock.buildLog()'s placement has no field ${unknown}.`, {
      metaMessages: [
        unknown === "hash"
          ? "A log's transaction is transactionHash, as on a log; hash is a transaction's."
          : placementHint,
      ],
    });
  const {
    blockNumber = chain.blockNumber,
    transactionHash,
    transactionIndex,
    logIndex,
  } = placement;
  if (typeof blockNumber !== "bigint" || blockNumber < 0n)
    throw new MockSetupError(
      `A block number must be a bigint, zero or more; got ${formatValue(blockNumber)}.`,
    );
  const hash =
    transactionHash === undefined ? zeroHash : nodeHash(transactionHash, "A transaction hash");
  for (const [name, index] of Object.entries({
    "transaction index": transactionIndex,
    "log index": logIndex,
  }))
    if (index !== undefined && (!Number.isSafeInteger(index) || index < 0))
      throw new MockSetupError(
        `A ${name} must be an integer, zero or more; got ${formatValue(index)}.`,
      );
  return placeLog(log, {
    blockHash: blockHash(blockNumber),
    blockNumber,
    blockTimestamp: chain.timestampAt(blockNumber),
    transactionHash: hash,
    transactionIndex: transactionIndex ?? 0,
    logIndex: logIndex ?? 0,
  });
}

/**
 * A contract's events, each building the log content its args would emit at
 * `address`, without registering the contract. For a transaction's logs from
 * a contract the app decodes but never calls, e.g.
 * `contractEvents({ abi, address }).Transfer({ from, to, value })`. The same
 * as a registered contract's `events`: indexed args are required, the rest
 * filled with zeros. The address is validated at the call.
 */
export function contractEvents<const abi extends Abi>({
  abi,
  address,
}: {
  abi: abi;
  address: Address;
}): MockContractEvents<abi> {
  const emitter = getAddress(address);
  const names = new Set((abi as Abi).flatMap((item) => (item.type === "event" ? [item.name] : [])));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- built from the ABI at runtime, in the shape MockContractEvents<abi> describes
  return Object.fromEntries(
    [...names].map((eventName) => [
      eventName,
      (args?: unknown) => encodeEventLog(abi, emitter, eventName, args),
    ]),
  ) as unknown as MockContractEvents<abi>;
}

/**
 * Encodes the log `address` emits for event `eventName` of `abi`. An
 * overloaded name uses the one overload `args` fit.
 */
export function encodeEventLog(
  abi: Abi,
  address: Address,
  eventName: string,
  args: unknown,
): MockEventLog {
  assertNoMatchers(args, "event args");
  const overloads = withoutRepeats(
    abi.filter((item): item is AbiEvent => item.type === "event" && item.name === eventName),
  );
  const [only] = overloads;
  if (only === undefined) throw new MockSetupError(`No event "${eventName}" on this ABI.`);
  // Checksummed, which also validates it.
  const emitter = getAddress(address);
  if (overloads.length === 1)
    return refuseUnencodable(`Event "${eventName}"`, () => encodeWith(only, emitter, args));

  const fits = overloads.flatMap((event) => {
    try {
      return [{ event, log: encodeWith(event, emitter, args) }];
    } catch {
      return [];
    }
  });
  const [fit] = fits;
  if (fit !== undefined && fits.length === 1) return fit.log;
  const call = formatCall(eventName, args ?? []);
  throw new MockSetupError(
    fits.length === 0
      ? `No overload of event "${eventName}" takes ${call}.`
      : `Ambiguous overload for event ${call}: pass an arg that tells them apart.`,
    {
      metaMessages:
        fits.length === 0
          ? ["Overloads:", listEvents(overloads)]
          : ["It fits:", listEvents(fits.map(({ event }) => event))],
    },
  );
}

/**
 * Encodes `event` with `args`, filling non-indexed args that are left out
 * with zeros.
 */
function encodeWith(event: AbiEvent, address: Address, args: unknown): MockEventLog {
  const { inputs, name } = event;
  const values = argValues(event, args);

  inputs.forEach((input, i) => {
    if (input.indexed !== true) return;
    const label = isNamed(input) ? input.name : `arg ${i + 1}`;
    if (values[i] === undefined)
      throw new MockSetupError(`Indexed arg "${label}" of event "${name}" is required.`);
    // A struct's or array's topic is a hash of a special encoding, which viem
    // doesn't encode.
    if (input.type === "tuple" || input.type.endsWith("]"))
      throw new MockSetupError(
        `Indexed arg "${label}" of event "${name}" is a ${input.type}; ` +
          "indexed structs and arrays aren't supported.",
      );
  });

  const indexed = inputs.flatMap((input, i) =>
    input.indexed === true ? [[input, values[i]] as const] : [],
  );
  // Named inputs go by name; unnamed ones, viem takes as the indexed values
  // in order.
  const topicArgs: Record<string, unknown> | unknown[] = inputs.every((input) => isNamed(input))
    ? Object.fromEntries(indexed.map(([input, value]) => [input.name ?? "", value] as const))
    : indexed.map(([, value]) => value);
  const topics = encodeEventTopics({ abi: [event], eventName: name, args: topicArgs });
  const nonIndexed = inputs.flatMap((input, i) =>
    input.indexed === true ? [] : [[input, values[i]] as const],
  );
  return {
    address,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every indexed arg is given, so each topic is one hash, not a filter's list
    topics: topics as MockEventLog["topics"],
    data: encodeAbiParameters(
      nonIndexed.map(([input]) => input),
      nonIndexed.map(([input, value]) => fillZeros(input, value)),
    ),
  };
}

/**
 * `args` as one value per input of `event`, in order; `undefined` where left
 * out.
 */
function argValues(event: AbiEvent, args: unknown): unknown[] {
  const { inputs, name } = event;
  if (inputs.every((input) => isNamed(input))) {
    if (args === undefined) return inputs.map(() => undefined);
    if (!isPlainObject(args))
      throw new MockSetupError(`Event "${name}" takes its args as an object, by name.`);
    const unknown = Object.keys(args).find((key) => !inputs.some((input) => input.name === key));
    if (unknown !== undefined)
      throw new MockSetupError(`No arg "${unknown}" on ${OxAbiEvent.format(event)}.`);
    return inputs.map((input) => (isNamed(input) ? args[input.name] : undefined));
  }
  if (!Array.isArray(args) || args.length !== inputs.length)
    throw new MockSetupError(
      `Event "${name}" has unnamed args: pass all ${inputs.length} of them, in order.`,
    );
  return args;
}

function isNamed<input extends AbiParameter>(input: input): input is input & { name: string } {
  return input.name !== undefined && input.name !== "";
}

function listEvents(events: readonly AbiEvent[]): string {
  return events.map((event) => `  ${OxAbiEvent.format(event)}`).join("\n");
}
