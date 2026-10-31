import type { ChainState } from "../chain/state.js";
import type { ContractEstimate } from "../contracts/createMockContract.js";
import type { Registry } from "../contracts/registry.js";
import { failureOutcome } from "../history.js";
import type { MockCallRecord, MockOutcome } from "../history/types.js";
import type { LogStore } from "../logs/store.js";
import { MockFailure, fail } from "../mocking/faults.js";
import {
  type ReceivedCall,
  formatCall,
  formatMismatch,
  formatReceived,
} from "../mocking/format.js";
import { type Handler as MockHandler, createHandlers } from "../mocking/handlers.js";
import { assertNoMatchers, mismatches } from "../mocking/matching.js";
import { zeroResult } from "../mocking/zeroResult.js";
import { MockNotFoundError, MockRpcError } from "../shared/errors.js";
import type { PartCheckpoint } from "../shared/parts.js";
import type { ActionContext } from "./types.js";

/** What an action's definition reads: the chain's state, what's registered, and emitted logs. */
export type ActionsContext = { state: ChainState; registry: Registry; logStore: LogStore };

export type Definition = {
  /** How calls and mocks are named in messages, e.g. `getBalance`. */
  name: string;
  /** Where to register a mock, for "not mocked" messages. */
  hint: string;
  decode: (params: readonly unknown[], method: string) => object;
  /**
   * Validates a value in viem's types and converts it to its JSON-RPC form.
   * `call` is `undefined` when validating a static value at registration.
   */
  encode: (value: unknown, call: object | undefined) => unknown;
  zero: unknown;
  /** Normalizes pinned fields at registration, e.g. checksumming addresses. */
  pin?: (pinned: unknown) => unknown;
  /** What pinned params are matched against, deeply. Defaults to the call itself. */
  actual?: (pinned: unknown, call: object) => unknown;
  /** The answer when no mock matches, or `undefined` to report the call as unhandled. */
  fallback?: (call: object) => unknown;
  /** A JSON-RPC answer in viem's types, as the action returns it; for history. Defaults to as is. */
  view?: (rpc: unknown) => unknown;
  /** Adds to what a resolver gets, beyond the call and `fail`. */
  extendContext?: (context: object, call: object) => void;
  /**
   * For estimates: a registered contract's turn, prepared as the call
   * arrives. Its mocks answer before this table's: it owns its functions.
   */
  contractTurn?: (call: object) => ContractEstimate | undefined;
};

/**
 * What a table tells the rpc about a call it answered, for history. An
 * estimate of a registered contract's function also has its decoded call.
 */
export type ActionReport = {
  action: string;
  call: object;
  outcome: MockOutcome;
  contract?: MockCallRecord;
};

export type Table = ReturnType<typeof createTable>;
type Handler = MockHandler<ActionContext<object>>;

/**
 * What a resolver throws that's an answer, not a resolver error: a fault, or
 * what its context threw, a node's refusal or an unmocked address.
 */
const isAnswer = (error: unknown) =>
  error instanceof MockFailure ||
  error instanceof MockRpcError ||
  error instanceof MockNotFoundError;

export function createTable(definition: Definition) {
  const mocks = createHandlers<ActionContext<object>, unknown>();
  const history: object[] = [];
  const actualOf = definition.actual ?? ((_pinned: unknown, call: object) => call);

  function register(params: unknown) {
    const pinned = params === undefined ? undefined : (definition.pin?.(params) ?? params);
    const handler = mocks.add(pinned, undefined);
    return mocks.builderFor(handler, (value) => {
      encode(value, undefined);
    });
  }

  /** Unused mocks, each with the calls this table received instead. */
  const describeUnused = (list: Handler[]) =>
    list.map(
      (h) =>
        `${mocks.withLimit(formatCall(definition.name, h.pinned), h)}${formatReceived(definition.name, received(h))}`,
    );

  /** The calls this table received since the last clear, and where each differs from `handler`. */
  function received(handler: Handler): ReceivedCall[] {
    return history.map((call) => {
      const mismatched = mismatches(handler.pinned, actualOf(handler.pinned, call));
      const [key] = mismatched;
      return {
        call: formatMismatch(definition.name, "params" in call ? call.params : call, mismatched),
        differs: typeof key === "number" ? `param ${key + 1}` : key,
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
    const view = definition.view ?? ((rpc: unknown) => rpc);
    const reportAs = (outcome: MockOutcome) => {
      const contract = turn?.record;
      // The contract's own outcome if it answered; otherwise the request's.
      if (contract?.outcome.type === "pending") contract.outcome = outcome;
      report?.({ action: definition.name, call, outcome, ...(contract && { contract }) });
    };
    try {
      const rpc = await answerCall(call, turn);
      reportAs({ type: "result", value: view(rpc) });
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
    const handler = mocks.best(mocks.handlers, (h) => actualOf(h.pinned, call), definition.name);
    if (!handler) {
      const fallback = definition.fallback?.(call);
      if (fallback !== undefined) return fallback;
      if (turn) throw turn.miss;
      const registered = mocks.handlers.map(
        (h) => `  ${mocks.withLimit(formatCall(definition.name, h.pinned), h)}`,
      );
      throw new MockNotFoundError(`No mock for ${formatCall(definition.name, call)}.`, {
        details:
          registered.length > 0
            ? `Registered:\n${registered.join("\n")}`
            : `Mock it with ${definition.hint}.`,
      });
    }

    const context = { ...call, fail };
    definition.extendContext?.(context, call);
    return await mocks.run(handler, context, (value) => encode(value, call), {
      name: definition.name,
      passThrough: isAnswer,
    });
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
    remove() {
      mocks.removeAll();
      history.length = 0;
    },
    unusedMocks: () => describeUnused(mocks.unused(mocks.handlers)),
    /** Saves the registered mocks and their answers, to put back or compare against. */
    checkpoint: (): Required<PartCheckpoint> => mocks.checkpoint(describeUnused),
  };
}
