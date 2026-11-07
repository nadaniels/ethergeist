import { type Address, type Hash, type Hex, getAddress, isHex } from "viem";

import { nodeHash } from "../chain/hashes.js";
import { type MockEventLog, isPlaced, refuseNonLogs } from "../logs/events.js";
import { formatValue } from "../mocking/format.js";
import { MockSetupError } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import { refuseRevertedLogs } from "./writeOutcome.js";

/**
 * What `mock.addTransaction()` takes: a transaction the app didn't send, in
 * a send's words. Its fields are its call's, its outcome's, and where it
 * goes. Every field may be left out: `mock.addTransaction()` adds a success
 * from and to the zero address, with no input, value, gas used or logs.
 */
export type AddTransactionParameters = {
  /**
   * Its sender. Defaults to the zero address, and then its nonce counts for
   * no one.
   */
  from?: Address;
  /**
   * Who it calls. Defaults to the zero address. A deploy (`to: null`) is
   * refused.
   */
  to?: Address;
  /** Wei sent with it. Defaults to `0n`. */
  value?: bigint;
  /**
   * Its calldata, which its record and transaction hold as `input`, as viem
   * names it.
   */
  data?: Hex;
  /**
   * Its nonce, which counts for `from` as a send's does. Given, it's taken
   * as given, as a replacement's is. Defaults to `from`'s next, as a send
   * takes it, so each transaction added from the same `from` takes the
   * next; `0` without a `from`.
   */
  nonce?: number;
  /**
   * Its logs: content from `contract.events`, `contractEvents()` or
   * `testLog()`, placed here, at any address but an `empty()` one's. A
   * swap's logs from several contracts go in one transaction, e.g.
   * `{ logs: [a, b] }`. A placed log is refused.
   */
  logs?: readonly MockEventLog[];
  /**
   * Its receipt's status: with `"reverted"`, logs are refused, as a
   * reverted transaction has none. Defaults to `"success"`.
   */
  status?: "success" | "reverted";
  /** Its receipt's `gasUsed`. Defaults to `0n`. */
  gasUsed?: bigint;
  /**
   * The block to place it in, after the transactions already there,
   * without mining. Defaults to a newly mined block, which moves the clock
   * on: watchers and a waiting `waitForTransactionReceipt({ confirmations })`
   * see it.
   * - A later block: it waits until that block is mined, as with Anvil's
   *   automine off.
   * - The current block or an earlier one: it joins a block that's already
   *   mined, which no node can do. Use it for history, or for a test that
   *   pins a block. A watcher that has already polled the block misses it,
   *   as it misses anything added to a block it has read.
   */
  blockNumber?: bigint;
  /**
   * Its hash, e.g. one the app reads from a URL, in any case: its record
   * holds it lowercase, as a node sends it. Refused if a placed transaction
   * already has it. Defaults to one made from the chain id and its
   * position, `testHash("tx:<chainId>:<block>:<index>")`.
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
/** The hint for `transactionHash` where a transaction's hash is `hash`. */
export const transactionHashHint =
  "The transaction's hash is hash, as on a transaction; transactionHash is a log's.";
const fieldsHint =
  "Its fields are from, to, value, data, nonce, logs, status, gasUsed, blockNumber and hash; " +
  "without blockNumber, it mines a new block.";

/**
 * `mock.addTransaction()`'s fields, checked, as the store's record takes them:
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
          ? transactionHashHint
          : unknown === "address" || unknown === "topics"
            ? "A log goes in logs: mock.addTransaction({ logs: [log] })."
            : fieldsHint,
      ],
    });
  const { value, data, nonce, logs = [], status, gasUsed, blockNumber, hash } = fields;
  if (fields.to === null)
    throw new MockSetupError("mock.addTransaction() doesn't deploy: to can't be null.");
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
  return {
    origin: "added" as const,
    hash: hash === undefined ? undefined : nodeHash(hash, "A transaction hash"),
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
