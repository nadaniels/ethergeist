import {
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
  decodeFunctionData,
  decodeFunctionResult,
  getAddress,
  hexToBigInt,
  slice,
  toFunctionSelector,
} from "viem";

import { failureOutcome } from "../history/outcomes.js";
import type { MockCallRecord, MockOutcome } from "../history/types.js";
import { type EmitOptions, type MockEventLog } from "../logs/events.js";
import { MockFailure, fail } from "../mocking/faults.js";
import { formatContract } from "../mocking/format.js";
import { type Handler as MockHandler, createHandlers } from "../mocking/handlers.js";
import { MockNotFoundError, MockRevertError } from "../shared/errors.js";
import type { PartCheckpoint } from "../shared/parts.js";
import { encodeAnswer, createRevertError } from "./answers.js";
import { createContractApi } from "./createContractApi.js";
import { type Namespace, createFunctions, type Kind, pinArgs } from "./functions.js";
import { missError, unusedLine } from "./messages.js";
import type {
  CallContext,
  CreateMockContractParameters,
  MockCall,
  MockContract,
  ResolverContext,
  RevertFn,
  RevertSpec,
} from "./types.js";

type Context = ResolverContext<Abi, readonly unknown[]>;
/** What a contract's mock adds to the engine's: which function it's for, and in which namespace. */
type ContractFunction = { namespace: Namespace; abiItem: AbiFunction; selector: Hex };
type Handler = MockHandler<Context, ContractFunction>;

/**
 * An estimate's turn at a contract, prepared when the estimate arrives: the
 * call is decoded and recorded then, and answered only if it gets its turn.
 */
export type ContractEstimate = {
  /** Answers with the best matching mock; `undefined` when none matches. */
  answer(): Promise<Hex> | undefined;
  /** The error for the estimate when nothing else answers it either. */
  miss: MockNotFoundError;
  /** The estimated call, for history; its outcome is the contract's, once it answers. */
  record: MockCallRecord;
};

/** Internal: the public contract API plus the hooks the rpc calls. */
export type InternalMockContract<abi extends Abi = Abi> = {
  contract: MockContract<abi>;
  /** The contract for messages: its name and address, or just the address. */
  label: string;
  /** Whether this contract is registered at `address`, which must be checksummed. */
  matches(address: Address): boolean;
  /** Answers a call; `report` hears the decoded call and its outcome, however it ends. */
  resolve(data: Hex, context: CallContext, report?: (record: MockCallRecord) => void): Promise<Hex>;
  /** Prepares an estimate of `data`: see `ContractEstimate`. */
  estimate(data: Hex, context: CallContext): ContractEstimate;
  clearCalls(): void;
  /** Mocks other than defaults that haven't answered a call, formatted for messages. */
  unusedMocks(): string[];
  /** Saves the registered mocks and their answers, to put back or compare against. */
  checkpoint(): Required<PartCheckpoint>;
  /** Marks the contract removed: registering on it, or answering its mocks, throws. */
  detach(): void;
};

