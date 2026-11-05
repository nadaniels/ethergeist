import { type Address, type Hash, type Hex, getAddress, isHash, isHex } from "viem";

import { type MockEventLog, isPlaced } from "../logs/events.js";
import { formatValue } from "../mocking/format.js";
import { MockSetupError } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import { refuseNonLogs, refuseRevertedLogs } from "./writeOutcome.js";

/**
 * A transaction the app didn't send, as `mock.addTransaction` takes it, in
 * a send's words: its call's fields, its write outcome's, and where it goes.
 * Every field may be left out: `mock.addTransaction()` adds a success from
 * and to the zero address, with no input, no value and no logs.
 */
export type AddTransactionParameters = {
  /** Its sender. Left out, the zero address, and its nonce counts for no one. */
  from?: Address;
  /** Who it calls. Left out, the zero address; deploys (`to: null`) aren't supported. */
  to?: Address;
  value?: bigint;
  /** Its calldata, which the record and the transaction answer as `input`, as viem does. */
  data?: Hex;
  /**
   * Left out, `from`'s next, as a send takes it, so each transaction added
   * from the same `from` takes the next; given, it's taken as given, as a
   * replacement's. Either way it counts for `from`, as a send's does.
   */
  nonce?: number;
  /** Its logs, from a contract's `events`, `contractEvents()` or `testLog()`: placed here. */
  logs?: readonly MockEventLog[];
  /** Left out, a success. A reverted one has no logs: they're refused. */
  status?: "success" | "reverted";
  gasUsed?: bigint;
  /**
   * The block to place it in, after the transactions already there,
   * without mining: an earlier block for history, the current one to share
   * a block, or a later one, which is on the chain once it's mined. A
   * watcher that has already polled the block misses it, as it misses
   * anything added to a block it has read. Left out, a newly mined block.
   */
  blockNumber?: bigint;
  /**
   * Its hash, e.g. one the app reads from a URL. Left out, one made from
   * its position. Refused if it's already on the chain.
   */
  hash?: Hash;
};

const addTransactionFields = new Set([
  "from",
  "to",
  "value",
  "data",
  "nonce",
  "logs",
  "status",
  "gasUsed",
  "blockNumber",
  "hash",
]);
const fieldsHint =
  "Its fields are from, to, value, data, nonce, logs, status, gasUsed, blockNumber and hash; " +
  "without blockNumber, it mines a new block.";

/**
 * `mock.addTransaction`'s fields, checked, as the store's record takes them:
 * addresses checksummed, `data` as `input`, and the outcome as its receipt.
 * Placement is the store's: `hash` goes on the record, `blockNumber` to `add`.
 */
export function checkAddTransaction(fields: AddTransactionParameters) {
  if (!isPlainObject(fields))
    throw new MockSetupError(
      `mock.addTransaction() takes an object of fields; got ${formatValue(fields)}.`,
      { metaMessages: [fieldsHint] },
    );
  const unknown = Object.keys(fields).find((key) => !addTransactionFields.has(key));
  if (unknown !== undefined)
    throw new MockSetupError(`mock.addTransaction() has no field ${unknown}.`, {
      metaMessages: [
        unknown === "transactionHash"
          ? "The transaction's hash is hash, as on a transaction; transactionHash is a log's."
          : unknown === "address" || unknown === "topics"
            ? "A log goes in logs: mock.addTransaction({ logs: [log] })."
            : fieldsHint,
      ],
    });
  const { value, data, nonce, logs = [], status, gasUsed, blockNumber, hash } = fields;
  if (fields.to === null)
    throw new MockSetupError("mock.addTransaction() doesn't deploy: to can't be null.");
  // getAddress validates them, with viem's error.
  const from = fields.from === undefined ? undefined : getAddress(fields.from);
  const to = fields.to === undefined ? undefined : getAddress(fields.to);
  for (const [name, amount] of Object.entries({ value, gasUsed }))
    if (amount !== undefined && (typeof amount !== "bigint" || amount < 0n))
      throw new MockSetupError(
        `A transaction's ${name} must be a bigint, zero or more; got ${formatValue(amount)}.`,
      );
  if (data !== undefined && !isHex(data))
    throw new MockSetupError(`A transaction's data must be hex; got ${formatValue(data)}.`);
  if (nonce !== undefined && (!Number.isSafeInteger(nonce) || nonce < 0))
    throw new MockSetupError(
      `A transaction's nonce must be an integer, zero or more; got ${formatValue(nonce)}.`,
    );
  if (status !== undefined && status !== "success" && status !== "reverted")
    throw new MockSetupError(
      `A transaction's status is "success" or "reverted"; got ${formatValue(status)}.`,
    );
  refuseNonLogs(logs, "A transaction's");
  refuseRevertedLogs(status, logs);
  if (logs.some((log) => isPlaced(log)))
    throw new MockSetupError(
      "mock.addTransaction() places logs itself, but one already has a position (e.g. from " +
        "mock.buildLog()).",
      {
        metaMessages: [
          "Pass a log from contract.events, and its block or hash as addTransaction()'s " +
            "blockNumber or hash.",
        ],
      },
    );
  if (blockNumber !== undefined && (typeof blockNumber !== "bigint" || blockNumber < 0n))
    throw new MockSetupError(
      `A block number must be a bigint, zero or more; got ${formatValue(blockNumber)}.`,
    );
  if (hash !== undefined && (typeof hash !== "string" || !isHash(hash)))
    throw new MockSetupError(`A transaction hash must be 32 bytes; got ${formatValue(hash)}.`);
  return {
    origin: "added" as const,
    hash,
    fields: {
      ...(from !== undefined && { from }),
      ...(to !== undefined && { to }),
      ...(nonce !== undefined && { nonce }),
      ...(value !== undefined && { value }),
      ...(data !== undefined && { input: data }),
    },
    receipt: {
      ...(status !== undefined && { status }),
      ...(gasUsed !== undefined && { gasUsed }),
    },
    logs,
    blockNumber,
  };
}
