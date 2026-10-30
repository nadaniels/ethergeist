import {
  type Address,
  type BlockTag,
  type Hash,
  type Hex,
  type RpcBlock,
  type RpcTransactionReceipt,
  type RpcLog,
  formatBlock,
  formatLog,
  formatTransactionReceipt,
  getAddress,
  hexToBigInt,
  hexToNumber,
  isHex,
  numberToHex,
} from "viem";
import {
  type Fees,
  type MockBlock,
  type MockFeeHistory,
  blobBaseFee,
  feeHistory,
  numberOfBlockHash,
  toRpcBlock,
  toRpcFeeHistory,
} from "./blocks.js";
import type { PartCheckpoint } from "./checkpoint.js";
import { type MockReceipt, completeReceipt, toRpcReceipt } from "./receipts.js";
import { MockNotFoundError, MockResolverError, MockRpcError, removedMockError } from "./errors.js";
import type { EmittedLog } from "./events.js";
import { type MockOutcome, errorOutcome } from "./history.js";
import { type LogsCall, createLogStore } from "./logs.js";
import { MockFailure, type MockFault, fail } from "./faults.js";
import {
  type ReceivedCall,
  formatCall,
  formatLimit,
  formatMismatch,
  formatReceived,
} from "./format.js";
import {
  type Specificity,
  assertNoMatchers,
  bestMatch,
  isMatch,
  mismatches,
  setLimit,
  specificity,
} from "./match.js";
import { isPlainObject, zeroResult } from "./result.js";

/** What a call to `getBalance` asked for. Block tags resolve to the mock's block number. */
export type BalanceCall = { address: Address; blockNumber: bigint };
/** What a call to `getCode` asked for. Block tags resolve to the mock's block number. */
export type CodeCall = { address: Address; blockNumber: bigint };
/**
 * What a call to `getBlock` asked for. `blockNumber` is always set: a tag
 * resolves to the mock's block number, and a generated block's hash to its
 * number. An unknown hash (one a mock pins) uses the mock's block number.
 */
export type BlockCall = {
  blockNumber: bigint;
  blockHash?: Hash;
  blockTag?: BlockTag;
  includeTransactions: boolean;
};
/** A JSON value, as JSON-RPC carries it: quantities are hex strings, not bigints. */
export type RpcValue =
  | string
  | number
  | boolean
  | null
  | readonly RpcValue[]
  | { readonly [key: string]: RpcValue };

/**
 * What a call to `getFeeHistory` asked for. `blockNumber` is the newest
 * block: a tag resolves to the mock's block number. `rewardPercentiles` is
 * left out when the request has none.
 */
export type FeeHistoryCall = {
  blockCount: number;
  blockNumber: bigint;
  blockTag?: BlockTag;
  rewardPercentiles?: readonly number[];
};
/** What a call to an action without params asked for: nothing. */
export type EmptyCall = Record<string, never>;
/** What a call to `getTransactionReceipt` asked for. */
export type ReceiptCall = { hash: Hash };
/** A raw JSON-RPC request answered by `mock.method()`. */
export type MethodCall = { method: string; params: readonly RpcValue[] };

export type ActionContext<call> = call & {
  /**
   * Fail the whole JSON-RPC request with a transport-level fault, e.g.
   * `fail({ status: 503 })`. See `MockFault` for the kinds.
   */
  fail: (fault: MockFault) => never;
};

/**
 * What a `getLogs` resolver gets: the filter, `fail`, and `logs`, what the
 * emitted logs would answer. Reading `logs` for a filter a node would refuse
 * (a range past the head, an address without a contract) throws that refusal.
 */
export type LogsContext = ActionContext<LogsCall> & { readonly logs: EmittedLog[] };

/** How a mock answers: `.returns()` or `.fails()`. */
export type MockActionAnswers<call, value, context = ActionContext<call>> = {
  /** With no argument, answers with the zero value, like `.returns(zeroResult)`. */
  returns(): void;
  returns(value: value | typeof zeroResult | ((context: context) => value | Promise<value>)): void;
  /** Fail every matching request at the network level. See `MockFault` for the kinds. */
  fails(fault: MockFault): void;
};

