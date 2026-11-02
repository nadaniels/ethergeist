import { type FormatContext, formatRecent } from "../history/format.js";
import type { Recorder } from "../history/recorder.js";
import type { UnhandledRequest } from "../history/types.js";
import { MockCheckError, MockSetupError } from "../shared/errors.js";
import type { RecordList } from "../shared/records.js";
import type { Checkpoints } from "./checkpoints.js";
/** `assertNoUnhandled()`'s message, if any request went unanswered. */
function unhandledFailure(unhandled: RecordList<UnhandledRequest>): string[] {
  if (unhandled.total === 0) return [];
  return [`The mock couldn't answer ${countOf(unhandled)}:\n${unhandledLines(unhandled)}`];
}

/** How many requests went unanswered, and how many of them are listed if not all. */
function countOf(unhandled: RecordList<UnhandledRequest>): string {
  const shown =
    unhandled.dropped === 0 ? "" : ` (the last ${unhandled.kept.length} kept, past historyLimit)`;
  return `${unhandled.total} request(s)${shown}`;
}

const unhandledLines = (unhandled: RecordList<UnhandledRequest>) =>
  unhandled.kept.map(({ error }) => `  - ${error.shortMessage}`).join("\n");

/** `assertAllUsed()`'s message, if any mock never answered. */
function unusedFailure(list: readonly string[]): string[] {
  if (list.length === 0) return [];
  const lines = list.map((mock) => `  - ${mock}`);
  return [`${list.length} mock(s) never answered a call:\n${lines.join("\n")}`];
}

/**
 * The mock's own checks: `assertNoUnhandled()`, `assertAllUsed()`, and
 * `checkpoint()`, whose `restore()` can run both. A failed check's error ends
 * with the most recent requests (`historyOnFailure` of them).
 */
export function createChecks({
  recorder,
  checkpoints,
  formatContext,
  historyOnFailure: given,
}: {
  recorder: Recorder;
  checkpoints: Checkpoints;
  formatContext: FormatContext;
  historyOnFailure: number | false | undefined;
}) {
  const historyOnFailure = given ?? 10;
  if (historyOnFailure !== false && (!Number.isInteger(historyOnFailure) || historyOnFailure < 0))
    throw new MockSetupError(
      `historyOnFailure takes a count of requests or false; got ${String(historyOnFailure)}.`,
    );

  /**
   * A failed check's error, with the most recent requests after the message.
   * Its stack starts where `check`, the public method, was called, so a test
   * runner points at the test, not into the mock.
   */
  function checkFailed(check: (...args: never[]) => unknown, message: string): Error {
    const recent =
      historyOnFailure === false || historyOnFailure === 0
        ? undefined
        : formatRecent(recorder.view, historyOnFailure, formatContext);
    const error = new MockCheckError(message, {
      metaMessages: recent?.split("\n"),
    });
    // Not every engine has it (Node's types say it's always there).
    if ("captureStackTrace" in Error) Error.captureStackTrace(error, check);
    return error;
  }

  function assertNoUnhandled() {
    const [failure] = unhandledFailure(recorder.unhandled);
    if (failure !== undefined) throw checkFailed(assertNoUnhandled, failure);
  }

  function assertAllUsed() {
    const [failure] = unusedFailure(checkpoints.unusedMocks());
    if (failure !== undefined) throw checkFailed(assertAllUsed, failure);
  }

  function checkpoint(): MockCheckpoint {
    if (recorder.unhandled.total > 0)
      throw checkFailed(
        checkpoint,
        `Can't checkpoint: ${countOf(recorder.unhandled)} since the last clear went ` +
          "unanswered. Fix the setup, or call clearCalls() first if they were " +
          `intentional:\n${unhandledLines(recorder.unhandled)}`,
      );

    const saved = checkpoints.addCheckpoint();

    function restore(options: MockRestoreOptions = {}) {
      if (!saved.valid)
        throw new MockSetupError(
          "This checkpoint is no longer valid: an earlier checkpoint was restored, " +
            "or reset() was called, after it was taken.",
        );
      // Checked first, because restoring clears what they look at; thrown
      // last, so a failed check can't leave the next test unrestored.
      const failures = [
        ...(options.assertNoUnhandled === true ? unhandledFailure(recorder.unhandled) : []),
        ...(options.assertAllUsed === true ? unusedFailure(saved.unusedSince()) : []),
      ];
      // Built now: restoring clears the history it shows.
      const failed = failures.length > 0 ? checkFailed(restore, failures.join("\n\n")) : undefined;

      saved.restore();

      if (failed) throw failed;
    }
    return { restore };
  }

  return { assertNoUnhandled, assertAllUsed, checkpoint };
}

