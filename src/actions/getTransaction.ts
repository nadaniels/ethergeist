import { formatTransaction, zeroHash } from "viem";

import { hashParam } from "../chain/params.js";
import { encodeTransaction } from "../chain/transactions.js";
import { MockSetupError } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import { minedWhenRegistered, pinnedHash } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";
import type { TransactionCall } from "./types.js";

/**
 * `eth_getTransactionByHash`: a mock's fields over the defaults
 * `encodeTransaction` gives. A static one without a `blockNumber` is mined
 * where its transaction is on the chain, or else in the block current when
 * it's registered; a pending one (`null`) stays pending. Unmocked, a
 * transaction on the chain: pending (`blockNumber: null`) while it's placed
 * in a block not mined yet.
 */
export const getTransaction = ({
  state,
  transactions,
}: ActionsContext): Definition<TransactionCall, ReturnType<typeof encodeTransaction> | null> => ({
  name: "getTransaction",
  hint: "mock.actions.getTransaction({ hash }).returns(…)",
  decode: ([hash]) => ({ hash: hashParam(hash) }),
  pinnedCall: pinnedHash,
  zero: {},
  fixAtRegistration: minedWhenRegistered(state, transactions),
  encode(value, call) {
    if (value === null) return null;
    if (!isPlainObject(value))
      throw new MockSetupError(`A transaction must be an object or null; got ${typeof value}.`);
    return encodeTransaction(state, value, call?.hash ?? zeroHash);
  },
  fallback: (call) => transactions.transactionFor(call.hash),
  view: (rpc) => (rpc === null ? null : formatTransaction(rpc)),
});
