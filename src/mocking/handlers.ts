import {
  MockNotFoundError,
  MockResolverError,
  MockRevertError,
  MockRpcError,
  removedMockError,
} from "../shared/errors.js";
import type { PartSnapshot } from "../shared/parts.js";
import { MockFailure, fail } from "./faults.js";
import { type Specificity, bestMatch, isMatch, setLimit, specificity } from "./matching.js";
import type { MockNodeFault } from "./types.js";
import { zeroResult } from "./zeroResult.js";

/**
 * One registered mock, for a contract's function or an action: what it pins,
 * how it answers, and how often. `extra` is what its engine adds, e.g. the
 * function a contract's mock is for.
 */
export type Handler<context = never, extra = unknown> = extra & {
  /** The args or params it pins, normalized; `undefined` matches any call. */
  pinned: unknown;
  specificity: Specificity;
  /** Static values are wrapped at registration; `undefined` until `.returns()` or another answer. */
  resolver: ((context: context) => unknown) | undefined;
  /** Calls this handler answered since registration or the last `clearCalls()`. */
  usedCount: number;
  /** Registered from a contract's `defaults`: shared setup, which `assertAllUsed()` doesn't hold to any one test. */
  isDefault: boolean;
  /** Set by `.once()`/`.times(n)`: answers in all, and how many are left. Kept by `clearCalls()`. */
  limit: number | undefined;
  remaining: number | undefined;
  /** Set when a `restore()` or `reset()` removes it, so its builder can't answer again. */
  removed: boolean;
};

/** What every builder has: its answers, and limits on how often it gives them. */
export type Builder = {
  returns(value?: unknown): void;
  fails(fault: MockNodeFault): void;
  once(): Builder;
  times(count: number): Builder;
};

/**
 * What a resolver throws that's an answer, not a resolver error: a revert, a
 * fault, a node's refusal, or that it doesn't answer this call
 * (`MockNotFoundError`). Its context's `revert()` and `fail()` throw these.
 */
const isDeliberate = (error: unknown) =>
  error instanceof MockRevertError ||
  error instanceof MockFailure ||
  error instanceof MockRpcError ||
  error instanceof MockNotFoundError;

/** `fn` with a `calls` getter, as `mock.actions.x` and a contract's functions have. */
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

  function register(
    pinned: unknown,
    extra: extra,
    { isDefault = false }: { isDefault?: boolean } = {},
  ): Handler<context, extra> {
    const handler: Handler<context, extra> = {
      ...extra,
      pinned,
      specificity: specificity(pinned),
      resolver: undefined,
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
   * `handler`'s builder. `validate` checks a static answer at registration,
   * so one that can't be encoded fails there, not inside a request.
   */
  function createBuilder(
    handler: Handler<context, extra>,
    validate: (value: unknown) => void,
  ): Builder {
    const builder: Builder = {
      returns(value: unknown = zeroResult) {
        if (handler.removed) throw removedMockError();
        if (typeof value !== "function") validate(value);
        handler.resolver =
          // The types guarantee a resolver's signature; it can't be checked at runtime.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- user-supplied function
          typeof value === "function" ? (value as Handler<context>["resolver"]) : () => value;
      },
      // Named node errors are typed only where a node can refuse with them.
      fails(fault: MockNodeFault) {
        builder.returns(() => fail(fault));
      },
      once: () => builder.times(1),
      times(count: number) {
        if (handler.removed) throw removedMockError();
        setLimit(handler, count);
        return builder;
      },
    };
    return builder;
  }

  /**
   * The best of `candidates` that matches and has an answer: the most
   * specific; among equally specific ones, see `bestMatch`. One without an
   * answer yet steps aside for the rest, however specific. A handler matches
   * when it pins nothing, or when what it pins matches `actual(handler)`, what
   * the call has for it. `name` names the function or action when a
   * predicate throws.
   */
  function findAnswering(
    candidates: readonly Handler<context, extra>[],
    actual: (handler: Handler<context, extra>) => unknown,
    name: string,
  ): Handler<context, extra> | undefined {
    return bestMatch(
      candidates.filter((handler) => handler.resolver !== undefined),
      (handler, options) =>
        handler.pinned === undefined || isMatch(handler.pinned, actual(handler), options),
      name,
    );
  }

  /**
   * Answers with `handler`, counting the use: its resolver's value, encoded.
   * What it throws becomes a resolver error named `name`, unless it's an
   * answer itself, like a revert or a fault: see `isDeliberate`.
   */
  async function answerWith<answer>(
    handler: Handler<context, extra>,
    context: context,
    encode: (value: unknown) => answer,
    name: string,
  ): Promise<answer> {
    handler.usedCount += 1;
    if (handler.remaining !== undefined) handler.remaining -= 1;
    try {
      return encode(await handler.resolver!(context));
    } catch (error) {
      if (isDeliberate(error)) throw error;
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
        (handler) => [handler, handler.resolver, handler.limit, handler.remaining] as const,
      );
      return {
        restore() {
          for (const handler of handlers.slice(saved.length)) handler.removed = true;
          handlers.length = saved.length;
          for (const [handler, resolver, limit, remaining] of saved)
            Object.assign(handler, { resolver, limit, remaining });
        },
        unusedSince: () => describeUnused(unused(handlers.slice(saved.length))),
      };
    },
  };
}