export function createMockContract<const abi extends Abi>(
  parameters: CreateMockContractParameters<abi>,
  hooks: {
    /** Called with every decoded call, so the rpc can keep a log across contracts. */
    onCall?: (call: MockCall) => void;
    /** Places a transaction's logs in the rpc's log store. */
    emit?: (logs: readonly MockEventLog[], options?: EmitOptions) => readonly unknown[];
  } = {},
): InternalMockContract<abi> {
  const { onCall = () => {}, emit = () => [] } = hooks;
  const { abi, name, defaults = {} } = parameters;
  // Also validates the address at registration.
  const address = getAddress(parameters.address);
  const label = formatContract(address, name);
  const mocks = createHandlers<Context, ContractFunction>();
  const history: MockCall[] = [];
  // Estimates aren't calls: `calls` and `mock.calls` are what `eth_call` asked.
  const estimates: MockCall[] = [];
  // Overloads share a name, so unused mocks find their calls by selector.
  const selectorOf = new WeakMap<MockCall, Hex>();
  let detached = false;
  /** Throws if `restore()` or `reset()` removed this contract. */
  function assertAttached() {
    if (detached)
      throw new Error(
        `The contract at ${label} was removed by restore() or reset(); register it again.`,
      );
  }
  // Handed to every resolver. RevertFn's generic signature only narrows what
  // callers may pass; createRevertError accepts every RevertSpec.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- generic signature, non-generic implementation
  const revert = ((spec?: RevertSpec) => {
    throw createRevertError(abi, spec);
  }) as RevertFn<Abi>;

  const { functionsIn, functionsBySelector, notInNamespaceError, findFunction } =
    createFunctions(abi);

  function register(
    namespace: Namespace,
    functionName: string,
    args: readonly unknown[] | undefined,
    /** For defaults: registered on a given overload, and exempt from `assertAllUsed()`. */
    asDefault?: { abiItem: AbiFunction },
  ) {
    assertAttached();
    const abiItem = asDefault?.abiItem ?? findFunction(namespace, functionName, args);
    const isDefault = asDefault !== undefined;

    const pinned = pinArgs(abiItem, args);
    const handler = mocks.add(
      pinned,
      { namespace, abiItem, selector: toFunctionSelector(abiItem) },
      { isDefault },
    );
    const builder = mocks.builderFor(handler, (value) => {
      encodeAnswer(handler, value);
    });
    return Object.assign(builder, {
      reverts(spec?: RevertSpec) {
        builder.returns(() => revert(spec));
      },
    });
  }

  // A default is keyed by name, so it answers every overload of that name.
  for (const namespace of ["read", "simulate", "estimateGas"] as const)
    for (const [functionName, resolver] of Object.entries(defaults[namespace] ?? {})) {
      const overloads = functionsIn[namespace].filter((f) => f.name === functionName);
      if (overloads.length === 0) throw notInNamespaceError(namespace, functionName);
      for (const abiItem of overloads)
        register(namespace, functionName, undefined, { abiItem }).returns(resolver);
    }

  const contract = createContractApi({
    abi,
    address,
    name,
    functions: { functionsIn, notInNamespaceError },
    register,
    calls: history,
    estimates,
    emit,
    assertAttached,
  });

  async function resolve(
    data: Hex,
    context: CallContext,
    report?: (record: MockCallRecord) => void,
  ): Promise<Hex> {
    const decoded: Decoded = { abiItem: undefined, call: undefined };
    const record = (outcome: MockOutcome): MockCallRecord => ({
      address,
      name,
      abiItem: decoded.abiItem,
      call: decoded.call,
      outcome,
    });
    try {
      const { hex, abiItem } = await answer(data, context, decoded);
      const value = decodeFunctionResult({ abi: [abiItem], functionName: abiItem.name, data: hex });
      report?.(record({ type: "result", value }));
      return hex;
    } catch (error) {
      report?.(record(failureOutcome(error, abi)));
      throw error;
    }
  }

  function estimate(data: Hex, context: CallContext): ContractEstimate {
    const record: MockCallRecord = {
      address,
      name,
      abiItem: undefined,
      call: undefined,
      outcome: { type: "pending" },
    };
    let call: MockCall;
    try {
      call = decode(data, context, "estimate");
    } catch (error) {
      if (!(error instanceof MockNotFoundError)) throw error;
      return { answer: () => undefined, miss: error, record };
    }
    record.call = call;
    record.abiItem = functionsBySelector.get(slice(data, 0, 4));
    const handler = match(call, "estimate");
    return {
      answer() {
        if (!handler) return undefined;
        return run(handler, call).then(
          (hex) => {
            record.outcome = { type: "result", value: hexToBigInt(hex) };
            return hex;
          },
          (error: unknown) => {
            record.outcome = failureOutcome(error, abi);
            throw error;
          },
        );
      },
      miss: missError(call, "estimate", label, candidates(call, "estimate")),
      record,
    };
  }

  /** What a call decoded to, for reporting however it ends. */
  type Decoded = { abiItem: AbiFunction | undefined; call: MockCall | undefined };

  /** Decodes and answers a call, leaving what it decoded in `decoded` for reporting. */
  async function answer(
    data: Hex,
    context: CallContext,
    decoded: Decoded,
  ): Promise<{ hex: Hex; abiItem: AbiFunction }> {
    const call = decode(data, context, "call");
    decoded.call = call;
    decoded.abiItem = functionsBySelector.get(slice(data, 0, 4));
    const handler = match(call, "call");
    if (!handler) throw missError(call, "call", label, candidates(call, "call"));
    return { hex: await run(handler, call), abiItem: handler.abiItem };
  }

  /** Decodes a call and records it as `kind`: an `eth_call` or an estimate. */
  function decode(data: Hex, context: CallContext, kind: Kind): MockCall {
    const selector = slice(data, 0, 4);
    let fn: { functionName: string; args: readonly unknown[] };
    try {
      const result = decodeFunctionData<Abi>({ abi, data });
      fn = { functionName: result.functionName, args: result.args ?? [] };
    } catch {
      throw new MockNotFoundError(
        `No function with selector ${selector} on mocked contract ${label}.`,
      );
    }

    const call: MockCall = { ...context, address, ...fn };
    selectorOf.set(call, selector);
    if (kind === "estimate") {
      estimates.push(call);
    } else {
      history.push(call);
      onCall(call);
    }
    return call;
  }

  /** The handlers that answer `kind` for the function `call` decoded to. */
  const candidates = (call: MockCall, kind: Kind) =>
    mocks.handlers.filter(
      (h) =>
        h.selector === selectorOf.get(call) &&
        (h.namespace === "estimateGas") === (kind === "estimate"),
    );

  // The most specific matching handler wins; among equally specific ones,
  // the most recently registered wins, so per-test mocks override defaults.
  function match(call: MockCall, kind: Kind): Handler | undefined {
    return mocks.best(candidates(call, kind), () => call.args, call.functionName);
  }

  /** Answers `call` with `handler`; a revert or a fault is an answer, not a resolver error. */
  const run = (handler: Handler, call: MockCall): Promise<Hex> =>
    mocks.run(handler, { ...call, revert, fail }, (value) => encodeAnswer(handler, value), {
      name: call.functionName,
      passThrough: (error) => error instanceof MockRevertError || error instanceof MockFailure,
    });

  /** Unused mocks, each with its contract and the calls its function received instead. */
  const describeUnused = (list: Handler[]) =>
    list.map((h) =>
      unusedLine(
        h,
        label,
        (h.namespace === "estimateGas" ? estimates : history).filter(
          (call) => selectorOf.get(call) === h.selector,
        ),
      ),
    );

  return {
    contract,
    label,
    matches: (other) => other === address,
    resolve,
    estimate,
    clearCalls() {
      history.length = 0;
      estimates.length = 0;
      mocks.clearUsage();
    },
    unusedMocks: () => describeUnused(mocks.unused(mocks.handlers)),
    checkpoint: () => mocks.checkpoint(describeUnused),
    detach() {
      detached = true;
      mocks.removeAll();
    },
  };
}
