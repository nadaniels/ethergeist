import { type Address, type Hash, type Hex, formatTransaction, getAddress } from "viem";

import { blockHash, numberOfBlockHash } from "../chain/blocks.js";
import { type ReceiptFields, completeReceipt, placeLog, toRpcReceipt } from "../chain/receipts.js";
import type { ChainState } from "../chain/state.js";
import { type MockTransactionType, encodeTransaction } from "../chain/transactions.js";
import type { EmittedLog, MockEventLog } from "../logs/events.js";
import { type LogsCall, topicsMatch } from "../logs/filter.js";
import { MockRpcError, MockSetupError } from "../shared/errors.js";
import { testHash } from "../shared/testValues.js";
import { type AddTransactionParameters, checkAddTransaction } from "./addTransaction.js";

/**
 * A placed transaction, as `mock.transactions` lists it: the facts it was
 * placed with, which its receipt, its transaction and its block answer
 * from. Frozen: once placed, a record never changes, and mining only moves
 * the head past it.
 */
export type TransactionRecord = {
  /** Lowercase, as a node sends it, however it was given. */
  readonly hash: Hash;
  /**
   * How it was placed: `"added"` by the mock's API (`mock.addTransaction()`
   * or `contract.emit`), or `"sent"` over JSON-RPC (`eth_sendTransaction`,
   * `eth_sendRawTransaction` or its Sync form), whoever sent it.
   */
  readonly origin: "added" | "sent";
  /**
   * The transaction's own fields, as its request or signed bytes had them;
   * any left out answer a node's defaults: zero or empty, an `"eip1559"`
   * type, and fees suggested at its block. An added one's are what it was
   * given, with `data` as `input`, and with a `from`, the nonce it took.
   */
  readonly fields: Readonly<{
    from?: Address;
    to?: Address | null;
    nonce?: number;
    value?: bigint;
    input?: Hex;
    gas?: bigint;
    type?: MockTransactionType;
    gasPrice?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  }>;
  /**
   * What its receipt says beyond its position and logs, where a send mock's
   * outcome or `mock.addTransaction()` set it, or a deploy's address. Left
   * out, a success that used the gas it was sent with (none for an added
   * one), at the price it paid.
   */
  readonly receipt: Readonly<{
    status?: "success" | "reverted";
    gasUsed?: bigint;
    effectiveGasPrice?: bigint;
    contractAddress?: Address;
  }>;
  /**
   * Its logs, placed in its block, with indexes counted across the block and
   * lowercase addresses: compare with `isAddressEqual()`, not `toBe()`.
   */
  readonly logs: readonly EmittedLog[];
  /**
   * Its block and index in it; a record is on the chain once its block is
   * mined.
   */
  readonly position: Readonly<{ blockNumber: bigint; index: number }>;
};

/** What `add` takes: a record's facts, which it places. */
type NewRecord = Pick<TransactionRecord, "origin" | "fields" | "receipt"> & {
  /** Lowercase; left out, one the mock makes from its chain id and position. */
  hash?: Hash | undefined;
  logs: readonly MockEventLog[];
};

/**
 * Where a block mock answers its transactions: its number, hash and
 * timestamp.
 */
type BlockPlacement = { blockNumber: bigint; blockHash: Hash; blockTimestamp: bigint };

/** The gas a transaction used: its receipt's, or else what it was sent with. */
const gasUsedBy = ({ receipt, fields }: TransactionRecord) => receipt.gasUsed ?? fields.gas ?? 0n;

/** The chain's transactions: see `createTransactionStore`. */
export type TransactionStore = ReturnType<typeof createTransactionStore>;

