import { createWalletClient, getContractAddress, parseAbi, parseGwei, zeroAddress } from "viem";
import { describe, expect, test } from "vite-plus/test";

import {
  MockCheckError,
  MockNotFoundError,
  MockSetupError,
  createMockRpc,
  match,
  testAddress,
  testHash,
  testLog,
} from "../src/index.js";
import { expectCause, expectThrows, lowercase, rejectionOf } from "./utils.js";

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

  test("a field left out can't be unknown", () => {
    const { mock } = setup();

    // @ts-expect-error -- not a field of a transaction
    expect(() => mock.addTransaction({ gass: unset })).not.toThrow();
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

describe("an explicit undefined in a pin is the value left out", () => {
  const bob = testAddress("bob");
  const tokenIn = testAddress("tokenIn");
  const tokenOut = testAddress("tokenOut");
  const anyValue = "Use match.any() to match any value there.";
  const pinAbi = parseAbi([
    "struct Swap { address tokenIn; address tokenOut; uint256 amountIn; address[] path; }",
    "function quote(Swap params) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function f(address owner) view returns (uint256)",
    "function f(address owner, uint256 amount) view returns (uint256)",
  ]);
  const swap = { tokenIn, tokenOut, amountIn: 5n, path: [alice] } as const;

  function withContract() {
    const { mock, client } = setup();
    const token = mock.contract({ abi: pinAbi, address: TOKEN });
    const quote = (params: typeof swap) =>
      client.readContract({ abi: pinAbi, address: TOKEN, functionName: "quote", args: [params] });
    return { mock, client, token, quote };
  }

  test("an action's key answers as left out", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: alice, blockNumber: unset }).returns(7n);
    mock.actions.getTransactionCount({ address: unset }).returns(3);

    expect(await client.getBalance({ address: alice })).toBe(7n);
    expect(await client.getTransactionCount({ address: bob })).toBe(3);
  });

  test("a key left out doesn't rank, so a later getLogs mock as specific wins", async () => {
    const { mock, client } = setup();
    mock.actions.getLogs({ toBlock: 5n, blockHash: unset }).returns([]);
    mock.actions.getLogs({ fromBlock: 5n }).returns([mock.buildLog(testLog("later"))]);

    expect(await client.getLogs({ fromBlock: 5n, toBlock: 5n })).toHaveLength(1);
  });

  test("a key left out doesn't rank, so a later send mock as specific wins", async () => {
    const { mock, client, wallet } = setup();
    mock.actions.sendTransaction({ to: TOKEN, data: unset }).returns({ gasUsed: 21_000n });
    mock.actions.sendTransaction({ to: TOKEN }).returns({ gasUsed: 20_000n });

    const hash = await wallet.sendTransaction({ to: TOKEN });
    expect((await client.getTransactionReceipt({ hash })).gasUsed).toBe(20_000n);
  });

  test("a pin left all out ranks as empty params, above one that pins nothing", async () => {
    const { mock, client } = setup();
    // The rule, not an accident: `{ address: undefined }` is `{}`, which pins
    // params, if none of their keys, so it ranks above a mock without params.
    mock.actions.getBalance({ address: unset }).returns(1n);
    mock.actions.getBalance().returns(2n);

    expect(await client.getBalance({ address: alice })).toBe(1n);
  });

  test("a miss lists the mock without the key", async () => {
    const { mock, client } = setup();
    mock.actions.getBalance({ address: alice, blockNumber: unset }).returns(7n);

    const error = expectCause(
      await rejectionOf(client.getBalance({ address: bob })),
      MockNotFoundError,
    );
    expect(error.metaMessages).toEqual([
      "Registered:",
      `  getBalance({ address: ${alice} })  ← address didn't match`,
    ]);
  });

  test("assertAllUsed() lists the mock without the key", () => {
    const { mock } = setup();
    mock.actions.getBalance({ address: alice, blockNumber: unset }).returns(7n);

    expectThrows(
      MockCheckError,
      `  - getBalance({ address: ${alice} })\n    received no calls to getBalance`,
      () => {
        mock.assertAllUsed();
      },
    );
  });

  test("a miss lists a mock the last restore removed without the key", async () => {
    const { mock, client } = setup();
    const checkpoint = mock.checkpoint();
    mock.actions.getBalance({ address: alice, blockNumber: unset }).returns(7n);
    checkpoint.restore();

    const error = expectCause(
      await rejectionOf(client.getBalance({ address: alice })),
      MockNotFoundError,
    );
    expect(error.metaMessages).toEqual([
      "Mock it with mock.actions.getBalance({ address }).returns(…).",
      "Removed by the last restore() or reset():",
      `  getBalance({ address: ${alice} })`,
      expect.stringContaining("nested describe"),
    ]);
  });

  test("a match.partial() field is left out", async () => {
    const { token, quote } = withContract();
    token.read.quote([match.partial({ tokenIn, amountIn: unset })]).returns(1n);

    expect(await quote(swap)).toBe(1n);
  });

  test("a struct's field written as an object is left out", async () => {
    const { token, quote } = withContract();
    token.read.quote([{ tokenIn, tokenOut, amountIn: unset, path: [alice] }]).returns(1n);

    expect(await quote(swap)).toBe(1n);
  });

  test("a raw method's last params are left out", async () => {
    const { mock } = setup();
    mock.method("eth_getProof", [TOKEN, unset]).returns({});

    expect(await mock.request({ method: "eth_getProof", params: [TOKEN, [], "latest"] })).toEqual(
      {},
    );
  });

  test("a raw method's last params left out don't rank, so a later mock as specific wins", async () => {
    const { mock } = setup();
    mock.method("eth_custom", [TOKEN, unset]).returns("first");
    mock.method("eth_custom", [TOKEN]).returns("later");

    // Without a second param, so a pinned `undefined` there would match and outrank `[TOKEN]`.
    expect(await mock.request({ method: "eth_custom", params: [TOKEN] })).toBe("later");
  });

  test("a raw method's param before a given one is refused", () => {
    const { mock } = setup();

    const error = expectThrows(
      MockSetupError,
      "eth_custom's param 1 is undefined, and only a raw method's last params can be left out.",
      () => mock.method("eth_custom", [unset, "latest"]),
    );
    expect(error.metaMessages).toEqual([anyValue]);
  });

  test("an element in a raw method's param is refused", () => {
    const { mock } = setup();

    const error = expectThrows(
      MockSetupError,
      "eth_getProof's param 2[1] is undefined, and a list's elements can't be left out.",
      () => mock.method("eth_getProof", [TOKEN, ["0x1", unset]]),
    );
    expect(error.metaMessages).toEqual([anyValue]);
  });

  test("a contract's arg is refused, named by its ABI name", () => {
    const { token } = withContract();

    const error = expectThrows(
      MockSetupError,
      "read.allowance's spender is undefined, and an arg can't be left out.",
      () => token.read.allowance([alice, unset]),
    );
    expect(error.metaMessages).toEqual([anyValue]);
  });

  test("a contract's arg without an ABI name is refused by position", () => {
    const { mock, token } = withContract();
    // As solc writes an unnamed input; `parseAbi` leaves its name out.
    const solcAbi = [
      {
        type: "function",
        name: "ownerOf",
        stateMutability: "view",
        inputs: [{ type: "uint256", name: "" }],
        outputs: [{ type: "address", name: "" }],
      },
    ] as const;
    const nft = mock.contract({ abi: solcAbi, address: testAddress("nft") });

    expectThrows(
      MockSetupError,
      "read.balanceOf's arg 1 is undefined, and an arg can't be left out.",
      () => token.read.balanceOf([unset]),
    );
    // The count first: a function that takes fewer args has no slot for it.
    expectThrows(MockSetupError, "read.allowance takes 2 args; got 3.", () =>
      // @ts-expect-error -- allowance takes two args
      token.read.allowance([alice, bob, unset]),
    );
    expectThrows(MockSetupError, "read.balanceOf takes 1 arg; got 2.", () =>
      // @ts-expect-error -- balanceOf takes one arg
      token.read.balanceOf([alice, unset]),
    );
    expectThrows(
      MockSetupError,
      "read.ownerOf's arg 1 is undefined, and an arg can't be left out.",
      () => nft.read.ownerOf([unset]),
    );
  });

  test("an overloaded function's arg is refused by its name in the only overload of the args' count", () => {
    const { token } = withContract();

    const error = expectThrows(
      MockSetupError,
      "read.f's amount is undefined, and an arg can't be left out.",
      () => token.read.f([alice, unset]),
    );
    expect(error.metaMessages).toEqual([anyValue]);
    // Not by the first overload's name for it.
    expectThrows(MockSetupError, "read.f's owner is undefined, and an arg can't be left out.", () =>
      token.read.f([unset, 5n]),
    );
  });

  test("an arg of overloads that take as many args is refused by position, not registered on one", () => {
    const { mock } = setup();
    const pairAbi = parseAbi([
      "function g(address owner, uint256 amount) view returns (uint256)",
      "function g(uint256 id, bool exact) view returns (uint256)",
    ]);
    const pair = mock.contract({ abi: pairAbi, address: TOKEN });

    expectThrows(MockSetupError, "read.g's arg 1 is undefined, and an arg can't be left out.", () =>
      pair.read.g([unset, 5n]),
    );
    expectThrows(MockSetupError, "read.g's arg 2 is undefined, and an arg can't be left out.", () =>
      pair.read.g([alice, unset]),
    );
  });

  test("an overloaded function's struct with a field left out chooses the overload its fields fit", async () => {
    const { mock, client } = setup();
    // The two-arg overload first: viem falls back to it.
    const routerAbi = parseAbi([
      "struct Swap { address tokenIn; address tokenOut; uint256 amountIn; address[] path; }",
      "function quote(Swap params, uint256 deadline) view returns (uint256)",
      "function quote(Swap params) view returns (uint256)",
    ]);
    const router = mock.contract({ abi: routerAbi, address: TOKEN });
    // A cast fixture with tokenOut unset and no path.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fixture cast as tests write one
    router.read.quote([{ tokenIn, tokenOut: unset, amountIn: 5n } as never]).returns(1n);

    expect(
      await client.readContract({
        abi: routerAbi,
        address: TOKEN,
        functionName: "quote",
        args: [swap],
      }),
    ).toBe(1n);
  });

  test("an undefined field in a struct written as a list is refused", () => {
    const { token } = withContract();

    const error = expectThrows(
      MockSetupError,
      "read.quote's params[1] is undefined, and a list's elements can't be left out.",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- viem's types take a struct as an object
      () => token.read.quote([[tokenIn, unset, 5n, [alice]] as never]),
    );
    expect(error.metaMessages).toEqual([anyValue]);
  });

  test("an element of a list inside an arg is refused", () => {
    const { token } = withContract();

    const error = expectThrows(
      MockSetupError,
      "read.quote's params.path[1] is undefined, and a list's elements can't be left out.",
      () => token.read.quote([match.partial({ path: [alice, unset] })]),
    );
    expect(error.metaMessages).toEqual([anyValue]);
  });

  test("an element of getLogs's address list is refused", () => {
    const { mock } = setup();

    const error = expectThrows(
      MockSetupError,
      "getLogs's address[1] is undefined, and a list's elements can't be left out.",
      () => mock.actions.getLogs({ address: [alice, unset] }),
    );
    expect(error.metaMessages).toEqual([anyValue]);
  });

  test("a topic is refused, pointing to match.any()", () => {
    const { mock } = setup();

    const error = expectThrows(
      MockSetupError,
      "getLogs's topics[1] is undefined, and a list's elements can't be left out.",
      () => mock.actions.getLogs({ topics: [testHash("Transfer"), unset] }),
    );
    expect(error.metaMessages).toEqual([anyValue]);
  });
});
