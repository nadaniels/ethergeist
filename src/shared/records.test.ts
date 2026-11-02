import { describe, expect, test } from "vite-plus/test";

import { createRecordList, unlimited } from "./records.js";

describe("createRecordList()", () => {
  test("keeps the most recent `limit` entries, oldest first, and counts them all", () => {
    let drops = 0;
    const list = createRecordList<number>({
      limit: 2,
      onDrop: () => {
        drops += 1;
      },
    });
    for (const n of [1, 2, 3, 4]) list.add(n);

    expect(list.kept).toEqual([3, 4]);
    expect([list.dropped, list.total, drops]).toEqual([2, 4, 2]);
  });

  test("keeps them in order however many it drops", () => {
    const list = createRecordList<number>({ limit: 3, onDrop: () => {} });
    for (let n = 1; n <= 8; n += 1) list.add(n);

    expect(list.kept).toEqual([6, 7, 8]);
  });

  test("clear() forgets the entries and the count", () => {
    const list = createRecordList<number>({ limit: 1, onDrop: () => {} });
    list.add(1);
    list.add(2);
    list.clear();
    list.add(3);

    expect(list.kept).toEqual([3]);
    expect([list.dropped, list.total]).toEqual([0, 1]);
  });

  test("keeps everything without a limit", () => {
    const list = createRecordList<number>(unlimited);
    for (let n = 0; n < 1000; n += 1) list.add(n);

    expect([list.kept.length, list.dropped]).toEqual([1000, 0]);
  });
});
