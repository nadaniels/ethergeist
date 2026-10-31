import {
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
import { blobBaseFee, feeHistory, toRpcFeeHistory } from "./chain/fees.js";
import { numberOfBlockHash, toRpcBlock } from "./chain/blocks.js";
import type { PartCheckpoint } from "./checkpoint.js";
import type {
  ActionContext,
  AddressAtBlockCall,
  BlockCall,
  CodeCall,
  EstimateGasCall,
  FeeHistoryCall,
  MethodCall,
  MockActions,
  MockMethodBuilder,
  ReceiptCall,
  StorageCall,
  TransactionCall,
} from "./actions/types.js";
import type { ContractEstimate } from "./contract.js";
import {
  type BuiltTransaction,
  type MockTransaction,
  toRpcTransaction,
} from "./chain/transactions.js";
import { type MockReceipt, completeReceipt, toRpcReceipt } from "./chain/receipts.js";
import { MockNotFoundError, MockRpcError } from "./shared/errors.js";
import { failureOutcome } from "./history.js";
import type { MockCallRecord, MockOutcome } from "./history/types.js";
import type { LogsCall } from "./logs/filter.js";
import type { LogStore } from "./logs/store.js";
import type { ChainState } from "./chain/state.js";
import type { Registry } from "./contracts/registry.js";
import { MockFailure, fail } from "./mocking/faults.js";
import { encodeGas } from "./mocking/gas.js";
import { type Handler as MockHandler, createHandlers, withCalls } from "./mocking/handlers.js";
import {
  type ReceivedCall,
  formatCall,
  formatMismatch,
  formatReceived,
  formatValue,
} from "./mocking/format.js";
import { assertNoMatchers, isMatch, mismatches } from "./mocking/matching.js";
import { isPlainObject, lowercase } from "./shared/values.js";
import { zeroResult } from "./mocking/zeroResult.js";

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
type Handler = MockHandler<ActionContext<object>>;

/**
 * What a resolver throws that's an answer, not a resolver error: a fault, or
 * what its context threw, a node's refusal or an unmocked address.
 */
const isAnswer = (error: unknown) =>
  error instanceof MockFailure ||
  error instanceof MockRpcError ||
  error instanceof MockNotFoundError;

function createTable(definition: Definition) {
  const mocks = createHandlers<ActionContext<object>, unknown>();
  const history: object[] = [];
  const actualOf = definition.actual ?? ((_pinned: unknown, call: object) => call);

  function register(params: unknown) {
    const pinned = params === undefined ? undefined : (definition.pin?.(params) ?? params);
    const handler = mocks.add(pinned, undefined);
    return mocks.builderFor(handler, (value) => {
      encode(value, undefined);
    });
  }

  /** Unused mocks, each with the calls this table received instead. */
  const describeUnused = (list: Handler[]) =>
    list.map(
      (h) =>
        `${mocks.withLimit(formatCall(definition.name, h.pinned), h)}${formatReceived(definition.name, received(h))}`,
    );

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
      reportAs(failureOutcome(error));
      throw error;
    }
  }

  /** A value in viem's types as JSON-RPC; `zeroResult` is the action's zero. */
  function encode(value: unknown, call: object | undefined) {
    assertNoMatchers(value);
    return definition.encode(value === zeroResult ? definition.zero : value, call);
  }

  async function answerCall(call: object, turn: ContractEstimate | undefined): Promise<unknown> {
    const answered = turn?.answer();
    if (answered) return await answered;
    // The most specific matching handler wins; among equally specific ones,
    // the most recently registered wins.
    const handler = mocks.best(
      mocks.handlers,
      (h, options) =>
        h.pinned === undefined || isMatch(h.pinned, actualOf(h.pinned, call), options),
      definition.name,
    );
    if (!handler) {
      const fallback = definition.fallback?.(call);
      if (fallback !== undefined) return fallback;
      if (turn) throw turn.miss;
      const registered = mocks.handlers.map(
        (h) => `  ${mocks.withLimit(formatCall(definition.name, h.pinned), h)}`,
      );
      throw new MockNotFoundError(`No mock for ${formatCall(definition.name, call)}.`, {
        details:
          registered.length > 0
            ? `Registered:\n${registered.join("\n")}`
            : `Mock it with ${definition.hint}.`,
      });
    }

    const context = { ...call, fail };
    definition.extendContext?.(context, call);
    return await mocks.run(handler, context, (value) => encode(value, call), {
      name: definition.name,
      passThrough: isAnswer,
    });
  }

  return {
    register,
    answer,
    history,
    clearCalls() {
      history.length = 0;
      mocks.clearUsage();
    },
    reset() {
      mocks.removeAll();
      history.length = 0;
    },
    unusedMocks: () => describeUnused(mocks.unused(mocks.handlers)),
    /** Saves the registered mocks and their answers, to put back or compare against. */
    checkpoint: (): PartCheckpoint => mocks.checkpoint(describeUnused),
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

export function createActions({
  state,
  registry,
  logStore,
}: {
  state: ChainState;
  registry: Registry;
  /** Emitted logs, which answer `eth_getLogs`. */
  logStore: LogStore;
}) {
  const { resolveBlock, generateBlock, feesAt, chainId } = state;
  const { codeAt } = registry;
  const blockNumber = () => state.blockNumber;
  /** A registered contract's turn at an estimate of one of its functions, if it's one. */
  function estimateAt({ to, data, account, value, blockNumber: number }: EstimateGasCall) {
    if (to === undefined || data === undefined || data === "0x") return undefined;
    return registry
      .contractAt(to)
      ?.estimate(data, { from: account, value, blockNumber: number, batch: undefined });
  }
  /** A transaction's JSON-RPC form, with the mock's defaults; see `getTransaction`. */
  const encodeTransaction = (transaction: MockTransaction, hash: Hash) =>
    toRpcTransaction(transaction, {
      hash,
      blockNumber: blockNumber(),
      chainId,
      feesAt,
      timestampAt: state.timestampAt,
    });
  const fees = () => feesAt(blockNumber());
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
      encode: encodeGas,
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
    return withCalls(
      (params?: unknown) => table.register(params),
      () => [...table.history],
    );
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
