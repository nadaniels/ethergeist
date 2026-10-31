import { type Hex, decodeErrorResult, parseAbi, hexToBigInt, isHex } from "viem";

import type { MockNodeFault, NodeErrorName } from "../mocking/types.js";

/** Solidity's built-in errors, which any contract can revert with. */
export const builtinErrors = parseAbi(["error Error(string)", "error Panic(uint256)"]);

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

export function isNodeErrorName(fault: MockNodeFault): fault is NodeErrorName {
  return typeof fault === "string" && Object.hasOwn(nodeErrors, fault);
}

/**
 * Reth's errors for each name, from the request's params: a transaction
 * first, as `eth_estimateGas` and `eth_call` take it (captured from reth
 * nodes for Ethereum and Base, 2026-10-29).
 */
export const nodeErrors: Record<
  NodeErrorName,
  (params: unknown) => { code: number; message: string }
> = {
  // Reth checks the balance against the value alone. With fee fields it
  // reports that check; without them, the EVM's.
  insufficientFunds(params) {
    const tx: unknown = Array.isArray(params) ? params[0] : undefined;
    if (typeof tx !== "object" || tx === null || !("gasPrice" in tx || "maxFeePerGas" in tx))
      return { code: -32003, message: "EVM error: OutOfFunds" };
    const value = "value" in tx && isHex(tx.value) ? hexToBigInt(tx.value) : 0n;
    return {
      code: -32003,
      message: `insufficient funds for gas * price + value: have 0 want ${value}`,
    };
  },
  feeCapTooLow: () => ({ code: -32000, message: "max fee per gas less than block base fee" }),
  tipAboveFeeCap: () => ({
    code: -32003,
    message: "max priority fee per gas higher than max fee per gas",
  }),
};
