import {
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type Address,
  type Hex,
  decodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionResult,
  getAbiItem,
  getAddress,
  hexToBigInt,
  slice,
  toFunctionSelector,
  toFunctionSignature,
} from "viem";
import { MockNotFoundError, MockRevertError } from "./shared/errors.js";
import { type EmitOptions, type MockEventLog, encodeEventLog } from "./logs/events.js";
import type { PartCheckpoint } from "./checkpoint.js";
import type {
  CallContext,
  CreateMockContractParameters,
  MockCall,
  MockContract,
  ResolverContext,
  RevertFn,
  RevertSpec,
} from "./contracts/types.js";
import { MockFailure, fail } from "./mocking/faults.js";
import { encodeGas } from "./mocking/gas.js";
import { type Handler as MockHandler, createHandlers, withCalls } from "./mocking/handlers.js";
import {
  type ReceivedCall,
  formatCall,
  formatContract,
  formatMismatch,
  formatReceived,
} from "./mocking/format.js";
import { failureOutcome } from "./history.js";
import type { MockCallRecord, MockOutcome } from "./history/types.js";
import { assertNoMatchers, findMatcher, isMatch, mismatches } from "./mocking/matching.js";
import { checksumAddresses } from "./contracts/pins.js";
import { normalizeResult } from "./contracts/results.js";
import { createRevertError } from "./contracts/revert.js";

