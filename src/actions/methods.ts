import type { PublicRpcSchema, WalletRpcSchema } from "viem";

import { MockSetupError } from "../shared/errors.js";
import type { PartSnapshot } from "../shared/parts.js";
import type { RecordLimit } from "../shared/records.js";
import { type Definition, type Table, createTable } from "./table.js";
import type { ActionMethod } from "./typedActions.js";
import type { MockMethodBuilder } from "./types.js";

/**
 * Methods the mock doesn't support, refused with Arbitrum's error unless
 * `mock.method()` mocks them. Clients fall back to methods it does answer:
 * - Filters, which many public nodes don't support either: watchers poll
 *   `eth_getLogs` instead.
 * - `eth_fillTransaction`, which reth and geth support: viem fills a
 *   transaction's nonce, fees, and gas with their own requests instead, which
 *   are what tests mock.
 * - `wallet_sendTransaction`, which nodes don't support: viem retries a failed
 *   `eth_sendTransaction` with it, and on this refusal rethrows the send's own
 *   error.
 * - `wallet_sendCalls`, which nodes don't support: `sendCalls` with
 *   `experimental_fallback` sends each call with `eth_sendTransaction` instead.
 */
const refusedMethods = new Set([
  "eth_newFilter",
  "eth_newBlockFilter",
  "eth_newPendingTransactionFilter",
  "eth_getFilterChanges",
  "eth_getFilterLogs",
  "eth_uninstallFilter",
  "eth_fillTransaction",
  "wallet_sendTransaction",
  "wallet_sendCalls",
]);

/** Methods answered outside `mock.method()`, with where to mock them. */
const builtInHints = {
  eth_chainId: "it's the chain's id; pass `chain` to createMockRpc()",
  eth_blockNumber: "pass `blockNumber` to createMockRpc() and advance it with mine()",
  eth_call: "register a contract with mock.contract()",
};
const builtIns = new Map(Object.entries(builtInHints));

/**
 * A JSON-RPC method `mock.method()` refuses: one with a typed mock, or one
 * the mock answers itself, e.g. `"eth_getBalance"` or `"eth_call"`. It
 * grows each time a method gets a typed mock.
 *
 * A function that passes a name on to `mock.method()`, generic or typed as
 * a union of method names, takes it as `Exclude<…, ReservedMethod>`, e.g.
 * `name: Exclude<name, ReservedMethod>`.
 */
export type ReservedMethod = ActionMethod | keyof typeof builtInHints;

/**
 * The JSON-RPC methods an editor suggests at `mock.method()`: viem's public
 * and wallet methods, as the installed viem names them, less each
 * `ReservedMethod`. `mock.method()` also takes names outside this set.
 *
 * A function that passes a name on to `mock.method()` offers the same
 * suggestions when it constrains its type parameter the same way, e.g.
 * `<name extends SuggestedMethod | (string & {})>`.
 */
export type SuggestedMethod = Exclude<
  PublicRpcSchema[number]["Method"] | WalletRpcSchema[number]["Method"],
  ReservedMethod
>;

/**
 * Raw JSON-RPC methods, mocked with `mock.method()`: a table per method,
 * made when it's first mocked. `actionFor` names the typed action for a
 * method that has one, which `mock.method()` refuses.
 */
export function createMethods(
  actionFor: (method: string) => string | undefined,
  recordLimit: RecordLimit,
  currentBlock: () => bigint,
) {
  /**
   * Each method's table, with its snapshot from when it was made, to empty it
   * on a restore to before it was first mocked.
   */
  const raw = new Map<string, { table: Table; created: Required<PartSnapshot> }>();

  function method(name: string, params?: readonly unknown[]): MockMethodBuilder {
    const builtIn = builtIns.get(name);
    if (builtIn !== undefined)
      throw new MockSetupError(`"${name}" can't be mocked raw: ${builtIn}.`);
    const action = actionFor(name);
    if (action !== undefined)
      throw new MockSetupError(`"${name}" has a typed mock: use mock.actions.${action}().`);

    let entry = raw.get(name);
    if (!entry) {
      const definition: Definition<{ method: string; params: readonly unknown[] }> = {
        name,
        hint: `mock.method("${name}", …).returns(…)`,
        decode: (rawParams) => ({ method: name, params: rawParams }),
        /**
         * Without the `undefined`s at the end, which are params left out:
         * pinned params are a prefix of the request's.
         */
        pin: (pinned) =>
          Array.isArray(pinned)
            ? pinned.slice(0, pinned.findLastIndex((each) => each !== undefined) + 1)
            : pinned,
        zero: null,
        encode: (value) => value,
        /**
         * Pinned params are a prefix of the request's: the rest are open. One
         * matcher in place of them all is matched against all the params.
         */
        actual: (pinned, call) =>
          Array.isArray(pinned) ? pinned.map((_, i) => call.params[i]) : call.params,
      };
      const table = createTable(definition, recordLimit, { currentBlock });
      entry = { table, created: table.snapshot() };
      raw.set(name, entry);
    }
    return entry.table.register(params);
  }

  return {
    method,
    /** The table answering `name`, if it's ever been mocked. */
    tableFor: (name: string) => raw.get(name)?.table,
    /**
     * Whether `name` is refused as unsupported: it's one the mock doesn't
     * support, and it has no mocks (none yet, or a restore removed them).
     */
    isRefused: (name: string) =>
      refusedMethods.has(name) && raw.get(name)?.table.hasMocks() !== true,
    tables: () => [...raw.values()].map(({ table }) => table),
    /**
     * Saves every method's mocks; `restore()` empties methods first mocked
     * since, so their misses list what it removed.
     */
    snapshot(): Required<PartSnapshot> {
      const saved = new Map([...raw].map(([name, { table }]) => [name, table.snapshot()]));
      return {
        restore() {
          for (const [name, { created }] of raw) (saved.get(name) ?? created).restore();
        },
        unusedSince: () =>
          [...raw].flatMap(([name, { created }]) => (saved.get(name) ?? created).unusedSince()),
      };
    },
  };
}
