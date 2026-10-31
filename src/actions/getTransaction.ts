import { type Hash, type RpcTransaction, formatTransaction, zeroHash } from "viem";

import type { ChainState } from "../chain/state.js";
import { type MockTransaction, toRpcTransaction } from "../chain/transactions.js";
import { isPlainObject } from "../shared/values.js";
import type { ActionsContext, Definition } from "./table.js";
import type { TransactionCall } from "./types.js";

/** A transaction's JSON-RPC form, with the mock's defaults: the current block and its fees. */
export const encodeTransaction = (state: ChainState, transaction: MockTransaction, hash: Hash) =>
  toRpcTransaction(transaction, {
    hash,
    blockNumber: state.blockNumber,
    chainId: state.chainId,
    feesAt: state.feesAt,
    timestampAt: state.timestampAt,
  });

/** `eth_getTransactionByHash`: a mock's fields over the defaults `encodeTransaction` gives. */
export const getTransaction = ({ state }: ActionsContext): Definition => ({
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
    return encodeTransaction(state, value, hash);
  },
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- encoded by toRpcTransaction
  view: (rpc) => (rpc === null ? null : formatTransaction(rpc as RpcTransaction)),
});
