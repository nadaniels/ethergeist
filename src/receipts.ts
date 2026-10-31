import { TransactionReceipt as OxTransactionReceipt } from "ox";
import {
  type AccessList,
  type Address,
  type Hex,
  type Hash,
  type Log,
  type SignedAuthorizationList,
  type TransactionEIP1559,
  type TransactionEIP2930,
  type TransactionEIP4844,
  type TransactionEIP7702,
  type TransactionLegacy,
  type TransactionReceipt,
  hexToBigInt,
  numberToHex,
  zeroAddress,
  zeroHash,
} from "viem";
import { type Fees, blobBaseFee, blockHash } from "./blocks.js";
import { formatValue } from "./format.js";
import { nodeAddress } from "./result.js";

/**
 * A log in a mocked receipt. Fields left out come from the receipt, or are
 * zero. `topics` takes any list of hashes, not only viem's non-empty tuple.
 */
export type MockLog = Partial<Omit<Log<bigint, number, false>, "topics">> & {
  topics?: readonly Hex[];
};

/** A mocked receipt: any receipt fields, with logs that may be partial too. */
export type MockReceipt = Partial<Omit<TransactionReceipt, "logs">> & { logs?: MockLog[] };

const zeroBloom = `0x${"00".repeat(256)}` as const;

/**
 * A receipt for `hash` with `receipt`'s fields over useful defaults: `status`
 * is `"success"` (zero would mean reverted), the block is `blockNumber` unless
 * given, and each log's position, block, and transaction come from the receipt.
 * Everything else is zero. Addresses are validated, and lowercase as nodes send them.
 * `hash` is `undefined` while it isn't known yet, e.g. at registration.
 */
export function completeReceipt(
  receipt: MockReceipt,
  { hash, blockNumber }: { hash: Hash | undefined; blockNumber: bigint },
): TransactionReceipt {
  const { logs = [], ...fields } = receipt;
  const number = fields.blockNumber ?? blockNumber;
  const complete: Omit<TransactionReceipt, "logs"> = {
    blockHash: blockHash(number),
    blockNumber: number,
    contractAddress: null,
    cumulativeGasUsed: 0n,
    effectiveGasPrice: 0n,
    from: zeroAddress,
    gasUsed: 0n,
    logsBloom: zeroBloom,
    status: "success",
    to: zeroAddress,
    transactionHash: hash ?? zeroHash,
    transactionIndex: 0,
    type: "eip1559",
    ...fields,
  };
  complete.from = nodeAddress(complete.from);
  if (complete.to) complete.to = nodeAddress(complete.to);
  if (complete.contractAddress) complete.contractAddress = nodeAddress(complete.contractAddress);
  // Only a hash given now can be checked; a pinned request's arrives later.
  const known = receipt.transactionHash ?? hash;
  logs.forEach((log, i) => {
    assertInReceipt(i, "blockNumber", log.blockNumber, complete.blockNumber);
    assertInReceipt(i, "blockHash", log.blockHash, complete.blockHash);
    if (known !== undefined) assertInReceipt(i, "transactionHash", log.transactionHash, known);
    assertInReceipt(i, "transactionIndex", log.transactionIndex, complete.transactionIndex);
  });
  return {
    ...complete,
    logs: logs.map((log, logIndex) => placeLog(log, { ...complete, logIndex })),
  };
}

/** Throws if receipt log `index` names a block or transaction other than the receipt's. */
function assertInReceipt<value extends bigint | number | string>(
  index: number,
  field: string,
  actual: value | null | undefined,
  expected: value,
) {
  if (actual === undefined || actual === null) return;
  const same =
    typeof actual === "string" && typeof expected === "string"
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  if (!same)
    throw new Error(
      `Receipt log ${index} has ${field} ${formatValue(actual)}, but the receipt's is ` +
        `${formatValue(expected)}. A receipt places its logs: pass only their content, e.g. from ` +
        "contract.events.",
    );
}

