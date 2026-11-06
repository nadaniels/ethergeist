import { NonceTooLowError, createWalletClient, erc20Abi, parseAbi } from "viem";
import { describe, expect, test } from "vite-plus/test";

import {
  MockCheckError,
  MockError,
  MockNotFoundError,
  MockResolverError,
  MockSetupError,
  createMockRpc,
  testAddress,
  testHash,
  testLog,
} from "../src/index.js";
import { expectCause, expectThrows, findCause, rejectionOf } from "./utils.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const alice = testAddress("alice");

function setup() {
  const mock = createMockRpc();
  const client = mock.publicClient();
  const usdc = mock.contract({ abi: erc20Abi, address: USDC });
  const balanceOf = () =>
    client.readContract({ abi: erc20Abi, address: USDC, functionName: "balanceOf", args: [alice] });
  return { mock, client, usdc, balanceOf };
}

describe("the mock's errors", () => {
  test("a bad value at setup is a MockSetupError", () => {
    const { mock } = setup();

    const register = () => {
      // @ts-expect-error -- a number isn't a block
      mock.actions.getBlock().returns(5);
    };

    expect(register).toThrow(MockSetupError);
    expect(register).toThrow(MockError);
  });

  test("a resolver's bad value is a MockResolverError, caused by the setup error, not retried", async () => {
    const { mock, client } = setup();
    // @ts-expect-error -- a number isn't a block
    mock.actions.getBlock().returns(() => 5);

    const error = expectCause(await rejectionOf(client.getBlock()), MockResolverError);

    expect(error.cause).toBeInstanceOf(MockSetupError);
    expect(mock.history).toHaveLength(1);
    expect(mock.unhandled).toHaveLength(1);
  });

  describe("a static answer that only fails at the request", () => {
    const hash = testHash("late");

    test("a reverted receipt for a hash mined with logs after .returns()", async () => {
      const { mock, client } = setup();
      mock.actions.getTransactionReceipt({ hash }).returns({ status: "reverted" });
      mock.addTransaction({ hash, logs: [testLog("noise")] });

      const error = await rejectionOf(client.getTransactionReceipt({ hash }));

      expect(findCause(error, MockResolverError)).toBeUndefined();
      expect(expectCause(error, MockSetupError).shortMessage).toBe(
        "A reverted transaction has no logs.",
      );
      expect(mock.unhandled.map((request) => request.error)).toEqual([expect.any(MockSetupError)]);
      expect(mock.formatHistory()).toContain("✗ A reverted transaction has no logs.");
      expectThrows(MockCheckError, /A reverted transaction has no logs\./u, () => {
        mock.assertNoUnhandled();
      });
    });

    test("a transaction's type over a sent transaction with fields it doesn't have", async () => {
      const { mock, client } = setup();
      mock.actions.getTransaction().returns({ type: "legacy" });
      const wallet = createWalletClient({
        account: alice,
        chain: mock.chain,
        transport: mock.transport({ retryCount: 0 }),
      });
      const sent = await wallet.sendTransaction({ to: testAddress("bob"), maxFeePerGas: 1n });

      const error = await rejectionOf(client.getTransaction({ hash: sent }));

      expect(findCause(error, MockResolverError)).toBeUndefined();
      expect(expectCause(error, MockSetupError).shortMessage).toMatch(
        /^A legacy transaction has no max/u,
      );
    });

    test("a resolver's value refused the same way is still a resolver error", async () => {
      const { mock, client } = setup();
      mock.actions.getTransactionReceipt({ hash }).returns(() => ({ status: "reverted" }));
      mock.addTransaction({ hash, logs: [testLog("noise")] });

      const error = expectCause(
        await rejectionOf(client.getTransactionReceipt({ hash })),
        MockResolverError,
      );

      expect(error.cause).toBeInstanceOf(MockSetupError);
      expect(mock.unhandled.map((request) => request.error)).toEqual([error]);
    });

    test("a static value changed after .returns() so it can't encode is a resolver error, not the mock's bug", async () => {
      const mock = createMockRpc();
      const client = mock.publicClient({ retryCount: 0 });
      const abi = parseAbi(["function reserves() view returns ((uint256 a, uint256 b))"]);
      const pool = mock.contract({ abi, address: USDC });
      const reserves = { a: 1n, b: 2n };
      pool.read.reserves().returns(reserves);
      Object.assign(reserves, { a: "soon" });

      const error = expectCause(
        await rejectionOf(client.readContract({ abi, address: USDC, functionName: "reserves" })),
        MockResolverError,
      );

      expect(error.cause).toBeInstanceOf(SyntaxError);
      expect(mock.unhandled.map((request) => request.error)).toEqual([error]);
    });
  });

  test("using a removed mock is a MockSetupError", () => {
    const { mock } = setup();
    const builder = mock.actions.getBlock();
    mock.reset();

    expect(() => {
      builder.returns({});
    }).toThrow(MockSetupError);
  });

  test("a failed check is a MockCheckError, with the recent requests under it", async () => {
    const { mock, balanceOf } = setup();
    await rejectionOf(balanceOf());

    expect(() => {
      mock.assertNoUnhandled();
    }).toThrow(MockCheckError);
    expectThrows(
      MockCheckError,
      /^The mock couldn't answer 1 request\(s\):\n.*\n {6}No mocks registered for "balanceOf"\.\n\nRequests so far:\n#1 eth_call[^]*[^\n]$/u,
      () => {
        mock.assertNoUnhandled();
      },
    );
  });
});

describe("through viem", () => {
  test("a miss's hints show in viem's error, once", async () => {
    const { usdc, balanceOf } = setup();
    usdc.read.balanceOf([testAddress("bob")]).returns(1n);

    const error = await rejectionOf(balanceOf());
    const message = error instanceof Error ? error.message : "";

    expect(message.match(/Registered:/gu)).toHaveLength(1);
    expect(message).toContain("← account didn't match");
    expect(findCause(error, MockNotFoundError)?.details).toBe("");
  });

  test("a mock error thrown inside a resolver keeps its hints", async () => {
    const { mock, usdc, balanceOf } = setup();
    // Registering USDC again throws a setup error, with how to fix it.
    usdc.read.balanceOf().returns(() => {
      mock.contract({ abi: erc20Abi, address: USDC });
      return 1n;
    });

    const error = await rejectionOf(balanceOf());
    const message = error instanceof Error ? error.message : "";

    expect(findCause(error, MockResolverError)?.cause).toBeInstanceOf(MockSetupError);
    expect(message).toContain("Register it once with a combined ABI");
  });

  test("a resolver's error text isn't mistaken for a node's", async () => {
    // viem matches an error's `details` against node errors ("nonce too low").
    const { usdc, balanceOf } = setup();
    usdc.read.balanceOf().returns(() => {
      throw new Error("nonce too low");
    });

    const error = await rejectionOf(balanceOf());

    expect(findCause(error, NonceTooLowError)).toBeUndefined();
    expect(findCause(error, MockResolverError)?.shortMessage).toBe(
      'Mock resolver for "balanceOf" threw: nonce too low',
    );
  });

  test("viem keeps its own docs link", async () => {
    const { balanceOf } = setup();

    const error = await rejectionOf(balanceOf());

    expect(error instanceof Error ? error.message : "").toContain(
      "Docs: https://viem.sh/docs/contract/readContract",
    );
  });
});
