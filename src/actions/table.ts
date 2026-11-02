import type { ChainState } from "../chain/state.js";
import type { ContractEstimate } from "../contracts/createMockContract.js";
import type { Registry } from "../contracts/registry.js";
import type { MockCallRecord } from "../contracts/types.js";
import type { LogStore } from "../logs/store.js";
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
import { type Handler as MockHandler, createHandlers } from "../mocking/handlers.js";
import { assertNoMatchers, mismatches } from "../mocking/matching.js";
import { failureOutcome, type MockOutcome } from "../mocking/outcomes.js";
import type { PinnedKey } from "../mocking/types.js";
import { zeroResult } from "../mocking/zeroResult.js";
import { MockNotFoundError } from "../shared/errors.js";
import type { PartSnapshot } from "../shared/parts.js";
import type { ActionContext } from "./types.js";

/** What an action's definition reads: the chain's state, what's registered, and emitted logs. */
export type ActionsContext = { state: ChainState; registry: Registry; logStore: LogStore };

/**
 * How a table answers one action: decoding its calls, encoding answers, and
 * what it answers unmocked. `call` is what `decode` returns and every other
 * member receives; `rpc` is the JSON-RPC answer `encode` and `fallback` give.
 *
 * Members are methods, whose parameters TypeScript checks both ways, so a
 * `Definition<BalanceCall>` is a `Definition`: the table holds every action's
 * the same way. That's sound because the table only passes each member what
 * the same definition's `decode`, `encode` or `fallback` produced.
 */
export type Definition<call extends object = object, rpc = unknown> = {
  /** How calls and mocks are named in messages, e.g. `getBalance`. */
  name: string;
  /** Where to register a mock, for "not mocked" messages. */
  hint: string;
  decode(params: readonly unknown[], method: string): call;
  /**
   * Validates a value in viem's types and converts it to its JSON-RPC form.
   * `call` is `undefined` when validating a static value at registration.
   */
  encode(value: unknown, call: call | undefined): rpc;
  zero: unknown;
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
  fallback?(call: call): rpc | undefined;
  /** A JSON-RPC answer in viem's types, as the action returns it; for history. Defaults to as is. */
  view?(rpc: rpc): unknown;
  /** Adds to what a resolver gets, beyond the call and `fail`. */
  extendContext?(context: object, call: call): void;
  /**
   * For estimates: a registered contract's turn, prepared as the call
   * arrives. Its mocks answer before this table's: it owns its functions.
   */
  contractTurn?(call: call): ContractEstimate | undefined;
};

/**
 * What a table tells the rpc about a call it answered, for history. An
 * estimate of a registered contract's function also has its decoded call.
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

export function createTable(definition: Definition) {
  const mocks = createHandlers<ActionContext<object>, unknown>();
  const history: object[] = [];
  const actualOf = (pinned: unknown, call: object) =>
    definition.actual === undefined ? call : definition.actual(pinned, call);

  function register(params: unknown) {
    const pinned = params === undefined ? undefined : (definition.pin?.(params) ?? params);
    const handler = mocks.register(pinned, undefined);
    return mocks.createBuilder(handler, (value) => {
      encode(value, definition.pinnedCall?.(pinned));
    });
  }

  /** Unused mocks, each with the calls this table received instead. */
  const describeUnused = (list: Handler[]) =>
    list.map(
      (handler) =>
        `${describeMock(definition.name, handler)}${
          handler.resolver === undefined
            ? formatNoAnswer(".returns() or .fails()")
            : formatReceived(definition.name, received(handler))
        }`,
    );

  /** The calls this table received since the last clear, and where each differs from `handler`. */
  function received(handler: Handler): ReceivedCall[] {
    return history.map((call) => {
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
    report?: (report: ActionReport) => void,
  ): Promise<unknown> {
    const call = definition.decode(params, method);
    history.push(call);
    const turn = definition.contractTurn?.(call);
    const reportAs = (outcome: MockOutcome) => {
      const contract = turn?.record;
      // The contract's own outcome if it answered; otherwise the request's.
      if (contract?.outcome.type === "pending") contract.outcome = outcome;
      report?.({ call, outcome, ...(contract && { contract }) });
    };
    try {
      const rpc = await answerCall(call, turn);
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

  async function answerCall(call: object, turn: ContractEstimate | undefined): Promise<unknown> {
    const answered = turn?.answer();
    if (answered) return await answered;
    // The most specific matching handler wins; among equally specific ones,
    // the most recently registered wins.
    const { handler, missed } = mocks.findAnswering(
      mocks.handlers,
      (candidate) => actualOf(candidate.pinned, call),
      definition.name,
    );
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
        details:
          registered.length > 0
            ? `Registered:\n${registered.join("\n")}`
            : `Mock it with ${definition.hint}.`,
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
    history,
    clearCalls() {
      history.length = 0;
      mocks.clearUsage();
    },
    /** Removes every mock, whose builders then throw, and forgets the calls. */
    removeAll() {
      mocks.removeAll();
      history.length = 0;
    },
    unusedMocks: () => describeUnused(mocks.unused(mocks.handlers)),
    /** Saves the registered mocks and their answers, to put back or compare against. */
    snapshot: (): Required<PartSnapshot> => mocks.snapshot(describeUnused),
  };
}