/** Where a log sits on the chain: its block, transaction, and index in the block. */
export type LogPosition = Pick<
  Log<bigint, number, false>,
  "blockHash" | "blockNumber" | "transactionHash" | "transactionIndex" | "logIndex"
>;

/**
 * A complete log: `log`'s fields over `position`, with zeros for the rest.
 * Fields the log sets win, so a receipt's log can name its own position.
 * The address is validated, and lowercase as nodes send it.
 */
export function placeLog(log: MockLog, position: LogPosition): Log<bigint, number, false> {
  return Object.assign(
    {
      address: zeroAddress,
      topics: [],
      data: "0x",
      blockHash: position.blockHash,
      blockNumber: position.blockNumber,
      transactionHash: position.transactionHash,
      transactionIndex: position.transactionIndex,
      logIndex: position.logIndex,
      removed: false,
    } satisfies Log<bigint, number, false>,
    log,
    log.address === undefined ? {} : { address: nodeAddress(log.address) },
    // viem's tuple type only says "empty or not"; the hashes are the same.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same values, viem's narrower type
    log.topics === undefined ? {} : { topics: [...log.topics] as Log["topics"] },
  );
}

/** A receipt in its JSON-RPC form, logs included. */
export function toRpcReceipt(receipt: TransactionReceipt) {
  // ox types a log's topics as non-empty, but a LOG0 log has none, as viem
  // allows; ox passes topics through as they are.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ox's type is narrower than its runtime
  return OxTransactionReceipt.toRpc(receipt as OxTransactionReceipt.TransactionReceipt);
}

/** The transaction types viem knows. */
export type TransactionType = "legacy" | "eip2930" | "eip1559" | "eip4844" | "eip7702";

/** viem's transaction of `type`, mined or pending. */
type TransactionOf<type extends TransactionType, pending extends boolean> = {
  legacy: TransactionLegacy<bigint, number, pending>;
  eip2930: TransactionEIP2930<bigint, number, pending>;
  eip1559: TransactionEIP1559<bigint, number, pending>;
  eip4844: TransactionEIP4844<bigint, number, pending>;
  eip7702: TransactionEIP7702<bigint, number, pending>;
}[type];

/**
 * Any fields of viem's `type` transaction; `type` is optional for EIP-1559,
 * the default. A pending one says so: `blockNumber: null`.
 */
type MockTransactionOf<type extends TransactionType, pending extends boolean> = Partial<
  Omit<TransactionOf<type, pending>, "type" | "typeHex">
> &
  (type extends "eip1559" ? { type?: type } : { type: type }) &
  (pending extends true ? { blockNumber: null } : unknown);

/**
 * A mocked transaction: any fields of viem's transaction of its `type`
 * (`"eip1559"` when left out), so fields the type doesn't have are type
 * errors. `blockNumber: null` makes it pending: its block hash and index are
 * `null` then, and it has no `blockTimestamp`.
 */
export type MockTransaction = {
  [type in TransactionType]: MockTransactionOf<type, false> | MockTransactionOf<type, true>;
}[TransactionType];

/** The viem transaction a `MockTransaction` completes to: its type, mined or pending. */
export type BuiltTransaction<transaction extends MockTransaction = MockTransaction> =
  transaction extends unknown
    ? TransactionOf<
        transaction extends { type: infer type extends TransactionType } ? type : "eip1559",
        transaction extends { blockNumber: null } ? true : false
      >
    : never;

/** Every field a transaction of any type can have, for completing one. */
type TransactionFields = {
  hash?: Hash | undefined;
  blockHash?: Hash | null | undefined;
  blockNumber?: bigint | null | undefined;
  blockTimestamp?: bigint | undefined;
  transactionIndex?: number | null | undefined;
  from?: Address | undefined;
  to?: Address | null | undefined;
  value?: bigint | undefined;
  input?: Hex | undefined;
  gas?: bigint | undefined;
  nonce?: number | undefined;
  r?: Hex | undefined;
  s?: Hex | undefined;
  v?: bigint | undefined;
  yParity?: number | undefined;
  chainId?: number | undefined;
  type?: TransactionType | undefined;
  typeHex?: Hex | null | undefined;
  gasPrice?: bigint | undefined;
  maxFeePerGas?: bigint | undefined;
  maxPriorityFeePerGas?: bigint | undefined;
  maxFeePerBlobGas?: bigint | undefined;
  accessList?: AccessList | undefined;
  blobVersionedHashes?: readonly Hex[] | undefined;
  authorizationList?: SignedAuthorizationList | undefined;
};

