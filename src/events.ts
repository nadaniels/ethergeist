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
  toEventSignature,
  zeroHash,
} from "viem";
import { AbiEvent as OxAbiEvent } from "ox";
import { blockHash } from "./blocks.js";
import { assertNoMatchers } from "./match.js";
import { placeLog } from "./receipts.js";
import { type AllNamed, type PartialStructs, fillZeros, isPlainObject } from "./result.js";

/**
 * A log's content, encoded from an event and its args: who emitted it, its
 * topics, and its data. It has no position; the receipt, `emit`, or
 * `buildLog` it goes to gives it one.
 */
export type MockEventLog = {
  /** The emitting contract, checksummed. */
  address: Address;
  topics: [Hex, ...Hex[]] | [];
  data: Hex;
};

/** Where a log goes: its block and transaction. Left out, they're zero. */
export type LogPlacement = {
  blockNumber?: bigint;
  transactionHash?: Hash;
  transactionIndex?: number;
};

/** An indexed input's value is required; a non-indexed one may be a partial struct. */
type EventInputValue<input extends AbiParameter> = input extends { indexed: true }
  ? AbiParameterToPrimitiveType<input>
  : PartialStructs<AbiParameterToPrimitiveType<input>>;

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
 * An event's args, as `events.X()` and `buildLog` take them: indexed args
 * are required, since filters match on them and a zero would quietly miss.
 * The rest may be left out, at any depth of a struct, and are zero-filled,
 * as in `.returns()`. Events with unnamed inputs take every arg, in order.
 * For an overloaded event, the args of any of its overloads.
 */
export type MockEventArgs<
  abi extends Abi,
  eventName extends ContractEventName<abi>,
  event = Extract<abi[number], { type: "event"; name: eventName }>,
> = event extends AbiEvent ? EventInputsArgs<event["inputs"]> : never;

/** Whether every field of `value` may be left out. */
type AllOptional<value> = Partial<value> extends value ? true : false;

/** `args` as a parameter: optional when the event's args may all be left out. */
export type MockEventArgsParameter<abi extends Abi, eventName extends ContractEventName<abi>> =
  AllOptional<MockEventArgs<abi, eventName>> extends true
    ? [args?: MockEventArgs<abi, eventName>]
    : [args: MockEventArgs<abi, eventName>];

/** A contract's events by name, each building the log its args would emit. */
export type MockContractEvents<abi extends Abi> = {
  [eventName in ContractEventName<abi>]: (
    ...args: MockEventArgsParameter<abi, eventName>
  ) => MockEventLog;
};

export type BuildLogParameters<
  abi extends Abi,
  eventName extends ContractEventName<abi>,
> = LogPlacement & {
  abi: abi;
  address: Address;
  eventName: eventName;
  /** The log's index in its block. Defaults to 0. */
  logIndex?: number;
} & (AllOptional<MockEventArgs<abi, eventName>> extends true
    ? { args?: MockEventArgs<abi, eventName> }
    : { args: MockEventArgs<abi, eventName> });

/**
 * The log `address` emits for `eventName` with `args`, as a complete viem
 * log: the same encoding as a contract's `events`, and the same placement
 * as a mocked receipt's logs. Position fields left out are zero, and the
 * block hash is the mock's generated hash for `blockNumber`.
 */
