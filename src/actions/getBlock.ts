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

/** A block in its JSON-RPC form, with its transactions' hashes or the transactions. */
type RpcBlockAnswer = Omit<ReturnType<typeof toRpcBlock>, "transactions"> & {
  transactions: readonly unknown[];
};

/** Whether the chain has the block `call` asks for: generated ones up to the current one, by their own hashes. */
const onChain = ({ blockNumber, blockHash }: BlockCall, state: ChainState) =>
  (blockHash === undefined || numberOfBlockHash(blockHash) !== undefined) &&
  blockNumber <= state.blockNumber;

/**
 * `eth_getBlockByNumber` and `eth_getBlockByHash`: unmocked, generated blocks
 * up to the current one, listing the chain's transactions in them.
 */
export const getBlock = ({
  state,
  transactions,
}: ActionsContext): Definition<BlockCall, RpcBlockAnswer | null> => ({
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
    const rpc = toRpcBlock({ ...base, ...value });
    // A mock's fields go over the chain's block, its transactions too, unless it sets its own.
    if (value.transactions !== undefined || call === undefined || !onChain(call, state)) return rpc;
    return {
      ...rpc,
      transactions: transactions.transactionsIn(call.blockNumber, call.includeTransactions),
    };
  },
  view: (rpc) =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ox's RPC block leaves out what viem's types as null
    rpc === null ? null : formatBlock(rpc as RpcBlock),
  fallback: (call) =>
    onChain(call, state)
      ? {
          ...toRpcBlock(state.generateBlock(call.blockNumber)),
          transactions: transactions.transactionsIn(call.blockNumber, call.includeTransactions),
        }
      : undefined,
});
