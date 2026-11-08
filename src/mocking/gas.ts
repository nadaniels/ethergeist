import { type Hex, numberToHex } from "viem";

import { checkAmount } from "./setupChecks.js";

/**
 * The gas a send mock implies: its transaction's estimate, which runs
 * nothing, and the gas an `eth_sendTransaction` without one is sent with.
 * Above most sends' real cost, as a wallet's padded estimate is.
 */
export const impliedGas = 100_000n;

/**
 * A gas estimate as a JSON-RPC quantity, for `estimateGas` mocks on actions
 * and contracts alike: a bigint, `0n` or more; `what` is its subject in the
 * message. `.returns()` with no value is refused: a node never estimates zero
 * gas, so an estimate has no zero answer to default to.
 */
export function encodeGas(value: unknown, what: string): Hex {
  checkAmount(value, what);
  return numberToHex(value);
}
