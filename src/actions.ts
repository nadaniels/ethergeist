import {
  type Address,
  type BlockTag,
  type Hash,
  type Hex,
  type RpcBlock,
  type RpcTransactionReceipt,
  type RpcLog,
  type RpcTransaction,
  formatBlock,
  formatLog,
  formatTransaction,
  formatTransactionReceipt,
  getAddress,
  hexToBigInt,
  hexToNumber,
  isHex,
  numberToHex,
  pad,
  size,
  zeroHash,
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
import type { ContractEstimate } from "./contract.js";
import {
  type BuiltTransaction,
  type MockReceipt,
  type MockTransaction,
  completeReceipt,
  toRpcReceipt,
  toRpcTransaction,
} from "./receipts.js";
import { MockNotFoundError, MockResolverError, MockRpcError, removedMockError } from "./errors.js";
import type { EmittedLog } from "./events.js";
import { type MockCallRecord, type MockOutcome, errorOutcome } from "./history.js";
import { type LogsCall, createLogStore } from "./logs.js";
import { MockFailure, type MockFault, type MockNodeFault, fail } from "./faults.js";
import {
  type ReceivedCall,
  formatCall,
  formatLimit,
  formatMismatch,
  formatReceived,
  formatValue,
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
import { isPlainObject, lowercase, zeroResult } from "./result.js";

/**
 * What a call about an address at a block asked for. A tag resolves to the
 * mock's block number and is kept, so `"pending"` can be pinned apart from
 * `"latest"`; no block is `"latest"`, and a block number has no tag.
 */
export type AddressAtBlockCall = { address: Address; blockNumber: bigint; blockTag?: BlockTag };
/** What a call to `getBalance` asked for; see `AddressAtBlockCall`. */
export type BalanceCall = AddressAtBlockCall;
/** What a call to `getCode` asked for; see `AddressAtBlockCall`. */
export type CodeCall = AddressAtBlockCall;
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
/**
 * What a call to `getTransactionCount` asked for; see `AddressAtBlockCall`.
 * A node counts transactions waiting to be mined in `"pending"`.
 */
export type TransactionCountCall = AddressAtBlockCall;
/**
 * What a call to `estimateGas` asked for: the transaction, and the block it's
 * estimated at. `account` is the sender, sent as `from`; `value` is `0n` when
 * the request has none. Other fields are left out when the request has none.
 * A tag resolves to the mock's block number and is kept; no block is `"latest"`.
 */
export type EstimateGasCall = {
  account?: Address;
  to?: Address;
  value: bigint;
  data?: Hex;
  gas?: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  nonce?: number;
  blockNumber: bigint;
  blockTag?: BlockTag;
};
/** What a call to an action without params asked for: nothing. */
export type EmptyCall = Record<string, never>;
/**
 * What a call to `getStorageAt` asked for; see `AddressAtBlockCall`. `slot`
 * is 32 bytes, lowercase, however the request wrote it (e.g. `"0x0"`).
 */
export type StorageCall = AddressAtBlockCall & { slot: Hex };
/** What a call to `getTransactionReceipt` asked for. */
export type ReceiptCall = { hash: Hash };
/** What a call to `getTransaction` asked for: a transaction by its hash. */
export type TransactionCall = { hash: Hash };
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

/**
 * What an estimate's resolver gets: the call, and `fail`, which also takes a
 * node's refusal by name, e.g. `fail("insufficientFunds")`.
 */
export type EstimateGasContext = EstimateGasCall & { fail: (fault: MockNodeFault) => never };

/**
 * How an estimate answers: with gas, or `.fails()`, which also takes a node's
 * refusal by name. There's no zero answer: a node never estimates zero gas.
 */
export type MockEstimateAnswers<context> = {
  returns(value: bigint | ((context: context) => bigint | Promise<bigint>)): void;
  /**
   * Fail every matching request: a node's refusal by name, e.g.
   * `"insufficientFunds"` (see `NodeErrorName`), or any `MockFault`.
   */
  fails(fault: MockNodeFault): void;
};

/** Like `MockActionBuilder`, for an estimate. */
export type MockEstimateBuilder<context> = MockEstimateAnswers<context> & {
  /** See `MockActionBuilder`'s `once()`. */
  once(): MockEstimateAnswers<context>;
  /** Like `.once()`, for the next `count` matching requests. */
  times(count: number): MockEstimateAnswers<context>;
};

/** `MockAction` for `estimateGas`. */
export type MockEstimateGasAction = {
  (params?: Partial<EstimateGasCall>): MockEstimateBuilder<EstimateGasContext>;
  /** Every call to this action the mock has received, in order. */
  readonly calls: EstimateGasCall[];
};

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
  getTransaction: TransactionCall;
  getLogs: LogsCall;
  getGasPrice: EmptyCall;
  estimateMaxPriorityFeePerGas: EmptyCall;
  getBlobBaseFee: EmptyCall;
  getFeeHistory: FeeHistoryCall;
  getTransactionCount: TransactionCountCall;
  getStorageAt: StorageCall;
  estimateGas: EstimateGasCall;
};

/**
 * What a table tells the rpc about a call it answered, for history. An
 * estimate of a registered contract's function also has its decoded call.
 */
export type ActionReport = {
  action: string;
  call: object;
  outcome: MockOutcome;
  contract?: MockCallRecord;
};

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
   * current one are generated: number, hash, parent hash, a timestamp that
   * follows the chain's `blockTime`, and the base fee (see `fees`), with
   * everything else zero. A mock's fields
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
   * `eth_getTransactionByHash`. A mock's fields go over defaults: an
   * `"eip1559"` transaction mined in the current block, at index 0, that paid
   * the suggested fees (see `fees`), with a zero signature; the rest is zero.
   * Fields its `type` doesn't have throw, and `blockNumber: null` makes it
   * pending. `null` answers "no such transaction". Unmocked hashes aren't
   * answered. `mock.buildTransaction()` builds the same transaction.
   */
  getTransaction: MockAction<TransactionCall, MockTransaction | null>;
  /**
   * `eth_getLogs`, for `getLogs` and `getContractEvents`. Unmocked, it's
   * answered from emitted logs (`mock.emit()`), filtered as a node filters
   * them. A mock answers first, with placed logs (from `emit()` or
   * `mock.buildLog()`), or fails, e.g. for a provider's block range cap; its
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
  /**
   * `eth_getTransactionCount`, an account's nonce: the transactions it has
   * sent. Unmocked addresses aren't answered. viem asks for `"pending"`
   * when preparing a transaction, and `"latest"` by default.
   */
  getTransactionCount: MockAction<TransactionCountCall, number>;
  /**
   * `eth_getStorageAt`, one storage slot of an address. Slots in pins and
   * requests are compared as 32 bytes, so `"0x0"` matches a request for slot
   * zero written in full. Answers are up to 32 bytes, padded to 32 as a node
   * sends them, so `.returns("0x1")` works. Unmocked, an `empty()` address's
   * storage is all zero, as for any address without code; other addresses
   * aren't answered.
   */
  getStorageAt: MockAction<StorageCall, Hex>;
  /**
   * `eth_estimateGas`, for `estimateGas` and the gas a transaction is
   * prepared with. A registered contract's `estimateGas` mocks and defaults
   * answer estimates of its functions first; these answer the rest. Unmocked,
   * a plain transfer, with no data, to an
   * address without code is 21000 gas, as a node estimates it; anything else
   * isn't answered. `.fails()` takes a node's refusal by name, e.g.
   * `"insufficientFunds"`.
   */
  estimateGas: MockEstimateGasAction;
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
  /**
   * For estimates: a registered contract's turn, prepared as the call
   * arrives. Its mocks answer before this table's: it owns its functions.
   */
  contractTurn?: (call: object) => ContractEstimate | undefined;
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
      // Named node errors are typed only where a node can refuse with them.
      fails(fault: MockNodeFault) {
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
    const turn = definition.contractTurn?.(call);
    const view = definition.view ?? ((rpc: unknown) => rpc);
    const reportAs = (outcome: MockOutcome) => {
      const contract = turn?.record;
      // The contract's own outcome if it answered; otherwise the request's.
      if (contract?.outcome.type === "pending") contract.outcome = outcome;
      report?.({ action: definition.name, call, outcome, ...(contract && { contract }) });
    };
    try {
      const rpc = await answerCall(call, turn);
      reportAs({ type: "result", value: view(rpc) });
      return rpc;
    } catch (error) {
      reportAs(
        error instanceof MockFailure
          ? { type: "fault", fault: error.fault, source: "mock" }
          : errorOutcome(error),
      );
      throw error;
    }
  }

  function encode(value: unknown, call: object | undefined) {
    assertNoMatchers(value);
    return definition.encode(value, call);
  }

  async function answerCall(call: object, turn: ContractEstimate | undefined): Promise<unknown> {
    const answered = turn?.answer();
    if (answered) return await answered;
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
      if (turn) throw turn.miss;
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

/** A JSON-RPC quantity in a transaction, as a bigint; `undefined` when it's missing. */
const quantity = (value: unknown) => (isHex(value) ? hexToBigInt(value) : undefined);

/** Checksums a pinned `account` and `to`, which also validates them at registration. */
function pinTransaction(pinned: unknown) {
  if (!isPlainObject(pinned)) return pinned;
  const { account, to } = pinned;
  return {
    ...pinned,
    ...(typeof account === "string" && { account: getAddress(account) }),
    ...(typeof to === "string" && { to: getAddress(to) }),
  };
}

/** A storage slot or value as 32 bytes, lowercase; `what` names it in the error. */
function toWord(value: unknown, what: string): Hex {
  if (!isHex(value))
    throw new TypeError(`${what} must be hex of up to 32 bytes; got ${formatValue(value)}.`);
  if (size(value) > 32)
    throw new TypeError(
      `${what} must be hex of up to 32 bytes; got ${size(value)} bytes: ${value}.`,
    );
  return pad(lowercase(value), { size: 32 });
}

/**
 * Checksums a pinned `address` and pads a pinned `slot` to 32 bytes, as calls
 * have them. Anything else, like a matcher, is left as is.
 */
function pinStorage(pinned: unknown) {
  const pinnedAddress = pinAddress(pinned);
  if (!isPlainObject(pinnedAddress) || typeof pinnedAddress.slot !== "string") return pinnedAddress;
  return { ...pinnedAddress, slot: toWord(pinnedAddress.slot, "A storage slot") };
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
  /** Block `number`'s fees. */
  feesAt: (number: bigint) => Fees;
  /** A registered contract's turn at an estimate of one of its functions, if it's one. */
  estimateAt: (call: EstimateGasCall) => ContractEstimate | undefined;
  chainId: number;
}) {
  const {
    resolveBlock,
    codeAt,
    blockNumber,
    generateBlock,
    mine,
    isContract,
    feesAt,
    estimateAt,
    chainId,
  } = options;
  /** A transaction's JSON-RPC form, with the mock's defaults; see `getTransaction`. */
  const encodeTransaction = (transaction: MockTransaction, hash: Hash) =>
    toRpcTransaction(transaction, {
      hash,
      blockNumber: blockNumber(),
      chainId,
      feesAt,
      timestampAt: (number) => generateBlock(number).timestamp,
    });
  const fees = () => feesAt(blockNumber());
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
    feeHistory({ blockCount, newest, ...(rewardPercentiles && { rewardPercentiles }) }, feesAt);
  /** An address and a block, as `eth_getBalance` and its kind take them; see `AddressAtBlockCall`. */
  function decodeAddressAtBlock([
    address,
    block = "latest",
  ]: readonly unknown[]): AddressAtBlockCall {
    const isTag = typeof block === "string" && !isHex(block);
    return {
      // JSON-RPC params arrive untyped; viem sends the address first.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- untyped JSON-RPC boundary
      address: getAddress(address as string),
      blockNumber: resolveBlock(block),
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a tag, per JSON-RPC
      ...(isTag && { blockTag: block as BlockTag }),
    };
  }
  /** `eth_estimateGas` takes a transaction and maybe a block. */
  function decodeEstimateGas([tx, block = "latest"]: readonly unknown[]): EstimateGasCall {
    const {
      from,
      to,
      value,
      data,
      input,
      gas,
      gasPrice,
      maxFeePerGas,
      maxPriorityFeePerGas,
      nonce,
    } = isPlainObject(tx) ? tx : {};
    const isTag = typeof block === "string" && !isHex(block);
    const fields = {
      account: typeof from === "string" ? getAddress(from) : undefined,
      to: typeof to === "string" ? getAddress(to) : undefined,
      value: quantity(value) ?? 0n,
      data: isHex(data) ? data : isHex(input) ? input : undefined,
      gas: quantity(gas),
      gasPrice: quantity(gasPrice),
      maxFeePerGas: quantity(maxFeePerGas),
      maxPriorityFeePerGas: quantity(maxPriorityFeePerGas),
      nonce: isHex(nonce) ? hexToNumber(nonce) : undefined,
      blockNumber: resolveBlock(block),
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a tag, per JSON-RPC
      blockTag: isTag ? (block as BlockTag) : undefined,
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- undefined fields are left out
    return Object.fromEntries(
      Object.entries(fields).filter(([, each]) => each !== undefined),
    ) as EstimateGasCall;
  }

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
    getTransaction: createTable({
      name: "getTransaction",
      hint: "mock.actions.getTransaction({ hash }).returns(…)",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- untyped JSON-RPC boundary
      decode: ([hash]) => ({ hash: hash as Hash }),
      zero: {},
      encode(value, call) {
        if (value === null) return null;
        if (!isPlainObject(value))
          throw new TypeError(`A transaction must be an object or null; got ${typeof value}.`);
        const { hash = zeroHash } = (call ?? {}) as Partial<TransactionCall>;
        return encodeTransaction(value, hash);
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- encoded by toRpcTransaction
      view: (rpc) => (rpc === null ? null : formatTransaction(rpc as RpcTransaction)),
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
    getTransactionCount: createTable({
      name: "getTransactionCount",
      hint: "mock.actions.getTransactionCount({ address }).returns(…)",
      decode: decodeAddressAtBlock,
      pin: pinAddress,
      zero: 0,
      encode(value) {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
          throw new TypeError(
            `A transaction count must be a whole number, zero or more; got ${formatValue(value)}.`,
          );
        return numberToHex(value);
      },
      view: (rpc) => (isHex(rpc) ? hexToNumber(rpc) : rpc),
    }),
    estimateGas: createTable({
      name: "estimateGas",
      hint: "mock.actions.estimateGas({ to }).returns(…)",
      decode: decodeEstimateGas,
      pin: pinTransaction,
      // `.returns()` without a value isn't typed: there's no zero estimate.
      zero: undefined,
      encode(value) {
        if (typeof value !== "bigint" || value < 0n)
          throw new TypeError(
            `A gas estimate must be a bigint, zero or more; got ${formatValue(value)}.`,
          );
        return numberToHex(value);
      },
      view: viewQuantity,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoded by decodeEstimateGas
      contractTurn: (call) => estimateAt(call as EstimateGasCall),
      // A plain transfer to an address without code costs the base 21000 gas.
      fallback(call) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoded by decodeEstimateGas
        const { to, data = "0x" } = call as EstimateGasCall;
        if (to === undefined || data !== "0x") return undefined;
        const code = codeAt(to);
        return code === undefined || code === "0x" ? numberToHex(21_000n) : undefined;
      },
    }),
    getStorageAt: createTable({
      name: "getStorageAt",
      hint: "mock.actions.getStorageAt({ address, slot }).returns(…), or mock.empty(address)",
      decode([address, slot, block]) {
        const { address: checksummed, ...at } = decodeAddressAtBlock([address, block]);
        return { address: checksummed, slot: toWord(slot, "A storage slot"), ...at };
      },
      pin: pinStorage,
      zero: "0x",
      encode: (value) => toWord(value, "A storage value"),
      // An address without code has no storage: every slot reads as zero.
      fallback: (call) =>
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoded above
        codeAt((call as StorageCall).address) === "0x" ? pad("0x", { size: 32 }) : undefined,
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
    ["eth_getTransactionByHash", "getTransaction"],
    ["eth_getLogs", "getLogs"],
    ["eth_gasPrice", "getGasPrice"],
    ["eth_maxPriorityFeePerGas", "estimateMaxPriorityFeePerGas"],
    ["eth_blobBaseFee", "getBlobBaseFee"],
    ["eth_feeHistory", "getFeeHistory"],
    ["eth_getTransactionCount", "getTransactionCount"],
    ["eth_getStorageAt", "getStorageAt"],
    ["eth_estimateGas", "estimateGas"],
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
    getTransaction: buildAction(typed.getTransaction),
    getLogs: buildAction(typed.getLogs),
    getGasPrice: buildAction(typed.getGasPrice),
    estimateMaxPriorityFeePerGas: buildAction(typed.estimateMaxPriorityFeePerGas),
    getBlobBaseFee: buildAction(typed.getBlobBaseFee),
    getFeeHistory: buildAction(typed.getFeeHistory),
    getTransactionCount: buildAction(typed.getTransactionCount),
    getStorageAt: buildAction(typed.getStorageAt),
    estimateGas: buildAction(typed.estimateGas),
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
    /** The receipt `getTransactionReceipt` answers for `.returns(receipt)`; its hash is zero unless given. */
    buildReceipt: (receipt: MockReceipt = {}) =>
      completeReceipt(receipt, {
        hash: receipt.transactionHash ?? zeroHash,
        blockNumber: blockNumber(),
      }),
    /** The transaction `getTransaction` answers for `.returns(transaction)`, in viem's types. */
    buildTransaction: <const transaction extends MockTransaction = { type?: "eip1559" }>(
      transaction?: transaction,
    ): BuiltTransaction<transaction> =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- formatTransaction of the transaction's own type
      formatTransaction(
        encodeTransaction(transaction ?? {}, transaction?.hash ?? zeroHash),
      ) as BuiltTransaction<transaction>,
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
