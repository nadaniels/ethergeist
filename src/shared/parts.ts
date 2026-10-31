/**
 * One piece of the mock's state: contracts, actions, logs, the chain's own
 * state, faults. `checkpoint()`, `restore()`, `reset()`, `clearCalls()` and
 * `assertAllUsed()` go through every part the same way, so a new piece of
 * state is looked after by being a part.
 */
export type Part = {
  /** Saves what it holds now. Parts that only record (history) have nothing to save. */
  checkpoint?(): PartCheckpoint;
  /** Forgets what it recorded (calls, usage); what's registered stays. */
  clearCalls?(): void;
  /** Mocks that never answered a call, formatted for messages; defaults aren't. */
  unusedMocks?(): string[];
};

/** What a part saved: `restore()` puts it back. */
export type PartCheckpoint = {
  restore(): void;
  /** Mocks registered since the checkpoint that haven't answered a call, except defaults. */
  unusedSince?(): string[];
};
