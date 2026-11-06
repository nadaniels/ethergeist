import { readFileSync } from "node:fs";
import { type Server, createServer } from "node:http";

import {
  type Abi,
  type Hex,
  type Transport,
  createPublicClient,
  encodeErrorResult,
  erc20Abi,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { mainnet } from "viem/chains";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { nodeRevertMessage } from "../src/chain/nodeErrors.js";
import {
  type MockContract,
  type MockFault,
  type MockTransaction,
  type RevertSpec,
  createMockRpc,
  testAddress,
} from "../src/index.js";
import { rejectionOf } from "./utils.js";

// The mock claims the app gets the error a real node would cause. This checks
// that against viem's `http` transport and a test server answering the way
// nodes do. Every revert body here was captured on 2026-10-29 with deployless
// eth_calls whose code reverts with exactly the data shown.
//
// The mock imitates reth exactly (Ethereum's publicnode and mainnet.base.org
// both run it). Other nodes word their messages differently, so against them
// only what error handling should rely on is compared: classes, codes, and
// the decoded revert. Later captures (named node errors, gas, fill) come from
// `scripts/capture-node-responses.ts`, one fixture folder per node.

const TOKEN = testAddress("token");
const abi = [
  ...erc20Abi,
  ...parseAbi([
    "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
    "error Custom(uint256)",
  ]),
] as const satisfies Abi;
const builtins = parseAbi(["error Error(string)", "error Panic(uint256)"]);
const alice = testAddress("alice");

/** How the test server answers the next requests. */
type Answer = {
  status: number;
  body: string;
  headers?: Record<string, string>;
  /** Wait before answering, past a transport's `timeout`. */
  delay?: number;
};
let answer: Answer;
let attempts = 0;
let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      attempts += 1;
      const parsed: unknown = JSON.parse(body);
      const id = typeof parsed === "object" && parsed !== null && "id" in parsed ? parsed.id : null;
      const { status, headers = {}, delay = 0 } = answer;
      setTimeout(() => {
        response.writeHead(status, headers);
        response.end(answer.body.replace('"id":1', `"id":${JSON.stringify(id)}`));
      }, delay);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  url = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server.close();
});

/** A JSON-RPC error response, as the nodes sent it. */
function rpcError(error: { code: number; message: string; data?: Hex }): Answer {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, error }),
  };
}

/** An HTTP error page, as providers send them: plain text, not JSON-RPC. */
function httpError(status: number, body: string, headers: Record<string, string> = {}): Answer {
  return { status, headers: { "content-type": "text/plain", ...headers }, body };
}

/**
 * Each error in the cause chain, as the fields error handling looks at.
 * `portable` leaves out what varies by node without changing what it means:
 * the human-readable text, and whether empty revert data is sent as "0x".
 * `details` adds the node's own message, where viem keeps it for RPC errors.
 */
function layers(error: unknown, { portable = false, details = false } = {}) {
  const result: Record<string, unknown>[] = [];
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    const fields = e as Error & {
      code?: unknown;
      status?: unknown;
      shortMessage?: unknown;
      details?: unknown;
      data?: unknown;
    };
    let { data } = fields;
    if (typeof data === "object" && data !== null && "errorName" in data)
      data = { errorName: data.errorName, args: "args" in data ? data.args : undefined };
    if (portable && data === "0x") data = undefined;
    result.push({
      name: e.name,
      code: fields.code,
      status: fields.status,
      ...(portable ? {} : { shortMessage: fields.shortMessage }),
      ...(details ? { details: fields.details } : {}),
      data,
    });
  }
  return result;
}

const read = { abi, address: TOKEN, functionName: "balanceOf", args: [alice] } as const;

/** The class names in an error's cause chain. */
function names(error: unknown) {
  return layers(error).map((layer) => layer.name);
}

