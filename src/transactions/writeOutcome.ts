import { type Address, getAddress } from "viem";

import { type MockEventLog, isPlaced } from "../logs/events.js";
import { formatValue } from "../mocking/format.js";
import type { Builder } from "../mocking/handlers.js";
import type { MockNodeFault, SendErrorName } from "../mocking/types.js";
import { zeroResult } from "../mocking/zeroResult.js";
import { MockRevertError, MockSetupError } from "../shared/errors.js";
import { isPlainObject } from "../shared/values.js";

/**
 * What the chain did with a sent transaction, as a write mock answers it:
 * the rest of its receipt comes from the transaction and the block it's
 * mined in. Left out, it's a success without logs, that used the gas it was
 * sent with, at the price it paid there.
 * - `logs`: what it emitted, placed when it's mined. Any address but an
 *   `empty()` one's, which has no code to emit them.
 * - `status`: `"reverted"` mines it reverted, without logs.
 * - `gasUsed`, `effectiveGasPrice`: its receipt's, e.g. for a fee display.
 * - `contractAddress`: a deploy's (`to: null`), which defaults to
 *   `getContractAddress({ from, nonce })`.
 */
export type MockWriteOutcome = {
  logs?: readonly MockEventLog[];
  status?: "success" | "reverted";
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  contractAddress?: Address;
};

/**
 * What a write's resolver gets beyond its call and its `fail` and `revert`,
 * to answer the transaction as it's mined. A write's `revert(spec)` mines
 * it reverted, dropping what it emitted: a resolver runs only at the send,
 * so its estimate doesn't revert (see `.reverts()`).
 */
export type MockWriteContext = {
  /**
   * Adds logs to the transaction, placed when it's mined, as `.emits()`
   * does. Use it rather than `mock.addTransaction()` or `contract.emit`,
   * which would put a transaction of their own on the chain, and are
   * refused in a write's resolver up to its first `await` (after it, they
   * would still place that separate transaction).
   */
  emit: (logs: MockEventLog | readonly MockEventLog[]) => void;
};

/**
 * How a write mock answers: with what the chain did, or the node's refusal.
 * `revertSpec` is what `.reverts()` takes.
 */
