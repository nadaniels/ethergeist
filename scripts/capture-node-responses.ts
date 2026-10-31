/**
 * Captures how a real node answers requests the mock imitates, so the
 * fidelity tests can replay them. Each case is built from the node's current
 * head, so captures stay valid as the chain moves on.
 *
 * Usage:
 *   vpx scripts/capture-node-responses.ts [endpoint] [--write] [--name <name>] [--only <prefix>]
 *
 * - `endpoint`: a JSON-RPC URL. Defaults to Ethereum's public reth node
 *   (publicnode), the node the mock imitates. Use any public endpoint to see
 *   how another client or chain answers.
 * - `--write`: save the responses to `test/fixtures/node-responses/<name>/`,
 *   which the fidelity tests read. Without it, the script only prints them,
 *   so checking another node never changes the fixtures.
 * - `--name`: the folder's name. Defaults to the chain and the node's client,
 *   e.g. `ethereum-reth` or `arbitrum-one-nitro`; set it to keep two
 *   captures of one apart, e.g. two reth versions.
 * - `--only`: capture only the cases whose names start with this, e.g.
 *   `estimate-gas`; repeat it for several. Defaults to every case, so a
 *   subset can be refreshed without rewriting the rest.
 *
 * It sends a handful of read-only requests, one at a time with a pause in
 * between, and needs no API key. Gas estimates are sent from an address
 * nobody holds a key to, which holds nothing (checked before they're sent):
 * nothing is signed or spent. Don't point it at an endpoint with a key in
 * its URL with `--write`: the endpoint is saved with each fixture.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import * as chains from "viem/chains";

const defaultEndpoint = "https://ethereum-rpc.publicnode.com";
const fixturesDir = new URL("../test/fixtures/node-responses/", import.meta.url);
/** Between requests, to stay well within public endpoints' rate limits. */
const pauseMs = 500;

// USDC on Ethereum: busy enough that any block has its logs. Public nodes
// refuse multi-block log queries without an address.
const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const unknownHash = `0x${"11".repeat(32)}`;
// The last 20 bytes of keccak256("viem-transport-mock: unfunded sender") and
// of "…: recipient": addresses nobody holds a key to.
const unfunded = "0x3ffad175d7e6060d236e450e9bc09bc54be68770";
const recipient = "0xe023cd5ae4146512f9ba0cbd4523f463603ecd67";

/**
 * The node's head: its number, hash and base fee, and a hash of each
 * transaction type in a recent block, by type (`0x2`), when a case needs one.
 */
type Head = {
  number: bigint;
  hash: string;
  baseFeePerGas: bigint;
  transactions: Record<string, string>;
};

/**
 * A capture case: the request, given the node's current head; `undefined`
 * skips it, e.g. when the block has no transaction of a type.
 */
type Case = {
  name: string;
  description: string;
  request: (head: Head) => RpcRequest | undefined;
};
type RpcRequest = { method: string; params: unknown[] };

const hex = (n: bigint) => `0x${n.toString(16)}`;