/** The same read through viem's `http` transport and through the mock, failing the same way. */
async function compare(
  arrange: (token: MockContract<typeof abi>) => void,
  options: { retryCount?: number; timeout?: number; portable?: boolean } = {},
) {
  const { retryCount = 0, timeout, portable = false } = options;
  const mock = createMockRpc();
  arrange(mock.contract({ abi, address: TOKEN }));
  const transportOptions = {
    retryCount,
    retryDelay: 0,
    ...(timeout === undefined ? {} : { timeout }),
  };
  const mocked = createPublicClient({
    chain: mainnet,
    transport: mock.transport(transportOptions),
  });
  const real = createPublicClient({ chain: mainnet, transport: http(url, transportOptions) });

  attempts = 0;
  const realError = await rejectionOf(real.readContract(read));
  const mockError = await rejectionOf(mocked.readContract(read));
  expect(layers(mockError, { portable })).toEqual(layers(realError, { portable }));
  expect(mock.history).toHaveLength(attempts);
}

describe("reverts match reth's exactly", () => {
  const reverts: { name: string; spec: RevertSpec<typeof abi> | undefined; node: Answer }[] = [
    {
      name: "a reason string",
      spec: "paused",
      node: rpcError({
        code: 3,
        message: "execution reverted: paused",
        data: encodeErrorResult({ abi: builtins, errorName: "Error", args: ["paused"] }),
      }),
    },
    {
      name: "an empty reason string",
      spec: "",
      node: rpcError({
        code: 3,
        message: "execution reverted: <empty>",
        data: encodeErrorResult({ abi: builtins, errorName: "Error", args: [""] }),
      }),
    },
    {
      name: "a custom error with args",
      spec: { errorName: "ERC20InsufficientBalance", args: [alice, 1n, 2n] },
      node: rpcError({
        code: 3,
        message: "execution reverted",
        data: encodeErrorResult({
          abi,
          errorName: "ERC20InsufficientBalance",
          args: [alice, 1n, 2n],
        }),
      }),
    },
    {
      name: "a panic",
      spec: { panic: 0x11 },
      node: rpcError({
        code: 3,
        message: "execution reverted: panic: arithmetic underflow or overflow (0x11)",
        data: encodeErrorResult({ abi: builtins, errorName: "Panic", args: [0x11n] }),
      }),
    },
    {
      name: "an unknown panic code",
      spec: { panic: 0x100 },
      node: rpcError({
        code: 3,
        message: "execution reverted: panic: unknown code (0x100)",
        data: encodeErrorResult({ abi: builtins, errorName: "Panic", args: [0x100n] }),
      }),
    },
    {
      name: "raw data",
      spec: { data: "0xdeadbeef" },
      node: rpcError({ code: 3, message: "execution reverted", data: "0xdeadbeef" }),
    },
    {
      // Nodes leave `data` out for an empty revert.
      name: "no data",
      spec: undefined,
      node: rpcError({ code: 3, message: "execution reverted" }),
    },
  ];

  test.each(reverts)("$name", async ({ spec, node }) => {
    answer = node;
    await compare((token) => {
      token.read.balanceOf().reverts(spec);
    });
  });

  test("through simulateContract", async () => {
    answer = reverts[0]!.node;
    const mock = createMockRpc();
    mock.contract({ abi, address: TOKEN }).simulate.approve().reverts("paused");
    const simulate = { abi, address: TOKEN, functionName: "approve", args: [alice, 1n] } as const;
    const real = createPublicClient({ chain: mainnet, transport: http(url, { retryCount: 0 }) });

    expect(layers(await rejectionOf(mock.publicClient().simulateContract(simulate)))).toEqual(
      layers(await rejectionOf(real.simulateContract(simulate))),
    );
  });
});

