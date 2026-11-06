import { type Hex, numberToHex } from "viem";

import { MockSetupError } from "../shared/errors.js";
import { formatValue } from "./format.js";
import { zeroResult } from "./zeroResult.js";

/**
 * The gas a send mock implies: its transaction's estimate, which runs
 * nothing, and the gas an `eth_sendTransaction` without one is sent with.
 * Above most sends' real cost, as a wallet's padded estimate is.
 */
export const impliedGas = 100_000n;

/**
 * A gas estimate as a JSON-RPC quantity, for `estimateGas` mocks on actions
 * and contracts alike: a bigint, `0n` or more. `zeroResult` (`.returns()`
 * with no value) is refused, shown as `undefined`: a node never estimates
 * zero gas, so an estimate has no zero answer to default to.
 */
export function encodeGas(value: unknown): Hex {
  if (typeof value !== "bigint" || value < 0n)
    throw new MockSetupError(
      `A gas estimate must be a bigint, zero or more; got ${formatValue(value === zeroResult ? undefined : value)}.`,
    );
  return numberToHex(value);
}
