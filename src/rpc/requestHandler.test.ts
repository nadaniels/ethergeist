import { describe, expect, test } from "vite-plus/test";

import { createActions } from "../actions/createActions.js";
import { createChainState } from "../chain/state.js";
import { createDispatch } from "../contracts/dispatch.js";
import { createRegistry } from "../contracts/registry.js";
import { createRecorder } from "../history/recorder.js";
import {
  MockInternalError,
  MockRpcError,
  MockSetupError,
  removedMockError,
} from "../shared/errors.js";
import type { RecordLimit } from "../shared/records.js";
import { createTransactionStore } from "../transactions/store.js";
import { createFaults } from "./faults.js";
import { createRequestHandler } from "./requestHandler.js";

/** A limit that keeps everything. */
const unlimited: RecordLimit = { limit: Infinity, onDrop() {} };

/** The mock's request handler, with an `eth_call` that throws `thrown`. */
function setup(thrown: unknown) {
  const state = createChainState({});
  const registry = createRegistry(state);
  const transactions = createTransactionStore({ state, registry });
  const actions = createActions({ state, registry, transactions }, unlimited);
  const recorder = createRecorder({
    multicallAddress: state.multicallAddress,
    actionFor: actions.actionFor,
    debug: undefined,
    formatContext: {},
    recordLimit: unlimited,
  });
  const dispatcher = {
    ...createDispatch({ state, registry }),
    call: () => {
      throw thrown;
    },
  };
  const handle = createRequestHandler({
    state,
    recorder,
    faults: createFaults(),
    actions,
    dispatcher,
  });
  const request = () => handle({ method: "eth_call", params: [{}, "latest"] });
  return { recorder, request };
}

describe("createRequestHandler()", () => {
  test("an error the mock didn't anticipate is a MockInternalError, counted as unhandled", async () => {
    const thrown = new TypeError("x is undefined");
    const { recorder, request } = setup(thrown);

    const error = await request().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MockInternalError);
    expect(error).toHaveProperty("cause", thrown);
    expect(recorder.view.entries[0]?.outcome).toEqual({ type: "unhandled", error });
    expect(recorder.unhandled.kept.map((entry) => entry.error)).toEqual([error]);
  });

  test("a mock error that escapes is thrown as is, counted as unhandled", async () => {
    const thrown = removedMockError();
    const { recorder, request } = setup(thrown);

    const error = await request().catch((caught: unknown) => caught);

    expect(error).toBe(thrown);
    expect(error).toBeInstanceOf(MockSetupError);
    expect(recorder.unhandled.kept.map((entry) => entry.error)).toEqual([thrown]);
  });

  test("a node's refusal is an answer, not unhandled", async () => {
    const thrown = new MockRpcError(-32602, "invalid params");
    const { recorder, request } = setup(thrown);

    expect(await request().catch((caught: unknown) => caught)).toBe(thrown);
    expect(recorder.view.entries[0]?.outcome).toEqual({
      type: "rpcError",
      code: -32602,
      message: "invalid params",
    });
    expect(recorder.unhandled.kept).toEqual([]);
  });
});
