import { type FormatContext, formatRecent } from "../history/format.js";
import type { Recorder } from "../history/recorder.js";
import type { UnhandledRequest } from "../history/types.js";
import { checkCount } from "../mocking/setupChecks.js";
import {
  MockCheckError,
  MockNotFoundError,
  MockSetupError,
  nestedRestoreHint,
  removalNotes,
} from "../shared/errors.js";
import type { RecordList } from "../shared/records.js";
import type { Checkpoints } from "./checkpoints.js";

/**
 * `assertNoUnhandled()`'s message, if any request went unanswered. It ends
 * with a line when one missed what the last restore removed, which a
 * request from an earlier test still asks for.
 */
function unhandledFailure(unhandled: RecordList<UnhandledRequest>): string[] {
  if (unhandled.total === 0) return [];
  const removed = unhandled.kept.some(({ error }) =>
    (error.metaMessages ?? []).some((line) => removalNotes.includes(line)),
  )
    ? "\nSome name what the last restore() or reset() removed: a request from an earlier " +
      "test, like a receipt wait, may still be running."
    : "";
  return [
    `The mock couldn't answer ${countOf(unhandled)}:\n${unhandledLines(unhandled)}${removed}`,
  ];
}

/**
 * How many requests went unanswered, and how many of them are listed if not
 * all.
 */
function countOf(unhandled: RecordList<UnhandledRequest>): string {
  const shown =
    unhandled.dropped === 0 ? "" : ` (the last ${unhandled.kept.length} kept, past historyLimit)`;
  return `${unhandled.total} request(s)${shown}`;
}

/**
 * The unhandled requests' list: each miss's short message, with its error's
 * hints indented under it, so a test that never saw the error (the app kept
 * it) still gets what was registered. Misses that read the same, hints as
 * shown included, are listed once with `(×n)`, in the order first seen.
 */
function unhandledLines(unhandled: RecordList<UnhandledRequest>): string {
  const groups = new Map<string, { message: string; hints: string[]; count: number }>();
  for (const { error } of unhandled.kept) {
    const message = error.shortMessage;
    const lines = hintLinesOf(error.metaMessages ?? []);
    // Only a miss's own lists are cut: a resolver's hints are its cause's,
    // like viem's block of a call's fields, which a cut would leave partial.
    const hints = error instanceof MockNotFoundError ? cutLists(lines) : lines;
    const key = [message, ...hints].join("\n");
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { message, hints, count: 1 });
  }
  const lines: string[] = [];
  for (const { message, hints, count } of groups.values())
    lines.push(
      `  - ${count === 1 ? message : withCount(message, count)}`,
      ...hints.map((line) => `      ${line}`),
    );
  return lines.join("\n");
}

/**
 * A miss's hints, a line each: blank lines dropped, so the list reads as
 * one.
 */
const hintLinesOf = (metaMessages: readonly string[]) =>
  metaMessages.flatMap((message) => message.split("\n")).filter((line) => line.trim() !== "");

/**
 * How many lines of a list show: a run of lines indented under a header,
 * like "Registered:".
 */
const listShown = 3;

/** Hints with each list cut to `listShown` lines, then how many more it had. */
function cutLists(lines: readonly string[]): string[] {
  const cut: string[] = [];
  let run = 0;
  const endRun = () => {
    if (run > listShown) cut.push(`  … ${run - listShown} more`);
    run = 0;
  };
  for (const line of lines) {
    if (/^\s/u.test(line)) {
      run += 1;
      if (run <= listShown) cut.push(line);
    } else {
      endRun();
      cut.push(line);
    }
  }
  endRun();
  return cut;
}

/**
 * A grouped miss's line with its count, before its closing period if it has
 * one.
 */
const withCount = (line: string, count: number) =>
  line.endsWith(".") ? `${line.slice(0, -1)} (×${count}).` : `${line} (×${count})`;

/**
 * `assertAllUsed()`'s message, if any mock answered no call since the last
 * clear.
 */
function unusedFailure(list: readonly string[]): string[] {
  if (list.length === 0) return [];
  const lines = list.map((mock) => `  - ${mock}`);
  return [`${list.length} mock(s) answered no call:\n${lines.join("\n")}`];
}

