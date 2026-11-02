/**
 * How many entries each record of requests keeps (`historyLimit`), and what
 * to do each time one drops its oldest.
 */
export type RecordLimit = { limit: number; onDrop: () => void };

/** Keeps everything: for parts made outside a mock, e.g. in unit tests. */
export const unlimited: RecordLimit = { limit: Infinity, onDrop() {} };

/** A record of requests: see `createRecordList`. */
export type RecordList<entry> = ReturnType<typeof createRecordList<entry>>;

/**
 * The most recent `limit` entries, oldest first, and how many there were in
 * all. Past the limit, adding one drops the oldest.
 */
export function createRecordList<entry>({ limit, onDrop }: RecordLimit) {
  // A ring once full: each entry overwrites the oldest, at `oldest`. (`shift()`
  // copies the whole array each time once it's long.)
  const entries: entry[] = [];
  let oldest = 0;
  let dropped = 0;
  return {
    /**
     * The entries kept, oldest first. It can be the live array, which the
     * next add changes: copy it to keep it.
     */
    get kept(): readonly entry[] {
      return oldest === 0 ? entries : [...entries.slice(oldest), ...entries.slice(0, oldest)];
    },
    /** How many were dropped, oldest first, to stay within the limit. */
    get dropped() {
      return dropped;
    },
    /** Every entry added since the last clear, kept or dropped. */
    get total() {
      return entries.length + dropped;
    },
    add(entry: entry) {
      if (entries.length < limit) {
        entries.push(entry);
        return;
      }
      entries[oldest] = entry;
      oldest = (oldest + 1) % limit;
      dropped += 1;
      onDrop();
    },
    clear() {
      entries.length = 0;
      oldest = 0;
      dropped = 0;
    },
  };
}
