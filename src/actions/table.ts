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
import { type Builder, type Handler as MockHandler, createHandlers } from "../mocking/handlers.js";
import { assertNoMatchers, firstMismatch, mismatches } from "../mocking/matching.js";
import { failureOutcome, type MockOutcome } from "../mocking/outcomes.js";
import type { PinnedKey } from "../mocking/types.js";
import { zeroResult } from "../mocking/zeroResult.js";
import { MockNotFoundError } from "../shared/errors.js";
import type { PartSnapshot } from "../shared/parts.js";
import { type RecordLimit, createRecordList } from "../shared/records.js";
import type { TransactionStore } from "../transactions/store.js";
import type { ActionCalls, ActionContext } from "./types.js";

/**
 * What an action's definition reads: the chain's state, what's registered,
 * its transactions, and the other actions' mocks.
 */
export type ActionsContext = {
  state: ChainState;
  registry: Registry;
  transactions: TransactionStore;
  /** The mock of action `name` that would answer `call` now, if any: see `findMock`. */
  mockFor: <name extends keyof ActionCalls>(
    name: name,
    call: ActionCalls[name],
  ) => { resolver: unknown } | undefined;
};

/**
 * How a table answers one action: decoding its calls, encoding answers, and
 * what it answers unmocked. `call` is what `decode` returns and every other
 * member receives; `answer` is what `encode` and `fallback` give, and `rpc`
 * the JSON-RPC answer `commit` makes of it (the answer itself, without one).
 *
 * Members are methods, whose parameters TypeScript checks both ways, so a
 * `Definition<BalanceCall>` is a `Definition`: the table holds every action's
 * the same way. That's sound because the table only passes each member what
 * the same definition's `decode`, `encode` or `fallback` produced.
 */
export type Definition<call extends object = object, rpc = unknown, answer = rpc> = {
  /** How calls and mocks are named in messages, e.g. `getBalance`. */
  name: string;
  /** Where to register a mock, for "not mocked" messages. */
  hint: string;
  /** `hint` for a call, where it depends on the call; `undefined` for `hint` itself. */
  hintFor?(call: call): string | undefined;
  /** The call `params` ask for; it may take a moment (a raw send's sender is recovered). */
  decode(params: readonly unknown[], method: string): call | Promise<call>;
  /**
   * Validates a value in viem's types and converts it to its JSON-RPC form.
   * `call` is `undefined` when validating a static value at registration.
   */
  encode(value: unknown, call: call | undefined): answer;
  zero: unknown;
  /**
   * Fixes what a static answer leaves to the chain at registration, as it
   * stands then, e.g. a receipt's block: the one it was mined in. `call` is
   * `pinnedCall`'s, when the pins settle it. A resolver's answer is made
   * when it answers, so it's left to `encode`.
   */
  fixAtRegistration?(value: unknown, call: call | undefined): unknown;
  /** Normalizes pinned fields at registration, e.g. checksumming addresses. */
  pin?(pinned: unknown): unknown;
  /**
   * The call a static answer is checked against at registration, from what
   * the mock pins, so a mismatch fails at `.returns()`. `undefined` when the
   * pins don't settle it (e.g. a matcher), leaving the check to request time.
   */
  pinnedCall?(pinned: unknown): call | undefined;
  /** What pinned params are matched against, deeply. Defaults to the call itself. */
  actual?(pinned: unknown, call: call): unknown;
  /** The answer when no mock matches, or `undefined` to report the call as unhandled. */
  fallback?(call: call): answer | undefined;
  /**
   * Turns the answer to a call into its JSON-RPC answer, once it's chosen
   * (a contract's, a mock's or the fallback's): a send places its
   * transaction on the chain and answers its hash. It runs only to answer,
   * never at registration, so it may change the chain; anything it throws,
   * it throws before changing anything.
   */
  commit?(answer: answer, call: call): rpc;
  /**
   * The answer a call already has, before any mock is asked: a repeated raw
   * send's hash, once its transaction is on the chain.
   */
  known?(call: call): rpc | undefined;
  /** Adds to a mock's builder, beyond `.returns()` and `.fails()`, e.g. a send's `.emits()`. */
  extendBuilder?(builder: Builder): void;
  /** A JSON-RPC answer in viem's types, as the action returns it; for history. Defaults to as is. */
  view?(rpc: rpc): unknown;
  /** Adds to what a resolver gets, beyond the call and `fail`. */
  extendContext?(context: object, call: call): void;
  /**
   * A registered contract's turn at the call (an estimate or a send of one
   * of its functions), prepared as the call arrives. Its mocks answer before
   * this table's: it owns its functions.
   */
  contractTurn?(call: call): ContractTurn<answer> | undefined;
  /**
   * The contract's mock that would answer the call in its turn, if any,
   * found without preparing the turn: nothing is recorded, and nothing runs.
   */
  contractMock?(call: call): { resolver: unknown } | undefined;
};

