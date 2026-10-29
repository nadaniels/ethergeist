import {
  type Address,
  type BlockTag,
  type Hash,
  type Hex,
  type RpcBlock,
  type RpcTransactionReceipt,
  formatBlock,
  formatTransactionReceipt,
  getAddress,
  hexToBigInt,
  isHex,
  numberToHex,
  zeroHash,
} from "viem";
import { type MockBlock, numberOfBlockHash, toRpcBlock } from "./blocks.js";
import { type PartCheckpoint, removedMockError } from "./checkpoint.js";
import { type MockReceipt, completeReceipt, toRpcReceipt } from "./receipts.js";
import { MockNotFoundError, MockResolverError } from "./errors.js";
import { type MockOutcome, errorOutcome } from "./history.js";
import { MockFailure, type MockFault, fail } from "./faults.js";
import { type ReceivedCall, formatCall, formatLimit, formatReceived } from "./format.js";
import {
  type Specificity,
  assertNoMatchers,
  bestMatch,
  firstMismatch,
  isMatch,
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

/** How a mock answers: `.returns()` or `.fails()`. */
export type MockActionAnswers<call, value> = {
  /** With no argument, answers with the zero value, like `.returns(zeroResult)`. */
  returns(): void;
  returns(
    value: value | typeof zeroResult | ((context: ActionContext<call>) => value | Promise<value>),
  ): void;
  /** Fail every matching request at the network level. See `MockFault` for the kinds. */
  fails(fault: MockFault): void;
};

export type MockActionBuilder<call, value> = MockActionAnswers<call, value> & {
  /**
   * Answer only the next matching request, then step aside for the next best
   * mock. Limited mocks go ahead of unlimited ones as specific, oldest first.
   * Retries use up answers too.
   */
  once(): MockActionAnswers<call, value>;
  /** Like `.once()`, for the next `count` matching requests. */
  times(count: number): MockActionAnswers<call, value>;
};

/**
 * Mirrors the viem action of the same name, but registers a mock. Pin any of
 * the call's fields to narrow it; with none, it answers every call.
 */
export type MockAction<call, value> = {
  (params?: Partial<call>): MockActionBuilder<call, value>;
  /** Every call to this action the mock has received, in order. */
  readonly calls: call[];
};

/** Each typed action's decoded call. */
export type ActionCalls = {
  getBalance: BalanceCall;
  getCode: CodeCall;
  getBlock: BlockCall;
  getTransactionReceipt: ReceiptCall;
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
      const key = firstMismatch(handler.pinned, actualOf(handler.pinned, call));
      return {
        call: formatCall(definition.name, "params" in call ? call.params : call),
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
      const value = await handler.resolver({ ...call, fail });
      return encode(value === zeroResult ? definition.zero : value, call);
    } catch (error) {
      if (error instanceof MockFailure) throw error;
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

/** Checksums a pinned `address`, which also validates it at registration. */
function pinAddress(pinned: unknown) {
  return isPlainObject(pinned) && typeof pinned.address === "string"
    ? { ...pinned, address: getAddress(pinned.address) }
    : pinned;
}

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
}) {
  const { resolveBlock, codeAt, blockNumber, generateBlock } = options;
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
      encode(value) {
        if (typeof value !== "bigint")
          throw new TypeError(`A balance must be a bigint; got ${typeof value}.`);
        return numberToHex(value);
      },
      view: (rpc) => (isHex(rpc) ? hexToBigInt(rpc) : rpc),
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
        const { hash = zeroHash } = (call ?? {}) as Partial<ReceiptCall>;
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
  };
  const typedMethods = new Map<string, keyof typeof typed>([
    ["eth_getBalance", "getBalance"],
    ["eth_getCode", "getCode"],
    ["eth_getBlockByNumber", "getBlock"],
    ["eth_getBlockByHash", "getBlock"],
    ["eth_getTransactionReceipt", "getTransactionReceipt"],
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
    /** Answers a request with a typed or raw mock, or returns `undefined` if none applies. */
    answer(
      name: string,
      params: unknown,
      report?: (report: ActionReport) => void,
    ): Promise<unknown> | undefined {
      const table = typedTable(name) ?? raw.get(name);
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
