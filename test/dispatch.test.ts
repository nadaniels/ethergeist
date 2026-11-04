import {
  ContractFunctionExecutionError,
  ContractFunctionZeroDataError,
  InvalidAddressError,
  createPublicClient,
  erc20Abi,
} from "viem";
import { mainnet } from "viem/chains";
import { describe, expect, test } from "vite-plus/test";

import { MockNotFoundError, MockSetupError, createMockRpc, testAddress } from "../src/index.js";
import { expectCause, expectThrows, failureOf, rejectionOf } from "./utils.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const NOWHERE = "0x000000000000000000000000000000000000dEaD";
const alice = testAddress("alice");

function setup() {
  const mock = createMockRpc();
  const client = createPublicClient({ chain: mainnet, transport: mock.transport() });
  const decimals = (address: `0x${string}`) =>
    client.readContract({ abi: erc20Abi, address, functionName: "decimals" });
  const balanceOf = (address: `0x${string}`, owner: `0x${string}` = alice) =>
    client.readContract({ abi: erc20Abi, address, functionName: "balanceOf", args: [owner] });
  return { mock, client, decimals, balanceOf };
}

describe("empty()", () => {
  test("a call to an address without code returns no data, as on a real node", async () => {
    const { mock, decimals } = setup();
    mock.empty(NOWHERE);

    const error = await rejectionOf(decimals(NOWHERE));
    expect(error).toBeInstanceOf(ContractFunctionExecutionError);
    expectCause(error, ContractFunctionZeroDataError);
    expect(() => {
      mock.assertNoUnhandled();
    }).not.toThrow();
  });

  test("a raw call gets no data back, as viem reads a node's empty answer", async () => {
    const { mock, client } = setup();
    mock.empty(NOWHERE);

    expect(await client.call({ to: NOWHERE, data: "0x313ce567" })).toEqual({ data: undefined });
  });

  test("inside a multicall, only that call fails", async () => {
    const { mock, client } = setup();
    mock.empty(NOWHERE);
    mock.contract({ abi: erc20Abi, address: USDC }).read.decimals().returns(6);

    const [missing, found] = await client.multicall({
      contracts: [
        { abi: erc20Abi, address: NOWHERE, functionName: "decimals" },
        { abi: erc20Abi, address: USDC, functionName: "decimals" },
      ],
    });
    expectCause(failureOf(missing), ContractFunctionZeroDataError);
    expect(found).toEqual({ status: "success", result: 6 });
  });

  test("calls are in requests but not in the decoded call log", async () => {
    const { mock, decimals } = setup();
    mock.empty(NOWHERE);

    await decimals(NOWHERE).catch(() => {});
    expect(mock.requests).toHaveLength(1);
    expect(mock.calls).toEqual([]);
  });

  test("an address is either empty or a contract", () => {
    const { mock } = setup();
    mock.empty(NOWHERE);
    mock.contract({ abi: erc20Abi, address: USDC });

    expectThrows(MockSetupError, `${NOWHERE} is already registered as empty`, () =>
      mock.contract({ abi: erc20Abi, address: NOWHERE }),
    );
    expectThrows(MockSetupError, `A contract is already registered at ${USDC}`, () => {
      mock.empty(USDC);
    });
    expectThrows(MockSetupError, "already registered as empty", () => {
      mock.empty(NOWHERE);
    });
  });

  test("matching ignores case, and malformed addresses are rejected", async () => {
    const { mock, decimals } = setup();
    mock.empty("0x000000000000000000000000000000000000dead");

    expectCause(await rejectionOf(decimals(NOWHERE)), ContractFunctionZeroDataError);
    expect(() => {
      mock.empty("0x1234");
    }).toThrow(InvalidAddressError);
  });

  test("reset() clears empty addresses", async () => {
    const { mock, decimals } = setup();
    mock.empty(NOWHERE);

    mock.reset();
    expectCause(await rejectionOf(decimals(NOWHERE)), MockNotFoundError);
  });
});

describe("not found", () => {
  test("the error lists the ways to register an address", async () => {
    const { decimals } = setup();

    const error = expectCause(await rejectionOf(decimals(NOWHERE)), MockNotFoundError);
    expect(error.message).toContain("contract()");
    expect(error.message).toContain("empty()");
  });
});
