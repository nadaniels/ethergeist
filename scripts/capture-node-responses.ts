/**
 * Captures how a real node answers requests the mock imitates, so the
 * fidelity tests can replay them. Each case is built from the node's current
 * head, so captures stay valid as the chain moves on.
 *
 * Usage:
 *   vpx scripts/capture-node-responses.ts [endpoint] [--write] [--name <name>] [--only <prefix>] [--pause <ms>]
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
 * - `--pause`: milliseconds between requests. Defaults to 500; raise it for
 *   an endpoint with a tight rate limit, e.g. 13000 for 5 requests a minute.
 *
 * It sends a handful of read-only requests, one at a time with a pause in
 * between, and needs no API key. Gas estimates are sent from an address
 * nobody holds a key to, which holds nothing (checked before they're sent):
 * nothing is signed or spent. The fee cases pretend it's funded for that one
 * request (a state override), since geth-family nodes check the balance
 * against the fees first. Don't point it at an endpoint with a key in
 * its URL with `--write`: the endpoint is saved with each fixture.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import {
  type Chain,
  type PublicClient,
  createPublicClient,
  http,
  keccak256,
  numberToHex,
  slice,
  toHex,
} from "viem";
import * as chains from "viem/chains";

const defaultEndpoint = "https://ethereum-rpc.publicnode.com";
const fixturesDir = new URL("../test/fixtures/node-responses/", import.meta.url);
/** Between requests, to stay well within public endpoints' rate limits; see `--pause`. */
let pauseMs = 500;

// USDC on Ethereum: busy enough that any block has its logs. Public nodes
// refuse multi-block log queries without an address.
const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const unknownHash = `0x${"11".repeat(32)}`;
/** An address derived from `seed`, which nobody holds a key to. */
const keyless = (seed: string) => slice(keccak256(toHex(`viem-transport-mock: ${seed}`)), 12);
const unfunded = keyless("unfunded sender");
const recipient = keyless("recipient");

/**
 * The node's head: its number, hash and base fee, and when a case needs them,
 * a hash of each transaction type in a recent block, by type (`eip1559`), and
 * of a recent transaction that emitted logs.
 */
type Head = {
  number: bigint;
  hash: string;
  baseFeePerGas: bigint;
  transactions: Record<string, string>;
  loggedTransaction: string | undefined;
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

const cases: Case[] = [
  {
    name: "get-logs-range-past-head",
    description: "eth_getLogs whose toBlock is past the head",
    request: (head) =>
      getLogs({
        fromBlock: numberToHex(head.number - 5n),
        toBlock: numberToHex(head.number + 10n),
      }),
  },
  {
    name: "get-logs-range-backwards",
    description: "eth_getLogs whose fromBlock is after its toBlock",
    request: (head) =>
      getLogs({
        fromBlock: numberToHex(head.number - 5n),
        toBlock: numberToHex(head.number - 10n),
      }),
  },
  {
    name: "get-logs-block-hash-with-range",
    description: "eth_getLogs with both a blockHash and a fromBlock",
    request: (head) => getLogs({ blockHash: head.hash, fromBlock: numberToHex(head.number) }),
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
        fromBlock: numberToHex(head.number),
        toBlock: numberToHex(head.number),
        topics: [null, null, null, null, null],
      }),
  },
  {
    name: "get-logs-shape",
    description: "eth_getLogs for one block, to compare the fields of a log",
    request: (head) =>
      getLogs({ fromBlock: numberToHex(head.number - 2n), toBlock: numberToHex(head.number - 2n) }),
  },
  {
    name: "get-storage-at",
    description: "eth_getStorageAt for a slot written short (0x0), to compare a value's form",
    request: (head) => ({
      method: "eth_getStorageAt",
      params: [usdc, "0x0", numberToHex(head.number - 2n)],
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
        maxFeePerGas: numberToHex(head.baseFeePerGas * 2n),
        maxPriorityFeePerGas: "0x0",
      }),
  },
  {
    name: "estimate-gas-fee-cap-too-low",
    description:
      "eth_estimateGas with a max fee of 1 wei, below the base fee, from a funded sender",
    request: () =>
      estimateGas({ maxFeePerGas: "0x1", maxPriorityFeePerGas: "0x0" }, { funded: true }),
  },
  {
    name: "estimate-gas-tip-above-fee-cap",
    description: "eth_estimateGas with a tip above its max fee, from a funded sender",
    request: (head) =>
      estimateGas(
        {
          maxFeePerGas: numberToHex(head.baseFeePerGas * 2n),
          maxPriorityFeePerGas: numberToHex(head.baseFeePerGas * 3n),
        },
        { funded: true },
      ),
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
  ...(["legacy", "eip2930", "eip1559", "eip4844", "eip7702"] as const).map((type) => ({
    name: `get-transaction-${type}`,
    description: `eth_getTransactionByHash for a mined ${type} transaction`,
    request: (head: Head) => {
      const hash = head.transactions[type];
      return hash === undefined
        ? undefined
        : { method: "eth_getTransactionByHash", params: [hash] };
    },
  })),
  {
    name: "get-receipt",
    description: "eth_getTransactionReceipt for a mined transaction with logs",
    request: ({ loggedTransaction }) =>
      loggedTransaction === undefined
        ? undefined
        : { method: "eth_getTransactionReceipt", params: [loggedTransaction] },
  },
];

