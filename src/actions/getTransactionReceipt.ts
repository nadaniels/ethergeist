import { formatTransactionReceipt } from "viem";

import { hashParam } from "../chain/params.js";
import type { toRpcReceipt } from "../chain/receipts.js";
import { checkObject } from "../mocking/setupChecks.js";
import { pinnedHash } from "./codec.js";
import type { ActionsContext, Definition } from "./table.js";
import type { ReceiptCall } from "./types.js";

const inAnswer = (field: string) => `${field} in getTransactionReceipt's answer`;

/**
 * `eth_getTransactionReceipt`. Unmocked, it answers with a placed
 * transaction's receipt, or `null` while it's waiting, as for a pending one,
 * and other hashes aren't answered. A mock's fields go over what the chain
 * would answer: the transaction's receipt once it's mined, and otherwise a
 * successful receipt with zeros and the mock's logs. That one is in a block
 * a node never moves: the block current at registration for a static
 * answer, or at the request for a resolver.
 */
export const getTransactionReceipt = ({
  transactions,
}: ActionsContext): Definition<ReceiptCall, ReturnType<typeof toRpcReceipt> | null> => ({
  name: "getTransactionReceipt",
  hint: "mock.actions.getTransactionReceipt({ hash }).returns(…)",
  decode: ([hash]) => ({ hash: hashParam(hash) }),
  pinnedCall: pinnedHash,
  zero: {},
  encode(value, { pinnedCall, blockNumber }) {
    if (value === null) return null;
    checkObject(value, "getTransactionReceipt's answer", "Or null for none.");
    return transactions.mockedReceipt(value, inAnswer, { hash: pinnedCall.hash, blockNumber });
  },
  fallback: (call) => transactions.receiptFor(call.hash),
  view: (rpc) => (rpc === null ? null : formatTransactionReceipt(rpc)),
});
