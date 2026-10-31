import { type Hex, numberToHex } from "viem";
import { formatValue } from "./format.js";
import { zeroResult } from "./zeroResult.js";

/**
 * A gas estimate as a JSON-RPC quantity, for `estimateGas` mocks on actions
 * and contracts alike. There's no zero estimate: a node never estimates zero
 * gas, so `zeroResult` (`.returns()` with no value) is rejected as nothing.
 */
export function encodeGas(value: unknown): Hex {
  if (typeof value !== "bigint" || value < 0n)
    throw new TypeError(
      `A gas estimate must be a bigint, zero or more; got ${formatValue(value === zeroResult ? undefined : value)}.`,
    );
  return numberToHex(value);
}
