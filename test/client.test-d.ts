import { describe, test } from "vite-plus/test";

import { createMockRpc } from "../src/index.js";

describe("publicClient()", () => {
  test("takes one options object, with the transport's retry options in it", () => {
    const mock = createMockRpc();

    mock.publicClient({ pollingInterval: 10, retryCount: 0, retryDelay: 5 });
    // @ts-expect-error -- transport options aren't a second argument
    mock.publicClient({}, { retryCount: 0 });
    // @ts-expect-error -- the transport is the mock's
    mock.publicClient({ transport: mock.transport() });
    // @ts-expect-error -- the transport's other options aren't reachable
    mock.publicClient({ methods: { include: ["eth_call"] } });
  });
});
