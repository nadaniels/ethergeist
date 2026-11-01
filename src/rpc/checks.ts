import { type FormatContext, formatRecent } from "../history/format.js";
import type { Recorder } from "../history/recorder.js";
import type { UnhandledRequest } from "../history/types.js";
import type { MockCheckpoint, MockRestoreOptions } from "../types.js";
import type { Checkpoints } from "./checkpoints.js";
/** `assertNoUnhandled()`'s message, if any request went unanswered. */
function unhandledFailure(list: readonly UnhandledRequest[]): string[] {
  if (list.length === 0) return [];
  const lines = list.map(({ error }) => `  - ${error.shortMessage}`);
  return [`The mock couldn't answer ${list.length} request(s):\n${lines.join("\n")}`];
}

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
    throw new RangeError(
      `historyOnFailure takes a count of requests or false; got ${String(historyOnFailure)}.`,
    );

  /**
   * A failed check's error, with the most recent requests after the message.
   * Its stack starts where `check`, the public method, was called, so a test
   * runner points at the test, not into the mock.
   */
  function checkFailed(check: (...args: never[]) => unknown, message: string): Error {
    const recent =
      historyOnFailure === false
        ? undefined
        : formatRecent(recorder.history, historyOnFailure, formatContext);
    const error = new Error(recent === undefined ? message : `${message}\n\n${recent}`);
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
    if (recorder.unhandled.length > 0)
      throw checkFailed(
        checkpoint,
        `Can't checkpoint: ${recorder.unhandled.length} request(s) since the last clear ` +
          "went unanswered. Fix the setup, or call clearCalls() first if they were " +
          `intentional:\n${recorder.unhandled.map(({ error }) => `  - ${error.shortMessage}`).join("\n")}`,
      );

    const saved = checkpoints.addCheckpoint();

    function restore(options: MockRestoreOptions = {}) {
      if (!saved.valid)
        throw new Error(
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
