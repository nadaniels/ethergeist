import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

// Dependabot rewrites a peer range that's the same as the dev range it bumps.
// A raised floor drops users on older versions, and the floor job in CI tests
// whatever floor the range names, so only this test catches it.
test("the peer ranges are viem 2.50.3+ and ox 0.14.22+", () => {
  const manifest: unknown = JSON.parse(
    readFileSync(join(import.meta.dirname, "../package.json"), "utf8"),
  );
  expect(manifest).toMatchObject({ peerDependencies: { ox: "^0.14.22", viem: "^2.50.3" } });
});
