import {
  type Abi,
  type ContractErrorArgs,
  type ContractErrorName,
  type Hex,
  decodeErrorResult,
  encodeErrorResult,
  parseAbi,
} from "viem";
import { MockRevertError } from "./errors.js";
import type { MockOutcome } from "./history.js";

const builtinErrors = parseAbi(["error Error(string)", "error Panic(uint256)"]);

type CustomRevert<abi extends Abi, errorName extends ContractErrorName<abi>> = {
  errorName: errorName;
} & (ContractErrorArgs<abi, errorName> extends readonly []
  ? { args?: readonly [] }
  : { args: ContractErrorArgs<abi, errorName> });

/**
 * What a mocked call reverts with:
 * - a string: `require(cond, "reason")`, encoded as `Error(string)`
 * - `{ errorName, args }`: a custom error from the contract's ABI
 * - `{ panic }`: a `Panic(uint256)` code, e.g. `0x11` for arithmetic overflow
 * - `{ data }`: raw revert data, for errors not on the ABI
 * - nothing: a bare `revert()` with empty data
 */
export type RevertSpec<
  abi extends Abi = Abi,
  errorName extends ContractErrorName<abi> = ContractErrorName<abi>,
> = string | CustomRevert<abi, errorName> | { panic: number | bigint } | { data: Hex };

export type RevertFn<abi extends Abi> = <
  errorName extends ContractErrorName<abi> = ContractErrorName<abi>,
>(
  spec?: RevertSpec<abi, errorName>,
) => never;

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
