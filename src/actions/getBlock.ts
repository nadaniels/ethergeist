import { type RpcBlock, formatBlock } from "viem";

import { numberOfBlockHash, toRpcBlock } from "../chain/blocks.js";
import { hashParam } from "../chain/params.js";
import type { ChainState } from "../chain/state.js";
import { MockSetupError } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import { blockAt } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";
import type { BlockCall } from "./types.js";

/** `eth_getBlockByNumber` takes a number or tag; `eth_getBlockByHash` a hash. */
function decodeBlock(
  [block, includeTransactions]: readonly unknown[],
  rpcMethod: string,
  state: ChainState,
): BlockCall {
  const include = includeTransactions === true;
  if (rpcMethod === "eth_getBlockByHash") {
    const blockHash = hashParam(block);
    return {
      blockNumber: numberOfBlockHash(blockHash) ?? state.blockNumber,
      blockHash,
      includeTransactions: include,
    };
  }
  return { ...blockAt(block, state.resolveBlock, "numberOrTag"), includeTransactions: include };
}

/** `eth_getBlockByNumber` and `eth_getBlockByHash`: unmocked, generated blocks up to the current one. */
export const getBlock = ({
  state,
}: ActionsContext): Definition<BlockCall, ReturnType<typeof toRpcBlock> | null> => ({
  name: "getBlock",
  hint: "mock.actions.getBlock({ blockNumber }).returns(…)",
  decode: (params, method) => decodeBlock(params, method, state),
  zero: {},
  encode(value, call) {
    if (value === null) return null;
    if (!isPlainObject(value))
      throw new MockSetupError(`A block must be an object or null; got ${typeof value}.`);
    const generated = state.generateBlock(call?.blockNumber ?? state.blockNumber);
    const blockHash = call?.blockHash;
    // A pinned, unknown hash is the block's own hash.
    const base = blockHash === undefined ? generated : { ...generated, hash: blockHash };
    return toRpcBlock({ ...base, ...value });
  },
  view: (rpc) =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ox's RPC block leaves out what viem's types as null
    rpc === null ? null : formatBlock(rpc as RpcBlock),
  // Generated blocks exist up to the current one, and only by their own hashes.
  fallback(call) {
    const { blockNumber: number, blockHash } = call;
    if (blockHash !== undefined && numberOfBlockHash(blockHash) === undefined) return undefined;
    if (number > state.blockNumber) return undefined;
    return toRpcBlock(state.generateBlock(number));
  },
});
