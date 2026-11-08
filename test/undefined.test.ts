import { createWalletClient, getContractAddress, parseAbi, parseGwei, zeroAddress } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { MockNotFoundError, createMockRpc, testAddress, testHash } from "../src/index.js";
import { expectCause, lowercase, rejectionOf } from "./utils.js";

const alice = testAddress("alice");
const TOKEN = testAddress("token");
const abi = parseAbi(["function f()", "function g() view returns (uint256)"]);

/**
 * An explicit `undefined`. Consumers' types allow one in any optional field
 * (`exactOptionalPropertyTypes` is off by default); this repo's refuse it.
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- stands in for a consumer's explicit undefined
const unset = undefined as never;

function setup() {
  const mock = createMockRpc({ blockNumber: 10n });
  const client = mock.publicClient({ retryCount: 0 });
  const wallet = createWalletClient({
    account: alice,
    chain: mock.chain,
    transport: mock.transport({ retryCount: 0 }),
  });
  return { mock, client, wallet };
}

describe("an explicit undefined in a mock's fields is the field left out", () => {
  test("a transaction mock over the chain keeps the record's from and block", async () => {
    const { mock, client } = setup();
    const { hash } = mock.addTransaction({ from: alice, blockNumber: 5n });
    mock.actions.getTransaction({ hash }).returns({ from: unset, blockNumber: unset });

    expect(await client.getTransaction({ hash })).toMatchObject({
      from: lowercase(alice),
      blockNumber: 5n,
    });
  });

  test("a receipt mock over the chain keeps the record's fields", async () => {
    const { mock, client } = setup();
    const { hash } = mock.addTransaction({ from: alice, blockNumber: 5n, gasUsed: 30_000n });
    mock.actions
      .getTransactionReceipt({ hash })
      .returns({ from: unset, blockNumber: unset, gasUsed: unset });

    expect(await client.getTransactionReceipt({ hash })).toMatchObject({
      from: lowercase(alice),
      blockNumber: 5n,
      gasUsed: 30_000n,
    });
  });

  test("a resolver's answer is stripped too", async () => {
    const { mock, client } = setup();
    const { hash } = mock.addTransaction({ from: alice, blockNumber: 5n, gasUsed: 30_000n });
    mock.actions.getTransactionReceipt({ hash }).returns(() => ({ gasUsed: unset }));

    expect((await client.getTransactionReceipt({ hash })).gasUsed).toBe(30_000n);
  });

  test("a block mock keeps the generated block's fields", async () => {
    const { mock, client } = setup();
    mock.actions.getBlock().returns({ number: unset, baseFeePerGas: unset, parentHash: unset });

    const block = await client.getBlock();
    expect(block).toMatchObject({ number: 10n, baseFeePerGas: parseGwei("10") });
    expect(block.parentHash).toBe((await client.getBlock({ blockNumber: 9n })).hash);
  });

  test("a fee history mock keeps the generated oldest block", async () => {
    const { mock, client } = setup();
    mock.actions.getFeeHistory().returns({ oldestBlock: unset });

    expect((await client.getFeeHistory({ blockCount: 2, rewardPercentiles: [] })).oldestBlock).toBe(
      9n,
    );
  });

  test("a legacy transaction may say maxFeePerGas: undefined, as viem types it", async () => {
    const { mock, client } = setup();
    const hash = testHash("legacy");
    mock.actions.getTransaction({ hash }).returns({ type: "legacy", hash, maxFeePerGas: unset });

    expect((await client.getTransaction({ hash })).type).toBe("legacy");
    expect(mock.buildTransaction({ type: "legacy", maxFeePerGas: unset }).type).toBe("legacy");
  });

  test("the builders keep their defaults", () => {
    const { mock } = setup();

    expect(
      mock.buildReceipt({ blockNumber: unset, from: unset, transactionHash: unset }),
    ).toMatchObject({ blockNumber: 10n, from: zeroAddress });
    expect(mock.buildTransaction({ blockNumber: unset }).blockNumber).toBe(10n);
  });

  test("a write's outcome keeps the receipt's status and fees", async () => {
    const { mock, client, wallet } = setup();
    const token = mock.contract({
      abi,
      address: TOKEN,
      defaults: { write: { f: { status: unset } } },
    });

    const viaDefault = await wallet.writeContract({ abi, address: TOKEN, functionName: "f" });
    token.write.f().returns({ status: unset, effectiveGasPrice: unset });
    const viaMock = await wallet.writeContract({ abi, address: TOKEN, functionName: "f" });

    for (const hash of [viaDefault, viaMock])
      expect(await client.getTransactionReceipt({ hash })).toMatchObject({
        status: "success",
        effectiveGasPrice: parseGwei("11"),
      });
  });

  test("a deploy's outcome keeps the computed contract address", async () => {
    const { mock, client, wallet } = setup();
    mock.actions.sendTransaction({ to: null }).returns({ contractAddress: unset });

    const hash = await wallet.deployContract({ abi: [], bytecode: "0x6000" });
    expect((await client.getTransactionReceipt({ hash })).contractAddress).toBe(
      lowercase(getContractAddress({ from: alice, nonce: 0n })),
    );
  });

  test("a defaults entry left out registers no mock, and isn't refused", async () => {
    const { mock, client } = setup();
    mock.contract({
      abi,
      address: TOKEN,
      defaults: { read: { g: unset }, estimateGas: { f: unset } },
    });

    const read = client.readContract({ abi, address: TOKEN, functionName: "g" });
    expectCause(await rejectionOf(read), MockNotFoundError);
  });
});