const sharedFields = new Set([
  "hash",
  "blockHash",
  "blockNumber",
  "blockTimestamp",
  "transactionIndex",
  "from",
  "to",
  "value",
  "input",
  "gas",
  "nonce",
  "r",
  "s",
  "v",
  "chainId",
  "type",
  "typeHex",
]);
const dynamicFeeFields = [
  "gasPrice",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "accessList",
  "yParity",
];
/** Each type's own fields, beyond the shared ones. */
const typeFields: Record<TransactionType, readonly string[]> = {
  legacy: ["gasPrice"],
  eip2930: ["gasPrice", "accessList", "yParity"],
  eip1559: dynamicFeeFields,
  eip4844: [...dynamicFeeFields, "blobVersionedHashes", "maxFeePerBlobGas"],
  eip7702: [...dynamicFeeFields, "authorizationList"],
};
const typeHexes: Record<TransactionType, Hex> = {
  legacy: "0x0",
  eip2930: "0x1",
  eip1559: "0x2",
  eip4844: "0x3",
  eip7702: "0x4",
};

/** What a transaction's defaults come from: the request, and the mock's chain, blocks and fees. */
export type TransactionContext = {
  hash: Hash;
  /** The current block, where a transaction without a `blockNumber` was mined. */
  blockNumber: bigint;
  chainId: number;
  feesAt: (number: bigint) => Fees;
  timestampAt: (number: bigint) => bigint;
};

/** Throws unless `transaction`'s fields are its type's, and a pending one's block fields agree. */
function assertTransaction(transaction: TransactionFields): TransactionType {
  const type = transaction.type ?? "eip1559";
  const own = typeFields[type];
  // Untyped callers can pass any type.
  if (own === undefined)
    throw new TypeError(
      `Unknown transaction type "${type}"; types: ${Object.keys(typeFields).join(", ")}.`,
    );
  for (const field of Object.keys(transaction)) {
    if (sharedFields.has(field) || own.includes(field)) continue;
    const types = Object.entries(typeFields)
      .filter(([, fields]) => fields.includes(field))
      .map(([name]) => name);
    throw new TypeError(
      types.length === 0
        ? `A transaction has no field "${field}".`
        : `An ${type} transaction has no ${field}: set \`type\` to one that has it (${types.join(", ")}).`,
    );
  }
  const { blockNumber, blockHash: hash, transactionIndex, blockTimestamp } = transaction;
  const pendingFields = [hash, transactionIndex].filter((field) => field === null).length;
  if (blockNumber === null) {
    if (pendingFields < 2 && (hash !== undefined || transactionIndex !== undefined))
      throw new TypeError(
        "A pending transaction (blockNumber: null) has a null blockHash and transactionIndex.",
      );
    if (blockTimestamp !== undefined)
      throw new TypeError("A pending transaction (blockNumber: null) has no blockTimestamp.");
  } else if (pendingFields > 0) {
    throw new TypeError(
      "Only a pending transaction has a null blockHash or transactionIndex: set blockNumber: null.",
    );
  }
  return type;
}

/** A hex value as a JSON-RPC quantity, as reth sends signatures: no leading zeros. */
const quantityOf = (value: Hex | undefined) =>
  numberToHex(value === undefined ? 0n : hexToBigInt(value));

/**
 * A transaction in its JSON-RPC form, in reth's field order: `transaction`'s
 * fields over defaults from `context`. A mined one is in the current block
 * unless given, at index 0, and paid the suggested fees: the tip, and a max
 * fee of the base fee plus the tip, so its effective `gasPrice` is the same.
 * The signature is zero, and the rest is zero or empty. Addresses are
 * validated, and lowercase as nodes send them.
 */