/**
 * The mock's own checks: `assertNoUnhandled()`, `assertAllUsed()`, and
 * `checkpoint()`, whose `restore()` can run both. A failed check's error
 * ends with the most recent requests: `historyOnFailure` of them. Throws if
 * `historyOnFailure` is neither `false` nor a non-negative integer.
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
  if (historyOnFailure !== false)
    checkCount(historyOnFailure, "createMockRpc()'s historyOnFailure", 0, "Or false for none.");

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
    // Missing in some engines, and typed only by Node's types.
    const { captureStackTrace } = Error as {
      captureStackTrace?: (target: object, constructor: typeof check) => void;
    };
    captureStackTrace?.(error, check);
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

    function restore(options: RestoreOptions = {}) {
      if (saved.invalidatedBy) {
        const cause =
          saved.invalidatedBy === "reset"
            ? "reset() was called"
            : "an earlier checkpoint was restored";
        throw new MockSetupError(
          `This checkpoint is no longer valid: ${cause} after it was taken.`,
          {
            metaMessages: [nestedRestoreHint],
          },
        );
      }
      // Checked, and the error built, first: restoring clears what they read
      // and the history the error shows. Thrown last, so a failed check can't
      // leave the next test unrestored.
      const failures = [
        ...(options.assertNoUnhandled === true ? unhandledFailure(recorder.unhandled) : []),
        ...(options.assertAllUsed === true ? unusedFailure(saved.unusedSince()) : []),
      ];
      const failed = failures.length > 0 ? checkFailed(restore, failures.join("\n\n")) : undefined;

      saved.restore();

      if (failed) throw failed;
    }
    return { restore };
  }

  return { assertNoUnhandled, assertAllUsed, checkpoint };
}

/**
 * A saved baseline of the mock, from `mock.checkpoint()`, to `restore()` to.
 * In a suite, register shared setup, call `mock.checkpoint()` in
 * `beforeAll`, and call
 * `restore({ assertNoUnhandled: true, assertAllUsed: true })` in `afterEach`.
 *
 * Checkpoints nest as a stack: restoring one invalidates every checkpoint
 * taken after it, and `mock.reset()` invalidates them all. Restore at one
 * level per test. Vitest runs an outer `afterEach` after a nested describe's
 * own, so an outer per-test restore removes the nested describe's suite
 * setup and invalidates its checkpoints. Keep describes that restore an outer
 * checkpoint per test beside describes with their own suite setup, not
 * around them. A describe with its own suite setup takes a checkpoint on
 * each side of it: `outer = mock.checkpoint()`, its setup, then
 * `suite = mock.checkpoint()`, with `suite.restore()` after each test and
 * `outer.restore()` in `afterAll`.
 *
 * `restore()` puts back the mock's own state, not state a resolver closes
 * over. History is cleared, not rolled back, so restoring a checkpoint taken
 * mid-test drops that test's earlier history too. A request still in flight
 * at a restore lands in the next test's history and `unhandled`. One mock
 * shared by concurrent tests is unsafe, checkpoints or not: use one mock per
 * concurrent test, e.g. from a fixture.
 */
export type MockCheckpoint = {
  /**
   * Undoes every registration and answer made since the checkpoint, and puts
   * the chain, fees, faults and batch ids back as they were, then clears the
   * lists of requests and calls, and usage. Can be called again, e.g. after
   * each test. Throws if the checkpoint is no longer valid, or, after
   * restoring, if a check in `options` fails.
   */
  restore(options?: RestoreOptions): void;
};

/**
 * The checks `restore()` runs on the test that's ending. They're checked
 * before restoring, which clears what they read, and thrown after, so a
 * failing check can't leave the next test running on this one's mocks. A
 * check in an `afterEach` of its own can: Vitest skips the remaining
 * `afterEach` hooks once one throws.
 */
export type RestoreOptions = {
  /**
   * Whether to throw, as `assertNoUnhandled()` does, if any request since the
   * last clear went unanswered.
   */
  assertNoUnhandled?: boolean;
  /**
   * Whether to throw, as `assertAllUsed()` does, if a mock registered since
   * the checkpoint never answered a call. Mocks from before it aren't
   * checked: shared setup can register more than any one test uses.
   */
  assertAllUsed?: boolean;
};