export type MockActionBuilder<call, value, context = ActionContext<call>> = MockActionAnswers<
  call,
  value,
  context
> & {
  /**
   * Answer only the next matching request, then step aside for the next best
   * mock. Limited mocks go ahead of unlimited ones as specific, oldest first.
   * Retries use up answers too.
   */
  once(): MockActionAnswers<call, value, context>;
  /** Like `.once()`, for the next `count` matching requests. */
  times(count: number): MockActionAnswers<call, value, context>;
};

/**
 * Mirrors the viem action of the same name, but registers a mock. Pin any of
 * the call's fields to narrow it; with none, it answers every call.
 */
export type MockAction<call, value, context = ActionContext<call>> = {
  (params?: Partial<call>): MockActionBuilder<call, value, context>;
  /** Every call to this action the mock has received, in order. */
  readonly calls: call[];
};

/** Like `MockAction`, for an action without params: there's nothing to pin. */
export type MockActionWithoutParams<value> = {
  (): MockActionBuilder<EmptyCall, value, ActionContext<object>>;
  /** Every call to this action the mock has received, in order. */
  readonly calls: EmptyCall[];
};

/** Each typed action's decoded call. */
export type ActionCalls = {
  getBalance: BalanceCall;
  getCode: CodeCall;
  getBlock: BlockCall;
  getTransactionReceipt: ReceiptCall;
  getLogs: LogsCall;
  getGasPrice: EmptyCall;
  estimateMaxPriorityFeePerGas: EmptyCall;
  getBlobBaseFee: EmptyCall;
  getFeeHistory: FeeHistoryCall;
};

/** What a table tells the rpc about a call it answered, for history. */
export type ActionReport = { action: string; call: object; outcome: MockOutcome };

/** Mocks for viem's public actions, answered with values in viem's own types. */
export type MockActions = {
  /** `eth_getBalance`. Unmocked addresses aren't answered. */
  getBalance: MockAction<BalanceCall, bigint>;
  /**
   * `eth_getCode`. Unmocked, a registered contract (and Multicall3) answers
   * with placeholder code, `0xfe`, and an `empty()` address with `0x`.
   */
  getCode: MockAction<CodeCall, Hex>;
  /**
   * `eth_getBlockByNumber` and `eth_getBlockByHash`. Unmocked, blocks up to the
   * current one are generated: number, hash, parent hash, and a timestamp that
   * follows the chain's `blockTime`, with everything else zero. A mock's fields
   * are merged over the generated block; `null` answers "no such block".
   */
  getBlock: MockAction<BlockCall, Partial<MockBlock> | null>;
  /**
   * `eth_getTransactionReceipt`. A mock's fields go over defaults: `status` is
   * `"success"`, the block is the current one, and logs get their index, block,
   * and transaction from the receipt; the rest is zero. `null` answers "no
   * such transaction". Unmocked hashes aren't answered.
   */
  getTransactionReceipt: MockAction<ReceiptCall, MockReceipt | null>;
  /**
   * `eth_getLogs`, for `getLogs` and `getContractEvents`. Unmocked, it's
   * answered from emitted logs (`mock.emit()`), filtered as a node filters
   * them. A mock answers first, with placed logs (from `emit()` or
   * `buildLog()`), or fails, e.g. for a provider's block range cap; its
   * resolver gets the emitted logs the filter matches as `logs`.
   */
  getLogs: MockAction<LogsCall, readonly EmittedLog[], LogsContext>;
  /**
   * `eth_gasPrice`. Unmocked, the current block's base fee plus the tip, as
   * reth suggests (see `fees` in `createMockRpc()`).
   */
  getGasPrice: MockActionWithoutParams<bigint>;
  /**
   * `eth_maxPriorityFeePerGas`, the tip a node suggests. Unmocked, `fees`'
   * `maxPriorityFeePerGas`. viem's `estimateMaxPriorityFeePerGas()` and
   * `estimateFeesPerGas()` don't fail when it fails: they fall back to
   * `eth_gasPrice` minus the base fee.
   */
  estimateMaxPriorityFeePerGas: MockActionWithoutParams<bigint>;
  /**
   * `eth_blobBaseFee`. Unmocked, 1 wei, the protocol's minimum: generated
   * blocks have no excess blob gas.
   */
  getBlobBaseFee: MockActionWithoutParams<bigint>;
  /**
   * `eth_feeHistory`. Unmocked, the generated blocks' history, as reth
   * answers it for empty blocks: their base fees from `fees`, no gas used,
   * and zero rewards. A mock's fields are merged over it. Unmocked, a newest
   * block past the current one and unordered percentiles are refused, as
   * reth refuses them.
   */
  getFeeHistory: MockAction<FeeHistoryCall, MockFeeHistory>;
};