const cases: Case[] = [
  {
    name: "get-logs-range-past-head",
    description: "eth_getLogs whose toBlock is past the head",
    request: (head) =>
      getLogs({ fromBlock: hex(head.number - 5n), toBlock: hex(head.number + 10n) }),
  },
  {
    name: "get-logs-range-backwards",
    description: "eth_getLogs whose fromBlock is after its toBlock",
    request: (head) =>
      getLogs({ fromBlock: hex(head.number - 5n), toBlock: hex(head.number - 10n) }),
  },
  {
    name: "get-logs-block-hash-with-range",
    description: "eth_getLogs with both a blockHash and a fromBlock",
    request: (head) => getLogs({ blockHash: head.hash, fromBlock: hex(head.number) }),
  },
  {
    name: "get-logs-unknown-block-hash",
    description: "eth_getLogs for a blockHash the node doesn't have",
    request: () => getLogs({ blockHash: unknownHash }),
  },
  {
    name: "get-logs-too-many-topics",
    description: "eth_getLogs with five topic positions",
    request: (head) =>
      getLogs({
        fromBlock: hex(head.number),
        toBlock: hex(head.number),
        topics: [null, null, null, null, null],
      }),
  },
  {
    name: "get-logs-shape",
    description: "eth_getLogs for one block, to compare the fields of a log",
    request: (head) =>
      getLogs({ fromBlock: hex(head.number - 2n), toBlock: hex(head.number - 2n) }),
  },
  {
    name: "get-storage-at",
    description: "eth_getStorageAt for a slot written short (0x0), to compare a value's form",
    request: (head) => ({
      method: "eth_getStorageAt",
      params: [usdc, "0x0", hex(head.number - 2n)],
    }),
  },
  // Named node errors and gas assumptions: what `.fails("insufficientFunds")`
  // and the others imitate, and the 21000 a plain transfer is estimated at.
  {
    name: "estimate-gas-insufficient-funds",
    description: "eth_estimateGas sending 1 wei from an unfunded address, without fee fields",
    request: () => estimateGas({ value: "0x1" }),
  },
  {
    name: "estimate-gas-insufficient-funds-with-fees",
    description: "eth_estimateGas sending 1 wei from an unfunded address, with fee fields",
    request: (head) =>
      estimateGas({
        value: "0x1",
        maxFeePerGas: hex(head.baseFeePerGas * 2n),
        maxPriorityFeePerGas: "0x0",
      }),
  },
  {
    name: "estimate-gas-fee-cap-too-low",
    description: "eth_estimateGas with a max fee of 1 wei, below the base fee",
    request: () => estimateGas({ maxFeePerGas: "0x1", maxPriorityFeePerGas: "0x0" }),
  },
  {
    name: "estimate-gas-tip-above-fee-cap",
    description: "eth_estimateGas with a tip above its max fee",
    request: (head) =>
      estimateGas({
        maxFeePerGas: hex(head.baseFeePerGas * 2n),
        maxPriorityFeePerGas: hex(head.baseFeePerGas * 3n),
      }),
  },
  {
    name: "estimate-gas-transfer",
    description: "eth_estimateGas for a plain transfer of nothing, to compare with 21000",
    request: () => estimateGas({}),
  },
  {
    name: "fill-transaction",
    description: "eth_fillTransaction for a plain transfer: supported, or how it's refused",
    request: () => ({
      method: "eth_fillTransaction",
      params: [{ from: unfunded, to: recipient, value: "0x0" }],
    }),
  },
  ...(
    [
      ["legacy", "0x0"],
      ["eip2930", "0x1"],
      ["eip1559", "0x2"],
      ["eip4844", "0x3"],
      ["eip7702", "0x4"],
    ] as const
  ).map(([type, typeHex]) => ({
    name: `get-transaction-${type}`,
    description: `eth_getTransactionByHash for a mined ${type} transaction`,
    request: (head: Head) => {
      const hash = head.transactions[typeHex];
      return hash === undefined
        ? undefined
        : { method: "eth_getTransactionByHash", params: [hash] };
    },
  })),
];

/** A transfer from the unfunded address, estimated at the head, with `fields` over it. */
function estimateGas(fields: Record<string, string>): RpcRequest {
  return {
    method: "eth_estimateGas",
    params: [{ from: unfunded, to: recipient, ...fields }, "latest"],
  };
}

function getLogs(filter: Record<string, unknown>): RpcRequest {
  return { method: "eth_getLogs", params: [{ address: usdc, ...filter }] };
}

type Response = { status: number; body: unknown };

async function send(endpoint: string, request: RpcRequest): Promise<Response> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...request }),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // An HTTP error page, kept as text.
  }
  return { status: response.status, body };
}

/** The result of a request that must succeed, for setting up the cases. */
async function result(endpoint: string, request: RpcRequest): Promise<unknown> {
  const { status, body } = await send(endpoint, request);
  if (status !== 200 || typeof body !== "object" || body === null || !("result" in body))
    throw new Error(`${request.method} failed (HTTP ${status}): ${JSON.stringify(body)}`);
  return body.result;
}

/** Keeps a successful log query to its first two logs; one block of USDC can have hundreds. */
function trimmed(body: unknown): unknown {
  if (
    typeof body !== "object" ||
    body === null ||
    !("result" in body) ||
    !Array.isArray(body.result)
  )
    return body;
  return { ...body, result: body.result.slice(0, 2) };
}

const pause = async () => {
  await new Promise((resolve) => {
    setTimeout(resolve, pauseMs);
  });
};

