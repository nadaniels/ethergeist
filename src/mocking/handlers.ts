import {
  MockNotFoundError,
  MockResolverError,
  MockRevertError,
  MockSetupError,
  refuseUnencodable,
  removedMockError,
} from "../shared/errors.js";
import type { PartSnapshot } from "../shared/parts.js";
import { checkFault, fail } from "./faults.js";
import {
  type MatchOptions,
  type Specificity,
  checkNoRunnerMatchers,
  bestMatch,
  specificity,
} from "./matching.js";
import { isAnswer } from "./outcomes.js";
import { checkCount } from "./setupChecks.js";
import type { Answer, MockNodeFault, PinnedKey } from "./types.js";
import { zeroResult } from "./zeroResult.js";

/** A mock's limit: `limit` answers in all, `remaining` of them left. */
type Limit = { limit: number | undefined; remaining: number | undefined };

/** Limits a mock to `count` answers, for `.once()` and `.times(count)`. */
function setLimit(mock: Limit, count: number): void {
  checkCount(count, "times()'s count", 1);
  if (mock.limit !== undefined)
    throw new MockSetupError("This mock already has a limit; call once() or times() only once.");
  mock.limit = count;
  mock.remaining = count;
}

/**
 * One registered mock, for a contract's function or an action: what it pins,
 * how it answers, and how often. `extra` is what its engine adds, e.g. the
 * function a contract's mock is for.
 */
export type Handler<context = never, extra = unknown> = extra & {
  /** The args or params it pins, normalized; `undefined` matches any call. */
  pinned: unknown;
  /** How specific its pins are, for ranking: see `Specificity`. */
  specificity: Specificity;
  /** How it answers: see `Answer`. `undefined` until it's given one. */
  answer: Answer<context> | undefined;
  /**
   * How many calls it answered since registration or the last
   * `clearCalls()`.
   */
  usedCount: number;
  /**
   * Whether it's from a contract's `defaults`: shared setup, which
   * `assertAllUsed()` doesn't hold to any one test.
   */
  isDefault: boolean;
  /**
   * How many answers `.once()` or `.times(count)` allow it in all, kept by
   * `clearCalls()`; `undefined` when unlimited.
   */
  limit: number | undefined;
  /** How many of `limit`'s answers are left. */
  remaining: number | undefined;
  /**
   * Whether a `restore()` or `reset()` removed it, so its builder throws if
   * used again.
   */
  removed: boolean;
};

/**
 * A mock found without answering (see `findAnswering`): its answer, and
 * `spend`, which counts a use if what it would answer is given after all.
 */
export type FoundMock = {
  /** Its answer, to read, not to run. */
  answer: Answer;
  spend: () => void;
};

/** `handler`, found without answering: see `FoundMock`. */
export function foundMock(handler: Handler | undefined): FoundMock | undefined {
  if (handler === undefined) return undefined;
  return {
    answer: handler.answer!,
    spend() {
      countUse(handler);
    },
  };
}

/**
 * Counts an answer `handler` gave: it's used, and spends one of a limit's
 * answers.
 */
function countUse(handler: Pick<Handler, "usedCount" | "remaining">): void {
  handler.usedCount += 1;
  if (handler.remaining !== undefined) handler.remaining -= 1;
}

/**
 * What every builder has: its answers, and limits on how often it gives
 * them.
 */
export type Builder = {
  returns(value?: unknown): void;
  /** Only where its engine gives `createBuilder` a `revertError`. */
  reverts?(spec?: unknown): void;
  fails(fault: MockNodeFault): void;
  once(): Builder;
  times(count: number): Builder;
};

/**
 * What a resolver throws that's an answer, not a resolver error: a revert, a
 * fault, a node's refusal, or that it doesn't answer this call
 * (`MockNotFoundError`). Its context's `revert()` and `fail()` throw these.
 */
const isDeliberate = (error: unknown) => isAnswer(error) || error instanceof MockNotFoundError;

/**
 * `fn` with a `calls` getter, as `mock.actions.x` and a contract's functions
 * have.
 */
export function withCalls<fn extends (...args: never[]) => unknown>(
  fn: fn,
  calls: () => unknown[],
): fn {
  return Object.defineProperty(fn, "calls", { get: calls });
}

/**
 * The mocks of one contract or action: registering them, building their
 * builders, choosing one to answer a call, and saving and restoring them.
 * How calls are decoded, matched, and encoded is the engine's own.
 */
