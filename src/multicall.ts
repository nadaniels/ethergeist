import {
  type Address,
  type Hex,
  decodeFunctionData,
  encodeFunctionResult,
  multicall3Abi,
} from "viem";
import type { CallContext } from "./contracts/types.js";
import { MockNotFoundError, MockRevertError } from "./shared/errors.js";
import { createRevertError } from "./contracts/revert.js";

type Dispatch = (to: Address, data: Hex, context: CallContext) => Promise<Hex>;

/**
 * Answers an `aggregate3` call by sending each sub-call through `dispatch`, as
 * the real contract would. Reverts become `success: false` when the sub-call
 * allows failure; missing mocks and resolver errors still fail the request.
 */
export async function resolveMulticall(
  data: Hex,
  {
    address,
    batchId,
    context,
    dispatch,
  }: { address: Address; batchId: number; context: CallContext; dispatch: Dispatch },
): Promise<Hex> {
  const decoded = (() => {
    try {
      return decodeFunctionData({ abi: multicall3Abi, data });
    } catch {
      return undefined;
    }
  })();
  if (decoded?.functionName !== "aggregate3")
    throw new MockNotFoundError(
      `Unsupported Multicall3 call on ${address}; only aggregate3 is mocked.`,
      { details: `Call data: ${data.slice(0, 10)}…` },
    );

  // Sequential, like the real contract: each sub-call finishes before the next
  // starts, so async resolvers never interleave and history keeps batch order.
  const results: { success: boolean; returnData: Hex }[] = [];
  for (const [index, { target, allowFailure, callData }] of decoded.args[0].entries()) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sub-calls run in order on-chain
      const returnData = await dispatch(target, callData, {
        ...context,
        from: address,
        value: 0n,
        batch: { id: batchId, index, from: context.from },
      });
      results.push({ success: true, returnData });
    } catch (error) {
      if (!(error instanceof MockRevertError)) throw error;
      if (!allowFailure) throw createRevertError([], "Multicall3: call failed");
      results.push({ success: false, returnData: error.data });
    }
  }

  return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
}