/**
 * The chain's transactions, one record each, in blocks of `state`: what
 * `addTransaction` and sends place, and what receipts, transactions, blocks
 * and `eth_getLogs` answer from when unmocked. A record is on the chain once
 * its block is mined (at or below the head); placed in a later block, it's
 * waiting, as a pending transaction is.
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
  /**
   * Hashes of the records the last `restore()` or `reset()` removed, for
   * hints.
   */
  let removed = new Set<string>();

  // Hashes are lowercase wherever they come in (requests, `add`), so they
  // compare as they are.
  const find = (hash: Hash) => records.find((record) => record.hash === hash);
  const inBlock = (number: bigint) =>
    records.filter((record) => record.position.blockNumber === number);
  /**
   * How many logs the transactions before `index` in block `number` have: a
   * log's index counts across its block.
   */
  const logsBefore = (number: bigint, index: number) =>
    inBlock(number)
      .filter((record) => record.position.index < index)
      .reduce((count, record) => count + record.logs.length, 0);
  /**
   * The record's position once it's on the chain; `undefined` while it
   * waits.
   */
  const minedAt = ({ position }: TransactionRecord) =>
    position.blockNumber <= state.blockNumber ? position : undefined;

  /**
   * Places a transaction in `blockNumber`, after what's placed there, or,
   * left out, in a newly mined block, as a send is. Checks everything first,
   * so a refused record changes nothing, mining included.
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
    const hash = record.hash ?? testHash(`tx:${state.chainId}:${number}:${index}`);
    if (find(hash) !== undefined)
      throw new MockSetupError(`Transaction ${hash} is already in mock.transactions.`, {
        metaMessages: [
          record.hash === undefined
            ? `Name a hash other than one the mock makes, testHash("tx:<chainId>:<block>:<index>").`
            : record.origin === "added"
              ? "Give each added transaction its own hash; one transaction's logs go in one " +
                "call, as mock.addTransaction({ logs: [a, b] })."
              : "A transaction added in a block not mined yet already claims this hash: give " +
                "that one another hash.",
        ],
      });
    const firstLogIndex = logsBefore(number, index);
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

  /**
   * Mines `blocks` blocks: all mining goes through here, `mock.mine()`'s
   * too.
   */
  function mine(blocks = 1) {
    state.mine(blocks);
  }

  /**
   * Whether a send mock's resolver is running, up to its first `await`:
   * adding a transaction is refused then.
   */
  let writing = false;

  /**
   * Runs a send mock's resolver, refusing `addTransaction` (and so
   * `contract.emit`) in it up to its first `await`: it would place a
   * transaction of its own, mined in the middle of the send. Code elsewhere
   * (a demo's ticker) can still add one while a resolver waits.
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

  /**
   * Places one transaction the app didn't send, from `fields`: checked
   * first, then in `blockNumber`, or left out, in a newly mined block. A
   * nonce left out is `from`'s next, as a send takes it.
   */
  function addTransaction(fields: AddTransactionParameters = {}): TransactionRecord {
    if (writing)
      throw new MockSetupError(
        "mock.addTransaction() and contract.emit can't run while a send mock's resolver answers a send.",
        {
          metaMessages: [
            "Use the resolver's emit(), which adds logs to the transaction it answers; these " +
              "would place a transaction of their own mid-send.",
          ],
        },
      );
    const { blockNumber, ...record } = checkAddTransaction(fields);
    const { from, nonce } = record.fields;
    return add(
      from === undefined || nonce !== undefined
        ? record
        : { ...record, fields: { ...record.fields, nonce: nonceOf(from, "pending") } },
      { blockNumber },
    );
  }

  /**
   * A record's transaction in its JSON-RPC form, pending until its block is
   * mined, with `override`'s fields (a mock's) over it: `blockNumber: null`
   * answers it pending.
   */
  function transactionOf(record: TransactionRecord, override: object = {}) {
    const mined = minedAt(record);
    return encodeTransaction(
      state,
      {
        ...record.fields,
        ...(mined === undefined || ("blockNumber" in override && override.blockNumber === null)
          ? { blockNumber: null }
          : { blockNumber: mined.blockNumber, transactionIndex: mined.index }),
        ...override,
      },
      record.hash,
    );
  }

  /**
   * The chain's logs a `getLogs` call asks for, by block and log index. Errors
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
   * of its transactions, or `0`. At `"pending"`, over all of them; at a
   * block, over those mined at or before it. Sends count, and so do
   * transactions added with a `from`; one added without counts for no one.
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
    logsBefore,
    add,
    addTransaction,
    whileWriting,
    mine,
    logsFor,
    nonceOf,
    /**
     * The receipt for `hash` in its JSON-RPC form, with `override`'s fields
     * (a mock's) over it, and `logs` (a mock's content) in place of its own:
     * `null` while its block isn't mined, and `undefined` for a hash with no
     * placed transaction.
     */
    receiptFor(hash: Hash, override: ReceiptFields = {}, logs?: readonly MockEventLog[]) {
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
            ...override,
          },
          {
            hash: record.hash,
            blockNumber: mined.blockNumber,
            timestampAt: state.timestampAt,
            logsBefore,
            logs: logs ?? record.logs,
          },
        ),
      );
    },
    /**
     * Where the transaction with `hash` is, once its block is mined;
     * `undefined` until then.
     */
    minedAt: (hash: Hash) => {
      const record = find(hash);
      return record === undefined ? undefined : minedAt(record);
    },
    /**
     * The record for `hash` once its block is mined; `undefined` while it
     * waits, or for a hash with no placed transaction.
     */
    minedRecord: (hash: Hash) => {
      const record = find(hash);
      return record !== undefined && minedAt(record) !== undefined ? record : undefined;
    },
    /**
     * The transaction for `hash` in its JSON-RPC form, with `override`'s
     * fields (a mock's) over it, pending while it waits, or `undefined` for a
     * hash with no placed transaction.
     */
    transactionFor(hash: Hash, override?: object) {
      const record = find(hash);
      return record === undefined ? undefined : transactionOf(record, override);
    },
    /**
     * Block `number`'s transactions, in order: their hashes, or with `full`,
     * their JSON-RPC forms, placed in `placement` (a block mock's) when given.
     */
    transactionsIn(number: bigint, full: boolean, placement?: BlockPlacement) {
      const listed = inBlock(number);
      return full
        ? listed.map((record) => transactionOf(record, placement))
        : listed.map(({ hash }) => hash);
    },
    /** Every record, by block and index. */
    get transactions(): TransactionRecord[] {
      return [...records];
    },
    /** Every placed log, by block and log index. */
    get logs(): EmittedLog[] {
      return allLogs();
    },
    /**
     * Whether the last `restore()` or `reset()` removed the transaction with
     * `hash`.
     */
    removedByLastRestore: (hash: string) => removed.has(hash),
    /** Saves the records; `restore()` puts them back, removing later ones. */
    snapshot() {
      const saved = [...records];
      return {
        restore() {
          const kept = new Set(saved);
          removed = new Set(records.filter((record) => !kept.has(record)).map(({ hash }) => hash));
          records = [...saved];
        },
      };
    },
  };
}
