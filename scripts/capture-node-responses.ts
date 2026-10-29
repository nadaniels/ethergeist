/**
 * Captures how a real node answers requests the mock imitates, so the
 * fidelity tests can replay them. Each case is built from the node's current
 * head, so captures stay valid as the chain moves on.
 *
 * Usage:
 *   vpx scripts/capture-node-responses.ts [endpoint] [--write] [--name <name>]
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
 *
 * It sends a handful of read-only requests, one at a time with a pause in
 * between, and needs no API key. Don't point it at an endpoint with a key in
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

type Head = { number: bigint; hash: string };

/** A capture case: the request, given the node's current head. */
type Case = { name: string; description: string; request: (head: Head) => RpcRequest };
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
];

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
    options: { write: { type: "boolean", default: false }, name: { type: "string" } },
  });
  const endpoint = positionals[0] ?? defaultEndpoint;

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
  const head = { number: BigInt(String(block.number)), hash: String(block.hash) };
  const name = values.name ?? defaultName(chainId, client);
  console.log(`${endpoint}: ${client}, chain ${chainId} (${name}), head ${head.number}\n`);

  const outDir = values.write ? new URL(`${name}/`, fixturesDir) : undefined;
  if (outDir !== undefined) await mkdir(outDir, { recursive: true });
  const context = { endpoint, client, chainId, head, outDir };
  for (const each of cases)
    // One at a time, on purpose: public endpoints rate-limit bursts.
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design
    await capture(each, context);
  if (outDir !== undefined) console.log(`Saved to ${outDir.pathname}`);
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