/** A folder name for a node: its chain's name and its client, e.g. `ethereum-reth`. */
function defaultName(chainId: number, client: string): string {
  const chain = Object.values(chains).find(
    (each) => typeof each === "object" && "id" in each && each.id === chainId,
  );
  const chainName = chain === undefined ? `chain-${chainId}` : chain.name;
  // e.g. "reth/v2.8.0-05ba481/x86_64-unknown-linux-gnu" or "Geth/v1.17.4-stable/…"
  const clientName = client.split("/")[0] ?? client;
  return `${chainName}-${clientName}`.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-");
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      write: { type: "boolean", default: false },
      name: { type: "string" },
      only: { type: "string", multiple: true },
    },
  });
  const endpoint = positionals[0] ?? defaultEndpoint;
  const selected = cases.filter(
    ({ name }) =>
      values.only === undefined || values.only.some((prefix) => name.startsWith(prefix)),
  );
  if (selected.length === 0) throw new Error(`No case starts with ${values.only?.join(" or ")}.`);

  const client = String(await result(endpoint, { method: "web3_clientVersion", params: [] }));
  await pause();
  const chainId = Number(await result(endpoint, { method: "eth_chainId", params: [] }));
  await pause();
  const block = await result(endpoint, {
    method: "eth_getBlockByNumber",
    params: ["latest", false],
  });
  if (typeof block !== "object" || block === null || !("number" in block) || !("hash" in block))
    throw new Error(`Unexpected block: ${JSON.stringify(block)}`);
  const number = BigInt(String(block.number));
  const baseFeePerGas = "baseFeePerGas" in block ? BigInt(String(block.baseFeePerGas)) : 0n;
  const transactions = selected.some(({ name }) => name.startsWith("get-transaction-"))
    ? await recentTransactions(endpoint, number)
    : {};
  if (selected.some(({ name }) => name.startsWith("estimate-gas-"))) {
    await pause();
    const balance = await result(endpoint, {
      method: "eth_getBalance",
      params: [unfunded, "latest"],
    });
    if (BigInt(String(balance)) !== 0n)
      throw new Error(`${unfunded} holds ${String(balance)} here; the estimates need it empty.`);
  }
  const head = { number, hash: String(block.hash), baseFeePerGas, transactions };
  const name = values.name ?? defaultName(chainId, client);
  console.log(`${endpoint}: ${client}, chain ${chainId} (${name}), head ${head.number}\n`);

  const outDir = values.write ? new URL(`${name}/`, fixturesDir) : undefined;
  if (outDir !== undefined) await mkdir(outDir, { recursive: true });
  const context = { endpoint, client, chainId, head, outDir };
  for (const each of selected)
    // One at a time, on purpose: public endpoints rate-limit bursts.
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design
    await capture(each, context);
  if (outDir !== undefined) console.log(`Saved to ${outDir.pathname}`);
}

/** A hash of each transaction type in a block a couple behind the head, by type (`0x2`). */
async function recentTransactions(endpoint: string, head: bigint) {
  await pause();
  const recent = await result(endpoint, {
    method: "eth_getBlockByNumber",
    params: [hex(head - 2n), true],
  });
  const transactions: Record<string, string> = {};
  const list: unknown[] =
    typeof recent === "object" && recent !== null && "transactions" in recent
      ? [recent.transactions].flat()
      : [];
  for (const tx of list)
    if (typeof tx === "object" && tx !== null && "type" in tx && "hash" in tx)
      transactions[String(tx.type)] ??= String(tx.hash);
  return transactions;
}

/** Sends one case after a pause, prints the answer, and saves it to `outDir` if given. */
async function capture(
  { name, description, request }: Case,
  context: {
    endpoint: string;
    client: string;
    chainId: number;
    head: Head;
    outDir: URL | undefined;
  },
) {
  const { endpoint, client, chainId, head, outDir } = context;
  await pause();
  const sent = request(head);
  if (sent === undefined) {
    console.log(`${name}: skipped, nothing to ask for at this head\n`);
    return;
  }
  const response = await send(endpoint, sent);
  const body = trimmed(response.body);
  console.log(`${name} (HTTP ${response.status}):\n  ${JSON.stringify(body)}\n`);
  if (outDir === undefined) return;
  const fixture = {
    description,
    client,
    chainId,
    endpoint,
    capturedAt: new Date().toISOString().slice(0, 10),
    head: head.number.toString(),
    request: sent,
    response: { status: response.status, body },
  };
  await writeFile(new URL(`${name}.json`, outDir), `${JSON.stringify(fixture, null, 2)}\n`);
}

await main();
