/**
 * What the smoke test runs from the installed package, in Node and bundled
 * for a browser: a mocked contract read, read through `publicClient()`. It
 * imports `../src/index.js`, which the smoke test replaces with the
 * package's name, and it's run as JavaScript, so it has no type annotations.
 */
import { parseAbi } from "viem";

import { createMockRpc, testAddress } from "../src/index.js";

const abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const address = testAddress("token");
const holder = testAddress("holder");

const mock = createMockRpc();
mock.contract({ abi, address }).read.balanceOf([holder]).returns(5n);
const balance = await mock
  .publicClient()
  .readContract({ abi, address, functionName: "balanceOf", args: [holder] });
if (balance !== 5n) throw new Error(`Read a balance of ${balance}, not 5.`);
mock.assertAllUsed();
