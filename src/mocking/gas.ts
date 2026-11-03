import { type Hex, numberToHex } from "viem";

import { MockSetupError } from "../shared/errors.js";
import { formatValue } from "./format.js";
import { zeroResult } from "./zeroResult.js";

/**
 * The gas a write mock implies: its transaction's estimate, which runs
 * nothing, and the gas an `eth_sendTransaction` without one is sent with.
 * Above most writes' real cost, as a wallet's padded estimate is.
 */
export const impliedGas = 100_000n;

/**
 * A gas estimate as a JSON-RPC quantity, for `estimateGas` mocks on actions
 * and contracts alike. There's no zero estimate: a node never estimates zero
 * gas, so `zeroResult` (`.returns()` with no value) is rejected as nothing.
 */
export function encodeGas(value: unknown): Hex {
  if (typeof value !== "bigint" || value < 0n)
    throw new MockSetupError(
      `A gas estimate must be a bigint, zero or more; got ${formatValue(value === zeroResult ? undefined : value)}.`,
    );
  return numberToHex(value);
}
