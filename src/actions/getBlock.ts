import { type RpcBlock, formatBlock, hexToBigInt } from "viem";

import { numberOfBlockHash, toRpcBlock } from "../chain/blocks.js";
import { hashParam } from "../chain/params.js";
import type { ChainState } from "../chain/state.js";
import { MockSetupError } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";
import { blockAt } from "./decode.js";
import type { ActionsContext, Definition } from "./table.js";
import type { BlockCall } from "./types.js";

/**
 * The call an `eth_getBlockByNumber` (a number or tag) or
 * `eth_getBlockByHash` (a hash) asks for. A hash that isn't a generated
 * block's takes the current block's number.
 */
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

/**
 * A block in its JSON-RPC form, with its transactions' hashes or the
 * transactions.
 */
type RpcBlockAnswer = Omit<ReturnType<typeof toRpcBlock>, "transactions"> & {
  transactions: readonly unknown[];
};

/**
 * Whether the chain has the block `call` asks for: a generated one up to the
 * current block, by number or by its own hash.
 */
const onChain = ({ blockNumber, blockHash }: BlockCall, state: ChainState) =>
  (blockHash === undefined || numberOfBlockHash(blockHash) !== undefined) &&
  blockNumber <= state.blockNumber;

/**
 * `eth_getBlockByNumber` and `eth_getBlockByHash`. Unmocked, generated
 * blocks up to the current one, listing the chain's transactions in them. A
 * mock's fields go over the generated block, and over its transactions
 * unless it sets its own; the block it answers places them.
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
    const base = blockHash === undefined ? generated : { ...generated, hash: blockHash };
    const rpc = toRpcBlock({ ...base, ...value });
    if (value.transactions !== undefined || call === undefined || !onChain(call, state)) return rpc;
    const placement =
      rpc.number === null || rpc.hash === null
        ? undefined
        : {
            blockNumber: hexToBigInt(rpc.number),
            blockHash: rpc.hash,
            blockTimestamp: hexToBigInt(rpc.timestamp),
          };
    return {
      ...rpc,
      transactions: transactions.transactionsIn(
        call.blockNumber,
        call.includeTransactions,
        placement,
      ),
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
