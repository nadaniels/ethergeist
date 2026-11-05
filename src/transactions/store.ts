import { type Address, type Hash, type Hex, formatTransaction, getAddress } from "viem";

import { blockHash, numberOfBlockHash } from "../chain/blocks.js";
import { completeReceipt, placeLog, toRpcReceipt } from "../chain/receipts.js";
import type { ChainState } from "../chain/state.js";
import { type TransactionType, encodeTransaction } from "../chain/transactions.js";
import type { EmitOptions, EmittedLog, MockEventLog } from "../logs/events.js";
import { type LogsCall, topicsMatch } from "../logs/filter.js";
import { MockRpcError, MockSetupError } from "../shared/errors.js";
import { testHash } from "../shared/testValues.js";

/**
 * A transaction on the mock's chain, as `mock.transactions` lists it: the
 * facts it was put there with, which its receipt, its transaction and its
 * block answer from. Frozen: once added, a record never changes; mining only
 * moves the head past it.
 */
export type TransactionRecord = {
  readonly hash: Hash;
  /**
   * How it got on the chain: `"added"` by the mock's API (`emit()`), or
   * `"sent"` over JSON-RPC (`eth_sendTransaction`, `eth_sendRawTransaction`
   * or its Sync form), whoever sent it.
   */
  readonly origin: "added" | "sent";
  /**
   * The transaction's own fields, as its request or signed bytes had them;
   * any left out answer a node's defaults: zero or empty, an `"eip1559"`
   * type, and fees suggested at its block. An emit's are all left out.
   */
  readonly fields: Readonly<{
    from?: Address;
    to?: Address | null;
    nonce?: number;
    value?: bigint;
    input?: Hex;
    gas?: bigint;
    type?: TransactionType;
    gasPrice?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  }>;
  /**
   * What its receipt says beyond its position and logs, where a write's
   * outcome set it or it's a deploy's address. Left out, a success that
   * used the gas it was sent with (none for an emit), at the price it paid.
   */
  readonly receipt: Readonly<{
    status?: "success" | "reverted";
    gasUsed?: bigint;
    effectiveGasPrice?: bigint;
    contractAddress?: Address;
  }>;
  /** Its logs, placed in its block, with indexes counted across the block. */
  readonly logs: readonly EmittedLog[];
  /** Its block and index in it; a record is on the chain once its block is mined. */
  readonly position: Readonly<{ blockNumber: bigint; index: number }>;
};

/** What `add` takes: a record's facts, which it places. */
type NewRecord = Pick<TransactionRecord, "origin" | "fields" | "receipt"> & {
  /** Left out, one the mock makes from its position. */
  hash?: Hash | undefined;
  logs: readonly MockEventLog[];
};

/** Fields a placed log has, which `emit` takes from its options instead. */
const positionFields = [
  "blockHash",
  "blockNumber",
  "blockTimestamp",
  "transactionHash",
  "transactionIndex",
  "logIndex",
] as const;

const emitOptionNames = new Set(["blockNumber", "transactionHash"]);

/** Whether `log` already has a position on the chain (e.g. from `mock.buildLog()`): it's placed only once. */
export const isPlaced = (log: object) => positionFields.some((field) => field in log);

/** The gas a transaction used: its receipt's, or else what it was sent with. */
const gasUsedBy = ({ receipt, fields }: TransactionRecord) => receipt.gasUsed ?? fields.gas ?? 0n;

export type TransactionStore = ReturnType<typeof createTransactionStore>;

/**
 * The chain's transactions, one record each, in blocks of `state`: what
 * `emit` and sends put on the chain, and what receipts, transactions, blocks and
 * `eth_getLogs` answer from once a request doesn't match a mock. A record is
 * on the chain once its block is mined (at or below the head); placed in a
 * later block, it's waiting, as a pending transaction is.
 */
