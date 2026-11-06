import { type Address, getAddress } from "viem";

import { testAddress, testHash } from "../shared/testValues.js";
import type { MockEventLog } from "./events.js";

/**
 * Stable log content for `label` that matches no event: a topic that's no
 * event's signature, and no data. For a receipt's noise, e.g. testing that
 * the app skips logs it doesn't know. It's from `testAddress(label)`, or
 * from `address` (any valid address, checksummed) for an unknown event at a
 * contract the app does know.
 */
export function testLog(label: string, { address }: { address?: Address } = {}): MockEventLog {
  return {
    address: address === undefined ? testAddress(label) : getAddress(address),
    topics: [testHash(`Unknown(${label})`)],
    data: "0x",
  };
}