export function toRpcTransaction(
  transaction: TransactionFields,
  context: TransactionContext,
): Record<string, unknown> {
  const type = assertTransaction(transaction);
  const pending = transaction.blockNumber === null;
  const number = transaction.blockNumber ?? context.blockNumber;
  const { baseFeePerGas, maxPriorityFeePerGas: tip } = context.feesAt(number);
  const chainId = transaction.chainId ?? context.chainId;
  const dynamic = type === "eip1559" || type === "eip4844" || type === "eip7702";
  const maxPriorityFeePerGas = transaction.maxPriorityFeePerGas ?? tip;
  const maxFeePerGas = transaction.maxFeePerGas ?? baseFeePerGas + maxPriorityFeePerGas;
  // A mined transaction's effective price; a pending one's has no block yet, so its cap.
  const tipPaid =
    maxPriorityFeePerGas < maxFeePerGas - baseFeePerGas
      ? maxPriorityFeePerGas
      : maxFeePerGas - baseFeePerGas;
  const gasPrice =
    transaction.gasPrice ??
    (dynamic ? (pending ? maxFeePerGas : baseFeePerGas + tipPaid) : baseFeePerGas + tip);
  const yParity = transaction.yParity ?? 0;
  // Legacy transactions sign the chain into `v` (EIP-155); the rest sign `yParity`.
  const v = transaction.v ?? (type === "legacy" ? BigInt(chainId) * 2n + 35n : BigInt(yParity));

  const rpc: Record<string, unknown> = {
    type: typeHexes[type],
    chainId: numberToHex(chainId),
    nonce: numberToHex(transaction.nonce ?? 0),
  };
  if (!dynamic) rpc.gasPrice = numberToHex(gasPrice);
  rpc.gas = numberToHex(transaction.gas ?? 0n);
  if (dynamic) {
    rpc.maxFeePerGas = numberToHex(maxFeePerGas);
    rpc.maxPriorityFeePerGas = numberToHex(maxPriorityFeePerGas);
  }
  rpc.to = transaction.to === null ? null : nodeAddress(transaction.to ?? zeroAddress);
  rpc.value = numberToHex(transaction.value ?? 0n);
  if (type !== "legacy")
    rpc.accessList = (transaction.accessList ?? []).map((entry) => ({
      address: nodeAddress(entry.address),
      storageKeys: entry.storageKeys,
    }));
  if (type === "eip4844") {
    rpc.blobVersionedHashes = transaction.blobVersionedHashes ?? [];
    rpc.maxFeePerBlobGas = numberToHex(transaction.maxFeePerBlobGas ?? blobBaseFee);
  }
  if (type === "eip7702")
    rpc.authorizationList = (transaction.authorizationList ?? []).map((authorization) => ({
      chainId: numberToHex(authorization.chainId),
      address: nodeAddress(authorization.address),
      nonce: numberToHex(authorization.nonce),
      yParity: numberToHex(authorization.yParity ?? 0),
      r: quantityOf(authorization.r),
      s: quantityOf(authorization.s),
    }));
  rpc.input = transaction.input ?? "0x";
  rpc.r = quantityOf(transaction.r);
  rpc.s = quantityOf(transaction.s);
  if (type !== "legacy") rpc.yParity = numberToHex(yParity);
  rpc.v = numberToHex(v);
  rpc.hash = transaction.hash ?? context.hash;
  rpc.blockHash = pending ? null : (transaction.blockHash ?? blockHash(number));
  rpc.blockNumber = pending ? null : numberToHex(number);
  rpc.transactionIndex = pending ? null : numberToHex(transaction.transactionIndex ?? 0);
  rpc.from = nodeAddress(transaction.from ?? zeroAddress);
  if (dynamic) rpc.gasPrice = numberToHex(gasPrice);
  if (!pending)
    rpc.blockTimestamp = numberToHex(transaction.blockTimestamp ?? context.timestampAt(number));
  return rpc;
}
