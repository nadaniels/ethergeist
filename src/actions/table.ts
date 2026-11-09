import type { ChainState } from "../chain/state.js";
import type { ContractTurn } from "../contracts/createMockContract.js";
import type { Registry } from "../contracts/registry.js";
import type { MockCallRecord } from "../contracts/types.js";
import { fail } from "../mocking/faults.js";
import {
  type ReceivedCall,
  describeMock,
  formatCall,
  formatMissReason,
  formatNoAnswer,
  formatMismatch,
  formatReceived,
} from "../mocking/format.js";
import {
  type Builder,
  type Handler as MockHandler,
  createHandlers,
  foundMock,
} from "../mocking/handlers.js";
import { checkNoMatchers, firstMismatch, mismatches } from "../mocking/matching.js";
import { failureOutcome, type MockOutcome } from "../mocking/outcomes.js";
import type { PinnedKey } from "../mocking/types.js";
import { zeroResult } from "../mocking/zeroResult.js";
import { MockNotFoundError, type MockRevertError } from "../shared/errors.js";
import type { PartSnapshot } from "../shared/parts.js";
import { type RecordLimit, createRecordList } from "../shared/records.js";
import { leftOut } from "../shared/values.js";
import type { TransactionStore } from "../transactions/store.js";
import type { ImpliedEstimate } from "../transactions/writeOutcome.js";
import type { ActionContext, SendTransactionCall } from "./types.js";

/**
 * What an action's definition reads: the chain's state, what's registered,
 * its transactions, and the send mocks' implied estimates.
 */
