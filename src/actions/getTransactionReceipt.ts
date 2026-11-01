import { type Hash, formatTransactionReceipt } from "viem";

import { completeReceipt, toRpcReceipt } from "../chain/receipts.js";
import { isPlainObject } from "../shared/values.js";
import type { ActionsContext, Definition } from "./table.js";
import type { ReceiptCall } from "./types.js";

/** `eth_getTransactionReceipt`: a mock's fields over a successful receipt in the current block. */
export const getTransactionReceipt = ({
  state,
}: ActionsContext): Definition<ReceiptCall, ReturnType<typeof toRpcReceipt> | null> => ({
  name: "getTransactionReceipt",
  hint: "mock.actions.getTransactionReceipt({ hash }).returns(…)",
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- untyped JSON-RPC boundary
  decode: ([hash]) => ({ hash: hash as Hash }),
  zero: {},
  encode(value, call) {
    if (value === null) return null;
    if (!isPlainObject(value))
      throw new TypeError(`A receipt must be an object or null; got ${typeof value}.`);
    return toRpcReceipt(
      completeReceipt(value, { hash: call?.hash, blockNumber: state.blockNumber }),
    );
  },
  view: (rpc) => (rpc === null ? null : formatTransactionReceipt(rpc)),
});
