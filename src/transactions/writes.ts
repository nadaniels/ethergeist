import { type Address, getAddress } from "viem";

import { checkStatus } from "../chain/receipts.js";
import { type MockLogContent, checkLogs } from "../logs/events.js";
import { formatValue } from "../mocking/format.js";
import type { Builder } from "../mocking/handlers.js";
import { checkAmount, checkFields } from "../mocking/setupChecks.js";
import type { MockFault, MockRefusalAnswers, SendErrorName } from "../mocking/types.js";
import { zeroResult } from "../mocking/zeroResult.js";
import { MockSetupError } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";

/**
 * What the chain did with a send, as a send mock answers it. The rest of its
 * receipt comes from the transaction and the block it's mined in.
 */
export type MockWriteOutcome = {
  /**
   * What it emitted: log content, e.g. from `contract.events`, placed when
   * it's mined. Any address but an `empty()` one's, which has no code to
   * emit them; a placed log is refused.
   */
  logs?: readonly MockLogContent[];
  /**
   * Its receipt's status: `"reverted"` mines it reverted, and logs with it
   * are refused. Defaults to `"success"`.
   */
  status?: "success" | "reverted";
  /**
   * Its receipt's `gasUsed`, e.g. for a fee display. Defaults to the gas it
   * was sent with.
   */
  gasUsed?: bigint;
  /** Its receipt's `effectiveGasPrice`. Defaults to the price it paid. */
  effectiveGasPrice?: bigint;
  /**
   * A deploy's contract address (`to: null`). Defaults to
   * `getContractAddress({ from, nonce })`; only a deploy takes one.
   */
  contractAddress?: Address;
};

/**
 * How a send mock answers: with what the chain did, a fault, or a node's
 * refusal (see `MockRefusalAnswers`). `revertSpec` is what `.reverts()`
 * takes.
 */
export type MockWriteAnswers<context, revertSpec> = MockRefusalAnswers<SendErrorName> & {
  /** Answers every matching call as a success, without logs. */
  returns(): void;
  /**
   * Answers every matching call with `outcome`: see `MockWriteOutcome`. A
   * resolver returns one, or nothing for a success; it runs at the send, as
   * the transaction is mined.
   */
  returns(
    outcome:
      | MockWriteOutcome
      | ((context: context) => MockWriteOutcome | void | Promise<MockWriteOutcome | void>),
  ): void;
  /**
   * Answers every matching call with this log, or these logs, as
   * `.returns({ logs: [log] })` does.
   */
  emits(logs: MockLogContent | readonly MockLogContent[]): void;
  /**
   * Reverts every matching call's transaction. Its estimate reverts with
   * `spec`, before any `mock.actions.estimateGas` mock, so a client that
   * estimates first throws before it sends. That answer uses the mock,
   * spending a `.once()`. A send that reaches the chain anyway is mined
   * reverted. See `RevertSpec` for the forms.
   */
  reverts(spec?: revertSpec): void;
  /**
   * Fails every matching call: the request it's in fails with `fault`, and
   * the chain is left as it was. See `MockFault` for the kinds.
   */
  fails(fault: MockFault): void;
};

const outcomeFields = new Set([
  "logs",
  "status",
  "gasUsed",
  "effectiveGasPrice",
  "contractAddress",
]);
const fieldsHint =
  "Its fields are logs, status, gasUsed, effectiveGasPrice and contractAddress; the rest of " +
  "its receipt comes from the transaction and the block it's mined in.";

/**
 * A send's outcome, checked, with its contract address checksummed. A
 * resolver that returns nothing, like `.returns()`, answers a success. Only
 * a deploy has a contract address: `isDeploy` is whether the send is one,
 * or `undefined` when that isn't known yet (a static answer whose `to`
 * isn't pinned).
 */
export function encodeWriteOutcome(
  value: unknown,
  isDeploy: boolean | undefined,
): MockWriteOutcome {
  if (value === undefined || value === zeroResult) return {};
  const outcome = checkFields(value, "a send's outcome", outcomeFields, fieldsHint);
  const { logs = [], status, gasUsed, effectiveGasPrice, contractAddress } = outcome;
  checkLogs(logs, (part) => `A send's ${part}`);
  checkStatus(status, logs, "A send's status");
  for (const [name, gas] of Object.entries({ gasUsed, effectiveGasPrice }))
    if (gas !== undefined) checkAmount(gas, `A send's ${name}`);
  if (contractAddress !== undefined && typeof contractAddress !== "string")
    throw new MockSetupError(
      `A send's contractAddress must be an address; got ${formatValue(contractAddress)}.`,
    );
  if (contractAddress !== undefined && isDeploy === false)
    throw new MockSetupError("Only a deploy (to: null) has a contractAddress.");
  return {
    ...outcome,
    ...(contractAddress !== undefined && { contractAddress: getAddress(contractAddress) }),
  };
}

/**
 * What a revert answers at a send, a mock's `.reverts()` or a resolver's
 * `revert()`: mined reverted, as a send that reaches the chain is. See
 * `answerWith`'s `reverted`.
 */
export const minedReverted: MockWriteOutcome = { status: "reverted" };

/** A resolver with `emit`, answering its outcome with what it emitted. */
const withWriteContext =
  (resolver: (context: object) => unknown) =>
  async (context: object): Promise<unknown> => {
    const emitted: MockLogContent[] = [];
    const emit = (logs: MockLogContent | readonly MockLogContent[]) => {
      emitted.push(...[logs].flat());
    };
    const outcome = await resolver({ ...context, emit });
    if (outcome === undefined) return { logs: emitted };
    const logs: unknown = isPlainObject(outcome) ? (outcome.logs ?? []) : undefined;
    if (!isPlainObject(outcome) || !Array.isArray(logs)) return outcome;
    const returned: unknown[] = logs;
    return { ...outcome, logs: [...emitted, ...returned] };
  };

/**
 * Gives a send mock's builder `.emits()`, and its resolvers `emit` (see
 * `WriteResolverContext` and `SendTransactionContext`).
 */
export function extendWriteBuilder(builder: Builder): void {
  const returns = builder.returns.bind(builder);
  Object.assign(builder, {
    returns(value?: unknown) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the types guarantee a resolver's signature
      returns(typeof value === "function" ? withWriteContext(value as () => unknown) : value);
    },
    emits(logs: MockLogContent | readonly MockLogContent[]) {
      returns({ logs: [logs].flat() });
    },
  });
}