export function createTransactionStore({
  state,
  registry,
}: {
  state: ChainState;
  /** What the contract registry knows, for checking addresses. */
  registry: { isEmpty(address: Address): boolean };
}) {
  /** In chain order: by block, and in a block by index. */
  let records: TransactionRecord[] = [];
  /** Hashes the last `restore()` or `reset()` took off the chain, lowercase, for hints. */
  let removed = new Set<string>();

  const find = (hash: Hash) =>
    records.find((record) => record.hash.toLowerCase() === hash.toLowerCase());
  const inBlock = (number: bigint) =>
    records.filter((record) => record.position.blockNumber === number);
  /** The record's position once it's on the chain; `undefined` while it waits. */
  const minedAt = ({ position }: TransactionRecord) =>
    position.blockNumber <= state.blockNumber ? position : undefined;

  /**
   * Puts a transaction on the chain: in `blockNumber`, after what's placed
   * there, or left out, as a sent one is: in a newly mined block. Checks
   * everything first, so a refused record changes nothing, mining included.
   */
  function add(record: NewRecord, { blockNumber }: { blockNumber?: bigint | undefined } = {}) {
    for (const log of record.logs)
      if (registry.isEmpty(getAddress(log.address)))
        throw new MockSetupError(
          `${log.address} is marked empty(), with no code to emit this log.`,
        );
    const number = blockNumber ?? state.blockNumber + 1n;
    const earlier = inBlock(number);
    const index = earlier.length;
    const hash = record.hash ?? testHash(`tx:${number}:${index}`);
    if (find(hash) !== undefined)
      throw new MockSetupError(`Transaction ${hash} is already on the chain.`, {
        // A hash the mock made collides only with one named after its position.
        metaMessages:
          record.hash === undefined
            ? [`Name a hash other than one the mock makes, testHash("tx:<block>:<index>").`]
            : [
                "Each emit() is a transaction: emit a transaction's logs together, as mock.emit([a, b]).",
              ],
      });
    const firstLogIndex = earlier.reduce((count, each) => count + each.logs.length, 0);
    // Frozen, topics too, so changing one throws instead of changing what the chain answers.
    const logs = record.logs.map((value, i) => {
      const log = placeLog(value, {
        blockHash: blockHash(number),
        blockNumber: number,
        blockTimestamp: state.timestampAt(number),
        transactionHash: hash,
        transactionIndex: index,
        logIndex: firstLogIndex + i,
      });
      Object.freeze(log.topics);
      return Object.freeze(log);
    });
    const added: TransactionRecord = Object.freeze({
      ...record,
      hash,
      // Copies, so the caller's objects can't change the chain afterwards.
      fields: Object.freeze({ ...record.fields }),
      receipt: Object.freeze({ ...record.receipt }),
      logs: Object.freeze(logs),
      position: Object.freeze({ blockNumber: number, index }),
    });
    const later = records.findIndex(({ position }) => position.blockNumber > number);
    records.splice(later === -1 ? records.length : later, 0, added);
    if (blockNumber === undefined) mine();
    return added;
  }

  /** Mines `blocks` blocks. A pending record would be placed in the first one here. */
  function mine(blocks = 1n) {
    state.mine(blocks);
  }

  /** Whether a write's resolver is running its body, during which `emit` is refused. */
  let writing = false;

  /**
   * Runs a write's resolver, refusing `emit` in its body: it would put a
   * transaction of its own on the chain, mined in the middle of the send.
   * Only up to its first `await`, so code elsewhere (a demo's ticker) can
   * still emit while a resolver waits.
   */
  function whileWriting<result>(run: () => result): result {
    const outer = writing;
    writing = true;
    try {
      return run();
    } finally {
      writing = outer;
    }
  }

  /** Places one transaction's logs, returning one for one and an array for an array. */
  function emit(log: MockEventLog, options?: EmitOptions): EmittedLog;
  function emit(logs: readonly MockEventLog[], options?: EmitOptions): EmittedLog[];
  function emit(
    given: MockEventLog | readonly MockEventLog[],
    options: EmitOptions = {},
  ): EmittedLog | EmittedLog[] {
    if (writing)
      throw new MockSetupError("emit() can't run while a write's resolver answers a send.", {
        metaMessages: [
          "Use the resolver's emit(), which adds logs to the transaction it answers; this one " +
            "would put a transaction of its own on the chain, mined mid-send.",
        ],
      });
    const values = isLogList(given) ? given : [given];
    if (values.length === 0) throw new MockSetupError("emit() requires at least one log.");
    for (const value of values)
      if (isPlaced(value))
        throw new MockSetupError(
          "emit() places logs itself, but this one already has a position (e.g. from " +
            "mock.buildLog()).",
          {
            metaMessages: [
              "Pass a log from contract.events, and set its block or transaction in emit()'s options.",
            ],
          },
        );
    const unknown = Object.keys(options).find((key) => !emitOptionNames.has(key));
    if (unknown !== undefined)
      throw new MockSetupError(`emit() has no option "${unknown}".`, {
        metaMessages: [
          "Its options are blockNumber and transactionHash; without blockNumber, it mines a new block.",
        ],
      });
    const { logs } = add(
      { origin: "added", hash: options.transactionHash, fields: {}, receipt: {}, logs: values },
      { blockNumber: options.blockNumber },
    );
    return isLogList(given) ? [...logs] : logs[0]!;
  }

  /** A record's transaction in its JSON-RPC form: pending until its block is mined. */
  function transactionOf(record: TransactionRecord) {
    const mined = minedAt(record);
    return encodeTransaction(
      state,
      mined === undefined
        ? { ...record.fields, blockNumber: null }
        : { ...record.fields, blockNumber: mined.blockNumber, transactionIndex: mined.index },
      record.hash,
    );
  }

  /**
   * The emitted logs a call asks for, sorted by block and log index. Errors
   * are reth's for the same filter. A range never passes the head, so it
   * only finds records on the chain.
   */
  function logsFor(call: LogsCall): EmittedLog[] {
    if (call.topics.length > 4)
      throw new MockRpcError(-32602, "query exceeds the maximum of 4 topics");
    const head = state.blockNumber;
    let from: bigint;
    let to: bigint;
    if (call.blockHash === undefined) {
      from = call.fromBlock ?? head;
      to = call.toBlock ?? head;
      if (from > head || to > head)
        throw new MockRpcError(-32602, "block range extends beyond current head block");
      if (from > to) throw new MockRpcError(-32602, "invalid block range params");
    } else {
      const number = numberOfBlockHash(call.blockHash);
      if (number === undefined || number > head)
        throw new MockRpcError(-32000, `block not found: ${call.blockHash.slice(2)}`);
      from = number;
      to = number;
    }

    const addresses = call.address === undefined ? [] : [call.address].flat();
    return allLogs().filter(
      (log) =>
        log.blockNumber >= from &&
        log.blockNumber <= to &&
        (addresses.length === 0 || addresses.includes(getAddress(log.address))) &&
        topicsMatch(call.topics, log.topics),
    );
  }

  const allLogs = () => records.flatMap((record) => record.logs);

  /**
   * The nonce `address`'s next transaction would take: one past the highest
   * it has sent, or 0. At `"pending"`, over every send; at a block, over
   * those mined at or before it. Emits aren't sends: they count for no one.
   */
  function nonceOf(address: Address, block: bigint | "pending") {
    const from = getAddress(address);
    const sent = records.filter((record) => {
      const mined = minedAt(record);
      return (
        record.fields.from === from &&
        (block === "pending" || (mined !== undefined && mined.blockNumber <= block))
      );
    });
    return Math.max(0, ...sent.map(({ fields }) => (fields.nonce ?? 0) + 1));
  }

  return {
    add,
    emit,
    whileWriting,
    mine,
    logsFor,
    nonceOf,
    /**
     * The receipt for `hash` in its JSON-RPC form: `null` while its block
     * isn't mined, and `undefined` for a hash not on the chain.
     */
    receiptFor(hash: Hash) {
      const record = find(hash);
      if (record === undefined) return undefined;
      const mined = minedAt(record);
      if (mined === undefined) return null;
      // What it shares with its transaction comes from it, so the two agree.
      const { from, to, type, gasPrice } = formatTransaction(transactionOf(record));
      const upToIt = inBlock(mined.blockNumber).slice(0, mined.index + 1);
      return toRpcReceipt(
        completeReceipt(
          {
            effectiveGasPrice: gasPrice ?? 0n,
            ...record.receipt,
            from,
            to,
            type,
            gasUsed: gasUsedBy(record),
            cumulativeGasUsed: upToIt.reduce((sum, each) => sum + gasUsedBy(each), 0n),
            blockNumber: mined.blockNumber,
            transactionIndex: mined.index,
            logs: [...record.logs],
          },
          { hash: record.hash, blockNumber: mined.blockNumber, timestampAt: state.timestampAt },
        ),
      );
    },
    /** Where the transaction with `hash` is, once its block is mined; `undefined` until then. */
    minedAt: (hash: Hash) => {
      const record = find(hash);
      return record === undefined ? undefined : minedAt(record);
    },
    /** The record for `hash` once its block is mined; `undefined` until then, or for a hash not on the chain. */
    minedRecord: (hash: Hash) => {
      const record = find(hash);
      return record !== undefined && minedAt(record) !== undefined ? record : undefined;
    },
    /** The transaction for `hash` in its JSON-RPC form, or `undefined` for a hash not on the chain. */
    transactionFor(hash: Hash) {
      const record = find(hash);
      return record === undefined ? undefined : transactionOf(record);
    },
    /** Block `number`'s transactions, in order: their hashes, or with `full`, their JSON-RPC forms. */
    transactionsIn(number: bigint, full: boolean) {
      const listed = inBlock(number);
      return full ? listed.map((record) => transactionOf(record)) : listed.map(({ hash }) => hash);
    },
    /** Every record, by block and index. */
    get transactions(): TransactionRecord[] {
      return [...records];
    },
    /** Every placed log, by block and log index. */
    get logs(): EmittedLog[] {
      return allLogs();
    },
    /** Whether the last `restore()` or `reset()` took the transaction with `hash` off the chain. */
    removedByLastRestore: (hash: string) => removed.has(hash.toLowerCase()),
    /** Saves the records; `restore()` puts them back, removing later ones. */
    snapshot() {
      const saved = [...records];
      return {
        restore() {
          const kept = new Set(saved);
          removed = new Set(
            records.filter((record) => !kept.has(record)).map(({ hash }) => hash.toLowerCase()),
          );
          records = [...saved];
        },
      };
    },
  };
}

function isLogList(
  given: MockEventLog | readonly MockEventLog[],
): given is readonly MockEventLog[] {
  return Array.isArray(given);
}