export type ActionsContext = {
  state: ChainState;
  registry: Registry;
  transactions: TransactionStore;
  /** The implied estimate of `sent`, as its send mocks stand now. */
  impliedEstimate: (sent: SendTransactionCall) => ImpliedEstimate;
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
 * How a table answers one action: decoding its calls, encoding answers, and
 * what it answers unmocked. `call` is what `decode` returns and every other
 * member receives; `answer` is what `encode` and `fallback` give, and `rpc`
 * the JSON-RPC answer `commit` makes of it (the answer itself, without one).
 *
 * Members are listed in the order they run: registration's first, then a
 * request's. At registration: `pin`, then `extendBuilder`, then `revertError`
 * for `.reverts()`, or for a static answer `pinnedCall` and `encode` (`zero`
 * for one left out). At a request: `decode`, then `known`, which skips to
 * `view` when it answers. Otherwise `contractTurn`, `preempt` and the
 * contract's turn, then this table's mocks are matched (`actual`), and the
 * one that answers gets `extendContext`, then `encode` of its answer or, for
 * a revert, of `reverted`. Without one, `fallback` answers, then the contract's
 * miss, then "No mock for" with `hint` or `hintFor`. `commit` and `view`
 * come last.
 *
 * Members are methods, whose parameters TypeScript checks both ways, so a
 * `Definition<BalanceCall>` is a `Definition`: the table holds every action's
 * the same way. That's sound because the table only passes each member what
 * the same definition's `decode`, `encode` or `fallback` produced.
 */
export type Definition<call extends object = object, rpc = unknown, answer = rpc> = {
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
   * The call `params` ask for. It may be async, as a raw send's sender is
   * recovered.
   */
  decode(params: readonly unknown[], method: string): call | Promise<call>;
  /**
   * The answer a call already has, before any mock is asked: a repeated raw
   * send's hash, once its transaction is on the chain.
   */
  known?(call: call): rpc | undefined;
  /**
   * A registered contract's turn at the call (an estimate or a send of one
   * of its functions), prepared as the call arrives. Its mocks answer before
   * this table's: it owns its functions.
   */
  contractTurn?(call: call): ContractTurn<answer> | undefined;
  /**
   * An answer that comes before the contract's and the mocks', thrown: an
   * estimate reverts as the `.reverts()` send mock that would answer its
   * send does. It runs once the contract's turn is prepared, so the call is
   * still recorded as the contract's.
   */
  preempt?(call: call): void;
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
  /**
   * The answer when no mock matches, or `undefined` to report the call as
   * unhandled.
   */
  fallback?(call: call): answer | undefined;
  /** Where to register a mock, for "No mock for" messages. */
  hint: string;
  /**
   * `hint` for a call, where it depends on the call; `undefined` for `hint`
   * itself.
   */
  hintFor?(call: call): string | undefined;
  /**
   * Turns the answer to a call into its JSON-RPC answer, once it's chosen
   * (a contract's, a mock's or the fallback's): a send mines its
   * transaction and answers its hash or receipt. It runs only to answer,
   * never at registration, so it may change the chain; anything it throws,
   * it throws before changing anything.
   */
  commit?(answer: answer, call: call): rpc;
  /**
   * A JSON-RPC answer in viem's types, as the action returns it, for history.
   * Defaults to the answer as is.
   */
  view?(rpc: rpc): unknown;
};

/**
 * What a table tells history about a call it answered. A call a registered
 * contract had a turn at also has the contract's record of it, which takes
 * `outcome` if the contract's turn didn't settle it.
 */
export type ActionReport = {
  call: object;
  outcome: MockOutcome;
  contract?: MockCallRecord;
};

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

/** What a table needs beside its definition: see `createTable`. */
type TableOptions = {
  /** The block current now, e.g. `state.blockNumber`. */
  currentBlock: () => bigint;
  /**
   * A first line for the error when nothing answers `call`, where the call
   * says why.
   */
  notFoundNote?: (call: object) => string | undefined;
};

/**
 * A table answering `definition`'s action, with its mocks and the calls it
 * received, kept to `recordLimit`.
 */
export function createTable(
  definition: Definition,
  recordLimit: RecordLimit,
  { currentBlock, notFoundNote }: TableOptions,
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

  /** Unused mocks, each with the calls this table received instead. */
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
   * The calls this table kept since the last clear, and where each differs
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

  async function answer(
    method: string,
    params: readonly unknown[],
    report: (report: ActionReport) => void,
  ): Promise<unknown> {
    const call = await definition.decode(params, method);
    calls.add(call);
    const known = definition.known?.(call);
    const turn = known === undefined ? definition.contractTurn?.(call) : undefined;
    const reportAs = (outcome: MockOutcome) => {
      const contract = turn?.record;
      report({ call, outcome, ...(contract && { contract }) });
    };
    try {
      const rpc = known ?? (await answerAndCommit(call, turn));
      reportAs({ type: "result", value: definition.view ? definition.view(rpc) : rpc });
      return rpc;
    } catch (error) {
      reportAs(failureOutcome(error));
      throw error;
    }
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
      mocks.handlers,
      (candidate, options) =>
        firstMismatch(candidate.pinned, actualOf(candidate.pinned, call), options),
      definition.name,
    );

  async function answerAndCommit(call: object, turn: ContractTurn | undefined) {
    const answered = await answerCall(call, turn);
    return definition.commit ? definition.commit(answered, call) : answered;
  }

  async function answerCall(call: object, turn: ContractTurn | undefined): Promise<unknown> {
    try {
      definition.preempt?.(call);
    } catch (error) {
      turn?.preempted(error);
      throw error;
    }
    const answered = turn?.answer();
    if (answered) return await answered;
    const { handler, missed } = match(call);
    if (!handler) {
      const fallback = definition.fallback?.(call);
      if (fallback !== undefined) return fallback;
      if (turn) throw turn.miss();
      const registered = mocks.handlers.map((mock) => {
        const key = missed.get(mock);
        const reason = formatMissReason(key === undefined ? undefined : paramName(key));
        return `  ${describeMock(definition.name, mock)}${reason}`;
      });
      const note = notFoundNote?.(call);
      throw new MockNotFoundError(`No mock for ${formatCall(definition.name, shown(call))}.`, {
        metaMessages: [
          ...(note === undefined ? [] : [note]),
          ...(registered.length > 0
            ? ["Registered:", ...registered]
            : [`Mock it with ${definition.hintFor?.(call) ?? definition.hint}.`]),
        ],
      });
    }

    const context = { ...call, fail };
    if (definition.revertError !== undefined)
      Object.assign(context, {
        revert(spec?: unknown): never {
          throw definition.revertError!(spec);
        },
      });
    definition.extendContext?.(context, call);
    return await mocks.answerWith(
      handler,
      context,
      (value) => encode(value, call, call),
      definition.name,
      definition.reverted,
    );
  }

  return {
    register,
    answer,
    /**
     * This table's mock that would answer `call` now, if any, found without
     * answering it: nothing runs, and no use is counted until `spend` counts
     * one.
     */
    findMock: (call: object) => foundMock(match(call).handler),
    /** The calls this table received, as they arrive. */
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
