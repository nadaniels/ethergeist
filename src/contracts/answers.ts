import {
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type Hex,
  encodeFunctionResult,
  encodeErrorResult,
} from "viem";
import { formatAbiItem } from "viem/utils";

import { formatValue } from "../mocking/format.js";
import { encodeGas } from "../mocking/gas.js";
import { checkNoMatchers } from "../mocking/matching.js";
import { checkHex, checkList } from "../mocking/setupChecks.js";
import { zeroResult } from "../mocking/zeroResult.js";
import { builtinErrors, fillZeros } from "../shared/abiValues.js";
import { MockRevertError, MockSetupError, refuseUnencodable } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import type { MockNamespace, RevertSpec } from "./types.js";

/**
 * A function mock's answer as viem's encoder takes it: named outputs become a
 * tuple in ABI order, omitted struct fields get zero values, and
 * `zeroResult` is every output's zero.
 */
function normalizeResult(outputs: readonly AbiParameter[], value: unknown): unknown {
  if (value === zeroResult) return normalizeResult(outputs, outputs.length > 1 ? [] : undefined);
  if (outputs.length === 0) return value;
  if (outputs.length === 1) return fillZeros(outputs[0]!, value);
  if (Array.isArray(value)) return outputs.map((output, i) => fillZeros(output, value[i]));
  if (isPlainObject(value) && outputs.every((output) => output.name))
    return outputs.map((output) => fillZeros(output, value[output.name!]));
  return value;
}

/**
 * A contract mock's answer as JSON-RPC: a call's return data, as `eth_call`
 * answers it, or an estimate's gas as a quantity.
 */
export function encodeAnswer(
  { namespace, abiItem }: { namespace: MockNamespace; abiItem: AbiFunction },
  value: unknown,
): Hex {
  return namespace === "estimateGas"
    ? encodeGas(value, `estimateGas.${abiItem.name}'s answer`)
    : encodeResult(abiItem, value, `${namespace}.${abiItem.name}'s answer`);
}

/**
 * `value` as `abiItem`'s encoded return data, as `eth_call` answers. `what`
 * names it for messages.
 */
function encodeResult(abiItem: AbiFunction, value: unknown, what: string): Hex {
  checkNoMatchers(value, what);
  return encodeFunctionResult({
    abi: [abiItem],
    functionName: abiItem.name,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- viem types result as a tuple, but takes a bare value for a single output
    result: normalizeResult(abiItem.outputs, value) as readonly unknown[] | undefined,
  });
}

/**
 * The revert `spec` gives, its custom errors from `abi`. A spec the types
 * rule out is the mock's setup error: an untyped caller's `null` or `{}`,
 * fields of two forms (e.g. `{ panic, data }`), data that isn't hex, a
 * panic that isn't a number or bigint, args that aren't a list or don't
 * match the error's inputs in number (as a loosely typed ABI allows), or
 * args or a panic code that throw a native error as they encode, e.g.
 * `1.5`. viem's own refusals pass through, e.g. an error not on the ABI or
 * a panic code out of range.
 */
export function createRevertError(abi: Abi, spec?: RevertSpec): MockRevertError {
  const given: unknown = spec;
  if (given === undefined) return new MockRevertError("0x");
  if (typeof given === "string")
    return new MockRevertError(
      encodeErrorResult({ abi: builtinErrors, errorName: "Error", args: [given] }),
      given,
    );
  if (!isPlainObject(given)) throw notARevert(given);
  checkNoMatchers(
    given,
    "a revert spec",
    "A revert spec holds the error's values. To revert whatever the call, pin the mock's " +
      "args or params instead: read.f([match.any()]).reverts(…).",
  );
  const { data, panic } = given;
  const fields = (["data", "panic", "errorName", "args"] as const).filter(
    (field) => given[field] !== undefined,
  );
  // `args` belong to `errorName`'s form.
  if (new Set(fields.map((field) => (field === "args" ? "errorName" : field))).size > 1)
    throw new MockSetupError(
      `A revert spec takes one of data, panic, or errorName; got ${fields.join(" and ")}.`,
    );
  if (data !== undefined) {
    checkHex(data, "A revert's data");
    return new MockRevertError(data);
  }
  if (panic !== undefined && typeof panic !== "number" && typeof panic !== "bigint")
    throw new MockSetupError(
      `A revert's panic must be a number or bigint; got ${formatValue(panic)}.`,
    );
  const encode = () => {
    if (typeof panic === "number" || typeof panic === "bigint")
      return encodeErrorResult({ abi: builtinErrors, errorName: "Panic", args: [BigInt(panic)] });
    const { errorName, args } = given;
    if (typeof errorName !== "string") throw notARevert(given);
    if (args !== undefined)
      checkList(
        args,
        "A revert's args",
        "List them in the error's input order, e.g. { errorName, args: [1n] }.",
      );
    // viem encodes no args at all for a missing or empty list, whatever the error takes.
    const count = args === undefined ? 0 : args.length;
    const errors = abi.filter(
      (item): item is Extract<Abi[number], { type: "error" }> =>
        item.type === "error" && item.name === errorName,
    );
    const counts = [...new Set(errors.map((error) => error.inputs.length))].toSorted(
      (a, b) => a - b,
    );
    if (counts.length > 0 && !counts.includes(count)) {
      throw new MockSetupError(
        `A revert of ${errorName} takes ${counts.join(" or ")} arg${counts.join() === "1" ? "" : "s"}; got ${count}.`,
        {
          metaMessages: [
            ...new Set(errors.map((error) => formatAbiItem(error, { includeName: true }))),
          ].toSorted((a, b) => a.localeCompare(b)),
        },
      );
    }
    return encodeErrorResult({ abi, errorName, args });
  };
  return new MockRevertError(refuseUnencodable("A revert", encode));
}

const notARevert = (spec: unknown) =>
  new MockSetupError(
    `A revert spec has no reason, errorName, panic or data; got ${formatValue(spec)}.`,
    {
      metaMessages: ["A revert is a reason, { errorName, args }, { panic } or { data }."],
    },
  );