/**
 * A saved baseline: what was registered when `mock.checkpoint()` was called.
 *
 * Notes for the docs (to expand when writing them):
 * - Typical use: register shared contracts and mocks at module scope, call
 *   `checkpoint()` in `beforeAll`, and in `afterEach` call
 *   `restore({ assertNoUnhandled: true, assertAllUsed: true })`. Passing the
 *   checks to `restore()` matters: it checks, restores, then throws, so a
 *   failing check can't skip the restore. Vitest skips the remaining
 *   `afterEach` hooks when one throws, so a separate assertion hook that
 *   fails would leave every later test running on this test's mocks.
 * - `assertAllUsed` in `restore()` checks only mocks registered since the
 *   checkpoint: shared setup can register more than any one test uses.
 * - Nesting: checkpoints form a stack. Restoring one invalidates every
 *   checkpoint taken after it, and `reset()` invalidates all of them.
 * - Restore at one level only per test. An `afterEach` applies to nested
 *   describes too, and vitest runs them innermost first, so an outer
 *   per-test restore runs after a nested suite's restore, wipes that suite's
 *   setup, and invalidates its checkpoints (its next `restore()` throws).
 *   Keep describes that restore an outer checkpoint per test as siblings of
 *   describes with their own suite setup, not parents of them.
 * - A describe with its own suite setup needs a checkpoint on each side of
 *   it, so later describes don't inherit it: `outer = checkpoint()`, setup,
 *   `suite = checkpoint()`; then `suite.restore()` per test and
 *   `outer.restore()` in `afterAll`.
 * - `checkpoint()` throws if requests since the last clear went unanswered.
 *   A test that deliberately triggers a missing mock, in a file that doesn't
 *   restore per test, needs a `clearCalls()` before a later checkpoint.
 * - Only registrations and the mock's own state are restored, not state a
 *   resolver closes over (counters, prices, external fixtures).
 * - History is cleared, not rolled back: `calls`, `requests`, `unhandled`,
 *   per-function and per-action `.calls`, and usage counts. A checkpoint
 *   taken mid-test therefore also drops that test's earlier history.
 * - Concurrency: one mock shared by concurrent tests is unsafe with or
 *   without checkpoints, since one test's restore (or overrides, `mine()`,
 *   history) affects the others. Use one mock per concurrent test, e.g. a
 *   setup factory or vitest fixtures; checkpoints are for serial suites.
 * - Requests still in flight at restore time (fire-and-forget calls from
 *   the previous test) land in the next test's history and `unhandled`.
 */
export type MockCheckpoint = {
  /**
   * Undoes every registration made since the checkpoint and returns the
   * mock's own state (block number, fees, batch ids, faults' counts) to what it
   * was, then clears history. Can be called repeatedly, e.g. after each test.
   * Throws if the checkpoint is no longer valid, or, after restoring, if a
   * check in `options` fails.
   */
  restore(options?: MockRestoreOptions): void;
};

/**
 * Checks `restore()` runs on the test that's ending. They're checked before
 * restoring (which clears what they look at) and thrown after, so a failing
 * check can't leave the next test running on this one's mocks.
 */
export type MockRestoreOptions = {
  /** Throw, like `assertNoUnhandled()`, if any request went unanswered. */
  assertNoUnhandled?: boolean;
  /**
   * Throw, like `assertAllUsed()`, if a mock registered since the checkpoint
   * never answered a call. Baseline mocks aren't checked: shared setup can
   * register more than any one test uses.
   */
  assertAllUsed?: boolean;
};
