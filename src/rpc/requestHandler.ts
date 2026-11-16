import { numberToHex } from "viem";

import type { Actions } from "../actions/createActions.js";
import { withoutTrailingNulls } from "../chain/params.js";
import type { ChainState } from "../chain/state.js";
import type { Dispatcher } from "../contracts/dispatch.js";
import { retryHint } from "../history/format.js";
import type { Recorder, Recording } from "../history/recorder.js";
import type { Asked, MockHistoryEntry, RpcRequest } from "../history/types.js";
import { MockFailure } from "../mocking/faults.js";
import { asMockError, isAnswer } from "../mocking/outcomes.js";
import { MockNotFoundError } from "../shared/errors.js";
import type { Faults } from "./faults.js";

/**
 * A function that answers a request, with the mock's own errors for what it
 * can't answer: see `createRequestHandler`.
 */
export type RequestHandler = (request: RpcRequest, retryCount?: number) => Promise<unknown>;

/** `asked` is `undefined` for a built-in or when its params don't decode. */
type RequestReading = {
  asked: Asked | undefined;
  answer: (recording: Recording) => Promise<unknown>;
};

/**
 * The mock's request pipeline: it reads what the request asks, records it,
 * fails it if a `failRequests()` fault applies, answers it, and records how
 * it ended. Nothing awaits before the answer, so requests made at once
 * reach their mocks in the order made.
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
   * came through one, for the retry hint. Throws answers (a fault, a revert,
   * or a node's refusal, as `isAnswer` names them), or the mock's own errors
   * for what it couldn't answer. An adapter turns the answers into its
   * client's errors, as `toViemError` does for viem.
   */
  async function handle(given: RpcRequest, retryCount?: number): Promise<unknown> {
    const { method, params } = given;
    // `unhandled` lists only `method` and `params`, and no `params` if none.
    const request: RpcRequest = params === undefined ? { method } : { method, params };
    // Read before the fault applies, so a faulted request's entry shows what
    // it asked, and answered only after, so a faulted one reaches no mock.
    const { asked, answer } = read(request);
    const recording = recorder.start(request, asked);

    const fault = faults.applyTo(method);
    if (fault !== undefined) {
      recording.fault(fault);
      throw new MockFailure(fault);
    }

    let rpc: unknown;
    try {
      rpc = await answer(recording);
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

  /**
   * Never throws: the answer refuses params that don't decode, so a fault
   * still wins over them, as a node that's down never reads them.
   */
  function read({ method, params }: RpcRequest): RequestReading {
    try {
      switch (method) {
        case "eth_chainId":
          return { asked: undefined, answer: () => Promise.resolve(numberToHex(state.chain.id)) };
        case "eth_blockNumber":
          return {
            asked: undefined,
            answer: () => Promise.resolve(numberToHex(state.blockNumber)),
          };
        case "eth_call": {
          const { asked, answer } = dispatcher.read(withoutTrailingNulls(params));
          return { asked, answer: (recording) => answer(recording.reporter) };
        }
        default: {
          const reading = actions.read(method, params);
          if (reading === undefined)
            throw new MockNotFoundError(`RPC method "${method}" is not mocked.`, {
              metaMessages: [`Mock it with mock.method("${method}", …).returns(…).`],
            });
          const { asked, answer } = reading;
          return { asked, answer: (recording) => answer(recording.reportAction) };
        }
      }
    } catch (error) {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- it's what reading threw
      return { asked: undefined, answer: () => Promise.reject(error) };
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
