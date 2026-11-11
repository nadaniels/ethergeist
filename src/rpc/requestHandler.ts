import { numberToHex } from "viem";

import type { Actions } from "../actions/createActions.js";
import { withoutTrailingNulls } from "../chain/params.js";
import type { ChainState } from "../chain/state.js";
import type { Dispatcher } from "../contracts/dispatch.js";
import { retryHint } from "../history/format.js";
import type { Recorder, Recording } from "../history/recorder.js";
import type { MockHistoryEntry, RpcRequest } from "../history/types.js";
import { MockFailure } from "../mocking/faults.js";
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
    const recording = recorder.start(request);

    const fault = faults.applyTo(method);
    if (fault !== undefined) {
      recording.fault(fault);
      throw new MockFailure(fault);
    }

    let rpc: unknown;
    try {
      rpc = await answer(request, recording);
    } catch (caught) {
      const error = withRetryHint(
        isAnswer(caught) ? caught : asMockError(caught),
        recording.entry,
        retryCount,
      );
      recording.settle({ error });
      throw error;
    }
    // Outside the try: a throw here is history's (`debug` or its formatting),
    // not the answer's.
    recording.settle({ rpc });
    return rpc;
  }

  async function answer({ method, params }: RpcRequest, recording: Recording): Promise<unknown> {
    switch (method) {
      case "eth_chainId":
        return numberToHex(state.chain.id);
      case "eth_blockNumber":
        return numberToHex(state.blockNumber);
      case "eth_call":
        return await dispatcher.call(withoutTrailingNulls(params), recording.reporter);
      default: {
        const answered = actions.answer(method, params, recording.reportAction);
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
