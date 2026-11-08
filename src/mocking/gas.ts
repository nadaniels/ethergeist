import { type Hex, numberToHex } from "viem";

import { MockSetupError } from "../shared/errors.js";
import { checkAmount } from "./setupChecks.js";
import { zeroResult } from "./zeroResult.js";

/**
 * The gas a send mock implies: its transaction's estimate, which runs
 * nothing, and the gas an `eth_sendTransaction` without one is sent with.
 * Above most sends' real cost, as a wallet's padded estimate is.
 */
export const impliedGas = 100_000n;

/**
 * A gas estimate as a JSON-RPC quantity, for `estimateGas` mocks on actions
 * and contracts alike: a non-negative bigint; `what` is its subject in the
 * message. `.returns()` with no value is refused: a node never estimates zero
 * gas, so an estimate has no zero answer to default to.
 */
export function encodeGas(value: unknown, what: string): Hex {
  if (value === undefined || value === zeroResult)
    throw new MockSetupError(`${what} can't be left out: an estimate has no zero answer.`, {
      metaMessages: ["Pass or return the gas, e.g. 21_000n."],
    });
  checkAmount(value, what);
  return numberToHex(value);
}
