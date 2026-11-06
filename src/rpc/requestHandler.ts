import { numberToHex } from "viem";

import type { Actions } from "../actions/createActions.js";
import { withoutTrailingNulls } from "../chain/params.js";
import type { ChainState } from "../chain/state.js";
import type { Dispatcher } from "../contracts/dispatch.js";
import { retryHint } from "../history/format.js";
import { type Recorder, outcomeOf, reporterFor, valueOf } from "../history/recorder.js";
import type { MockHistoryEntry, RpcRequest } from "../history/types.js";
import { MockFailure } from "../mocking/faults.js";
import type { MockOutcome } from "../mocking/outcomes.js";
import { asMockError, isAnswer } from "../mocking/outcomes.js";
import { MockNotFoundError } from "../shared/errors.js";
import type { Faults } from "./faults.js";

/** Answers a request with the mock's own errors: see `createRequestHandler`. */
export type RequestHandler = (request: RpcRequest, retryCount?: number) => Promise<unknown>;

/**
 * The mock's request pipeline: it records the request, fails it if a
 * `failRequests()` fault applies, answers it (built-ins, `eth_call`, then
 * actions and raw methods), and records how it ended.
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
   * came through one, for the retry hint. Throws answers (a fault, a revert
   * or a node's refusal, as `isAnswer` names them), or the mock's own errors
   * for what it couldn't answer. An adapter turns the answers into its
   * client's errors, as `toViemError` does for viem.
   */
  async function handle(given: RpcRequest, retryCount?: number): Promise<unknown> {
    const { method, params } = given;
    // `unhandled` lists only `method` and `params`, and no `params` if none.
    const request: RpcRequest = params === undefined ? { method } : { method, params };
    const historyEntry = recorder.start(request);

    const fault = faults.applyTo(method);
    if (fault !== undefined) {
      recorder.settle(historyEntry, { type: "fault", fault, source: "failRequests" });
      throw new MockFailure(fault);
    }

    let answered: { rpc: unknown; value: unknown };
    try {
      answered = await answer(request, historyEntry);
    } catch (caught) {
      // Anything that isn't an answer or one of the mock's errors is a bug in
      // the mock, wrapped: thrown as is, viem would retry it with backoff.
      const error = withRetryHint(
        isAnswer(caught) ? caught : asMockError(caught),
        historyEntry,
        retryCount,
      );
      const outcome = outcomeOf(historyEntry, error);
      // Recorded because callers can swallow these: app code with a fallback,
      // or viem's multicall turning a failed batch into per-call failures.
      // First, so a `debug` function that throws in `settle` can't skip it.
      if (outcome.type === "unhandled") recorder.markUnhandled(request, outcome.error);
      recorder.settle(historyEntry, outcome);
      throw error;
    }
    // Outside the try: a throw here is `debug`'s, not the answer's.
    recorder.settle(historyEntry, { type: "result", value: answered.value });
    return answered.rpc;
  }

  async function answer(
    request: RpcRequest,
    historyEntry: MockHistoryEntry,
  ): Promise<{ rpc: unknown; value: unknown }> {
    let actionOutcome: MockOutcome | undefined;
    const rpc = await answerRpc(request, historyEntry, (outcome) => {
      actionOutcome = outcome;
    });
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
        return await dispatcher.call(withoutTrailingNulls(params), reporterFor(historyEntry));
      default: {
        const answered = actions.answer(method, params, (report) => {
          if (historyEntry.type !== "action") return;
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the table for historyEntry.action decoded it
          historyEntry.call = report.call as typeof historyEntry.call;
          if (report.contract) historyEntry.contract = report.contract;
          onAction(report.outcome);
        });
        if (answered) return await answered;
        throw new MockNotFoundError(`RPC method "${method}" is not mocked.`, {
          metaMessages: [`Mock it with mock.method("${method}", …).returns(…).`],
        });
      }
    }
  }

  /**
   * A "not mocked" error, explained when it's viem retrying past a limited
   * mock's fault.
   */
  function withRetryHint(
    error: unknown,
    historyEntry: MockHistoryEntry,
    retryCount: number | undefined,
  ) {
    if (!(error instanceof MockNotFoundError)) return error;
    const hint = retryHint(recorder.view.faultRetried(historyEntry), retryCount);
    if (hint === undefined) return error;
    return new MockNotFoundError(error.shortMessage, {
      metaMessages: [...(error.metaMessages ?? []), hint],
      cause: error.cause instanceof Error ? error.cause : undefined,
    });
  }

  return handle;
}
