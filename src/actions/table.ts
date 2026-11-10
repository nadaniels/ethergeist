import type { ChainState } from "../chain/state.js";
import type { ContractTurn } from "../contracts/createMockContract.js";
import type { Registry } from "../contracts/registry.js";
import type { MockCallRecord } from "../contracts/types.js";
import { fail } from "../mocking/faults.js";
import {
  type ReceivedCall,
  describeMock,
  formatCall,
  formatNoAnswer,
  formatMismatch,
  formatReceived,
  missedLines,
  removedLines,
} from "../mocking/format.js";
import {
  type Builder,
  type Handler as MockHandler,
  createHandlers,
  foundMock,
} from "../mocking/handlers.js";
import { checkNoMatchers, firstMismatch, mismatches } from "../mocking/matching.js";
import type { PinnedKey } from "../mocking/types.js";
import { zeroResult } from "../mocking/zeroResult.js";
import { MockNotFoundError, type MockRevertError } from "../shared/errors.js";
import type { PartSnapshot } from "../shared/parts.js";
import { type RecordLimit, createRecordList } from "../shared/records.js";
import { leftOut } from "../shared/values.js";
import type { TransactionStore } from "../transactions/store.js";
import type { ActionContext } from "./types.js";

/**
 * What an action's definition reads: the chain's state, what's registered,
 * and its transactions.
 */
export type ActionsContext = {
  state: ChainState;
  registry: Registry;
  transactions: TransactionStore;
};

/**
 * What `encode` gets beside the value: the call, what's known of it, and the
 * block the answer is made in.
 */
type Encoding<call extends object> = {
  /** The request's call; `undefined` at registration. */
  call: call | undefined;
  /**
   * What's known of the call: at the request, the call itself; at
   * registration, what `pinnedCall` settles from the pins, or `{}`.
   */
  pinnedCall: Partial<call>;
  /**
   * The block current when a static answer was registered, which a node
   * never moves: a receipt for a hash with no mined transaction is mined in
   * it. A resolver's answer is made at the request, in the block current
   * then.
   */
  blockNumber: bigint;
};

/**
 * How an action's mocks register, match a call and encode their answers.
 * `call` is the action's decoded call, which every member receives, and
 * `answer` what `encode` gives.
 *
 * Members are listed in the order they run: registration's first, then a
 * request's. At registration: `pin`, then `extendBuilder`, then `revertError`
 * for `.reverts()`, or for a static answer `pinnedCall` and `encode` (`zero`
 * for one left out). At a request, the mocks are matched (`actual`), and the
 * one that answers gets `extendContext`, then `encode` of its answer or, for
 * a revert, of `reverted`. A miss names `hint`.
 *
 * Members are methods, whose parameters TypeScript checks both ways, so a
 * `MockDefinition<BalanceCall>` is a `MockDefinition`: a mock set holds
 * every action's the same way. That's sound because each member only gets
 * what the same action's decoder or `encode` produced.
 */
export type MockDefinition<call extends object = object, answer = unknown> = {
  /** How calls and mocks are named in messages, e.g. `getBalance`. */
  name: string;
  /** Normalizes pinned fields at registration, e.g. checksumming addresses. */
  pin?(pinned: unknown): unknown;
  /**
   * Adds to a mock's builder, beyond `.returns()` and `.fails()`, e.g. a
   * send's `.emits()`.
   */
  extendBuilder?(builder: Builder): void;
  /**
   * What `.reverts(spec)` and a resolver's `revert(spec)` revert with;
   * without it, a mock has neither.
   */
  revertError?(spec?: unknown): MockRevertError;
  /**
   * What the pins settle of the call, for checking a static answer at
   * registration, so a mismatch fails at `.returns()`. It leaves out what
   * the pins don't settle exactly (e.g. a matcher), leaving that check to
   * the request.
   */
  pinnedCall?(pinned: unknown): Partial<call>;
  /**
   * What `.returns()` without a value answers, in viem's types: the action's
   * zero.
   */
  zero: unknown;
  /**
   * What pinned params are matched against, deeply. Defaults to the call
   * itself.
   */
  actual?(pinned: unknown, call: call): unknown;
  /** Adds to what a resolver gets, beyond the call, `fail` and `revert`. */
  extendContext?(context: object, call: call): void;
  /**
   * Validates a value in viem's types and converts it to its JSON-RPC form.
   * At registration it only checks a static answer, which is encoded again
   * at each request: see `Encoding`.
   */
  encode(value: unknown, at: Encoding<call>): answer;
  /**
   * What a revert answers instead of being thrown, a mock's `.reverts()` or
   * a resolver's `revert()`: a send's is mined reverted. It's a value in
   * viem's types, encoded as a mock's answer is.
   */
  reverted?: unknown;
  /** Where to register a mock, for "No mock for" messages. */
  hint: string;
};