/**
 * A transfer from the unfunded address, estimated at the head, with `fields`
 * over it. `funded` gives the sender 100 ether for this request only, with a
 * state override: nothing is held or spent.
 */
function estimateGas(fields: Record<string, string>, { funded = false } = {}): RpcRequest {
  const transaction = { from: unfunded, to: recipient, ...fields };
  return {
    method: "eth_estimateGas",
    params: funded
      ? [transaction, "latest", { [unfunded]: { balance: numberToHex(10n ** 20n) } }]
      : [transaction, "latest"],
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

/** Keeps the first two logs of a log query (one block of USDC can have hundreds) or a receipt. */
function trimmed(body: unknown): unknown {
  if (typeof body !== "object" || body === null || !("result" in body)) return body;
  const { result } = body;
  if (Array.isArray(result)) return { ...body, result: result.slice(0, 2) };
  // A receipt's logs, which a busy transaction has dozens of.
  if (
    typeof result === "object" &&
    result !== null &&
    "logs" in result &&
    Array.isArray(result.logs)
  )
    return { ...body, result: { ...result, logs: result.logs.slice(0, 2) } };
  return body;
}

const pause = async () => {
  await new Promise((resolve) => {
    setTimeout(resolve, pauseMs);
  });
};

/** A folder name for a node: its chain's name and its client, e.g. `ethereum-reth`. */
function defaultName(chainId: number, client: string): string {
  const known: readonly object[] = Object.values(chains);
  const chain = known.find((each): each is Chain => "id" in each && each.id === chainId);
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
      pause: { type: "string" },
    },
  });
  if (values.pause !== undefined) pauseMs = Number(values.pause);
  const endpoint = positionals[0] ?? defaultEndpoint;
  const selected = cases.filter(
    ({ name }) =>
      values.only === undefined || values.only.some((prefix) => name.startsWith(prefix)),
  );
  if (selected.length === 0) throw new Error(`No case starts with ${values.only?.join(" or ")}.`);

  // Setting up goes through viem: these must succeed, and aren't saved. The
  // cases themselves are sent raw, to save exactly what the node answered.
  // viem retries rate limits with backoff, and waits as long as Retry-After asks.
  const setup = createPublicClient({ transport: http(endpoint, { retryCount: 3 }) });
  const client = await setup.request({ method: "web3_clientVersion" });
  await pause();
  const chainId = await setup.getChainId();
  await pause();
  const block = await setup.getBlock();
  const transactions = selected.some(({ name }) => name.startsWith("get-transaction-"))
    ? await recentTransactions(setup, block.number)
    : {};
  const loggedTransaction = selected.some(({ name }) => name.startsWith("get-receipt"))
    ? await recentLoggedTransaction(setup, block.number)
    : undefined;
  if (selected.some(({ name }) => name.startsWith("estimate-gas-"))) {
    await pause();
    const balance = await setup.getBalance({ address: unfunded });
    if (balance !== 0n)
      throw new Error(`${unfunded} holds ${balance} wei here; the estimates need it empty.`);
  }
  const head = {
    number: block.number,
    hash: block.hash,
    baseFeePerGas: block.baseFeePerGas ?? 0n,
    transactions,
    loggedTransaction,
  };
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

/** A hash of each transaction type in a block a couple behind the head, by type (`eip1559`). */
async function recentTransactions(setup: PublicClient, head: bigint) {
  await pause();
  const recent = await setup.getBlock({ blockNumber: head - 2n, includeTransactions: true });
  const transactions: Record<string, string> = {};
  for (const tx of recent.transactions) transactions[tx.type] ??= tx.hash;
  return transactions;
}

/** A transaction that emitted a USDC log in a block a couple behind the head. */
async function recentLoggedTransaction(setup: PublicClient, head: bigint) {
  await pause();
  const [log] = await setup.getLogs({ address: usdc, fromBlock: head - 2n, toBlock: head - 2n });
  return log?.transactionHash;
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
