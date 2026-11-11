import type { ChainState } from "../chain/state.js";
import type { ContractTurn } from "../contracts/createMockContract.js";
import type { Registry } from "../contracts/registry.js";
import type { MockCallRecord } from "../contracts/types.js";
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