/**
 * How a table answers one action: its mocks (see `MockDefinition`), decoding
 * its calls, and what it answers unmocked. `rpc` is its JSON-RPC answer,
 * which `encode` and `fallback` give.
 *
 * At a request, `decode` runs first and `view` last. Between them a mock
 * answers, or else `fallback`.
 */
export type Definition<call extends object = object, rpc = unknown> = MockDefinition<call, rpc> & {
  /** The call `params` ask for. */
  decode(params: readonly unknown[], method: string): call;
  /**
   * The answer when no mock matches, or `undefined` to report the call as
   * unhandled.
   */
  fallback?(call: call): rpc | undefined;
  /**
   * A JSON-RPC answer in viem's types, as the action returns it, for history.
   * Defaults to the answer as is.
   */
  view?(rpc: rpc): unknown;
};

/**
 * What an action tells history about a call, however it ended. A call a
 * registered contract had a turn at also has the contract's record of it.
 */
export type ActionReport = {
  call: object;
  /**
   * The call's outcome when it was answered, with the answer in viem's
   * types. Left out when the call threw: the request's error says how it
   * ended.
   */
  outcome?: { type: "result"; value: unknown };
  contract?: MockCallRecord | undefined;
};

/**
 * Runs `answer` for `call`, then tells history how it ended: with the answer
 * in viem's types, as `view` gives it, or without an outcome when it threw.
 * `turn` is a registered contract's turn at the call, where it had one: its
 * record of the call goes to history too.
 */
export async function reportAnswer<rpc>(
  {
    call,
    turn,
    report,
    view,
  }: {
    call: object;
    turn?: ContractTurn | undefined;
    report: (report: ActionReport) => void;
    view: (rpc: rpc) => unknown;
  },
  answer: () => Promise<rpc>,
): Promise<rpc> {
  try {
    const rpc = await answer();
    const outcome = { type: "result" as const, value: view(rpc) };
    report({ call, outcome, contract: turn?.record({ outcome }) });
    return rpc;
  } catch (error) {
    report({ call, contract: turn?.record({ error }) });
    throw error;
  }
}

/** The mocks and calls of one action or raw method: see `createTable`. */
export type Table = ReturnType<typeof createTable>;
type Handler = MockHandler<ActionContext<object>>;

/**
 * A param's name in messages: its key, its position from 1 for a raw
 * method's params, or `params` for all of them.
 */
const paramName = (key: PinnedKey) =>
  key === null ? "params" : typeof key === "number" ? `param ${key + 1}` : key;

/** A call as messages show it: a raw method's by its params. */
const shown = (call: object) => ("params" in call ? call.params : call);

/**
 * A static answer with the block current when it was registered, as its
 * mock's resolver returns it: see `Encoding`. The value is held as given,
 * not copied.
 */
class Registered {
  readonly value: unknown;
  readonly blockNumber: bigint;
  constructor(value: unknown, blockNumber: bigint) {
    this.value = value;
    this.blockNumber = blockNumber;
  }
}

/** What a mock set needs beside its definition: see `createMockSet`. */
export type MockSetOptions = {
  /** The block current now, e.g. `state.blockNumber`. */
  currentBlock: () => bigint;
  /**
   * The first lines for the error when nothing answers `call`, where the
   * call says why.
   */
  notFoundLines?: (call: object) => readonly string[];
};

/**
 * One action's mocks and the calls it received, kept to `recordLimit`:
 * registering mocks, finding the one that answers a call (`match`),
 * answering with it (`answerWith`), and the error when nothing answers
 * (`missError`). Decoding the call, and what answers when no mock does, are
 * its caller's: a table's, or sends and their estimates'.
 */
