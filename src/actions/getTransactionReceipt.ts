import { formatTransactionReceipt, isHash } from "viem";

import { completeReceipt, toRpcReceipt } from "../chain/receipts.js";
import { isPlainObject } from "../shared/values.js";
import { hashParam } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";
import type { ReceiptCall } from "./types.js";

/** `eth_getTransactionReceipt`: a mock's fields over a successful receipt in the current block. */
export const getTransactionReceipt = ({
  state,
}: ActionsContext): Definition<ReceiptCall, ReturnType<typeof toRpcReceipt> | null> => ({
  name: "getTransactionReceipt",
  hint: "mock.actions.getTransactionReceipt({ hash }).returns(…)",
  decode: ([hash]) => ({ hash: hashParam(hash) }),
  // A pinned hash is the receipt's, so its logs' placement is checked at registration.
  pinnedCall: (pinned) =>
    isPlainObject(pinned) && typeof pinned.hash === "string" && isHash(pinned.hash)
      ? { hash: pinned.hash }
      : undefined,
  zero: {},
  encode(value, call) {
    if (value === null) return null;
    if (!isPlainObject(value))
      throw new TypeError(`A receipt must be an object or null; got ${typeof value}.`);
    return toRpcReceipt(
      completeReceipt(value, {
        hash: call?.hash,
        blockNumber: state.blockNumber,
        timestampAt: state.timestampAt,
      }),
    );
  },
  view: (rpc) => (rpc === null ? null : formatTransactionReceipt(rpc)),
});
