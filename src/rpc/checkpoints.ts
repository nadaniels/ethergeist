import type { Part } from "../shared/parts.js";

/** Every part's state as a checkpoint saved it. */
export type SavedParts = {
  /** Whether it can still be restored: see `createCheckpoints`. */
  readonly valid: boolean;
  /** Restores every part, then clears what they recorded. */
  restore(): void;
  /** Mocks registered since that never answered a call, except defaults. */
  unusedSince(): string[];
};

/** Every part's checkpoints: see `createCheckpoints`. */
export type Checkpoints = ReturnType<typeof createCheckpoints>;

/**
 * Checkpoints of every part, and what they do to each other. They nest as a
 * stack: restoring one invalidates every one taken after it, whose state is
 * gone. `reset()` restores the mock as it was created, saved here before
 * anything was registered, and invalidates every checkpoint.
 */
export function createCheckpoints(parts: readonly Part[]) {
  const stack: { valid: boolean }[] = [];

  function clearCalls() {
    for (const part of parts) part.clearCalls?.();
  }

  function save() {
    const saved = parts.map((part) => part.checkpoint?.());
    return {
      restore() {
        for (const each of saved) each?.restore();
        clearCalls();
      },
      unusedSince: () => saved.flatMap((each) => each?.unusedSince?.() ?? []),
    };
  }

  const created = save();

  return {
    clearCalls,
    /** Every part's mocks that never answered a call. */
    unusedMocks: () => parts.flatMap((part) => part.unusedMocks?.() ?? []),
    /** Saves every part, as the newest checkpoint on the stack. */
    take(): SavedParts {
      const saved = save();
      const entry = { valid: true };
      stack.push(entry);
      return {
        get valid() {
          return entry.valid;
        },
        restore() {
          for (const later of stack.splice(stack.indexOf(entry) + 1)) later.valid = false;
          saved.restore();
        },
        unusedSince: saved.unusedSince,
      };
    },
    /** Back to the mock as it was created; every checkpoint becomes invalid. */
    reset() {
      for (const entry of stack.splice(0)) entry.valid = false;
      created.restore();
    },
  };
}
