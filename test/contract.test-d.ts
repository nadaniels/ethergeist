import { type Address, erc20Abi } from 'viem'
import { describe, expectTypeOf, test } from 'vitest'
import { createMockRpc } from '../src/index.js'

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

const mock = createMockRpc()
const usdc = mock.contract({ abi: erc20Abi, address: USDC })

describe('on()', () => {
  test('accepts only read function names from the ABI', () => {
    expectTypeOf(usdc.on)
      .parameter(0)
      .toEqualTypeOf<'allowance' | 'balanceOf' | 'decimals' | 'name' | 'symbol' | 'totalSupply'>()

    // @ts-expect-error not on the ABI
    usdc.on('balanceOff')
    // @ts-expect-error write functions are excluded
    usdc.on('transfer')
  })

  test('args are typed per function', () => {
    usdc.on('balanceOf', ['0x0000000000000000000000000000000000000001'])
    usdc.on('allowance', [USDC, USDC])

    // @ts-expect-error wrong arg type
    usdc.on('balanceOf', [123n])
    // @ts-expect-error wrong arity
    usdc.on('allowance', [USDC])
  })

  test('returns() takes the function return type or a resolver', () => {
    usdc.on('balanceOf').returns(1n)
    usdc.on('decimals').returns(6)
    usdc.on('symbol').returns('USDC')

    usdc.on('balanceOf').returns((call) => {
      expectTypeOf(call.args).toEqualTypeOf<readonly [Address]>()
      expectTypeOf(call.blockNumber).toEqualTypeOf<bigint>()
      expectTypeOf(call.from).toEqualTypeOf<Address | undefined>()
      return 0n
    })

    // @ts-expect-error wrong return type
    usdc.on('balanceOf').returns('lots')
    // @ts-expect-error resolver returns wrong type
    usdc.on('balanceOf').returns(() => 'lots')
  })
})

describe('calls()', () => {
  test('history args are typed per function', () => {
    expectTypeOf(usdc.calls('balanceOf')[0]!.args).toEqualTypeOf<readonly [Address]>()
    expectTypeOf(usdc.calls('allowance')[0]!.args).toEqualTypeOf<readonly [Address, Address]>()
  })
})