/**
 * What a table tells the rpc about a call it answered, for history. A call a
 * registered contract had a turn at also has the contract's record of it.
 */
export type ActionReport = {
  call: object;
  outcome: MockOutcome;
  contract?: MockCallRecord;
};

export type Table = ReturnType<typeof createTable>;
type Handler = MockHandler<ActionContext<object>>;

/** A param by its key, by its position from 1 for raw methods' params, or all of them. */
const paramName = (key: PinnedKey) =>
  key === null ? "params" : typeof key === "number" ? `param ${key + 1}` : key;

/** A table answering `definition`'s action; its calls are kept to `recordLimit`. */
export function createTable(definition: Definition, recordLimit: RecordLimit) {
  const mocks = createHandlers<ActionContext<object>, unknown>();
  const calls = createRecordList<object>(recordLimit);
  const actualOf = (pinned: unknown, call: object) =>
    definition.actual === undefined ? call : definition.actual(pinned, call);

  function register(params: unknown) {
    const pinned = params === undefined ? undefined : (definition.pin?.(params) ?? params);
    const handler = mocks.register(pinned, undefined);
    const builder = mocks.createBuilder(handler, (value) => {
      const given = value === zeroResult ? definition.zero : value;
      const call = definition.pinnedCall?.(pinned);
      const fixed = definition.fixAtRegistration?.(given, call) ?? given;
      encode(fixed, call);
      return fixed;
    });
    definition.extendBuilder?.(builder);
    return builder;
  }

  /** Unused mocks, each with the calls this table received instead. */
  const describeUnused = (list: Handler[]) =>
    list.map(
      (handler) =>
        `${describeMock(definition.name, handler)}${
          handler.resolver === undefined
            ? formatNoAnswer(".returns() or .fails()")
            : formatReceived(definition.name, received(handler), calls.total)
        }`,
    );

  /** The calls this table kept since the last clear, and where each differs from `handler`. */
  function received(handler: Handler): ReceivedCall[] {
    return calls.kept.map((call) => {
      const mismatched = mismatches(handler.pinned, actualOf(handler.pinned, call));
      const [key] = mismatched;
      return {
        call: formatMismatch(definition.name, "params" in call ? call.params : call, mismatched),
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
      // The contract's own outcome if it answered; otherwise the request's.
      if (contract?.outcome.type === "pending") contract.outcome = outcome;
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

  /** A value in viem's types as JSON-RPC; `zeroResult` is the action's zero. */
  function encode(value: unknown, call: object | undefined) {
    assertNoMatchers(value);
    return definition.encode(value === zeroResult ? definition.zero : value, call);
  }

  // The most specific matching handler wins; among equally specific ones,
  // the most recently registered wins.
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
      throw new MockNotFoundError(`No mock for ${formatCall(definition.name, call)}.`, {
        metaMessages:
          registered.length > 0
            ? ["Registered:", ...registered]
            : [`Mock it with ${definition.hintFor?.(call) ?? definition.hint}.`],
      });
    }

    const context = { ...call, fail };
    definition.extendContext?.(context, call);
    return await mocks.answerWith(
      handler,
      context,
      (value) => encode(value, call),
      definition.name,
    );
  }

  return {
    register,
    answer,
    /**
     * The mock that would answer `call` now, if any, found without answering
     * it: nothing runs, and no use is counted. A registered contract's mock
     * comes first, as in its turn.
     */
    findMock: (call: object) => definition.contractMock?.(call) ?? match(call).handler,
    /** The calls this table received, as they arrive. */
    calls,
    clearCalls() {
      calls.clear();
      mocks.clearUsage();
    },
    /** Removes every mock, whose builders then throw, and forgets the calls. */
    removeAll() {
      mocks.removeAll();
      calls.clear();
    },
    unusedMocks: () => describeUnused(mocks.unused(mocks.handlers)),
    /** Saves the registered mocks and their answers, to put back or compare against. */
    snapshot: (): Required<PartSnapshot> => mocks.snapshot(describeUnused),
  };
}