export type MockMethodBuilder = MockActionBuilder<MethodCall, RpcValue>;

type Handler = {
  pinned: unknown;
  specificity: Specificity;
  /** Static values are wrapped at registration; `undefined` until `.returns()`/`.fails()`. */
  resolver: ((context: ActionContext<object>) => unknown) | undefined;
  /** Calls this handler answered since registration or the last `clearCalls()`. */
  usedCount: number;
  /** Set by `.once()`/`.times(n)`: answers in all, and how many are left. Kept by `clearCalls()`. */
  limit: number | undefined;
  remaining: number | undefined;
  /** Set when a `restore()` or `reset()` removes it, so its builder can't answer again. */
  removed: boolean;
};

type Definition = {
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
};

type Table = ReturnType<typeof createTable>;

function createTable(definition: Definition) {
  const handlers: Handler[] = [];
  const history: object[] = [];
  const actualOf = definition.actual ?? ((_pinned: unknown, call: object) => call);

  function register(params: unknown) {
    const pinned = params === undefined ? undefined : (definition.pin?.(params) ?? params);
    const handler: Handler = {
      pinned,
      specificity: specificity(pinned),
      resolver: undefined,
      usedCount: 0,
      limit: undefined,
      remaining: undefined,
      removed: false,
    };
    handlers.push(handler);

    const builder: MockActionBuilder<object, unknown> = {
      returns(value: unknown = zeroResult) {
        if (handler.removed) throw removedMockError();
        const resolved = value === zeroResult ? definition.zero : value;
        // A static value that can't be encoded fails here, not inside a request.
        if (typeof resolved !== "function") encode(resolved, undefined);
        handler.resolver =
          // The types guarantee a resolver's signature; it can't be checked at runtime.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- user-supplied function
          typeof resolved === "function" ? (resolved as Handler["resolver"]) : () => resolved;
      },
      fails(fault: MockFault) {
        builder.returns(() => fail(fault));
      },
      once: () => builder.times(1),
      times(count: number) {
        if (handler.removed) throw removedMockError();
        setLimit(handler, count);
        return builder;
      },
    };
    return builder;
  }

  /** Mocks that haven't answered a call, except used-up ones: they answered every call they had. */
  function unused(list: Handler[]) {
    return list
      .filter((h) => h.resolver !== undefined && h.usedCount === 0 && h.remaining !== 0)
      .map((h) => {
        const mock = `${formatCall(definition.name, h.pinned)}${formatLimit(h.limit, h.remaining)}`;
        return `${mock}${formatReceived(definition.name, received(h))}`;
      });
  }

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
    const view = definition.view ?? ((rpc: unknown) => rpc);
    try {
      const rpc = await answerCall(call);
      report?.({ action: definition.name, call, outcome: { type: "result", value: view(rpc) } });
      return rpc;
    } catch (error) {
      const outcome: MockOutcome =
        error instanceof MockFailure
          ? { type: "fault", fault: error.fault, source: "mock" }
          : errorOutcome(error);
      report?.({ action: definition.name, call, outcome });
      throw error;
    }
  }

  function encode(value: unknown, call: object | undefined) {
    assertNoMatchers(value);
    return definition.encode(value, call);
  }

  async function answerCall(call: object): Promise<unknown> {
    // The most specific matching handler wins; among equally specific ones,
    // the most recently registered wins.
    const handler = bestMatch(
      handlers,
      (h, options) =>
        h.pinned === undefined || isMatch(h.pinned, actualOf(h.pinned, call), options),
      definition.name,
    );
    if (!handler?.resolver) {
      const fallback = definition.fallback?.(call);
      if (fallback !== undefined) return fallback;
      const registered = handlers.map(
        (h) => `  ${formatCall(definition.name, h.pinned)}${formatLimit(h.limit, h.remaining)}`,
      );
      throw new MockNotFoundError(`No mock for ${formatCall(definition.name, call)}.`, {
        details:
          registered.length > 0
            ? `Registered:\n${registered.join("\n")}`
            : `Mock it with ${definition.hint}.`,
      });
    }

    handler.usedCount += 1;
    if (handler.remaining !== undefined) handler.remaining -= 1;
    try {
      const context = { ...call, fail };
      definition.extendContext?.(context, call);
      const value = await handler.resolver(context);
      return encode(value === zeroResult ? definition.zero : value, call);
    } catch (error) {
      // A fault, or what the context threw: a node's refusal or an unmocked address.
      if (
        error instanceof MockFailure ||
        error instanceof MockRpcError ||
        error instanceof MockNotFoundError
      )
        throw error;
      throw new MockResolverError(definition.name, error);
    }
  }

  return {
    register,
    answer,
    history,
    clearCalls() {
      history.length = 0;
      for (const handler of handlers) handler.usedCount = 0;
    },
    reset() {
      for (const handler of handlers) handler.removed = true;
      handlers.length = 0;
      history.length = 0;
    },
    unusedMocks: () => unused(handlers),
    /** Saves the registered mocks and their answers, to put back or compare against. */
    checkpoint(): PartCheckpoint {
      const saved = handlers.map((h) => [h, h.resolver, h.limit, h.remaining] as const);
      return {
        restore() {
          for (const handler of handlers.slice(saved.length)) handler.removed = true;
          handlers.length = saved.length;
          for (const [handler, resolver, limit, remaining] of saved)
            Object.assign(handler, { resolver, limit, remaining });
        },
        unusedSince: () => unused(handlers.slice(saved.length)),
      };
    },
  };
}

