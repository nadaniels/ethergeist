/**
 * A saved baseline: what was registered when `mock.checkpoint()` was called.
 *
 * Notes for the docs (to expand when writing them):
 * - Typical use: register shared contracts and mocks at module scope, call
 *   `checkpoint()` in `beforeAll`, and in one `afterEach` call
 *   `assertNoUnhandled()` first, then `restore()`. `restore()` clears
 *   `unhandled`, so the assertion has to run before it, in the same hook;
 *   separate hooks would depend on vitest's (reversed) hook order.
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
   * mock's own state (block number, batch ids, faults' counts) to what it
   * was, then clears history. Can be called repeatedly, e.g. after each test.
   * Throws if the checkpoint is no longer valid.
   */
  restore(): void;
};

/** For a builder whose mock a `restore()` or `reset()` removed. */
export function removedMockError(): Error {
  return new Error(
    "This mock was removed by restore() or reset(); register it again before answering it.",
  );
}