describe("reverts match other nodes' on classes, codes, and decoded data", () => {
  const data = {
    reason: encodeErrorResult({ abi: builtins, errorName: "Error", args: ["paused"] }),
    emptyReason: encodeErrorResult({ abi: builtins, errorName: "Error", args: [""] }),
    custom: encodeErrorResult({ abi, errorName: "Custom", args: [7n] }),
    panic: encodeErrorResult({ abi: builtins, errorName: "Panic", args: [0x11n] }),
  };
  const kinds = ["reason", "emptyReason", "custom", "panic"] as const;
  const specs: Record<keyof typeof data | "empty", RevertSpec<typeof abi> | undefined> = {
    reason: "paused",
    emptyReason: "",
    custom: { errorName: "Custom", args: [7n] },
    panic: { panic: 0x11 },
    empty: undefined,
  };
  /** Each node family's messages for the cases above, and its empty revert. */
  const nodes: {
    name: string;
    messages: Record<keyof typeof data, string>;
    empty: { code: number; message: string; data?: Hex };
  }[] = [
    {
      name: "geth and its forks (Geth 1.16/1.17, Arbitrum Nitro, Avalanche, Linea)",
      messages: {
        reason: "execution reverted: paused",
        emptyReason: "execution reverted: ",
        custom: "execution reverted",
        panic: "execution reverted: arithmetic underflow or overflow",
      },
      empty: { code: 3, message: "execution reverted", data: "0x" },
    },
    {
      name: "BSC, which appends the data",
      messages: {
        reason: `execution reverted: paused: ${data.reason}`,
        emptyReason: `execution reverted: : ${data.emptyReason}`,
        custom: `execution reverted: ${data.custom}`,
        panic: `execution reverted: arithmetic underflow or overflow: ${data.panic}`,
      },
      empty: { code: 3, message: "execution reverted: 0x", data: "0x" },
    },
    {
      name: "zkSync Era",
      messages: {
        reason: "execution reverted: paused",
        emptyReason: "execution reverted",
        custom: "execution reverted",
        panic: "execution reverted",
      },
      empty: { code: 3, message: "execution reverted", data: "0x" },
    },
    {
      // Its bare revert is the known difference, tested below.
      name: "Scroll, except its empty revert",
      messages: {
        reason: "execution reverted: paused",
        emptyReason: "execution reverted: ",
        custom: "execution reverted",
        panic: "execution reverted",
      },
      empty: { code: 3, message: "execution reverted", data: "0x" },
    },
  ];
  const cases = nodes.flatMap((node) =>
    kinds
      .map((kind): { node: string; kind: keyof typeof specs; error: (typeof node)["empty"] } => ({
        node: node.name,
        kind,
        error: { code: 3, message: node.messages[kind], data: data[kind] },
      }))
      .concat({ node: node.name, kind: "empty", error: node.empty }),
  );

  test.each(cases)("$node: $kind", async ({ kind, error }) => {
    answer = rpcError(error);
    await compare(
      (token) => {
        token.read.balanceOf().reverts(specs[kind]);
      },
      { portable: true },
    );
  });

  test("Scroll sends a bare revert as -32000, which viem doesn't classify as a revert", async () => {
    answer = rpcError({ code: -32000, message: "execution reverted" });
    const mock = createMockRpc();
    mock.contract({ abi, address: TOKEN }).read.balanceOf().reverts();
    const real = createPublicClient({ chain: mainnet, transport: http(url, { retryCount: 0 }) });

    // The mock answers like reth: a revert viem decodes. On Scroll, the app
    // gets no ContractFunctionRevertedError for an empty revert.
    expect(names(await rejectionOf(mock.publicClient().readContract(read)))).toContain(
      "ContractFunctionRevertedError",
    );
    expect(names(await rejectionOf(real.readContract(read)))).not.toContain(
      "ContractFunctionRevertedError",
    );
  });
});

/**
 * A response captured from Ethereum's reth (publicnode) by
 * `scripts/capture-node-responses.ts`. Rerun it with `--write` to refresh them.
 */