/** Encodes a bigint answer as a JSON-RPC quantity; `what` names it in the error. */
function encodeQuantity(what: string) {
  return (value: unknown) => {
    if (typeof value !== "bigint")
      throw new TypeError(`${what} must be a bigint; got ${typeof value}.`);
    return numberToHex(value);
  };
}

/** A JSON-RPC quantity as viem's action returns it. */
const viewQuantity = (rpc: unknown) => (isHex(rpc) ? hexToBigInt(rpc) : rpc);

const isList = (value: unknown, type: string) =>
  Array.isArray(value) && value.every((each) => typeof each === type);

/** Throws unless `history`'s fields have viem's types: bigints, and numbers for ratios. */
function assertFeeHistory(history: Record<string, unknown>) {
  const kinds: Record<string, "bigints" | "numbers" | "bigint" | "rewards"> = {
    baseFeePerGas: "bigints",
    baseFeePerBlobGas: "bigints",
    gasUsedRatio: "numbers",
    blobGasUsedRatio: "numbers",
    oldestBlock: "bigint",
    reward: "rewards",
  };
  for (const [field, value] of Object.entries(history)) {
    const kind = kinds[field];
    if (kind === undefined)
      throw new TypeError(
        `A fee history has no field "${field}". Its fields: ${Object.keys(kinds).join(", ")}.`,
      );
    const valid =
      kind === "bigint"
        ? typeof value === "bigint"
        : kind === "rewards"
          ? Array.isArray(value) && value.every((block) => isList(block, "bigint"))
          : isList(value, kind === "bigints" ? "bigint" : "number");
    if (!valid) {
      const expected = {
        bigints: "bigints",
        numbers: "numbers",
        bigint: "a bigint",
        rewards: "lists of bigints, one per block",
      }[kind];
      throw new TypeError(`A fee history's ${field} must be ${expected}.`);
    }
  }
}