export function createHandlers<context, extra>() {
  const handlers: Handler<context, extra>[] = [];

  /** Registers a mock pinning `pinned`, without an answer yet. */
  function register(
    pinned: unknown,
    extra: extra,
    {
      isDefault = false,
      ranked = specificity(pinned),
    }: {
      isDefault?: boolean;
      /**
       * Its specificity, when it pins more than `pinned` (a contract's `from`
       * and `value`).
       */
      ranked?: Specificity;
    } = {},
  ): Handler<context, extra> {
    checkNoRunnerMatchers(pinned);
    const handler: Handler<context, extra> = {
      ...extra,
      pinned,
      specificity: ranked,
      answer: undefined,
      usedCount: 0,
      isDefault,
      limit: undefined,
      remaining: undefined,
      removed: false,
    };
    handlers.push(handler);
    return handler;
  }

  /**
   * `handler`'s builder, for the function or action `name`. `prepare` checks
   * a static answer at registration, so one that can't be encoded fails
   * there, not inside a request, and returns what the mock answers with.
   * With `engine.revertError`, it has `.reverts(spec)`, reverting with what
   * `revertError` makes of `spec` at registration, so a spec that can't be
   * encoded throws there and changes nothing.
   */
  function createBuilder(
    handler: Handler<context, extra>,
    name: string,
    prepare: (value: unknown) => unknown,
    engine: { revertError?(spec?: unknown): MockRevertError } = {},
  ): Builder {
    /**
     * Gives `handler` the answer `make` makes. A removed mock throws first,
     * before anything is checked or prepared.
     */
    function setAnswer(make: () => Answer<context>) {
      if (handler.removed) throw removedMockError();
      handler.answer = make();
    }
    const builder: Builder = {
      returns(value: unknown = zeroResult) {
        setAnswer(() => {
          if (typeof value !== "function")
            return {
              kind: "static",
              prepared: refuseUnencodable(`.returns() for "${name}"`, () => prepare(value)),
            };
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the types check a resolver's signature, which can't be checked at runtime
          return { kind: "resolver", resolve: value as (context: context) => unknown };
        });
      },
      /**
       * Fails every matching call with `fault`. Any node's refusal passes
       * here: the names are typed only where a node can refuse with them.
       */
      fails(fault: MockNodeFault) {
        setAnswer(() => {
          checkFault(fault);
          return { kind: "fault", fault };
        });
      },
      once: () => builder.times(1),
      times(count: number) {
        if (handler.removed) throw removedMockError();
        setLimit(handler, count);
        return builder;
      },
    };
    if (engine.revertError !== undefined)
      builder.reverts = (spec?: unknown) => {
        setAnswer(() => ({ kind: "revert", error: engine.revertError!(spec) }));
      };
    return builder;
  }

  /**
   * The best of `candidates` that can answer and matches: the most specific;
   * among equally specific ones, see `bestMatch`. A handler can answer when
   * it has an answer and answers left; one that can't steps aside for the
   * rest, however specific. `differs` gives where a handler's pins first
   * differ from the call (see `firstMismatch`), or `undefined` when it
   * matches. `name` names the function or action when a predicate throws.
   *
   * `missed` says where each handler that didn't answer first differs from
   * the call, for messages: as matching found it for those that were tried,
   * and by exact values only for those that couldn't answer, so no predicate
   * runs for the message.
   */
  function findAnswering(
    candidates: readonly Handler<context, extra>[],
    differs: (handler: Handler<context, extra>, options: MatchOptions) => PinnedKey | undefined,
    name: string,
  ): {
    handler: Handler<context, extra> | undefined;
    missed: ReadonlyMap<Handler<context, extra>, PinnedKey>;
  } {
    const canAnswer = (handler: Handler<context, extra>) =>
      handler.answer !== undefined && handler.remaining !== 0;
    const { best, missed } = bestMatch(
      candidates.filter((handler) => canAnswer(handler)),
      differs,
      name,
    );
    if (best === undefined)
      for (const handler of candidates) {
        const key = canAnswer(handler) ? undefined : differs(handler, { predicates: false });
        if (key !== undefined) missed.set(handler, key);
      }
    return { handler: best, missed };
  }

  /**
   * Answers with `handler`, counting the use: its answer, encoded. A revert,
   * the mock's own or a resolver's `revert()`, answers `reverted` where it's
   * given (a send is mined reverted), and is thrown otherwise. What a
   * resolver throws becomes a resolver error named `name`, unless it's an
   * answer itself (see `isDeliberate`). A static value's setup error, from
   * encoding it at the request (a check that needs the call or the chain),
   * is the mock's, thrown as it is.
   */
  async function answerWith<answer>(
    handler: Handler<context, extra>,
    context: context,
    encode: (value: unknown) => answer,
    name: string,
    reverted?: unknown,
  ): Promise<answer> {
    countUse(handler);
    const given = handler.answer!;
    try {
      if (given.kind === "static") return encode(given.prepared);
      if (given.kind === "revert") throw given.error;
      if (given.kind === "fault") return fail(given.fault);
      return encode(await given.resolve(context));
    } catch (error) {
      if (error instanceof MockRevertError && reverted !== undefined) return encode(reverted);
      if (isDeliberate(error)) throw error;
      if (error instanceof MockSetupError && given.kind === "static") throw error;
      throw new MockResolverError(name, error);
    }
  }

  /**
   * Mocks in `list` that haven't answered a call, including ones registered
   * without an answer. Defaults are shared setup, so they're left out, and so
   * are used-up mocks, which answered every call they had.
   */
  const unused = (list: readonly Handler<context, extra>[]) =>
    list.filter(
      (handler) => !handler.isDefault && handler.usedCount === 0 && handler.remaining !== 0,
    );

  return {
    handlers,
    register,
    createBuilder,
    findAnswering,
    answerWith,
    unused,
    /** Zeroes every mock's use count; limits keep what's left. */
    clearUsage() {
      for (const handler of handlers) handler.usedCount = 0;
    },
    /** Removes every mock: their builders throw if used again. */
    removeAll() {
      for (const handler of handlers) handler.removed = true;
      handlers.length = 0;
    },
    /**
     * Saves the registered mocks and their answers and limits. `restore()`
     * removes mocks registered since; `unusedSince` reports their unused ones.
     */
    snapshot(
      describeUnused: (list: Handler<context, extra>[]) => string[],
    ): Required<PartSnapshot> {
      const saved = handlers.map(
        (handler) => [handler, handler.answer, handler.limit, handler.remaining] as const,
      );
      return {
        restore() {
          for (const handler of handlers.slice(saved.length)) handler.removed = true;
          handlers.length = saved.length;
          for (const [handler, answer, limit, remaining] of saved)
            Object.assign(handler, { answer, limit, remaining });
        },
        unusedSince: () => describeUnused(unused(handlers.slice(saved.length))),
      };
    },
  };
}
