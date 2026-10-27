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
    usdc.read.balanceOf([alice]).returns(500_000000n)

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
    usdc.read.balanceOf([alice]).returns(1n)
    usdc.read.balanceOf([bob]).returns(2n)

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
    usdc.read.balanceOf().returns(0n)
    usdc.read.balanceOf([alice]).returns(1n)
    usdc.read.balanceOf([alice]).returns(2n)

    const read = (account: `0x${string}`) =>
      client.readContract({ abi: erc20Abi, address: USDC, functionName: 'balanceOf', args: [account] })
    expect(await read(alice)).toBe(2n)
    expect(await read(bob)).toBe(0n)
  })

  test('matches addresses case-insensitively', async () => {
    const { mock, client } = setup()
    const usdc = mock.contract({ abi: erc20Abi, address: USDC.toLowerCase() as `0x${string}` })
    usdc.read.balanceOf([alice.toUpperCase().replace('0X', '0x') as `0x${string}`]).returns(7n)

    expect(
      await client.readContract({ abi: erc20Abi, address: USDC, functionName: 'balanceOf', args: [alice] }),
    ).toBe(7n)
  })

  test('resolver functions see args and block (balance-at-block)', async () => {
    const { mock, client } = setup({ blockNumber: 10n })
    const usdc = mock.contract({ abi: erc20Abi, address: USDC })
    usdc.read.balanceOf().returns(({ blockNumber }) => (blockNumber >= 10n ? 100n : 50n))

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
    usdc.read.balanceOf().returns(0n)

    await client.readContract({ abi: erc20Abi, address: USDC, functionName: 'balanceOf', args: [alice] })
    const calls = usdc.read.balanceOf.calls
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual([getAddress(alice)])
  })

  test('function names that shadow object/function builtins work', async () => {
    const { mock, client } = setup()
    const usdc = mock.contract({ abi: erc20Abi, address: USDC })
    usdc.read.name().returns('USD Coin')

    expect(await client.readContract({ abi: erc20Abi, address: USDC, functionName: 'name' })).toBe('USD Coin')
    expect(usdc.read.name.calls).toHaveLength(1)
  })

  test('unmocked calls fail once, loudly, without retries', async () => {
    const { mock, client } = setup()
    const usdc = mock.contract({ abi: erc20Abi, address: USDC })
    usdc.read.balanceOf([bob]).returns(0n)

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

describe('defaults', () => {
  test('answers reads from a defaults object', async () => {
    const { mock, client } = setup()
    const balances: Record<string, bigint> = { [getAddress(alice)]: 500n }
    mock.contract({
      abi: erc20Abi,
      address: USDC,
      defaults: {
        decimals: 6,
        symbol: 'USDC',
        balanceOf: ({ args: [owner] }) => balances[owner] ?? 0n,
      },
    })

    const read = <functionName extends 'decimals' | 'symbol'>(functionName: functionName) =>
      client.readContract({ abi: erc20Abi, address: USDC, functionName })
    expect(await read('decimals')).toBe(6)
    expect(await read('symbol')).toBe('USDC')

    const balanceOf = (account: `0x${string}`) =>
      client.readContract({ abi: erc20Abi, address: USDC, functionName: 'balanceOf', args: [account] })
    expect(await balanceOf(alice)).toBe(500n)
    expect(await balanceOf(bob)).toBe(0n)

    // Closures over test state are the store, for now.
    balances[getAddress(bob)] = 3n
    expect(await balanceOf(bob)).toBe(3n)
  })

  test('read mocks override defaults', async () => {
    const { mock, client } = setup()
    const usdc = mock.contract({ abi: erc20Abi, address: USDC, defaults: { balanceOf: 0n } })
    usdc.read.balanceOf([alice]).returns(9n)
    usdc.read.balanceOf().returns(1n)

    const balanceOf = (account: `0x${string}`) =>
      client.readContract({ abi: erc20Abi, address: USDC, functionName: 'balanceOf', args: [account] })
    expect(await balanceOf(bob)).toBe(1n)
    // An args-less mock registered later wins over a specific one registered earlier.
    expect(await balanceOf(alice)).toBe(1n)
  })

  test('functions missing from defaults still fail loudly', async () => {
    const { mock, client } = setup()
    mock.contract({ abi: erc20Abi, address: USDC, defaults: { decimals: 6 } })

    await expect(
      client.readContract({ abi: erc20Abi, address: USDC, functionName: 'symbol' }),
    ).rejects.toThrow('No mocks registered for "symbol"')
  })
})
