import {
  type AccessList,
  type Address,
  type Hex,
  type Hash,
  type SignedAuthorizationList,
  type TransactionEIP1559,
  type TransactionEIP2930,
  type TransactionEIP4844,
  type TransactionEIP7702,
  type TransactionLegacy,
  type TransactionSerialized,
  getAddress,
  hexToBigInt,
  isHex,
  keccak256,
  numberToHex,
  parseTransaction,
  recoverTransactionAddress,
  zeroAddress,
} from "viem";

import { formatValue } from "../mocking/format.js";
import { MockSetupError, invalidParams } from "../shared/errors.js";
import { isPlainObject, nodeAddress } from "../shared/values.js";
import { blockHash } from "./blocks.js";
import { type Fees, blobBaseFee } from "./fees.js";
import { nodeHash } from "./hashes.js";
import type { ChainState } from "./state.js";

/**
 * The transaction types viem knows, as a transaction mock or a send has them:
 * viem's own `TransactionType` also takes any string.
 */
export type MockTransactionType = "legacy" | "eip2930" | "eip1559" | "eip4844" | "eip7702";

/** viem's transaction of `type`, mined or pending. */
type TransactionOf<type extends MockTransactionType, pending extends boolean> = {
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
type MockTransactionOf<type extends MockTransactionType, pending extends boolean> = Partial<
  Omit<TransactionOf<type, pending>, "type" | "typeHex">
> &
  (type extends "eip1559" ? { type?: type } : { type: type }) &
  (pending extends true ? { blockNumber: null } : unknown);

/**
 * A mocked transaction: any fields of viem's transaction of its `type`
 * (`"eip1559"` when left out), so fields the type doesn't have are type
 * errors. `blockNumber: null` makes it pending: its block hash and index are
 * `null` then, and it has no `blockTimestamp`. A `getTransaction` mock
 * answers with one, and `mock.buildTransaction()` completes one.
 */
export type MockTransaction = {
  [type in MockTransactionType]: MockTransactionOf<type, false> | MockTransactionOf<type, true>;
}[MockTransactionType];

/**
 * The viem transaction a `MockTransaction` completes to: its type, mined or
 * pending.
 */
export type BuiltTransaction<transaction extends MockTransaction = MockTransaction> =
  transaction extends unknown
    ? TransactionOf<
        transaction extends { type: infer type extends MockTransactionType } ? type : "eip1559",
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
  type?: MockTransactionType | undefined;
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
const typeFields: Record<MockTransactionType, readonly string[]> = {
  legacy: ["gasPrice"],
  eip2930: ["gasPrice", "accessList", "yParity"],
  eip1559: dynamicFeeFields,
  eip4844: [...dynamicFeeFields, "blobVersionedHashes", "maxFeePerBlobGas"],
  eip7702: [...dynamicFeeFields, "authorizationList"],
};
const typeHexes: Record<MockTransactionType, Hex> = {
  legacy: "0x0",
  eip2930: "0x1",
  eip1559: "0x2",
  eip4844: "0x3",
  eip7702: "0x4",
};

/**
 * What a transaction's defaults come from: the request, and the mock's chain
 * id, blocks and fees.
 */
type TransactionContext = {
  hash: Hash;
  /**
   * The current block, where a transaction without a `blockNumber` is mined;
   * a static answer's is fixed at registration.
   */
  blockNumber: bigint;
  chainId: number;
  feesAt: (number: bigint) => Fees;
  timestampAt: (number: bigint) => bigint;
};

/**
 * Throws unless `transaction`'s fields are its type's, and a pending one's
 * block fields agree.
 */
function assertTransaction(transaction: TransactionFields): MockTransactionType {
  const type = transaction.type ?? "eip1559";
  const own = typeFields[type];
  // Untyped callers can pass any type.
  if (own === undefined)
    throw new MockSetupError(
      `Unknown transaction type "${type}"; types: ${Object.keys(typeFields).join(", ")}.`,
    );
  for (const field of Object.keys(transaction)) {
    if (sharedFields.has(field) || own.includes(field)) continue;
    const types = Object.entries(typeFields)
      .filter(([, fields]) => fields.includes(field))
      .map(([name]) => name);
    throw new MockSetupError(
      types.length === 0
        ? `A transaction has no field "${field}".`
        : `${type === "legacy" ? "A" : "An"} ${type} transaction has no ${field}: set \`type\` to one that has it (${types.join(", ")}).`,
    );
  }
  const { blockNumber, blockHash: hash, transactionIndex, blockTimestamp } = transaction;
  const pendingFields = [hash, transactionIndex].filter((field) => field === null).length;
  if (blockNumber === null) {
    if (pendingFields < 2 && (hash !== undefined || transactionIndex !== undefined))
      throw new MockSetupError(
        "A pending transaction (blockNumber: null) has a null blockHash and transactionIndex.",
      );
    if (blockTimestamp !== undefined)
      throw new MockSetupError("A pending transaction (blockNumber: null) has no blockTimestamp.");
  } else if (pendingFields > 0) {
    throw new MockSetupError(
      "Only a pending transaction has a null blockHash or transactionIndex: set blockNumber: null.",
    );
  }
  return type;
}

/**
 * A hex value as a JSON-RPC quantity, as reth sends signatures: no leading
 * zeros.
 */
const quantityOf = (value: Hex | undefined) =>
  numberToHex(value === undefined ? 0n : hexToBigInt(value));

/**
 * A transaction in its JSON-RPC form, in reth's field order: `transaction`'s
 * fields over defaults from `context`. A mined one is in the current block
 * unless given, at index 0. Unless given, it paid the suggested fees: the
 * tip, and a max fee of its block's base fee plus the tip, so its effective
 * `gasPrice` is their sum. The signature is zero, and the rest is
 * zero or empty. Addresses and hashes are validated, and lowercase as nodes
 * send them.
 */
function toRpcTransaction(
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
  // A mined transaction's effective price; a pending one's has no block yet,
  // so its cap.
  const tipPaid =
    maxPriorityFeePerGas < maxFeePerGas - baseFeePerGas
      ? maxPriorityFeePerGas
      : maxFeePerGas - baseFeePerGas;
  const gasPrice =
    transaction.gasPrice ??
    (dynamic ? (pending ? maxFeePerGas : baseFeePerGas + tipPaid) : baseFeePerGas + tip);
  const yParity = transaction.yParity ?? 0;
  // Legacy transactions sign the chain into `v` (EIP-155); the rest sign
  // `yParity`.
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
    rpc.blobVersionedHashes = (transaction.blobVersionedHashes ?? []).map((hash) =>
      nodeHash(hash, "A transaction's blob versioned hash"),
    );
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
  rpc.hash = nodeHash(transaction.hash ?? context.hash, "A transaction's hash");
  rpc.blockHash = pending
    ? null
    : nodeHash(transaction.blockHash ?? blockHash(number), "A transaction's blockHash");
  rpc.blockNumber = pending ? null : numberToHex(number);
  rpc.transactionIndex = pending ? null : numberToHex(transaction.transactionIndex ?? 0);
  rpc.from = nodeAddress(transaction.from ?? zeroAddress);
  if (dynamic) rpc.gasPrice = numberToHex(gasPrice);
  if (!pending)
    rpc.blockTimestamp = numberToHex(transaction.blockTimestamp ?? context.timestampAt(number));
  return rpc;
}

/**
 * A transaction's JSON-RPC form, with the mock's defaults: the current block
 * and its fees. Its fields are checked against its type: see `MockTransaction`.
 */
export const encodeTransaction = (state: ChainState, transaction: TransactionFields, hash: Hash) =>
  toRpcTransaction(transaction, {
    hash,
    blockNumber: state.blockNumber,
    chainId: state.chainId,
    feesAt: state.feesAt,
    timestampAt: state.timestampAt,
  });

/**
 * A transaction's fees, as a send has them: a legacy `gasPrice`, or
 * EIP-1559's max fees.
 */
type SentFees = {
  gasPrice?: bigint | undefined;
  maxFeePerGas?: bigint | undefined;
  maxPriorityFeePerGas?: bigint | undefined;
};

/** The transaction types by number, as a request's `type` param has them. */
const typeNames: readonly MockTransactionType[] = [
  "legacy",
  "eip2930",
  "eip1559",
  "eip4844",
  "eip7702",
];

/**
 * A request's type by its fields, as viem's `getTransactionType()` reads
 * them.
 */
function typeByFields(request: Record<string, unknown>): MockTransactionType {
  if (request.authorizationList !== undefined) return "eip7702";
  if (request.blobVersionedHashes !== undefined || request.maxFeePerBlobGas !== undefined)
    return "eip4844";
  if (request.gasPrice === undefined) return "eip1559";
  return request.accessList === undefined ? "legacy" : "eip2930";
}

/**
 * A sent transaction's type: its request's `type` param (the spec's `byte`),
 * or else its fields': EIP-7702 with an `authorizationList`, EIP-4844 with
 * blob fields, EIP-1559 without a `gasPrice`, and with one, EIP-2930 with an
 * `accessList` or else legacy. Refused as invalid params for a type viem
 * doesn't know, or fees the type doesn't have, as a node refuses both.
 */
export function sentType(request: unknown, fees: SentFees): MockTransactionType {
  const fields = isPlainObject(request) ? request : {};
  const { type } = fields;
  const named =
    type === undefined
      ? typeByFields(fields)
      : typeof type === "string" && /^0x[0-9a-fA-F]{1,2}$/u.test(type)
        ? typeNames[Number(type)]
        : undefined;
  if (named === undefined)
    throw invalidParams(`expected a transaction type; got ${formatValue(type)}`);
  // A dynamic-fee transaction's `gasPrice` is its effective price, which a
  // node works out.
  const other =
    named === "legacy" || named === "eip2930"
      ? (["maxFeePerGas", "maxPriorityFeePerGas"] as const).find(
          (field) => fees[field] !== undefined,
        )
      : fees.gasPrice === undefined
        ? undefined
        : "gasPrice";
  if (other !== undefined) throw invalidParams(`${named} transactions have no ${other}`);
  return named;
}

/**
 * A signed transaction's fields, hash and sender, as a node reads them from
 * its bytes: the hash is `keccak256` of the bytes, and the sender is
 * recovered from the signature. Refused as invalid params unless it's a
 * signed transaction. Its chain id isn't checked: clients check it themselves.
 */
export async function decodeRawTransaction(serialized: unknown) {
  const refused = () =>
    invalidParams(`expected a signed transaction; got ${formatValue(serialized)}`);
  if (!isHex(serialized)) throw refused();
  let parsed: ReturnType<typeof parseTransaction>;
  let from: Address;
  try {
    parsed = parseTransaction(serialized);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- it parsed, so it's one
    const serializedTransaction = serialized as TransactionSerialized;
    from = await recoverTransactionAddress({ serializedTransaction });
  } catch {
    throw refused();
  }
  // viem parses a type for every transaction it can parse.
  const { to, value = 0n, data, nonce = 0, gas = 0n, type = "legacy" } = parsed;
  const { gasPrice, maxFeePerGas, maxPriorityFeePerGas } = parsed;
  return {
    hash: keccak256(serialized),
    from,
    fields: {
      to: to === undefined || to === null ? null : getAddress(to),
      value,
      ...(data !== undefined && data !== "0x" && { data }),
      nonce,
      gas,
      ...(gasPrice !== undefined && { gasPrice }),
      ...(maxFeePerGas !== undefined && { maxFeePerGas }),
      ...(maxPriorityFeePerGas !== undefined && { maxPriorityFeePerGas }),
      type,
    },
  };
}
