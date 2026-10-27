import { type Address, erc20Abi } from 'viem'
import { describe, expectTypeOf, test } from 'vitest'
import { createMockRpc } from '../src/index.js'

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

const mock = createMockRpc()
const usdc = mock.contract({ abi: erc20Abi, address: USDC })

describe('read', () => {
  test('exposes only read function names from the ABI', () => {
    expectTypeOf<keyof typeof usdc.read>().toEqualTypeOf<
      'allowance' | 'balanceOf' | 'decimals' | 'name' | 'symbol' | 'totalSupply'
    >()

    // @ts-expect-error not on the ABI
    usdc.read.balanceOff()
    // @ts-expect-error write functions are excluded
    usdc.read.transfer()
  })

  test('args are typed per function', () => {
    usdc.read.balanceOf(['0x0000000000000000000000000000000000000001'])
    usdc.read.allowance([USDC, USDC])

    // @ts-expect-error wrong arg type
    usdc.read.balanceOf([123n])
    // @ts-expect-error wrong arity
    usdc.read.allowance([USDC])
    // @ts-expect-error takes no args
    usdc.read.decimals([1n])
  })

  test('returns() takes the function return type or a resolver', () => {
    usdc.read.balanceOf().returns(1n)
    usdc.read.decimals().returns(6)
    usdc.read.symbol().returns('USDC')

    usdc.read.balanceOf().returns((call) => {
      expectTypeOf(call.args).toEqualTypeOf<readonly [Address]>()
      expectTypeOf(call.blockNumber).toEqualTypeOf<bigint>()
      expectTypeOf(call.from).toEqualTypeOf<Address | undefined>()
      return 0n
    })

    // @ts-expect-error wrong return type
    usdc.read.balanceOf().returns('lots')
    // @ts-expect-error resolver returns wrong type
    usdc.read.balanceOf().returns(() => 'lots')
  })
})

describe('calls()', () => {
  test('history args are typed per function', () => {
    expectTypeOf(usdc.read.balanceOf.calls[0]!.args).toEqualTypeOf<readonly [Address]>()
    expectTypeOf(usdc.read.allowance.calls[0]!.args).toEqualTypeOf<readonly [Address, Address]>()
  })
})

describe('defaults', () => {
  test('keys are read function names; values are typed resolvers', () => {
    mock.contract({
      abi: erc20Abi,
      address: USDC,
      defaults: {
        decimals: 6,
        balanceOf: (call) => {
          expectTypeOf(call.args).toEqualTypeOf<readonly [Address]>()
          return 0n
        },
      },
    })

    mock.contract({
      abi: erc20Abi,
      address: USDC,
      // @ts-expect-error not a function on the ABI
      defaults: { balanceOff: 0n },
    })
    mock.contract({
      abi: erc20Abi,
      address: USDC,
      // @ts-expect-error write functions are excluded
      defaults: { transfer: true },
    })
    // @ts-expect-error wrong return type
    mock.contract({ abi: erc20Abi, address: USDC, defaults: { decimals: 'six' } })
  })
})
