import {
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
  formatTransaction,
  getAddress,
  getContractAddress,
} from "viem";

import { blockHash, numberOfBlockHash } from "../chain/blocks.js";
import {
  type ReceiptFields,
  checkStatus,
  completeReceipt,
  placeLog,
  toRpcReceipt,
} from "../chain/receipts.js";
import type { ChainState } from "../chain/state.js";
import { type MockTransactionType, encodeTransaction } from "../chain/transactions.js";
import { type EmittedLog, type MockLogContent, checkLogs } from "../logs/events.js";
import { type LogsCall, topicsMatch } from "../logs/filter.js";
import { impliedGas } from "../mocking/gas.js";
import { MockRpcError, MockSetupError } from "../shared/errors.js";
import { testHash } from "../shared/testValues.js";
import { type AddTransactionParameters, checkAddTransaction } from "./addTransaction.js";
import type { MockWriteOutcome } from "./writes.js";

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

/**
 * A mocked receipt: any receipt fields, in viem's types, and its logs'
 * content (see `logs`).
 */
export type MockReceipt = ReceiptFields & {
  /**
   * Its logs' content, from `contract.events`, `contractEvents()` or
   * `testLog()`, in place of any its transaction has. The receipt places
   * them in its block and transaction. They answer this receipt only:
   * viem's `getLogs()` and watchers don't see them. To have them seen, place
   * the transaction with `mock.addTransaction({ hash, logs })`. A reverted
   * receipt with logs is refused: its own, or its mined transaction's.
   */
  logs?: readonly MockLogContent[];
};

/** Names a part of a mocked receipt for messages, as the user wrote it. */
type ReceiptNames = (part: string) => string;

/** Where a transaction's logs are placed: its block and its place in it. */
type LogsPosition = Pick<
  TransactionReceipt,
  "blockHash" | "blockNumber" | "transactionHash" | "transactionIndex"
>;

/**
 * What `placeSend` takes: the transaction a send asked for, with its
 * calldata as `data`, as a request names it.
 */
type SentTransaction = Omit<TransactionRecord["fields"], "from" | "to" | "input"> & {
  from: Address;
  to: Address | null;
  data?: Hex;
};

