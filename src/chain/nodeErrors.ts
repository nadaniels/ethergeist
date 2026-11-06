import { type Hex, decodeErrorResult, isHex, parseTransaction } from "viem";

import type { NodeErrorName } from "../mocking/types.js";
import { builtinErrors } from "../shared/abiValues.js";
import { isPlainObject } from "../shared/values.js";
import { optionalQuantity } from "./params.js";

/**
 * Reth's descriptions of Solidity's panic codes, as it puts them in the error
 * message (captured from reth nodes for Ethereum and Base, 2026-10-29). Geth
 * words some differently, without the code; viem doesn't classify on the text.
 */
const panicDescriptions: Record<number, string> = {
  0x00: "generic/unspecified error",
  0x01: "assertion failed",
  0x11: "arithmetic underflow or overflow",
  0x12: "division or modulo by zero",
  0x21: "failed to convert value into enum type",
  0x22: "storage byte array incorrectly encoded",
  0x31: "called `.pop()` on an empty array",
  0x32: "array out-of-bounds access",
  0x41: "memory allocation error",
  0x51: "called an invalid internal function",
};

/**
 * The error message a reth node sends with revert `data`, which it derives
 * from the data alone: `Error(string)` adds the reason (`<empty>` for
 * an empty one), `Panic(uint256)` its description and code, and anything else
 * adds nothing.
 */
export function nodeRevertMessage(data: Hex): string {
  try {
    const { errorName, args } = decodeErrorResult({ abi: builtinErrors, data });
    if (errorName === "Error") return `execution reverted: ${args[0] === "" ? "<empty>" : args[0]}`;
    const code = args[0];
    const description = panicDescriptions[Number(code)] ?? "unknown code";
    return `execution reverted: panic: ${description} (0x${code.toString(16).padStart(2, "0")})`;
  } catch {
    return "execution reverted";
  }
}

/**
 * A request's transaction, for its error: `params[0]`, as `eth_estimateGas`,
 * `eth_call` and `eth_sendTransaction` take it, or decoded from a raw send's
 * bytes. Hex that doesn't decode (`getBalance`'s address, under a name its
 * types refuse) is no transaction.
 */
function transactionOf(params: unknown) {
  const tx: unknown = Array.isArray(params) ? params[0] : undefined;
  if (isHex(tx))
    try {
      const { value, gas } = parseTransaction(tx);
      return { value: value ?? 0n, gas, paysFees: true };
    } catch {
      // No transaction: see above.
    }
  const fields = isPlainObject(tx) ? tx : {};
  return {
    value: optionalQuantity(fields.value, "a value") ?? 0n,
    gas: optionalQuantity(fields.gas, "a gas limit"),
    paysFees: "gasPrice" in fields || "maxFeePerGas" in fields,
  };
}

/**
 * The gas a node's estimate or call allows when the request sets none: the
 * block's gas limit, capped by the node (geth's and reth's default RPC gas
 * cap). Nothing reads the number: viem classifies by the words.
 */
const nodeGasCap = 50_000_000n;

/**
 * The error a node sends for each refusal name, from the request's params:
 * its transaction (see `transactionOf`). The first three are reth's,
 * captured from reth nodes for Ethereum and Base, 2026-10-29. The rest are
 * geth's messages without the detail it adds (e.g.
 * `: next nonce 5, tx nonce 3`), which viem's patterns match either way.
 */
export const nodeErrors: Record<
  NodeErrorName,
  (params: unknown) => { code: number; message: string }
> = {
  // Reth checks the balance against the value alone. With fee fields it
  // reports that check; without them, the EVM's.
  insufficientFunds(params) {
    const tx = transactionOf(params);
    if (!tx.paysFees) return { code: -32003, message: "EVM error: OutOfFunds" };
    return {
      code: -32003,
      message: `insufficient funds for gas * price + value: have 0 want ${tx.value}`,
    };
  },
  feeCapTooLow: () => ({ code: -32000, message: "max fee per gas less than block base fee" }),
  tipAboveFeeCap: () => ({
    code: -32003,
    message: "max priority fee per gas higher than max fee per gas",
  }),
  gasExceedsAllowance: (params) => ({
    code: -32000,
    message: `gas required exceeds allowance (${transactionOf(params).gas ?? nodeGasCap})`,
  }),
  intrinsicGasTooLow: () => ({ code: -32000, message: "intrinsic gas too low" }),
  nonceTooLow: () => ({ code: -32000, message: "nonce too low" }),
  nonceTooHigh: () => ({ code: -32000, message: "nonce too high" }),
  alreadyKnown: () => ({ code: -32000, message: "already known" }),
};