export function createMockSet<answer>(
  definition: MockDefinition<object, answer>,
  recordLimit: RecordLimit,
  { currentBlock, notFoundLines }: MockSetOptions,
) {
  const mocks = createHandlers<ActionContext<object>, unknown>();
  const calls = createRecordList<object>(recordLimit);
  const actualOf = (pinned: unknown, call: object) =>
    definition.actual === undefined ? call : definition.actual(pinned, call);

  /**
   * The builder methods that answer, named for a mock registered without
   * one.
   */
  const answers =
    definition.revertError === undefined
      ? ".returns() or .fails()"
      : ".returns(), .reverts() or .fails()";

  function register(params: unknown) {
    const pinned = params === undefined ? undefined : (definition.pin?.(params) ?? params);
    const handler = mocks.register(pinned, undefined);
    const builder = mocks.createBuilder(
      handler,
      definition.name,
      (value) => {
        const registered = new Registered(value, currentBlock());
        encode(registered, undefined, definition.pinnedCall?.(pinned) ?? {});
        return registered;
      },
      definition,
    );
    definition.extendBuilder?.(builder);
    return builder;
  }

  /** Unused mocks, each with the calls this action received instead. */
  const describeUnused = (list: Handler[]) =>
    list.map(
      (handler) =>
        `${describeMock(definition.name, handler)}${
          handler.answer === undefined
            ? formatNoAnswer(answers)
            : formatReceived(definition.name, received(handler), calls.total)
        }`,
    );

  /**
   * The calls this action kept since the last clear, and where each differs
   * from `handler`.
   */
  function received(handler: Handler): ReceivedCall[] {
    return calls.kept.map((call) => {
      const mismatched = mismatches(handler.pinned, actualOf(handler.pinned, call));
      const [key] = mismatched;
      return {
        call: formatMismatch(definition.name, shown(call), mismatched),
        differs: key === undefined ? undefined : paramName(key),
      };
    });
  }

  /**
   * An answer in viem's types as JSON-RPC: a static one with the block it was
   * registered in, a resolver's with the block current now. Its `undefined`
   * fields are left out, and `zeroResult` is the action's zero.
   */
  function encode(given: unknown, call: object | undefined, pinnedCall: object) {
    const registered = given instanceof Registered ? given : undefined;
    const value = registered === undefined ? given : registered.value;
    checkNoMatchers(value, `${definition.name}'s answer`);
    return definition.encode(leftOut(value === zeroResult ? definition.zero : value), {
      call,
      pinnedCall,
      blockNumber: registered === undefined ? currentBlock() : registered.blockNumber,
    });
  }

  /**
   * The handler that answers `call`, and where the others missed: see
   * `findAnswering`.
   */
  const match = (call: object) =>
    mocks.findAnswering(
      () => true,
      (candidate, options) =>
        firstMismatch(candidate.pinned, actualOf(candidate.pinned, call), options),
      definition.name,
    );

  /** Answers `call` with `handler`, the mock `match` found for it. */
  function answerWith(handler: Handler, call: object): Promise<answer> {
    const context = { ...call, fail };
    if (definition.revertError !== undefined)
      Object.assign(context, {
        revert(spec?: unknown): never {
          throw definition.revertError!(spec);
        },
      });
    definition.extendContext?.(context, call);
    return mocks.answerWith(
      handler,
      context,
      (value) => encode(value, call, call),
      definition.name,
      definition.reverted,
    );
  }

  /**
   * The error for a call nothing answers, from what `match` gave for it. It
   * lists the mocks that missed the call, or without any, says where to
   * register one: `hint`, the definition's by default.
   */
  function missError(
    call: object,
    { missed, removed }: ReturnType<typeof match>,
    hint = definition.hint,
  ): MockNotFoundError {
    const registered = missedLines(definition.name, mocks.handlers, missed, (_, key) =>
      paramName(key),
    );
    return new MockNotFoundError(`No mock for ${formatCall(definition.name, shown(call))}.`, {
      metaMessages: [
        ...(notFoundLines?.(call) ?? []),
        ...(registered.length > 0 ? ["Registered:", ...registered] : [`Mock it with ${hint}.`]),
        ...removedLines(definition.name, removed),
      ],
    });
  }

  return {
    register,
    match,
    answerWith,
    missError,
    /**
     * The mock that would answer `call` now, if any, found without answering
     * it: nothing runs, and no use is counted until `spend` counts one.
     */
    findMock: (call: object) => foundMock(match(call).handler),
    /** The calls this action received, as they arrive. */
    calls,
    clearCalls() {
      calls.clear();
      mocks.clearUsage();
    },
    /** Removes every mock, whose builders then throw. */
    removeAll() {
      mocks.removeAll();
    },
    unusedMocks: () => describeUnused(mocks.unused(mocks.handlers)),
    /**
     * Saves the registered mocks and their answers, to put back or compare
     * against.
     */
    snapshot: (): Required<PartSnapshot> => mocks.snapshot(describeUnused),
  };
}

/**
 * A table answering `definition`'s action: its mocks (see `createMockSet`),
 * and its requests, each answered by the mock that matches its call, or else
 * by `fallback`.
 */
export function createTable(
  definition: Definition,
  recordLimit: RecordLimit,
  options: MockSetOptions,
) {
  const mockSet = createMockSet(definition, recordLimit, options);
  const view = (rpc: unknown) => (definition.view ? definition.view(rpc) : rpc);

  async function answerCall(call: object): Promise<unknown> {
    const found = mockSet.match(call);
    if (found.handler) return await mockSet.answerWith(found.handler, call);
    const fallback = definition.fallback?.(call);
    if (fallback !== undefined) return fallback;
    throw mockSet.missError(call, found);
  }

  return {
    ...mockSet,
    async answer(
      method: string,
      params: readonly unknown[],
      report: (report: ActionReport) => void,
    ): Promise<unknown> {
      const call = definition.decode(params, method);
      // Waits a microtask before the call is recorded, as an
      // `eth_sendTransaction` takes one to decode: this request and that
      // send, made at once, reach their mocks in the order made.
      await Promise.resolve();
      mockSet.calls.add(call);
      return await reportAnswer({ call, report, view }, () => answerCall(call));
    },
  };
}
