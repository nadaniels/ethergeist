import { formatTransaction, zeroHash } from "viem";

import { hashParam } from "../chain/params.js";
import { encodeTransaction } from "../chain/transactions.js";
import { MockSetupError } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import { registeredAt, unwrapRegistered } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";
import type { TransactionCall } from "./types.js";

/**
 * `eth_getTransactionByHash`: a mock's fields over what the chain would
 * answer: its transaction on the chain, pending (`blockNumber: null`) while
 * it's placed in a block not mined yet, and for a hash the chain doesn't
 * have, the defaults `encodeTransaction` gives, mined in the block current
 * when it's registered for a static one, and when it answers for a
 * resolver's. Unmocked, the transaction on the chain.
 */
export const getTransaction = ({
  state,
  transactions,
}: ActionsContext): Definition<TransactionCall, ReturnType<typeof encodeTransaction> | null> => ({
  name: "getTransaction",
  hint: "mock.actions.getTransaction({ hash }).returns(…)",
  decode: ([hash]) => ({ hash: hashParam(hash) }),
  zero: {},
  fixAtRegistration: registeredAt(state),
  encode(answer, call) {
    const { value, blockNumber } = unwrapRegistered(answer);
    if (value === null) return null;
    if (!isPlainObject(value))
      throw new MockSetupError(`A transaction must be an object or null; got ${typeof value}.`);
    const onChain = call && transactions.transactionFor(call.hash, value);
    return onChain ?? encodeTransaction(state, { blockNumber, ...value }, call?.hash ?? zeroHash);
  },
  fallback: (call) => transactions.transactionFor(call.hash),
  view: (rpc) => (rpc === null ? null : formatTransaction(rpc)),
});
