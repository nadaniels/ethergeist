import { isAddress } from "viem";

import { withoutTrailingNulls } from "../chain/params.js";
import { withCalls } from "../mocking/handlers.js";
import { MockRpcError, removedContractLines, removedTransactionNote } from "../shared/errors.js";
import type { PartSnapshot } from "../shared/parts.js";
import type { RecordLimit } from "../shared/records.js";
import { createMethods } from "./methods.js";
import { createSends } from "./sends.js";
import { type ActionReport, type Table, createTable, type ActionsContext } from "./table.js";
import { type MockActions, type ActionName, actionMethods, typedActions } from "./typedActions.js";

/** The typed actions and raw methods: see `createActions`. */
export type Actions = ReturnType<typeof createActions>;

/**
 * The typed actions (`mock.actions`) and raw methods (`mock.method()`): their
 * mocks, and answering the requests they're for.
 */
export function createActions(chain: ActionsContext, recordLimit: RecordLimit) {
  /**
   * The lines for a miss on what the last restore removed: a hash lookup's
   * transaction, or the contract an estimate or send is to. They're keyed on
   * the call's `hash` and `to`, which only those actions have, so a new
   * action that names something else `hash` or `to` gets them too.
   */
  const removedTargetLines = (call: object): readonly string[] =>
    "hash" in call &&
    typeof call.hash === "string" &&
    chain.transactions.removedByLastRestore(call.hash)
      ? [removedTransactionNote]
      : "to" in call &&
          typeof call.to === "string" &&
          isAddress(call.to) &&
          chain.registry.removedByLastRestore(call.to)
        ? removedContractLines
        : [];
  const currentBlock = () => chain.state.blockNumber;
  const options = { currentBlock, notFoundLines: removedTargetLines };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an object literal's own keys, which Object.keys types as string
  const tableNames = Object.keys(typedActions) as (keyof typeof typedActions)[];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- one table per name, as built
  const tableActions = Object.fromEntries(
    tableNames.map((name) => [name, createTable(typedActions[name](chain), recordLimit, options)]),
  ) as Record<keyof typeof typedActions, Table>;
  /**
   * Every typed action: a table, or for sends and their estimates, the
   * action `createSends` gives in a table's shape.
   */
  const typed: Record<ActionName, Table> = {
    ...tableActions,
    ...createSends(chain, recordLimit, options),
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an object literal's own keys, which Object.keys types as string
  const actionNames = Object.keys(actionMethods) as ActionName[];
  const typedMethods = new Map<string, ActionName>(
    actionNames.flatMap((name) => actionMethods[name].map((method) => [method, name] as const)),
  );
  const methods = createMethods((method) => typedMethods.get(method), recordLimit, currentBlock);

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- built from the tables at runtime, in the shape MockActions describes
  const actions = Object.fromEntries(
    Object.entries(typed).map(([name, table]) => [
      name,
      withCalls(
        (params?: unknown) => table.register(params),
        () => [...table.calls.kept],
      ),
    ]),
  ) as unknown as MockActions;

  const tables = () => [...Object.values(typed), ...methods.tables()];

  return {
    actions,
    method: methods.method,
    /**
     * Answers a request with a typed or raw mock, or returns `undefined` if
     * none applies. A method the mock doesn't support is refused unless it's
     * mocked.
     */
    answer(
      name: string,
      params: unknown,
      report: (report: ActionReport) => void,
    ): Promise<unknown> | undefined {
      const action = typedMethods.get(name);
      if (action === undefined && methods.isRefused(name))
        return Promise.reject(
          new MockRpcError(-32601, `the method ${name} does not exist/is not available`),
        );
      const table = action === undefined ? methods.tableFor(name) : typed[action];
      // A raw method's params stay as sent, trailing nulls included: it isn't
      // the spec's.
      const given = action === undefined ? params : withoutTrailingNulls(params);
      return table?.answer(name, Array.isArray(given) ? given : [], report);
    },
    /**
     * The typed action answering `method`, if any: history records those as
     * actions.
     */
    actionFor: (rpcMethod: string) => typedMethods.get(rpcMethod),
    clearCalls() {
      for (const table of tables()) table.clearCalls();
    },
    unusedMocks: () => tables().flatMap((table) => table.unusedMocks()),
    /**
     * Saves every table's mocks, typed and raw, to put back or compare
     * against.
     */
    snapshot(): Required<PartSnapshot> {
      const typedSaved = Object.values(typed).map((table) => table.snapshot());
      const rawSaved = methods.snapshot();
      return {
        restore() {
          for (const saved of typedSaved) saved.restore();
          rawSaved.restore();
        },
        unusedSince: () => [
          ...typedSaved.flatMap((saved) => saved.unusedSince()),
          ...rawSaved.unusedSince(),
        ],
      };
    },
  };
}
