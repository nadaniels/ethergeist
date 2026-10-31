import { type Abi, type Hex, decodeErrorResult, encodeErrorResult, parseAbi } from "viem";
import type { RevertSpec } from "./contracts/types.js";
import { MockRevertError } from "./errors.js";
import type { MockOutcome } from "./history/types.js";

const builtinErrors = parseAbi(["error Error(string)", "error Panic(uint256)"]);

export function createRevertError(abi: Abi, spec?: RevertSpec): MockRevertError {
  if (spec === undefined) return new MockRevertError("0x");
  if (typeof spec === "string")
    return new MockRevertError(
      encodeErrorResult({ abi: builtinErrors, errorName: "Error", args: [spec] }),
      spec,
    );
  if ("data" in spec) return new MockRevertError(spec.data);
  if ("panic" in spec)
    return new MockRevertError(
      encodeErrorResult({ abi: builtinErrors, errorName: "Panic", args: [BigInt(spec.panic)] }),
    );
  return new MockRevertError(
    encodeErrorResult({ abi, errorName: spec.errorName, args: spec.args }),
  );
}

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

/** A revert's data, decoded against `abi` and the built-in errors where possible. */
export function revertOutcome(abi: Abi, data: Hex): Extract<MockOutcome, { type: "revert" }> {
  try {
    const { errorName, args } = decodeErrorResult({ abi: [...abi, ...builtinErrors], data });
    if (errorName === "Error" && typeof args[0] === "string")
      return { type: "revert", data, reason: args[0] };
    return { type: "revert", data, errorName, args: args ?? [] };
  } catch {
    return { type: "revert", data };
  }
}
