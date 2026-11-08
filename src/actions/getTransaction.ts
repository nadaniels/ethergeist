import { formatTransaction, zeroHash } from "viem";

import { hashParam } from "../chain/params.js";
import { encodeTransaction } from "../chain/transactions.js";
import { checkObject } from "../mocking/setupChecks.js";
import { registeredAt, unwrapRegistered } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";
import type { TransactionCall } from "./types.js";

/**
 * `eth_getTransactionByHash`. Unmocked, it answers with a placed
 * transaction, pending (`blockNumber: null`) while it's waiting, and other
 * hashes aren't answered. A mock's fields go over what the chain would
 * answer: the placed transaction, or for a hash with no placed transaction,
 * `encodeTransaction`'s defaults. That one is mined in the block current at
 * registration for a static answer, or at the request for a resolver.
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
    checkObject(value, "getTransaction's answer", "Or null for none.");
    const onChain = call && transactions.transactionFor(call.hash, value);
    return onChain ?? encodeTransaction(state, { blockNumber, ...value }, call?.hash ?? zeroHash);
  },
  fallback: (call) => transactions.transactionFor(call.hash),
  view: (rpc) => (rpc === null ? null : formatTransaction(rpc)),
});
