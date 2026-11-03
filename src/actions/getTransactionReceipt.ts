import { formatTransactionReceipt } from "viem";

import { hashParam } from "../chain/params.js";
import { completeReceipt, toRpcReceipt } from "../chain/receipts.js";
import { MockSetupError } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import { minedWhenRegistered, pinnedHash } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";
import type { ReceiptCall } from "./types.js";

/**
 * `eth_getTransactionReceipt`: a mock's fields over a successful receipt in
 * the current block: when it's registered for a static one, which a node
 * never moves (its transaction's block, if its hash is on the chain), and
 * when it answers for a resolver's. Unmocked, the receipt of a transaction
 * on the chain: `null` while it's placed in a block not mined yet, as for a
 * pending one.
 */
export const getTransactionReceipt = ({
  state,
  transactions,
}: ActionsContext): Definition<ReceiptCall, ReturnType<typeof toRpcReceipt> | null> => ({
  name: "getTransactionReceipt",
  hint: "mock.actions.getTransactionReceipt({ hash }).returns(…)",
  decode: ([hash]) => ({ hash: hashParam(hash) }),
  // A pinned hash is the receipt's, so its logs' placement is checked at registration.
  pinnedCall: pinnedHash,
  zero: {},
  fixAtRegistration: minedWhenRegistered(state, transactions),
  encode(value, call) {
    if (value === null) return null;
    if (!isPlainObject(value))
      throw new MockSetupError(`A receipt must be an object or null; got ${typeof value}.`);
    return toRpcReceipt(
      completeReceipt(value, {
        hash: call?.hash,
        blockNumber: state.blockNumber,
        timestampAt: state.timestampAt,
      }),
    );
  },
  fallback: (call) => transactions.receiptFor(call.hash),
  view: (rpc) => (rpc === null ? null : formatTransactionReceipt(rpc)),
});