/** What `add` takes: a record's facts, which it places. */
type NewRecord = Pick<TransactionRecord, "origin" | "fields" | "receipt"> & {
  /** Lowercase; left out, one the mock makes from its chain id and position. */
  hash?: Hash | undefined;
  logs: readonly MockLogContent[];
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
   * The record's position once it's on the chain; `undefined` while it
   * waits.
   */
  const minedAt = ({ position }: TransactionRecord) =>
    position.blockNumber <= state.blockNumber ? position : undefined;
  /**
   * `contents` placed as a transaction's logs at `position`, with block
   * timestamps, as reth sends them. Their indexes count on from the logs of
   * the block's earlier transactions, as a node counts them.
   */
  const placeLogs = (contents: readonly MockLogContent[], position: LogsPosition) => {
    const { blockNumber, transactionIndex } = position;
    const firstLogIndex = inBlock(blockNumber)
      .filter((record) => record.position.index < transactionIndex)
      .reduce((count, record) => count + record.logs.length, 0);
    const blockTimestamp = state.timestampAt(blockNumber);
    return contents.map((content, i) =>
      placeLog(content, {
        blockHash: position.blockHash,
        blockNumber,
        blockTimestamp,
        transactionHash: position.transactionHash,
        transactionIndex,
        logIndex: firstLogIndex + i,
      }),
    );
  };

  /**
   * Places a transaction in `blockNumber`, after what's placed there, or,
   * left out, in a newly mined block, as a send is. Checks everything first,
   * so a refused record changes nothing, mining included. A nonce left out
   * is `from`'s next, waiting transactions included (`nonceOf`), not a
   * `getTransactionCount` mock's. A deploy's address (only a send deploys)
   * follows from both, unless its receipt gives one.
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
    const hash = record.hash ?? testHash(`tx:${state.chain.id}:${number}:${index}`);
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
    const logs = placeLogs(record.logs, {
      blockHash: blockHash(number),
      blockNumber: number,
      transactionHash: hash,
      transactionIndex: index,
    }).map((log) => {
      Object.freeze(log.topics);
      return Object.freeze(log);
    });
    const fields = { ...record.fields };
    const receipt = { ...record.receipt };
    if (fields.from !== undefined) {
      fields.nonce ??= nonceOf(fields.from, "pending");
      if (fields.to === null)
        receipt.contractAddress ??= getContractAddress({
          from: fields.from,
          nonce: BigInt(fields.nonce),
        });
    }
    const added: TransactionRecord = Object.freeze({
      ...record,
      hash,
      fields: Object.freeze(fields),
      receipt: Object.freeze(receipt),
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
   * Whether a send's outcome is being chosen (see `whileSending`): adding a
   * transaction is refused then.
   */
  let sending = false;

  /**
   * Runs `run`, which chooses a send's outcome, refusing `addTransaction`
   * (and so `contract.emit`) until `run` first awaits: a send mock's
   * resolver would place a transaction of its own, mid-send. Code elsewhere
   * (a demo's ticker) can still add one while a send waits.
   */
  function whileSending<result>(run: () => result): result {
    const outer = sending;
    sending = true;
    try {
      return run();
    } finally {
      sending = outer;
    }
  }

  /**
   * Places one transaction the app didn't send, from `fields`: checked
   * first, then in `blockNumber`, or left out, in a newly mined block.
   */
  function addTransaction(fields: AddTransactionParameters = {}): TransactionRecord {
    if (sending)
      throw new MockSetupError(
        "mock.addTransaction() and contract.emit can't run while a send mock's resolver answers a send.",
        {
          metaMessages: [
            "They would place a transaction of their own, mid-send.",
            "For the send's own logs, return them from the resolver: " +
              "return { logs: [contract.events.Transfer(args)] }.",
          ],
        },
      );
    const { blockNumber, ...record } = checkAddTransaction(fields);
    return add(record, { blockNumber });
  }

  /**
   * Places a send's transaction in a newly mined block: `sent` as its
   * request asked for it, and `outcome` as what the chain did. Gas left out
   * is `impliedGas`. `hash` is a raw send's, from its bytes; left out, the
   * mock makes one.
   */
  function placeSend({
    hash,
    sent,
    outcome,
  }: {
    hash?: Hash | undefined;
    sent: SentTransaction;
    outcome: MockWriteOutcome;
  }) {
    const { data, gas = impliedGas, ...fields } = sent;
    const { logs = [], ...receipt } = outcome;
    return add({
      origin: "sent",
      hash,
      fields: { ...fields, ...(data && { input: data }), gas },
      receipt,
      logs,
    });
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
   * `receipt` completed, with `logs` placed at the position it completes
   * with, a mock's included.
   */
  function receiptWith(
    receipt: ReceiptFields,
    logs: readonly MockLogContent[],
    at: { hash: Hash | undefined; blockNumber: bigint },
  ): TransactionReceipt {
    const complete = completeReceipt(receipt, at);
    return { ...complete, logs: placeLogs(logs, complete) };
  }

  /**
   * A mined record's receipt, with `override`'s fields (a mock's) over it,
   * and `logs` (a mock's content) in place of its own.
   */
  function receiptOf(
    record: TransactionRecord,
    override: ReceiptFields = {},
    logs: readonly MockLogContent[] = record.logs,
  ) {
    const { position } = record;
    // What it shares with its transaction comes from it, so the two agree.
    const { from, to, type, gasPrice } = formatTransaction(transactionOf(record));
    const upToIt = inBlock(position.blockNumber).slice(0, position.index + 1);
    return receiptWith(
      {
        effectiveGasPrice: gasPrice ?? 0n,
        ...record.receipt,
        from,
        to,
        type,
        gasUsed: gasUsedBy(record),
        cumulativeGasUsed: upToIt.reduce((sum, each) => sum + gasUsedBy(each), 0n),
        blockNumber: position.blockNumber,
        transactionIndex: position.index,
        ...override,
      },
      logs,
      { hash: record.hash, blockNumber: position.blockNumber },
    );
  }

  /**
   * A mocked receipt for a hash with no mined transaction: `receipt`'s fields
   * over zeros, in block `blockNumber` (left out, the head), with its logs'
   * content placed in it. Logs that aren't content, are already placed, or
   * are on a reverted receipt are refused.
   */
  function placedReceipt(
    receipt: MockReceipt,
    named: ReceiptNames,
    {
      hash,
      blockNumber = state.blockNumber,
    }: { hash?: Hash | undefined; blockNumber?: bigint | undefined } = {},
  ): TransactionReceipt {
    const { logs = [], ...fields } = receipt;
    checkLogs(logs, named);
    checkStatus(fields.status, logs, named("status"));
    return receiptWith(fields, logs, { hash, blockNumber });
  }

  /**
   * A mocked receipt for `hash` in its JSON-RPC form: its fields over its
   * mined transaction's receipt, or for a hash with no mined transaction
   * (or none yet, at registration), placed at `blockNumber`. A status that
   * disagrees with the logs is refused, the transaction's own included.
   */
  function mockedReceipt(
    receipt: MockReceipt,
    named: ReceiptNames,
    { hash, blockNumber }: { hash: Hash | undefined; blockNumber: bigint },
  ) {
    const record = hash === undefined ? undefined : find(hash);
    const mined = record && minedAt(record);
    if (record === undefined || mined === undefined)
      return toRpcReceipt(placedReceipt(receipt, named, { hash, blockNumber }));
    const { logs, ...fields } = receipt;
    if (logs !== undefined) checkLogs(logs, named);
    checkStatus(fields.status ?? record.receipt.status, logs ?? record.logs, named("status"), [
      fields.status === undefined
        ? `Transaction ${record.hash} on the chain reverted: answer this receipt without logs, ` +
          'or add it with them and without status: "reverted", so every method agrees.'
        : `Transaction ${record.hash} on the chain has ${record.logs.length} log(s): answer this ` +
          'receipt without them, { status: "reverted", logs: [] }, or add it reverted, ' +
          'mock.addTransaction({ …, status: "reverted" }), so every method agrees.',
    ]);
    return toRpcReceipt(receiptOf(record, fields, logs));
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
      from = call.fromBlock;
      to = call.toBlock;
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
    // A record with a `from` always has a nonce: `add` fills it in.
    return Math.max(0, ...sent.map(({ fields }) => fields.nonce! + 1));
  }

  return {
    addTransaction,
    placeSend,
    whileSending,
    mine,
    logsFor,
    nonceOf,
    /**
     * The receipt for `hash` in its JSON-RPC form: `null` while its block
     * isn't mined, and `undefined` for a hash with no placed transaction.
     */
    receiptFor(hash: Hash) {
      const record = find(hash);
      if (record === undefined) return undefined;
      const mined = minedAt(record);
      return mined === undefined ? null : toRpcReceipt(receiptOf(record));
    },
    mockedReceipt,
    placedReceipt,
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