/** JSON-RPC quantities as bigints, leaving anything else as is. */
const bigints = (list: unknown) =>
  Array.isArray(list)
    ? list.map((value: unknown) => (isHex(value) ? hexToBigInt(value) : value))
    : list;

/** A JSON-RPC fee history as viem's `getFeeHistory` returns it. */
function viewFeeHistory(rpc: unknown) {
  if (!isPlainObject(rpc)) return rpc;
  return {
    ...rpc,
    ...("baseFeePerGas" in rpc && { baseFeePerGas: bigints(rpc.baseFeePerGas) }),
    ...("baseFeePerBlobGas" in rpc && { baseFeePerBlobGas: bigints(rpc.baseFeePerBlobGas) }),
    ...(isHex(rpc.oldestBlock) && { oldestBlock: hexToBigInt(rpc.oldestBlock) }),
    ...(Array.isArray(rpc.reward) && { reward: rpc.reward.map(bigints) }),
  };
}

/** Checksums a pinned `address` (or each of several), which also validates it at registration. */
function pinAddress(pinned: unknown) {
  if (!isPlainObject(pinned)) return pinned;
  const { address } = pinned;
  if (typeof address === "string") return { ...pinned, address: getAddress(address) };
  if (Array.isArray(address))
    return {
      ...pinned,
      address: address.map((each: unknown) => (typeof each === "string" ? getAddress(each) : each)),
    };
  return pinned;
}

/**
 * Methods the mock doesn't support, refused with Arbitrum's error unless
 * `mock.method()` mocks them. Clients fall back to methods it does answer:
 * - Filters, which many public nodes don't support either: watchers poll
 *   `eth_getLogs` instead.
 * - `eth_fillTransaction`, which reth and geth support: viem fills a
 *   transaction's nonce, fees, and gas with their own requests instead, which
 *   are what tests mock.
 */
const refusedMethods = new Set([
  "eth_newFilter",
  "eth_newBlockFilter",
  "eth_newPendingTransactionFilter",
  "eth_getFilterChanges",
  "eth_getFilterLogs",
  "eth_uninstallFilter",
  "eth_fillTransaction",
]);

/** Methods answered outside `mock.method()`, with where to mock them instead. */
const builtIns = new Map([
  ["eth_chainId", "it's the chain's id; pass `chain` to createMockRpc()"],
  ["eth_blockNumber", "pass `blockNumber` to createMockRpc() and advance it with mine()"],
  ["eth_call", "register a contract with mock.contract()"],
]);

