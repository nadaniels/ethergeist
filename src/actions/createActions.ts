import { withCalls } from "../mocking/handlers.js";
import { MockRpcError } from "../shared/errors.js";
import type { PartCheckpoint } from "../shared/parts.js";
import { createMethods } from "./methods.js";
import { type ActionReport, type Table, createTable, type ActionsContext } from "./table.js";
import { type MockActions, type ActionName, typedActions } from "./typedActions.js";

/** The typed actions and raw methods: see `createActions`. */
export type Actions = ReturnType<typeof createActions>;

/**
 * The typed actions (`mock.actions`) and raw methods (`mock.method()`): their
 * mocks, and answering the requests they're for.
 */
export function createActions(context: ActionsContext) {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.keys loses the key type
  const names = Object.keys(typedActions) as ActionName[];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- one table per name, as built
  const typed = Object.fromEntries(
    names.map((name) => [name, createTable(typedActions[name].define(context))]),
  ) as Record<ActionName, Table>;
  const typedMethods = new Map<string, ActionName>(
    names.flatMap((name) => typedActions[name].methods.map((method) => [method, name] as const)),
  );
  const methods = createMethods((method) => typedMethods.get(method));

  // Built at runtime from the tables; `MockActions` describes the same shape.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime-built typed facade
  const actions = Object.fromEntries(
    names.map((name) => {
      const table = typed[name];
      return [
        name,
        withCalls(
          (params?: unknown) => table.register(params),
          () => [...table.history],
        ),
      ];
    }),
  ) as unknown as MockActions;

  const tables = () => [...Object.values(typed), ...methods.tables()];

  return {
    actions,
    method: methods.method,
    /** Answers a request with a typed or raw mock, or returns `undefined` if none applies. */
    answer(
      name: string,
      params: unknown,
      report?: (report: ActionReport) => void,
    ): Promise<unknown> | undefined {
      const action = typedMethods.get(name);
      const table = action === undefined ? methods.tableFor(name) : typed[action];
      // Refused as unsupported; clients fall back to other methods.
      if (table === undefined && methods.isRefused(name))
        return Promise.reject(
          new MockRpcError(-32601, `the method ${name} does not exist/is not available`),
        );
      // JSON-RPC params are an array for every method viem sends.
      return table?.answer(name, Array.isArray(params) ? params : [], report);
    },
    /** The typed action answering `method`, if any: history records those as actions. */
    actionFor: (rpcMethod: string) => typedMethods.get(rpcMethod),
    clearCalls() {
      for (const table of tables()) table.clearCalls();
    },
    unusedMocks: () => tables().flatMap((table) => table.unusedMocks()),
    /** Saves every table's mocks, typed and raw, to put back or compare against. */
    checkpoint(): Required<PartCheckpoint> {
      const typedSaved = Object.values(typed).map((table) => table.checkpoint());
      const rawSaved = methods.checkpoint();
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
