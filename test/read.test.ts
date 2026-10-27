import { BaseError, createPublicClient, erc20Abi, getAddress } from 'viem'
import { mainnet } from 'viem/chains'
import { describe, expect, test } from 'vitest'
import { MockNotFoundError, createMockRpc } from '../src/index.js'

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const alice = '0x00000000000000000000000000000000000a11ce'
const bob = '0x0000000000000000000000000000000000000b0b'

function setup(parameters?: Parameters<typeof createMockRpc>[0]) {
  const mock = createMockRpc(parameters)
  const client = createPublicClient({
    chain: mainnet,
    transport: mock.transport(),
    // viem caches eth_blockNumber for `cacheTime`, which defaults from
    // `chain.blockTime` (4s on mainnet). Without this, `mock.mine()` is
    // invisible to `getBlockNumber`.
    cacheTime: 0,
  })
  return { mock, client }
}

describe('block number', () => {
  test('returns the configured block and advances with mine()', async () => {
    const { mock, client } = setup({ blockNumber: 100n })
    expect(await client.getBlockNumber()).toBe(100n)
    mock.mine(5n)
    expect(await client.getBlockNumber()).toBe(105n)
  })

  test('default client caching hides mined blocks', async () => {
    const mock = createMockRpc({ blockNumber: 100n })
    const client = createPublicClient({ chain: mainnet, transport: mock.transport() })
    expect(await client.getBlockNumber()).toBe(100n)
    mock.mine()
    expect(await client.getBlockNumber()).toBe(100n)
  })
})

describe('balanceOf', () => {
  test('returns a mocked value for specific args', async () => {
    const { mock, client } = setup()
    const usdc = mock.contract({ abi: erc20Abi, address: USDC })
    usdc.on('balanceOf', [alice]).returns(500_000000n)

    const balance = await client.readContract({
      abi: erc20Abi,
      address: USDC,
      functionName: 'balanceOf',
      args: [alice],
    })
    expect(balance).toBe(500_000000n)
  })

  test('stores and retrieves multiple calls', async () => {
    const { mock, client } = setup()
    const usdc = mock.contract({ abi: erc20Abi, address: USDC })
    usdc.on('balanceOf', [alice]).returns(1n)
    usdc.on('balanceOf', [bob]).returns(2n)

    const read = (account: `0x${string}`) =>
      client.readContract({ abi: erc20Abi, address: USDC, functionName: 'balanceOf', args: [account] })
    const balanceAlice = await read(alice)
    const balanceBob = await read(bob)
    expect(balanceAlice).toBe(1n)
    expect(balanceBob).toBe(2n)
  })

  test('falls back to an args-less mock; most recent match wins', async () => {
    const { mock, client } = setup()
    const usdc = mock.contract({ abi: erc20Abi, address: USDC })
    usdc.on('balanceOf').returns(0n)
    usdc.on('balanceOf', [alice]).returns(1n)
    usdc.on('balanceOf', [alice]).returns(2n)

    const read = (account: `0x${string}`) =>
      client.readContract({ abi: erc20Abi, address: USDC, functionName: 'balanceOf', args: [account] })
    expect(await read(alice)).toBe(2n)
    expect(await read(bob)).toBe(0n)
  })

  test('matches addresses case-insensitively', async () => {
    const { mock, client } = setup()
    const usdc = mock.contract({ abi: erc20Abi, address: USDC.toLowerCase() as `0x${string}` })
    usdc.on('balanceOf', [alice.toUpperCase().replace('0X', '0x') as `0x${string}`]).returns(7n)

    expect(
      await client.readContract({ abi: erc20Abi, address: USDC, functionName: 'balanceOf', args: [alice] }),
    ).toBe(7n)
  })

  test('resolver functions see args and block (balance-at-block)', async () => {
    const { mock, client } = setup({ blockNumber: 10n })
    const usdc = mock.contract({ abi: erc20Abi, address: USDC })
    usdc.on('balanceOf').returns(({ blockNumber }) => (blockNumber >= 10n ? 100n : 50n))

    const read = (blockNumber?: bigint) =>
      client.readContract({
        abi: erc20Abi,
        address: USDC,
        functionName: 'balanceOf',
        args: [alice],
        ...(blockNumber === undefined ? {} : { blockNumber }),
      })
    expect(await read()).toBe(100n)
    expect(await read(5n)).toBe(50n)
  })

  test('records decoded calls', async () => {
    const { mock, client } = setup()
    const usdc = mock.contract({ abi: erc20Abi, address: USDC })
    usdc.on('balanceOf').returns(0n)

    await client.readContract({ abi: erc20Abi, address: USDC, functionName: 'balanceOf', args: [alice] })
    const calls = usdc.calls('balanceOf')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual([getAddress(alice)])
  })

  test('unmocked calls fail once, loudly, without retries', async () => {
    const { mock, client } = setup()
    const usdc = mock.contract({ abi: erc20Abi, address: USDC })
    usdc.on('balanceOf', [bob]).returns(0n)

    const error = await client
      .readContract({ abi: erc20Abi, address: USDC, functionName: 'balanceOf', args: [alice] })
      .catch((e: BaseError) => e)

    expect(error).toBeInstanceOf(BaseError)
    const { message } = error as BaseError
    expect(message).toContain(`No mock for balanceOf(${getAddress(alice)})`)
    expect(message).toContain(`balanceOf(${bob})`)
    expect((error as BaseError).walk((e) => e instanceof MockNotFoundError)).toBeInstanceOf(MockNotFoundError)
    expect(mock.requests).toHaveLength(1)
  })
})