export function buildLog<const abi extends Abi, eventName extends ContractEventName<abi>>(
  parameters: BuildLogParameters<abi, eventName>,
): Log<bigint, number, false> {
  const { abi, address, eventName, blockNumber = 0n } = parameters;
  const args: unknown = "args" in parameters ? parameters.args : undefined;
  return placeLog(encodeEventLog(abi, address, eventName, args), {
    blockHash: blockHash(blockNumber),
    blockNumber,
    transactionHash: parameters.transactionHash ?? zeroHash,
    transactionIndex: parameters.transactionIndex ?? 0,
    logIndex: parameters.logIndex ?? 0,
  });
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
  const overloads = abi.filter(
    (item): item is AbiEvent => item.type === "event" && item.name === eventName,
  );
  const [only] = overloads;
  if (only === undefined) throw new Error(`No event "${eventName}" on this ABI.`);
  // Checksummed, which also validates it.
  const emitter = getAddress(address);
  if (overloads.length === 1) return encodeWith(only, emitter, args);

  const fits = overloads.flatMap((event) => {
    try {
      return [encodeWith(event, emitter, args)];
    } catch {
      return [];
    }
  });
  const [log] = fits;
  if (log !== undefined && fits.length === 1) return log;
  const signatures = overloads.map((event) => `  ${toEventSignature(event)}`).join("\n");
  throw new Error(
    fits.length === 0
      ? `No overload of event "${eventName}" takes these args. Overloads:\n${signatures}`
      : `Ambiguous overload for event "${eventName}": pass an arg only one of them has. ` +
          `Overloads:\n${signatures}`,
  );
}

/** Encodes `event` with `args`, zero-filling non-indexed args that are left out. */
function encodeWith(event: AbiEvent, address: Address, args: unknown): MockEventLog {
  const { inputs, name } = event;
  const values = argValues(event, args);

  inputs.forEach((input, i) => {
    if (input.indexed !== true) return;
    const label = isNamed(input) ? input.name : `arg ${i + 1}`;
    if (values[i] === undefined)
      throw new Error(`Indexed arg "${label}" of event "${name}" is required.`);
    // A struct's or array's topic is a hash of a special encoding, which viem doesn't encode.
    if (input.type === "tuple" || input.type.endsWith("]"))
      throw new Error(
        `Indexed arg "${label}" of event "${name}" is a ${input.type}; ` +
          "indexed structs and arrays aren't supported.",
      );
  });

  const indexed = inputs.flatMap((input, i) =>
    input.indexed === true ? [[input, values[i]] as const] : [],
  );
  // Named inputs go by name; unnamed ones, viem takes as the indexed values in order.
  const topicArgs: Record<string, unknown> | unknown[] = inputs.every((input) => isNamed(input))
    ? Object.fromEntries(indexed.map(([input, value]) => [input.name ?? "", value] as const))
    : indexed.map(([, value]) => value);
  const topics = encodeEventTopics({ abi: [event], eventName: name, args: topicArgs });
  const nonIndexed = inputs.flatMap((input, i) =>
    input.indexed === true ? [] : [[input, values[i]] as const],
  );
  return {
    address,
    // Every indexed arg is given, so every topic is a single hash.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- viem types topics for filters
    topics: topics as MockEventLog["topics"],
    data: encodeAbiParameters(
      nonIndexed.map(([input]) => input),
      nonIndexed.map(([input, value]) => fillZeros(input, value)),
    ),
  };
}

/** `args` as one value per input of `event`, in order; `undefined` where left out. */
function argValues(event: AbiEvent, args: unknown): unknown[] {
  const { inputs, name } = event;
  if (inputs.every((input) => isNamed(input))) {
    if (args === undefined) return inputs.map(() => undefined);
    if (!isPlainObject(args))
      throw new TypeError(`Event "${name}" takes its args as an object, by name.`);
    const unknown = Object.keys(args).find((key) => !inputs.some((input) => input.name === key));
    if (unknown !== undefined)
      throw new Error(`No arg "${unknown}" on ${OxAbiEvent.format(event)}.`);
    return inputs.map((input) => (isNamed(input) ? args[input.name] : undefined));
  }
  if (!Array.isArray(args) || args.length !== inputs.length)
    throw new TypeError(
      `Event "${name}" has unnamed args: pass all ${inputs.length} of them, in order.`,
    );
  return args;
}

function isNamed<input extends AbiParameter>(input: input): input is input & { name: string } {
  return input.name !== undefined && input.name !== "";
}