export type MockWriteAnswers<context, revertSpec> = {
  /** Mined as a success, without logs. */
  returns(): void;
  /**
   * Mined with this outcome: see `MockWriteOutcome`. A resolver returns
   * one, or nothing for a success; it runs at the send, as the
   * transaction is mined.
   */
  returns(
    outcome:
      | MockWriteOutcome
      | ((context: context) => MockWriteOutcome | void | Promise<MockWriteOutcome | void>),
  ): void;
  /** Mined with these logs: `.returns({ logs })`. */
  emits(logs: readonly MockEventLog[]): void;
  /**
   * The transaction reverts: its estimate reverts with `spec`, so a client
   * that estimates first throws before it sends; a send that reaches the
   * chain anyway is mined reverted. See `RevertSpec` for the forms.
   */
  reverts(spec?: revertSpec): void;
  /**
   * The node refuses the send: nothing goes on the chain. A node's refusal
   * by name, e.g. `"insufficientFunds"` or `"nonceTooLow"` (see
   * `NodeErrorName`), or any `MockFault`.
   */
  fails(fault: MockNodeFault<SendErrorName>): void;
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
 * A write's outcome, checked, with its contract address checksummed. A
 * resolver that returns nothing, like `.returns()`, answers a success. Only
 * a deploy has a contract address: `isDeploy` is whether the write is one,
 * or `undefined` when that isn't known yet (a static answer whose `to`
 * isn't pinned).
 */
export function encodeWriteOutcome(
  value: unknown,
  isDeploy: boolean | undefined,
): MockWriteOutcome {
  if (value === undefined || value === zeroResult) return {};
  if (!isPlainObject(value))
    throw new MockSetupError(`A write's outcome must be an object; got ${formatValue(value)}.`, {
      metaMessages: [fieldsHint],
    });
  const unknown = Object.keys(value).find((key) => !outcomeFields.has(key));
  if (unknown !== undefined)
    throw new MockSetupError(`A write's outcome has no ${unknown}.`, {
      metaMessages: [fieldsHint],
    });
  const { logs = [], status, gasUsed, effectiveGasPrice, contractAddress } = value;
  refuseNonLogs(logs, "A write's");
  if (status !== undefined && status !== "success" && status !== "reverted")
    throw new MockSetupError(
      `A write's status is "success" or "reverted"; got ${formatValue(status)}.`,
    );
  refuseRevertedLogs(status, logs);
  for (const [name, gas] of Object.entries({ gasUsed, effectiveGasPrice }))
    if (gas !== undefined && (typeof gas !== "bigint" || gas < 0n))
      throw new MockSetupError(
        `A write's ${name} must be a bigint, zero or more; got ${formatValue(gas)}.`,
      );
  if (contractAddress !== undefined && typeof contractAddress !== "string")
    throw new MockSetupError(
      `A write's contractAddress must be an address; got ${formatValue(contractAddress)}.`,
    );
  if (contractAddress !== undefined && isDeploy === false)
    throw new MockSetupError("Only a deploy (to: null) has a contractAddress.");
  if (logs.some((log: object) => isPlaced(log)))
    throw new MockSetupError(
      "A write's logs are placed when it's mined, but one already has a position (e.g. from " +
        "mock.buildLog()).",
      { metaMessages: ["Pass a log from contract.events."] },
    );
  return {
    ...value,
    ...(typeof contractAddress === "string" && { contractAddress: getAddress(contractAddress) }),
  };
}

/**
 * Refuses `logs` unless it's a list of logs, for `subject` ("A write's"):
 * a log that isn't one would fail where it's placed, as the mock's bug.
 */
export function refuseNonLogs(
  logs: unknown,
  subject: string,
): asserts logs is readonly MockEventLog[] {
  if (!Array.isArray(logs))
    throw new MockSetupError(`${subject} logs must be a list; got ${formatValue(logs)}.`);
  logs.forEach((log: unknown, index: number) => {
    if (
      !isPlainObject(log) ||
      typeof log.address !== "string" ||
      (log.topics !== undefined && !Array.isArray(log.topics))
    )
      throw new MockSetupError(`${subject} log ${index} isn't a log; got ${formatValue(log)}.`, {
        metaMessages: ["Pass logs from contract.events, contractEvents() or testLog()."],
      });
    // getAddress validates it; the store checksums it where it's placed.
    getAddress(log.address);
  });
}

/**
 * Refuses logs on a reverted transaction, which emits none: for a write's
 * outcome and an added transaction alike.
 */
export function refuseRevertedLogs(status: unknown, logs: readonly unknown[]): void {
  if (status === "reverted" && logs.length > 0)
    throw new MockSetupError("A reverted transaction has no logs.");
}

/**
 * A write mock's `.reverts()` answer: mined reverted, as a send that reaches
 * the chain is. The resolver carries `error`, so an estimate the mock
 * implies reverts with it without running anything (see `registeredRevert`).
 */
const revertedWith = (error: MockRevertError) =>
  Object.assign((): MockWriteOutcome => ({ status: "reverted" }), { revert: error });

/** What a write mock's builder takes from its engine: see `extendWriteBuilder`. */
type WriteEngine = {
  /** What a resolver's `revert(spec)` and `.reverts(spec)` revert with. */
  revertError(spec?: unknown): MockRevertError;
  /** Runs a resolver, refusing `mock.addTransaction()` in its body. */
  whileWriting<result>(run: () => result): result;
};

/**
 * Gives a write mock's builder `.emits()` and `.reverts()`, and its
 * resolvers `emit` and `revert` (see `MockWriteContext`).
 */
export function extendWriteBuilder(builder: Builder, engine: WriteEngine): void {
  const returns = builder.returns.bind(builder);
  /** A resolver with `emit` and `revert`, answering its outcome with what it emitted. */
  const withWriteContext =
    (resolver: (context: object) => unknown) =>
    async (context: object): Promise<unknown> => {
      const emitted: MockEventLog[] = [];
      const writeContext: MockWriteContext & { revert: (spec?: unknown) => never } = {
        emit(logs) {
          emitted.push(...[logs].flat());
        },
        revert(spec) {
          throw engine.revertError(spec);
        },
      };
      try {
        const outcome = await engine.whileWriting(() => resolver({ ...context, ...writeContext }));
        if (emitted.length === 0) return outcome;
        if (outcome === undefined) return { logs: emitted };
        const logs: unknown = isPlainObject(outcome) ? (outcome.logs ?? []) : undefined;
        // Anything else isn't an outcome, which encodeWriteOutcome says.
        if (!isPlainObject(outcome) || !Array.isArray(logs)) return outcome;
        const returned: unknown[] = logs;
        return { ...outcome, logs: [...emitted, ...returned] };
      } catch (error) {
        // A revert at the send is mined: the transaction still goes on the chain.
        if (error instanceof MockRevertError) return { status: "reverted" };
        throw error;
      }
    };
  Object.assign(builder, {
    returns(value?: unknown) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the types guarantee a resolver's signature
      returns(typeof value === "function" ? withWriteContext(value as () => unknown) : value);
    },
    emits(logs: readonly MockEventLog[]) {
      returns({ logs });
    },
    // The unwrapped `returns`, so the estimate still sees the resolver's `revert`.
    reverts(spec?: unknown) {
      returns(revertedWith(engine.revertError(spec)));
    },
  });
}

/** The revert a write mock's `.reverts()` registered, if its resolver is one. */
export const registeredRevert = (resolver: unknown): MockRevertError | undefined =>
  typeof resolver === "function" &&
  "revert" in resolver &&
  resolver.revert instanceof MockRevertError
    ? resolver.revert
    : undefined;
