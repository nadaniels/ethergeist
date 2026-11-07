import { MockSetupError } from "../shared/errors.js";
import type { RecordLimit } from "../shared/records.js";

/** How many entries each list keeps when `historyLimit` isn't given. */
const defaultHistoryLimit = 1000;

/**
 * Each list's limit, from `createMockRpc()`'s `historyLimit`. Left out, it's
 * `defaultHistoryLimit`, and the first entry dropped warns once, so a test
 * that counted on every request hears about it. Throws on anything but a
 * positive whole number or `Infinity`.
 */
export function createRecordLimit(
  historyLimit: number | undefined,
  warn: (message: string) => void = console.warn,
): RecordLimit {
  if (historyLimit === 0)
    throw new MockSetupError(
      "historyLimit keeps at least 1 entry per record; use 1 for the least memory, " +
        "or Infinity to keep them all.",
    );
  if (historyLimit !== undefined && historyLimit !== Infinity && !isPositiveInteger(historyLimit))
    throw new MockSetupError(
      `historyLimit takes a positive whole number or Infinity; got ${String(historyLimit)}.`,
    );
  if (historyLimit !== undefined) return { limit: historyLimit, onDrop() {} };

  let warned = false;
  return {
    limit: defaultHistoryLimit,
    onDrop() {
      if (warned) return;
      warned = true;
      warn(
        "ethergeist: dropped the oldest entry of a record. Each record (history, " +
          "calls, unhandled, and each action's and contract function's .calls) " +
          `keeps its last ${defaultHistoryLimit.toLocaleString("en-US")} by default. Pass ` +
          "createMockRpc({ historyLimit }) to choose: how many to keep, or Infinity to keep " +
          "them all.",
      );
    },
  };
}

const isPositiveInteger = (value: number) => Number.isInteger(value) && value >= 1;