/** A captured answer from `node`'s folder of fixtures, Ethereum's reth node by default. */
function nodeResponse(
  name: string,
  node = "ethereum-reth",
): { client: string; answer: Answer; body: unknown } {
  const fixture: unknown = JSON.parse(
    readFileSync(new URL(`fixtures/node-responses/${node}/${name}.json`, import.meta.url), "utf8"),
  );
  if (typeof fixture !== "object" || fixture === null || !("response" in fixture))
    throw new Error(`Malformed fixture ${name}`);
  const { response } = fixture;
  if (typeof response !== "object" || response === null || !("status" in response))
    throw new Error(`Malformed fixture ${name}`);
  const body = "body" in response ? response.body : undefined;
  return {
    client: "client" in fixture ? String(fixture.client) : "",
    answer: {
      status: Number(response.status),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    body,
  };
}

/** The sorted field names of the first log in a list of JSON-RPC logs. */
function logKeys(logs: unknown): string[] {
  const first: unknown = Array.isArray(logs) ? logs[0] : undefined;
  return typeof first === "object" && first !== null ? Object.keys(first).toSorted() : [];
}

/** A JSON-RPC body's result, if it has one. */
function resultOf(body: unknown): unknown {
  return typeof body === "object" && body !== null && "result" in body ? body.result : undefined;
}

/** A JSON-RPC receipt's logs, if it has any. */
function logsOf(receipt: unknown): unknown {
  return typeof receipt === "object" && receipt !== null && "logs" in receipt
    ? receipt.logs
    : undefined;
}

/** An object's keys, in order; none for anything else. */
function keysOf(value: unknown): string[] {
  return typeof value === "object" && value !== null ? Object.keys(value) : [];
}

/** A JSON-RPC transaction's first authorization, if it has any. */
function firstAuthorization(transaction: unknown): unknown {
  return typeof transaction === "object" &&
    transaction !== null &&
    "authorizationList" in transaction &&
    Array.isArray(transaction.authorizationList)
    ? transaction.authorizationList[0]
    : undefined;
}

/** The address of the first log in a list of JSON-RPC logs. */
function firstAddress(logs: unknown): string | undefined {
  const first: unknown = Array.isArray(logs) ? logs[0] : undefined;
  return typeof first === "object" && first !== null && "address" in first
    ? String(first.address)
    : undefined;
}

describe("getLogs errors match reth's exactly", () => {
  // Filters the mock refuses as the captured node did, at the mock's head (block 10).
  const refusals: { fixture: string; filter: Record<string, unknown> }[] = [
    { fixture: "get-logs-range-past-head", filter: { fromBlock: "0x5", toBlock: "0x14" } },
    { fixture: "get-logs-range-backwards", filter: { fromBlock: "0x5", toBlock: "0x1" } },
    {
      fixture: "get-logs-block-hash-with-range",
      filter: { blockHash: `0x${"22".repeat(32)}`, fromBlock: "0xa" },
    },
    { fixture: "get-logs-unknown-block-hash", filter: { blockHash: `0x${"11".repeat(32)}` } },
    {
      fixture: "get-logs-too-many-topics",
      filter: { fromBlock: "0xa", toBlock: "0xa", topics: [null, null, null, null, null] },
    },
  ];

  test.each(refusals)("$fixture", async ({ fixture, filter }) => {
    const mock = createMockRpc({ blockNumber: 10n });
    mock.contract({ abi, address: TOKEN });
    answer = nodeResponse(fixture).answer;
    // Sent through the transports themselves: some of these filters are ones
    // viem's typed actions never send.
    const request = { method: "eth_getLogs", params: [{ address: TOKEN, ...filter }] };
    const options = { retryCount: 0, retryDelay: 0 };
    const real = http(url, options)({ chain: mainnet });
    const mocked = mock.transport(options)({ chain: mainnet });

    const realError = await rejectionOf(real.request(request));
    const mockError = await rejectionOf(mocked.request(request));
    // The node's message is in `details`; viem's own wording is in `shortMessage`.
    expect(layers(mockError, { details: true })).toEqual(layers(realError, { details: true }));
    expect(mock.unhandled).toEqual([]);
  });

  test("a log has the fields reth sends", async () => {
    const { body, client } = nodeResponse("get-logs-shape");
    expect(client).toMatch(/^reth\//u);
    const mock = createMockRpc({ blockNumber: 10n });
    mock.contract({ abi, address: TOKEN }).emit.Transfer({ from: alice, to: TOKEN, value: 1n });

    const logs = await mock.request({ method: "eth_getLogs", params: [{ address: TOKEN }] });
    const realLogs =
      typeof body === "object" && body !== null && "result" in body ? body.result : undefined;
    expect(logKeys(logs)).toEqual(logKeys(realLogs));
  });

  test("addresses are lowercase, as reth sends them", async () => {
    const { body } = nodeResponse("get-logs-shape");
    const mock = createMockRpc({ blockNumber: 10n });
    mock.contract({ abi, address: TOKEN }).emit.Transfer({ from: alice, to: TOKEN, value: 1n });

    const logs = await mock.request({ method: "eth_getLogs", params: [{ address: TOKEN }] });
    const realLogs =
      typeof body === "object" && body !== null && "result" in body ? body.result : undefined;
    expect(firstAddress(realLogs)).toBe(firstAddress(realLogs)?.toLowerCase());
    expect(firstAddress(logs)).toBe(TOKEN.toLowerCase());
  });
});

// The gas fixtures' sender and recipient: addresses nobody holds a key to.
const unfunded = "0x3FFad175d7E6060D236E450E9Bc09BC54BE68770";
const recipient = "0xE023cD5ae4146512f9BA0CBd4523f463603ecd67";
/** Each named error's fixture, and the request it answered, in viem's terms. */
const namedErrors = [
  { fixture: "estimate-gas-insufficient-funds", name: "insufficientFunds", fields: { value: 1n } },
  {
    fixture: "estimate-gas-insufficient-funds-with-fees",
    name: "insufficientFunds",
    fields: { value: 1n, maxFeePerGas: 2n, maxPriorityFeePerGas: 0n },
  },
  {
    fixture: "estimate-gas-fee-cap-too-low",
    name: "feeCapTooLow",
    fields: { maxFeePerGas: 1n, maxPriorityFeePerGas: 0n },
  },
  {
    fixture: "estimate-gas-tip-above-fee-cap",
    name: "tipAboveFeeCap",
    fields: { maxFeePerGas: 2n, maxPriorityFeePerGas: 3n },
  },
] as const;
const noRetries = { retryCount: 0, retryDelay: 0 };

/** An estimate of the fixtures' transfer through `transport`, with `fields` over it. */
function estimate(transport: Transport, fields: object) {
  const client = createPublicClient({ chain: mainnet, transport });
  return client.estimateGas({ account: unfunded, to: recipient, ...fields });
}

/** The error a mock answers an estimate with when it `.fails(name)`. */
function mockedRefusal(name: (typeof namedErrors)[number]["name"], fields: object) {
  const mock = createMockRpc();
  mock.actions.estimateGas().fails(name);
  return rejectionOf(estimate(mock.transport(noRetries), fields));
}

describe("named node errors match reth's exactly", () => {
  const nodes = ["ethereum-reth", "base-reth"];

  test.each(
    nodes.flatMap((node) =>
      namedErrors.map(({ fixture, name, fields }) => ({ node, fixture, name, fields })),
    ),
  )("$node: $fixture", async ({ node, fixture, name, fields }) => {
    expect(nodeResponse(fixture, node).client).toMatch(/^reth\//u);
    answer = nodeResponse(fixture, node).answer;

    const realError = await rejectionOf(estimate(http(url, noRetries), fields));
    const mockError = await mockedRefusal(name, fields);

    // The one difference on purpose: reth's "EVM error: OutOfFunds" without
    // fees is the balance check's wording, which viem before 2.57.12 doesn't
    // name. Its code and the errors viem gives the app still match.
    if (fixture === "estimate-gas-insufficient-funds") {
      const classes = (error: unknown) =>
        layers(error).map((layer) => ({ name: layer.name, code: layer.code }));
      expect(classes(mockError)).toEqual(classes(realError));
      expect(layers(mockError, { details: true }).map((layer) => layer.details)).toContain(
        "insufficient funds for gas * price + value: have 0 want 1",
      );
    } else
      expect(layers(mockError, { details: true })).toEqual(layers(realError, { details: true }));
  });

  test.each(nodes)("%s: a plain transfer is estimated at 21000, as unmocked", async (node) => {
    answer = nodeResponse("estimate-gas-transfer", node).answer;
    const mock = createMockRpc();

    expect(await estimate(mock.transport(noRetries), {})).toBe(
      await estimate(http(url, noRetries), {}),
    );
  });
});

// Other clients word these differently, and send -32000 where reth sends
// -32003, so viem's middle layer differs (InvalidInputRpcError vs
// TransactionRejectedRpcError). What error handling relies on matches: the
// estimate's error, and the node error viem names from the message.
describe("named node errors classify the same on other clients", () => {
  const families = [
    { node: "ethereum-geth", family: "geth" },
    { node: "mantle-geth", family: "geth (an OP Stack fork)" },
    { node: "arbitrum-one-nitro", family: "Arbitrum Nitro" },
    { node: "ethereum-erigon", family: "Erigon" },
    { node: "gnosis-nethermind", family: "Nethermind" },
  ];

  test.each(
    families.flatMap(({ node, family }) =>
      namedErrors.map(({ fixture, name, fields }) => ({ node, family, fixture, name, fields })),
    ),
  )("$family ($node): $fixture", async ({ node, fixture, name, fields }) => {
    answer = nodeResponse(fixture, node).answer;

    const realError = await rejectionOf(estimate(http(url, noRetries), fields));
    const mockError = await mockedRefusal(name, fields);

    expect(names(mockError).slice(0, 2)).toEqual(names(realError).slice(0, 2));
  });

  test.each(families)("$family ($node): a plain transfer is 21000 too", async ({ node }) => {
    answer = nodeResponse("estimate-gas-transfer", node).answer;

    expect(await estimate(http(url, noRetries), {})).toBe(21_000n);
  });

  test("zkSync Era sends insufficient funds as a revert, and doesn't check fee caps", async () => {
    const node = "zksync-era-zksync";
    answer = nodeResponse("estimate-gas-insufficient-funds", node).answer;
    const realError = await rejectionOf(estimate(http(url, noRetries), { value: 1n }));
    // Code 3, so viem names it a revert, not InsufficientFundsError.
    expect(names(realError).slice(0, 2)).toEqual([
      "EstimateGasExecutionError",
      "ExecutionRevertedError",
    ]);
    expect(names(await mockedRefusal("insufficientFunds", { value: 1n }))[1]).toBe(
      "InsufficientFundsError",
    );

    // Fee caps the other clients refuse are estimated, and a transfer isn't 21000.
    answer = nodeResponse("estimate-gas-fee-cap-too-low", node).answer;
    expect(await estimate(http(url, noRetries), { maxFeePerGas: 1n })).toBe(146_830n);
    answer = nodeResponse("estimate-gas-transfer", node).answer;
    expect(await estimate(http(url, noRetries), {})).toBe(146_780n);
  });
});

describe("eth_fillTransaction", () => {
  test("is refused as Arbitrum refuses it, which viem remembers", async () => {
    answer = nodeResponse("fill-transaction", "arbitrum-one-nitro").answer;
    const request = { method: "eth_fillTransaction", params: [{ from: unfunded, to: recipient }] };
    const real = http(url, noRetries)({ chain: mainnet });
    const mocked = createMockRpc().transport(noRetries)({ chain: mainnet });

    const realError = await rejectionOf(real.request(request));
    const mockError = await rejectionOf(mocked.request(request));

    expect(layers(mockError, { details: true })).toEqual(layers(realError, { details: true }));
    expect(names(mockError)[0]).toBe("MethodNotFoundRpcError");
  });
});

describe("storage", () => {
  test("a value is 32 bytes, lowercase, as reth sends it", async () => {
    const { body, client } = nodeResponse("get-storage-at");
    expect(client).toMatch(/^reth\//u);
    const real = resultOf(body);
    if (typeof real !== "string") throw new Error("Malformed fixture get-storage-at");
    const mock = createMockRpc({ blockNumber: 10n });
    // The address the word holds, checksummed, as a test would write it.
    mock.actions
      .getStorageAt({ address: TOKEN, slot: "0x0" })
      .returns(getAddress(`0x${real.slice(26)}`));

    const mocked = await mock.request({
      method: "eth_getStorageAt",
      params: [TOKEN, "0x0", "latest"],
    });

    expect(mocked).toBe(real);
  });
});

describe("transactions", () => {
  const transactions = {
    legacy: { type: "legacy" },
    eip1559: { type: "eip1559" },
    eip4844: { type: "eip4844" },
    eip7702: {
      type: "eip7702",
      authorizationList: [{ address: TOKEN, chainId: 1, nonce: 0, r: "0x1", s: "0x1", yParity: 0 }],
    },
  } satisfies Record<string, MockTransaction>;

  // eip2930 is rare on mainnet; none was in the captured block.
  test.each(["legacy", "eip1559", "eip4844", "eip7702"] as const)(
    "an %s transaction has reth's fields, in its order",
    async (type) => {
      const { body, client } = nodeResponse(`get-transaction-${type}`);
      expect(client).toMatch(/^reth\//u);
      const mock = createMockRpc({ blockNumber: 10n });
      const hash = `0x${"ab".repeat(32)}` as const;
      mock.actions.getTransaction({ hash }).returns(transactions[type]);

      const mocked = await mock.request({ method: "eth_getTransactionByHash", params: [hash] });
      const real = resultOf(body);

      expect(keysOf(mocked)).toEqual(keysOf(real));
      expect(keysOf(firstAuthorization(mocked))).toEqual(keysOf(firstAuthorization(real)));
    },
  );
});

describe("receipts", () => {
  test("a receipt's log has the fields reth sends", async () => {
    const { body, client } = nodeResponse("get-receipt");
    expect(client).toMatch(/^reth\//u);
    const mock = createMockRpc({ blockNumber: 10n });
    const log = mock
      .contract({ abi, address: TOKEN })
      .emit.Transfer({ from: alice, to: TOKEN, value: 1n });

    const mocked = await mock.request({
      method: "eth_getTransactionReceipt",
      params: [log.transactionHash],
    });
    expect(logKeys(logsOf(mocked))).toEqual(logKeys(logsOf(resultOf(body))));
  });
});

describe("faults match the http transport's, retries included", () => {
  const faults: { name: string; fault: MockFault; node: Answer; timeout?: number }[] = [
    {
      name: "an HTTP error status",
      fault: { status: 503 },
      node: httpError(503, "Service Unavailable"),
    },
    {
      name: "a rate limit with Retry-After",
      fault: { status: 429, retryAfter: 0 },
      node: httpError(429, "Too Many Requests", { "Retry-After": "0" }),
    },
    {
      name: "a JSON-RPC error viem maps to a class",
      fault: { code: -32005, message: "limit exceeded" },
      node: rpcError({ code: -32005, message: "limit exceeded" }),
    },
    {
      name: "a generic JSON-RPC server error",
      fault: { code: -32000, message: "header not found" },
      node: rpcError({ code: -32000, message: "header not found" }),
    },
    {
      name: "a timeout",
      fault: "timeout",
      node: { ...rpcError({ code: 3, message: "too late" }), delay: 200 },
      timeout: 50,
    },
  ];

  test.each(faults)("$name", async ({ fault, node, timeout }) => {
    answer = node;
    await compare(
      (token) => {
        token.read.balanceOf().fails(fault);
      },
      { retryCount: 2, ...(timeout === undefined ? {} : { timeout }) },
    );
  });
});

describe("revert messages", () => {
  // Every panic message the reth nodes sent, verbatim.
  const captured: [number, string][] = [
    [0x00, "execution reverted: panic: generic/unspecified error (0x00)"],
    [0x01, "execution reverted: panic: assertion failed (0x01)"],
    [0x11, "execution reverted: panic: arithmetic underflow or overflow (0x11)"],
    [0x12, "execution reverted: panic: division or modulo by zero (0x12)"],
    [0x21, "execution reverted: panic: failed to convert value into enum type (0x21)"],
    [0x22, "execution reverted: panic: storage byte array incorrectly encoded (0x22)"],
    [0x31, "execution reverted: panic: called `.pop()` on an empty array (0x31)"],
    [0x32, "execution reverted: panic: array out-of-bounds access (0x32)"],
    [0x41, "execution reverted: panic: memory allocation error (0x41)"],
    [0x51, "execution reverted: panic: called an invalid internal function (0x51)"],
    [0x100, "execution reverted: panic: unknown code (0x100)"],
  ];

  test.each(captured.map(([code, message]) => ({ hex: `0x${code.toString(16)}`, code, message })))(
    "panic $hex matches the nodes' message",
    ({ code, message }) => {
      const data = encodeErrorResult({ abi: builtins, errorName: "Panic", args: [BigInt(code)] });
      expect(nodeRevertMessage(data)).toBe(message);
    },
  );

  test("reasons keep newlines, as nodes send them", () => {
    const data = encodeErrorResult({ abi: builtins, errorName: "Error", args: ["a\nb"] });
    expect(nodeRevertMessage(data)).toBe("execution reverted: a\nb");
  });
});
