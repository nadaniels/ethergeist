import { NonceTooLowError, erc20Abi } from "viem";
import { describe, expect, test } from "vite-plus/test";

import {
  MockCheckError,
  MockError,
  MockNotFoundError,
  MockResolverError,
  MockSetupError,
  createMockRpc,
  testAddress,
} from "../src/index.js";
import { expectCause, findCause, rejectionOf } from "./utils.js";

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
    expect(() => {
      mock.assertNoUnhandled();
    }).toThrow(
      /^The mock couldn't answer 1 request\(s\):\n.*\n\nRequests so far:\n#1 eth_call[^]*[^\n]$/u,
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
