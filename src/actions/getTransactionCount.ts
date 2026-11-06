import { hexToNumber, isHex, numberToHex } from "viem";

import { formatValue } from "../mocking/format.js";
import { MockSetupError } from "../shared/errors.js";
import { decodeAddressAtBlock, pinAddress } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";
import type { ActionContext, TransactionCountCall } from "./types.js";

/**
 * What a `getTransactionCount` resolver gets: the call's fields, `fail`, and
 * `count`.
 */
export type TransactionCountContext = ActionContext<TransactionCountCall> & {
  /**
   * The chain's count for the call, as `getTransactionCount` answers
   * unmocked: the address's next nonce at the block. A starting nonce that
   * counts up is `({ count }) => Math.max(7, count)`: once the app sends
   * nonce 7, `count` passes it.
   */
  readonly count: number;
};

/**
 * `eth_getTransactionCount`, an account's nonce. Unmocked, its transactions'
 * count (`nonceOf`).
 */
export const getTransactionCount = ({
  state,
  transactions,
}: ActionsContext): Definition<TransactionCountCall> => {
  const countFor = ({ address, blockNumber, blockTag }: TransactionCountCall) =>
    transactions.nonceOf(address, blockTag === "pending" ? "pending" : blockNumber);
  return {
    name: "getTransactionCount",
    hint: "mock.actions.getTransactionCount({ address }).returns(…)",
    decode: (params) => decodeAddressAtBlock(params, state.resolveBlock),
    pin: pinAddress,
    zero: 0,
    encode(value) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
        throw new MockSetupError(
          `A transaction count must be a whole number, zero or more; got ${formatValue(value)}.`,
        );
      return numberToHex(value);
    },
    extendContext(context, call) {
      Object.assign(context, { count: countFor(call) });
    },
    fallback: (call) => numberToHex(countFor(call)),
    view: (rpc) => (isHex(rpc) ? hexToNumber(rpc) : rpc),
  };
};
