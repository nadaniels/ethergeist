import { hexToNumber, isHex, numberToHex } from "viem";

import { formatValue } from "../mocking/format.js";
import { MockSetupError } from "../shared/errors.js";
import { decodeAddressAtBlock, pinAddress } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";
import type { ActionContext, TransactionCountCall } from "./types.js";

/**
 * What a `getTransactionCount` resolver gets: the call, `fail`, and
 * `count`, what the chain's transactions would answer: the address's next
 * nonce. A starting nonce is `({ count }) => Math.max(7, count)`, as the
 * count already includes sends from 7 on.
 */
export type TransactionCountContext = ActionContext<TransactionCountCall> & {
  readonly count: number;
};

/** `eth_getTransactionCount`, an account's nonce: unmocked, what it has sent (`nonceOf`). */
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
