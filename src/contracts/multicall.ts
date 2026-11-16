import {
  type Address,
  type Hex,
  decodeFunctionData,
  encodeFunctionResult,
  multicall3Abi,
} from "viem";

import { MockNotFoundError, MockRevertError } from "../shared/errors.js";
import { createRevertError } from "./answers.js";
import type { CallReading, Reporter } from "./types.js";

type SubCall = CallReading & { allowFailure: boolean };

export const unsupportedMulticallError = (address: Address, data: Hex) =>
  new MockNotFoundError(`Unsupported Multicall3 call on ${address}; only aggregate3 is mocked.`, {
    metaMessages: [`Call data: ${data.slice(0, 10)}…`],
  });

/** Throws for any Multicall3 call but `aggregate3`. */
export function decodeAggregate3(address: Address, data: Hex) {
  const decoded = (() => {
    try {
      return decodeFunctionData({ abi: multicall3Abi, data });
    } catch {
      return undefined;
    }
  })();
  if (decoded?.functionName !== "aggregate3") throw unsupportedMulticallError(address, data);
  return decoded.args[0];
}

/**
 * As Multicall3 does, a revert is `success: false` when the sub-call allows
 * failure, and otherwise reverts the whole call. Any other error, like a
 * missing mock, a resolver's error, or a fault, fails the request. Sub-calls
 * after one that fails the batch are `notReached`.
 */
export async function answerAggregate3(
  subCalls: readonly SubCall[],
  report: Reporter,
): Promise<Hex> {
  const results: { success: boolean; returnData: Hex }[] = [];
  for (const [index, { allowFailure, answer }] of subCalls.entries()) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sub-calls run in order on-chain, so resolvers never interleave and history keeps batch order
      const returnData = await answer(report);
      results.push({ success: true, returnData });
    } catch (error) {
      if (error instanceof MockRevertError && allowFailure) {
        results.push({ success: false, returnData: error.data });
        continue;
      }
      for (const later of subCalls.keys()) if (later > index) report({ type: "notReached" }, later);
      throw error instanceof MockRevertError
        ? createRevertError([], "Multicall3: call failed")
        : error;
    }
  }

  return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
}
