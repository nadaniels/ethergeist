import type { PartCheckpoint } from "../shared/parts.js";
import { type Table, createTable } from "./table.js";
import type { MethodCall, MockMethodBuilder } from "./types.js";

/**
 * Methods the mock doesn't support, refused with Arbitrum's error unless
 * `mock.method()` mocks them. Clients fall back to methods it does answer:
 * - Filters, which many public nodes don't support either: watchers poll
 *   `eth_getLogs` instead.
 * - `eth_fillTransaction`, which reth and geth support: viem fills a
 *   transaction's nonce, fees, and gas with their own requests instead, which
 *   are what tests mock.
 */
const refusedMethods = new Set([
  "eth_newFilter",
  "eth_newBlockFilter",
  "eth_newPendingTransactionFilter",
  "eth_getFilterChanges",
  "eth_getFilterLogs",
  "eth_uninstallFilter",
  "eth_fillTransaction",
]);

/** Methods answered outside `mock.method()`, with where to mock them instead. */
const builtIns = new Map([
  ["eth_chainId", "it's the chain's id; pass `chain` to createMockRpc()"],
  ["eth_blockNumber", "pass `blockNumber` to createMockRpc() and advance it with mine()"],
  ["eth_call", "register a contract with mock.contract()"],
]);

/**
 * Raw JSON-RPC methods, mocked with `mock.method()`: a table per method,
 * made when it's first mocked. `actionFor` names the typed action for a
 * method that has one, which `mock.method()` refuses.
 */
export function createMethods(actionFor: (method: string) => string | undefined) {
  const raw = new Map<string, Table>();

  function method(name: string, params?: readonly unknown[]): MockMethodBuilder {
    const builtIn = builtIns.get(name);
    if (builtIn !== undefined) throw new Error(`"${name}" can't be mocked raw: ${builtIn}.`);
    const action = actionFor(name);
    if (action !== undefined)
      throw new Error(`"${name}" has a typed mock: use mock.actions.${action}().`);

    let table = raw.get(name);
    if (!table) {
      table = createTable({
        name,
        hint: `mock.method("${name}", …).returns(…)`,
        decode: (rawParams) => ({ method: name, params: rawParams }),
        zero: null,
        encode: (value) => value,
        // Pinned params are a prefix: pin the leading ones, leave the rest open.
        actual: (pinned, call) =>
          Array.isArray(pinned)
            ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoded above
              pinned.map((_, i) => (call as MethodCall).params[i])
            : call,
      });
      raw.set(name, table);
    }
    return table.register(params);
  }

  return {
    method,
    /** The table answering `name`, if it's been mocked. */
    tableFor: (name: string) => raw.get(name),
    /** Whether `name` is refused as unsupported when it isn't mocked. */
    isRefused: (name: string) => refusedMethods.has(name),
    tables: () => [...raw.values()],
    /** Saves every method's mocks; `restore()` removes methods first mocked since. */
    checkpoint(): Required<PartCheckpoint> {
      const saved = new Map([...raw].map(([name, table]) => [name, table.checkpoint()]));
      return {
        restore() {
          for (const [name, table] of raw) {
            const each = saved.get(name);
            if (each) {
              each.restore();
            } else {
              table.remove();
              raw.delete(name);
            }
          }
        },
        unusedSince: () =>
          [...raw].flatMap(
            ([name, table]) => saved.get(name)?.unusedSince() ?? table.unusedMocks(),
          ),
      };
    },
  };
}