type Namespace = "read" | "simulate" | "estimateGas";
/** What a contract answers: an `eth_call`, or an `eth_estimateGas`. */
type Kind = "call" | "estimate";

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
  checkpoint(): PartCheckpoint;
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
  // Handed to every resolver. RevertFn's generic signature only narrows what
  // callers may pass; createRevertError accepts every RevertSpec.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- generic signature, non-generic implementation
  const revert = ((spec?: RevertSpec) => {
    throw createRevertError(abi, spec);
  }) as RevertFn<Abi>;

  const functionsOf = (mutabilities: readonly string[]) =>
    (abi as Abi).filter(
      (item): item is AbiFunction =>
        item.type === "function" && mutabilities.includes(item.stateMutability),
    );
  const writes = functionsOf(["nonpayable", "payable"]);
  const functionsIn = {
    read: functionsOf(["view", "pure"]),
    simulate: writes,
    estimateGas: writes,
  };
  const functionsBySelector = new Map(
    [...functionsIn.read, ...functionsIn.simulate].map((f) => [toFunctionSelector(f), f]),
  );

  /** For a name that isn't in `namespace`: says where it is instead, if anywhere. */
  function notInNamespaceError(namespace: Namespace, functionName: string) {
    const other = namespace === "read" ? "simulate" : "read";
    const elsewhere = functionsIn[other].find((f) => f.name === functionName);
    if (!elsewhere) return new Error(`No function "${functionName}" on this contract's ABI.`);
    const kind = `"${functionName}" is a ${elsewhere.stateMutability} function`;
    return namespace === "estimateGas"
      ? new Error(`${kind}; viem estimates gas only for nonpayable and payable functions.`)
      : new Error(`${kind}; register it under ${other}, not ${namespace}.`);
  }

  /**
   * The function `args` call, looked up only within `namespace`, so an overload
   * never binds across namespaces. viem's `getAbiItem` tells overloads apart by
   * their args' values, and silently picks the first when none fits. Matchers
   * fit no type, so with matchers, overloads are told apart by the exact args
   * alone. Args holding a matcher anywhere are skipped whole: a `match.partial`
   * could rule overloads out field by field, but doesn't yet.
   */
  function findFunction(
    namespace: Namespace,
    functionName: string,
    args: readonly unknown[] | undefined,
  ): AbiFunction {
    const overloads = functionsIn[namespace].filter((f) => f.name === functionName);
    // viem would pick the first overload; "any args" can't say which one.
    if (args === undefined && overloads.length > 1)
      throw new Error(
        `Ambiguous overload for ${functionName}(*): pin args to choose one, e.g. ` +
          `[match.any()]:\n${listSignatures(overloads)}`,
      );
    if (overloads.length < 2 || findMatcher(args) === undefined) {
      const abiItem = getAbiItem({ abi: functionsIn[namespace], name: functionName, args });
      // viem's type assumes a match, but untyped callers can pass any name.
      if (abiItem === undefined) throw notInNamespaceError(namespace, functionName);
      return abiItem;
    }

    const fits = overloads.filter(
      (f) =>
        f.inputs.length === args!.length &&
        args!.every((arg, i) => findMatcher(arg) !== undefined || isOfType(f.inputs[i]!, arg)),
    );
    if (fits.length === 1) return fits[0]!;
    const call = formatCall(functionName, args);
    throw new Error(
      fits.length === 0
        ? `No overload of "${functionName}" takes ${call}. Overloads:\n${listSignatures(overloads)}`
        : `Ambiguous overload for ${call}: pin an arg that tells them apart. It fits:\n${listSignatures(fits)}`,
    );
  }

  function register(
    namespace: Namespace,
    functionName: string,
    args: readonly unknown[] | undefined,
    /** For defaults: registered on a given overload, and exempt from `assertAllUsed()`. */
    asDefault?: { abiItem: AbiFunction },
  ) {
    if (detached)
      throw new Error(
        `The contract at ${label} was removed by restore() or reset(); register it again.`,
      );
    const abiItem = asDefault?.abiItem ?? findFunction(namespace, functionName, args);
    const isDefault = asDefault !== undefined;

    // Checksummed so messages show addresses one way, and a malformed one fails here.
    const pinned = args?.map((arg, i) => {
      const input = abiItem.inputs[i];
      return input ? checksumAddresses(input, arg) : arg;
    });
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

  // Overloads share one entry, as in viem's `getContract`.
  function buildNamespace(namespace: Namespace) {
    const entries: Record<string, unknown> = {};
    const callsIn = namespace === "estimateGas" ? estimates : history;
    for (const { name: functionName } of functionsIn[namespace]) {
      if (functionName in entries) continue;
      entries[functionName] = withCalls(
        (args?: readonly unknown[]) => register(namespace, functionName, args),
        () => callsIn.filter((call) => call.functionName === functionName),
      );
    }
    // Untyped callers reaching for the other namespace's functions get a pointer
    // to the right one instead of "is not a function". Hidden from Object.keys.
    for (const { name: functionName } of functionsIn[namespace === "read" ? "simulate" : "read"]) {
      if (functionName in entries) continue;
      Object.defineProperty(entries, functionName, {
        value: () => {
          throw notInNamespaceError(namespace, functionName);
        },
      });
    }
    return entries;
  }

  // Built from the ABI at runtime; `MockContract<abi>` describes the same shape.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime-built typed facade
  const contract = {
    address,
    name,
    abi,
    get calls() {
      return [...history];
    },
    read: buildNamespace("read"),
    simulate: buildNamespace("simulate"),
    estimateGas: buildNamespace("estimateGas"),
    events: Object.fromEntries(
      (abi as Abi).flatMap((item) =>
        item.type === "event"
          ? [[item.name, (args?: unknown) => encodeEventLog(abi, address, item.name, args)]]
          : [],
      ),
    ),
    emit: Object.fromEntries(
      (abi as Abi).flatMap((item) =>
        item.type === "event"
          ? [
              [
                item.name,
                (args?: unknown, options?: EmitOptions) => {
                  if (detached)
                    throw new Error(
                      `The contract at ${label} was removed by restore() or reset(); register it again.`,
                    );
                  return emit([encodeEventLog(abi, address, item.name, args)], options)[0];
                },
              ],
            ]
          : [],
      ),
    ),
  } as unknown as MockContract<abi>;

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
      miss: missError(call, "estimate"),
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
    if (!handler) throw missError(call, "call");
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
    return mocks.best(
      candidates(call, kind),
      (h, options) => h.pinned === undefined || isMatch(h.pinned, call.args, options),
      call.functionName,
    );
  }

  function missError(call: MockCall, kind: Kind): MockNotFoundError {
    const registered = candidates(call, kind).map(
      (h) => `  ${mocks.withLimit(formatCall(call.functionName, h.pinned), h)}`,
    );
    const what = kind === "estimate" ? "estimateGas mock" : "mock";
    const none =
      kind === "estimate"
        ? `No estimateGas mocks registered for "${call.functionName}"; a simulate mock doesn't answer estimates.`
        : `No mocks registered for "${call.functionName}".`;
    return new MockNotFoundError(
      `No ${what} for ${formatCall(call.functionName, call.args)} on ${label}.`,
      { details: registered.length > 0 ? `Registered:\n${registered.join("\n")}` : none },
    );
  }

  /** Answers `call` with `handler`; a revert or a fault is an answer, not a resolver error. */
  const run = (handler: Handler, call: MockCall): Promise<Hex> =>
    mocks.run(handler, { ...call, revert, fail }, (value) => encodeAnswer(handler, value), {
      name: call.functionName,
      passThrough: (error) => error instanceof MockRevertError || error instanceof MockFailure,
    });

  /** Unused mocks, each with its contract and the calls its function received instead. */
  const describeUnused = (list: Handler[]) =>
    list.map(
      (h) =>
        `${mocks.withLimit(formatCall(h.abiItem.name, h.pinned), h)} on ${label}${formatReceived(h.abiItem.name, received(h))}`,
    );

  /** The calls `handler`'s function received since the last clear, and where each differs. */
  function received(handler: Handler): ReceivedCall[] {
    return (handler.namespace === "estimateGas" ? estimates : history)
      .filter((call) => selectorOf.get(call) === handler.selector)
      .map((call) => {
        const mismatched =
          handler.pinned === undefined ? [] : mismatches(handler.pinned, call.args);
        const index = mismatched[0];
        // Inputs may be unnamed (`""`); those are numbered from 1.
        const inputName =
          typeof index === "number" ? handler.abiItem.inputs[index]?.name : undefined;
        const differs =
          index === undefined
            ? undefined
            : inputName === undefined || inputName === ""
              ? `arg ${Number(index) + 1}`
              : inputName;
        return { call: formatMismatch(call.functionName, call.args, mismatched), differs };
      });
  }

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

function listSignatures(functions: readonly AbiFunction[]): string {
  return functions.map((f) => `  ${toFunctionSignature(f)}`).join("\n");
}

/** Whether `value` encodes as `parameter`'s type. */
function isOfType(parameter: AbiParameter, value: unknown): boolean {
  try {
    encodeAbiParameters([parameter], [value]);
    return true;
  } catch {
    return false;
  }
}

/** Answers a contract call `eth_call`'s way, or an estimate as gas, as a JSON-RPC quantity. */
function encodeAnswer({ namespace, abiItem }: Handler, value: unknown): Hex {
  return namespace === "estimateGas" ? encodeGas(value) : encodeResult(abiItem, value);
}

function encodeResult(abiItem: AbiFunction, value: unknown): Hex {
  assertNoMatchers(value);
  return encodeFunctionResult({
    abi: [abiItem],
    functionName: abiItem.name,
    // viem types `result` as a tuple for a non-literal AbiFunction, but it
    // takes a bare value for single-output functions at runtime.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- viem's type is narrower than its runtime
    result: normalizeResult(abiItem.outputs, value) as readonly unknown[] | undefined,
  });
}
