import { type Hash, isHash } from "viem";

import { formatValue } from "../mocking/format.js";
import { MockSetupError } from "../shared/errors.js";
import { lowercase } from "../shared/values.js";

/**
 * `hash` as the mock holds it and nodes send it: lowercase, its only form
 * (a hash has no checksum, as an address has). Validated first, so a
 * malformed one fails where it's given; `name` says which it is ("A
 * transaction hash"). For identifiers only: calldata, bytes and topics keep
 * their case.
 */
export function nodeHash(hash: unknown, name: string): Hash {
  if (typeof hash !== "string" || !isHash(hash))
    throw new MockSetupError(`${name} must be 32 bytes; got ${formatValue(hash)}.`);
  return lowercase(hash);
}
