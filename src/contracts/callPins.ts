import { type AbiFunction, getAddress } from "viem";

import { formatValue } from "../mocking/format.js";
import { isMatcher } from "../mocking/matchers.js";
import { type MatchOptions, firstMismatch, mismatches } from "../mocking/matching.js";
import type { PinnedKey } from "../mocking/types.js";
import { MockSetupError } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import type { MockCall } from "./types.js";

/** A mock's pinned `from` and `value`, beside its args: only those given. */
export type Pins = { readonly from?: unknown; readonly value?: unknown };

/**
 * `pins` as a mock of `abiItem` pins them, checked: `from` an address
 * (checksummed) or a matcher, and `value` only on a payable function, as
 * no other takes one. `undefined` when nothing is pinned.
 */
export function pinCall(abiItem: AbiFunction, pins: unknown): Pins | undefined {
  if (pins === undefined) return undefined;
  if (!isPlainObject(pins) || isMatcher(pins))
    throw new MockSetupError(`A mock pins from and value as an object; got ${formatValue(pins)}.`);
  const { from, value, ...rest } = pins;
  const [other] = Object.keys(rest);
  if (other !== undefined)
    throw new MockSetupError(`A mock pins from and value, not ${other}.`, {
      metaMessages: ["Pin the sender as from, e.g. { from: alice }."],
    });
  if (value !== undefined && abiItem.stateMutability !== "payable")
    throw new MockSetupError(
      `"${abiItem.name}" is ${abiItem.stateMutability}, so it takes no value; only a payable function's mock pins one.`,
    );
  if (from !== undefined && !isMatcher(from) && typeof from !== "string")
    throw new MockSetupError(`from takes an address or a matcher; got ${formatValue(from)}.`);
  const pinned: Pins = {
    ...(from !== undefined && { from: typeof from === "string" ? getAddress(from) : from }),
    ...(value !== undefined && { value }),
  };
  return Object.keys(pinned).length === 0 ? undefined : pinned;
}

/**
 * Whether `call` lacks the `from` that `pins` pins: then it doesn't match,
 * and no predicate runs.
 */
const lacksFrom = (pins: Pins, call: MockCall) =>
  pins.from !== undefined && call.from === undefined;

/** Where `call` first differs from a mock's `pins`, as `firstMismatch` says. */
export const firstPinMismatch = (
  pins: Pins | undefined,
  call: MockCall,
  options: MatchOptions,
): PinnedKey | undefined =>
  pins === undefined
    ? undefined
    : lacksFrom(pins, call)
      ? "from"
      : firstMismatch(pins, { from: call.from, value: call.value }, options);

/** Every key of a mock's `pins` that `call` doesn't match, for messages. */
export const pinMismatches = (
  pins: Pins | undefined,
  call: MockCall,
  options: MatchOptions = {},
): PinnedKey[] =>
  pins === undefined
    ? []
    : lacksFrom(pins, call)
      ? ["from"]
      : mismatches(pins, { from: call.from, value: call.value }, options);
