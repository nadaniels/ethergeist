import type { ChainState } from "../chain/state.js";
import type { ContractTurn } from "../contracts/createMockContract.js";
import type { Registry } from "../contracts/registry.js";
import type { MockCallRecord } from "../contracts/types.js";
import type { MockOutcome } from "../mocking/outcomes.js";
import type { RecordLimit } from "../shared/records.js";
import type { TransactionStore } from "../transactions/store.js";
import { type MockDefinition, type MockSetOptions, createMockSet } from "./mockSet.js";

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
 * How a table answers one action: its mocks (see `MockDefinition`), decoding
 * its calls, and what it answers unmocked. `rpc` is its JSON-RPC answer,
 * which `encode` and `fallback` give.
 *
 * At a request, `decode` runs as it arrives and `view` last. Between them a
 * mock answers, or else `fallback`.
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
 * `contract` is a registered contract's pending record of the call, for an
 * estimate or a send to it with data.
 */
export type ActionAsked = { type: "action"; call: object; contract: MockCallRecord | undefined };

/**
 * Only the answer receives the call (adds it to its `.calls`), and it runs
 * only if no `failRequests()` fault fails the request first.
 */
export type ActionReading = {
  asked: ActionAsked;
  answer: (report: (report: ActionReport) => void) => Promise<unknown>;
};

export type ActionReport = {
  /**
   * The call's outcome when it was answered, with the answer in viem's
   * types. Left out when the call threw: the request's error says how it
   * ended.
   */
  outcome?: { type: "result"; value: unknown };
  /** Only for a call a registered contract had a turn at. */
  contractOutcome?: MockOutcome | undefined;
};

/**
 * Runs `answer`, then tells history how it ended: with the answer in viem's
 * types, as `view` gives it, or without an outcome when it threw, and with
 * `turn`'s outcome for its record.
 */
export async function reportAnswer<rpc>(
  {
    turn,
    report,
    view,
  }: {
    turn?: ContractTurn | undefined;
    report: (report: ActionReport) => void;
    view: (rpc: rpc) => unknown;
  },
  answer: () => Promise<rpc>,
): Promise<rpc> {
  try {
    const rpc = await answer();
    const outcome = { type: "result" as const, value: view(rpc) };
    report({ outcome, contractOutcome: turn?.outcomeOf({ outcome }) });
    return rpc;
  } catch (error) {
    report({ contractOutcome: turn?.outcomeOf({ error }) });
    throw error;
  }
}

/** The mocks and calls of one action or raw method: see `createTable`. */
export type Table = ReturnType<typeof createTable>;

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
    read(method: string, params: readonly unknown[]): ActionReading {
      const call = definition.decode(params, method);
      return {
        asked: { type: "action", call, contract: undefined },
        async answer(report) {
          mockSet.calls.add(call);
          return await reportAnswer({ report, view }, () => answerCall(call));
        },
      };
    },
  };
}
