import { numberToHex } from "viem";

import type { Actions } from "../actions/createActions.js";
import type { ChainState } from "../chain/state.js";
import type { Dispatcher } from "../contracts/dispatch.js";
import { retryHint } from "../history/format.js";
import { type Recorder, outcomeOf, reporterFor, valueOf } from "../history/recorder.js";
import type { MockHistoryEntry, RpcRequest } from "../history/types.js";
import { MockFailure } from "../mocking/faults.js";
import type { MockOutcome } from "../mocking/outcomes.js";
import { MockNotFoundError, MockResolverError } from "../shared/errors.js";
import type { Faults } from "./faults.js";

/** Answers a request with the mock's own errors: see `createRequestHandler`. */
export type RequestHandler = (request: RpcRequest, retryCount?: number) => Promise<unknown>;

/**
 * The mock's request pipeline: record the request, fail it if a
 * `failRequests()` fault applies, answer it (built-ins, `eth_call`, then
 * actions and raw methods), and record how it ended.
 */
export function createRequestHandler({
  state,
  recorder,
  faults,
  actions,
  dispatcher,
}: {
  state: ChainState;
  recorder: Recorder;
  faults: Faults;
  actions: Actions;
  dispatcher: Dispatcher;
}): RequestHandler {
  /**
   * Answers a request, recording it. `retryCount` is the transport's, when it
   * came through one, for the retry hint. Throws the mock's own errors: a
   * fault (`MockFailure`), a revert, a node's refusal (`MockRpcError`), or
   * what it couldn't answer; adapters turn them into their client's errors.
   */
  async function handle(given: RpcRequest, retryCount?: number): Promise<unknown> {
    const { method, params } = given;
    // As recorded: without `params` when the request had none.
    const request: RpcRequest = params === undefined ? { method } : { method, params };
    const historyEntry = recorder.start(request);

    // The most recent fault wins, like mocks. A fault is a deliberate answer, so
    // it isn't recorded as unhandled.
    const fault = faults.applyTo(method);
    if (fault !== undefined) {
      recorder.settle(historyEntry, { type: "fault", fault, source: "failRequests" });
      throw new MockFailure(fault);
    }

    try {
      const answered = await answer(request, historyEntry);
      recorder.settle(historyEntry, { type: "result", value: answered.value });
      return answered.rpc;
    } catch (caught) {
      const error = withRetryHint(caught, historyEntry, retryCount);
      recorder.settle(historyEntry, outcomeOf(historyEntry, error));
      // Recorded because callers can swallow these: app code with a fallback,
      // or viem's multicall turning a failed batch into per-call failures.
      if (error instanceof MockNotFoundError || error instanceof MockResolverError)
        recorder.markUnhandled(request, error);
      throw error;
    }
  }

  async function answer(
    request: RpcRequest,
    historyEntry: MockHistoryEntry,
  ): Promise<{ rpc: unknown; value: unknown }> {
    let actionOutcome: MockOutcome | undefined;
    const rpc = await answerRpc(request, historyEntry, (outcome) => {
      actionOutcome = outcome;
    });
    // An action's table knows its value in viem's types; for the rest, decode the answer.
    const value =
      actionOutcome?.type === "result" ? actionOutcome.value : valueOf(historyEntry, rpc);
    return { rpc, value };
  }

  async function answerRpc(
    { method, params }: RpcRequest,
    historyEntry: MockHistoryEntry,
    onAction: (outcome: MockOutcome) => void,
  ): Promise<unknown> {
    switch (method) {
      case "eth_chainId":
        return numberToHex(state.chainId);
      case "eth_blockNumber":
        return numberToHex(state.blockNumber);
      case "eth_call":
        return await dispatcher.call(params, reporterFor(historyEntry));
      default: {
        const answered = actions.answer(method, params, (report) => {
          if (historyEntry.type !== "action") return;
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the table for historyEntry.action decoded it
          historyEntry.call = report.call as typeof historyEntry.call;
          if (historyEntry.action === "estimateGas" && report.contract)
            historyEntry.contract = report.contract;
          onAction(report.outcome);
        });
        if (answered) return await answered;
        throw new MockNotFoundError(`RPC method "${method}" is not mocked.`, {
          details: `Mock it with mock.method("${method}", …).returns(…).`,
        });
      }
    }
  }

  /** A "not mocked" error, explained when it's viem retrying past a limited mock's fault. */
  function withRetryHint(
    error: unknown,
    historyEntry: MockHistoryEntry,
    retryCount: number | undefined,
  ) {
    if (!(error instanceof MockNotFoundError)) return error;
    const hint = retryHint(recorder.history, recorder.history.indexOf(historyEntry), retryCount);
    if (hint === undefined) return error;
    return new MockNotFoundError(error.shortMessage, {
      details: error.details === "" ? hint : `${error.details}\n${hint}`,
    });
  }

  return handle;
}
