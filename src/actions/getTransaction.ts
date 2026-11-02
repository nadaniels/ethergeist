import { formatTransaction, zeroHash } from "viem";

import { hashParam } from "../chain/params.js";
import { encodeTransaction } from "../chain/transactions.js";
import { isPlainObject } from "../shared/values.js";
import type { ActionsContext, Definition } from "./table.js";
import type { TransactionCall } from "./types.js";

/** `eth_getTransactionByHash`: a mock's fields over the defaults `encodeTransaction` gives. */
export const getTransaction = ({
  state,
}: ActionsContext): Definition<TransactionCall, ReturnType<typeof encodeTransaction> | null> => ({
  name: "getTransaction",
  hint: "mock.actions.getTransaction({ hash }).returns(…)",
  decode: ([hash]) => ({ hash: hashParam(hash) }),
  zero: {},
  encode(value, call) {
    if (value === null) return null;
    if (!isPlainObject(value))
      throw new TypeError(`A transaction must be an object or null; got ${typeof value}.`);
    return encodeTransaction(state, value, call?.hash ?? zeroHash);
  },
  view: (rpc) => (rpc === null ? null : formatTransaction(rpc)),
});