export function createActions(options: {
  /** Resolves a block parameter (tag, number, or EIP-1898 object) to a block number. */
  resolveBlock: (block: unknown) => bigint;
  /** Code for an address the mock knows about without a mock: registered or empty. */
  codeAt: (address: Address) => Hex | undefined;
  /** The current block number. */
  blockNumber: () => bigint;
  /** Block `number` as generated, before any mock's fields. */
  generateBlock: (number: bigint) => MockBlock;
  /** Mines one block. */
  mine: () => void;
  /** Whether a contract is registered at `address`, which is checksummed. */
  isContract: (address: Address) => boolean;
  /** The current block's fees. */
  fees: () => Fees;
}) {
  const { resolveBlock, codeAt, blockNumber, generateBlock, mine, isContract, fees } = options;
  // Emitted logs, which answer `eth_getLogs`.
  const logStore = createLogStore({
    blockNumber,
    mine,
    timestamp: (number) => generateBlock(number).timestamp,
    resolveBlock,
    isContract,
    isKnown: (address) => codeAt(address) !== undefined,
  });
  /** `eth_getBlockByNumber` takes a number or tag; `eth_getBlockByHash` a hash. */
  function decodeBlock([block, includeTransactions]: readonly unknown[], rpcMethod: string) {
    const include = includeTransactions === true;
    if (rpcMethod === "eth_getBlockByHash" && isHex(block)) {
      const number = numberOfBlockHash(block);
      return {
        blockNumber: number ?? blockNumber(),
        blockHash: block,
        includeTransactions: include,
      };
    }
    if (isHex(block)) return { blockNumber: hexToBigInt(block), includeTransactions: include };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a tag, per JSON-RPC
    const blockTag = (block ?? "latest") as BlockTag;
    return { blockNumber: resolveBlock(blockTag), blockTag, includeTransactions: include };
  }
  /** `eth_feeHistory` takes a count (hex, or a number), the newest block, and maybe percentiles. */
  function decodeFeeHistory([count, newest, percentiles]: readonly unknown[]): FeeHistoryCall {
    const blockCount = isHex(count) ? hexToNumber(count) : Number(count);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a tag, per JSON-RPC
    const blockTag = (newest ?? "latest") as BlockTag;
    const block = isHex(newest)
      ? { blockNumber: hexToBigInt(newest) }
      : { blockNumber: resolveBlock(blockTag), blockTag };
    return {
      blockCount,
      ...block,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- percentiles, per JSON-RPC
      ...(Array.isArray(percentiles) && { rewardPercentiles: percentiles as number[] }),
    };
  }
  const feeHistoryOf = ({ blockCount, blockNumber: newest, rewardPercentiles }: FeeHistoryCall) =>
    feeHistory({ blockCount, newest, ...(rewardPercentiles && { rewardPercentiles }) }, fees);
  const decodeAddressAtBlock = ([address, block]: readonly unknown[]) => ({
    // JSON-RPC params arrive untyped; viem sends the address first.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- untyped JSON-RPC boundary
    address: getAddress(address as string),
    blockNumber: resolveBlock(block),
  });

  const typed = {
    getBalance: createTable({
      name: "getBalance",
      hint: "mock.actions.getBalance({ address }).returns(…)",
      decode: decodeAddressAtBlock,
      pin: pinAddress,
      zero: 0n,
      encode: encodeQuantity("A balance"),
      view: viewQuantity,
    }),
    getCode: createTable({
      name: "getCode",
      hint: "mock.actions.getCode({ address }).returns(…), or mock.empty(address)",
      decode: decodeAddressAtBlock,
      pin: pinAddress,
      zero: "0x",
      encode(value) {
        if (!isHex(value)) throw new TypeError(`Code must be hex; got ${String(value)}.`);
        return value;
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoded by decodeAddressAtBlock
      fallback: (call) => codeAt((call as CodeCall).address),
    }),
    getTransactionReceipt: createTable({
      name: "getTransactionReceipt",
      hint: "mock.actions.getTransactionReceipt({ hash }).returns(…)",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- untyped JSON-RPC boundary
      decode: ([hash]) => ({ hash: hash as Hash }),
      zero: {},
      encode(value, call) {
        if (value === null) return null;
        if (!isPlainObject(value))
          throw new TypeError(`A receipt must be an object or null; got ${typeof value}.`);
        const { hash } = (call ?? {}) as Partial<ReceiptCall>;
        return toRpcReceipt(completeReceipt(value, { hash, blockNumber: blockNumber() }));
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- encoded by toRpcReceipt
      view: (rpc) => (rpc === null ? null : formatTransactionReceipt(rpc as RpcTransactionReceipt)),
    }),
    getBlock: createTable({
      name: "getBlock",
      hint: "mock.actions.getBlock({ blockNumber }).returns(…)",
      decode: decodeBlock,
      zero: {},
      encode(value, call) {
        if (value === null) return null;
        if (!isPlainObject(value))
          throw new TypeError(`A block must be an object or null; got ${typeof value}.`);
        const { blockNumber: number, blockHash } = (call ?? {}) as Partial<BlockCall>;
        const generated = generateBlock(number ?? blockNumber());
        // A pinned, unknown hash is the block's own hash.
        const base = blockHash === undefined ? generated : { ...generated, hash: blockHash };
        return toRpcBlock({ ...base, ...value });
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- encoded by toRpcBlock
      view: (rpc) => (rpc === null ? null : formatBlock(rpc as RpcBlock)),
      // Generated blocks exist up to the current one, and only by their own hashes.
      fallback(call) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoded by decodeBlock
        const { blockNumber: number, blockHash } = call as BlockCall;
        if (blockHash !== undefined && numberOfBlockHash(blockHash) === undefined) return undefined;
        if (number > blockNumber()) return undefined;
        return toRpcBlock(generateBlock(number));
      },
    }),
    getLogs: createTable({
      name: "getLogs",
      hint: "mock.actions.getLogs(…).returns(…), or mock.emit(…)",
      decode: (params) => logStore.decode(params),
      pin: pinAddress,
      zero: [],
      encode: (value) => logStore.toRpc(value),
      extendContext(context, call) {
        Object.defineProperty(context, "logs", {
          enumerable: true,
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoded by logStore.decode
          get: () => logStore.find(call as LogsCall),
        });
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoded by logStore.decode
      fallback: (call) => logStore.toRpc(logStore.find(call as LogsCall)),
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- encoded by logStore.toRpc
      view: (rpc) => (rpc as RpcLog[]).map((log) => formatLog(log)),
    }),
    getGasPrice: createTable({
      name: "getGasPrice",
      hint: "mock.actions.getGasPrice().returns(…), or `fees` in createMockRpc()",
      decode: () => ({}),
      zero: 0n,
      encode: encodeQuantity("A gas price"),
      view: viewQuantity,
      fallback() {
        const { baseFeePerGas, maxPriorityFeePerGas } = fees();
        return numberToHex(baseFeePerGas + maxPriorityFeePerGas);
      },
    }),
    estimateMaxPriorityFeePerGas: createTable({
      name: "estimateMaxPriorityFeePerGas",
      hint: "mock.actions.estimateMaxPriorityFeePerGas().returns(…), or `fees` in createMockRpc()",
      decode: () => ({}),
      zero: 0n,
      encode: encodeQuantity("A priority fee"),
      view: viewQuantity,
      fallback: () => numberToHex(fees().maxPriorityFeePerGas),
    }),
    getBlobBaseFee: createTable({
      name: "getBlobBaseFee",
      hint: "mock.actions.getBlobBaseFee().returns(…)",
      decode: () => ({}),
      zero: 0n,
      encode: encodeQuantity("A blob base fee"),
      view: viewQuantity,
      fallback: () => numberToHex(blobBaseFee),
    }),
    getFeeHistory: createTable({
      name: "getFeeHistory",
      hint: "mock.actions.getFeeHistory(…).returns(…), or `fees` in createMockRpc()",
      decode: decodeFeeHistory,
      zero: {},
      encode(value, call) {
        if (!isPlainObject(value))
          throw new TypeError(`A fee history must be an object; got ${typeof value}.`);
        assertFeeHistory(value);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoded by decodeFeeHistory
        const derived = call === undefined ? {} : feeHistoryOf(call as FeeHistoryCall);
        return toRpcFeeHistory({ ...derived, ...value });
      },
      view: viewFeeHistory,
      fallback(call) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoded by decodeFeeHistory
        const feeCall = call as FeeHistoryCall;
        const head = blockNumber();
        if (feeCall.blockCount > 0 && feeCall.blockNumber > head)
          throw new MockRpcError(
            -32602,
            `request beyond head block: requested ${feeCall.blockNumber}, head ${head}`,
          );
        const percentiles = feeCall.rewardPercentiles ?? [];
        if (percentiles.some((p, i) => p < 0 || p > 100 || p < (percentiles[i - 1] ?? 0)))
          throw new MockRpcError(-32602, "invalid reward percentiles");
        return toRpcFeeHistory(feeHistoryOf(feeCall));
      },
    }),
  };
  const typedMethods = new Map<string, keyof typeof typed>([
    ["eth_getBalance", "getBalance"],
    ["eth_getCode", "getCode"],
    ["eth_getBlockByNumber", "getBlock"],
    ["eth_getBlockByHash", "getBlock"],
    ["eth_getTransactionReceipt", "getTransactionReceipt"],
    ["eth_getLogs", "getLogs"],
    ["eth_gasPrice", "getGasPrice"],
    ["eth_maxPriorityFeePerGas", "estimateMaxPriorityFeePerGas"],
    ["eth_blobBaseFee", "getBlobBaseFee"],
    ["eth_feeHistory", "getFeeHistory"],
  ]);
  const typedTable = (name: string) => {
    const action = typedMethods.get(name);
    return action === undefined ? undefined : typed[action];
  };
  const raw = new Map<string, Table>();

  function buildAction(table: Table) {
    return Object.defineProperty((params?: unknown) => table.register(params), "calls", {
      get: () => [...table.history],
    });
  }

  // Built at runtime from the tables; `MockActions` describes the same shape.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime-built typed facade
  const actions = {
    getBalance: buildAction(typed.getBalance),
    getCode: buildAction(typed.getCode),
    getBlock: buildAction(typed.getBlock),
    getTransactionReceipt: buildAction(typed.getTransactionReceipt),
    getLogs: buildAction(typed.getLogs),
    getGasPrice: buildAction(typed.getGasPrice),
    estimateMaxPriorityFeePerGas: buildAction(typed.estimateMaxPriorityFeePerGas),
    getBlobBaseFee: buildAction(typed.getBlobBaseFee),
    getFeeHistory: buildAction(typed.getFeeHistory),
  } as unknown as MockActions;

  function method(name: string, params?: readonly unknown[]): MockMethodBuilder {
    const builtIn = builtIns.get(name);
    if (builtIn !== undefined) throw new Error(`"${name}" can't be mocked raw: ${builtIn}.`);
    const action = typedMethods.get(name);
    if (action !== undefined)
      throw new Error(`"${name}" has a typed mock: use mock.actions.${action}().`);

    let table = raw.get(name);
    if (!table) {
      table = createTable({
        name,
        hint: `mock.method("${name}", …).returns(…)`,
        decode: (rawParams) => ({ method: name, params: rawParams }),
        zero: null,
        encode: (value) => value,
        // Pinned params are a prefix: pin the leading ones, leave the rest open.
        actual: (pinned, call) =>
          Array.isArray(pinned)
            ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoded above
              pinned.map((_, i) => (call as MethodCall).params[i])
            : call,
      });
      raw.set(name, table);
    }
    return table.register(params);
  }

  const tables = () => [...Object.values(typed), ...raw.values()];

  return {
    actions,
    method,
    logStore,
    /** Answers a request with a typed or raw mock, or returns `undefined` if none applies. */
    answer(
      name: string,
      params: unknown,
      report?: (report: ActionReport) => void,
    ): Promise<unknown> | undefined {
      const table = typedTable(name) ?? raw.get(name);
      // Refused as unsupported; clients fall back to other methods.
      if (table === undefined && refusedMethods.has(name))
        return Promise.reject(
          new MockRpcError(-32601, `the method ${name} does not exist/is not available`),
        );
      // JSON-RPC params are an array for every method viem sends.
      return table?.answer(name, Array.isArray(params) ? params : [], report);
    },
    /** The typed action answering `method`, if any: history records those as actions. */
    actionFor: (rpcMethod: string) => typedMethods.get(rpcMethod),
    clearCalls() {
      for (const table of tables()) table.clearCalls();
    },
    reset() {
      for (const table of tables()) table.reset();
      raw.clear();
    },
    unusedMocks: () => tables().flatMap((table) => table.unusedMocks()),
    /** Saves every table's mocks, typed and raw, to put back or compare against. */
    checkpoint(): PartCheckpoint {
      const typedSaved = Object.values(typed).map((table) => table.checkpoint());
      const rawSaved = new Map([...raw].map(([name, table]) => [name, table.checkpoint()]));
      return {
        restore() {
          for (const saved of typedSaved) saved.restore();
          for (const [name, table] of raw) {
            const saved = rawSaved.get(name);
            if (saved) {
              saved.restore();
            } else {
              // Created since the checkpoint.
              table.reset();
              raw.delete(name);
            }
          }
        },
        unusedSince: () => [
          ...typedSaved.flatMap((saved) => saved.unusedSince()),
          ...[...raw].flatMap(
            ([name, table]) => rawSaved.get(name)?.unusedSince() ?? table.unusedMocks(),
          ),
        ],
      };
    },
  };
}
