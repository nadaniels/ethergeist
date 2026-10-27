import {
  type Abi,
  type AbiFunction,
  type Address,
  type ContractErrorName,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type ContractFunctionReturnType,
  type Hex,
  decodeFunctionData,
  encodeFunctionResult,
  getAbiItem,
  slice,
  toFunctionSelector,
} from 'viem'
import { MockNotFoundError, MockResolverError, MockRevertError } from './errors.js'
import { type RevertFn, type RevertSpec, createRevertError } from './revert.js'

type ReadMutability = 'pure' | 'view'

export type CallContext = {
  from: Address | undefined
  blockNumber: bigint
}

export type MockCall<args = readonly unknown[]> = CallContext & {
  functionName: string
  args: args
}

export type ResolverContext<abi extends Abi, args> = MockCall<args> & {
  /** Revert this call, e.g. `revert('paused')` or `revert({ errorName, args })`. */
  revert: RevertFn<abi>
}

type Resolver<abi extends Abi, args, result> =
  | result
  | ((context: ResolverContext<abi, args>) => result)

type Handler = {
  abiItem: AbiFunction
  selector: Hex
  args: readonly unknown[] | undefined
  specificity: number
  resolver: Resolver<Abi, readonly unknown[], unknown> | undefined
  hasResolver: boolean
}

export type MockFunction<abi extends Abi, args, result> = {
  returns(value: Resolver<abi, args, result>): void
  /** Revert every matching call. See `RevertSpec` for the accepted forms. */
  reverts<errorName extends ContractErrorName<abi> = ContractErrorName<abi>>(
    spec?: RevertSpec<abi, errorName>,
  ): void
}

/** Mirrors `getContract(...).read.<functionName>(args)`, but registers a mock. */
export type MockReadFunction<
  abi extends Abi,
  functionName extends ContractFunctionName<abi, ReadMutability>,
> = {
  <const args extends ContractFunctionArgs<abi, ReadMutability, functionName>>(
    args?: args,
  ): MockFunction<
    abi,
    args,
    ContractFunctionReturnType<abi, ReadMutability, functionName, args>
  >
  /** Every call to this function the mock has received, in order. */
  readonly calls: MockCall<
    ContractFunctionArgs<abi, ReadMutability, functionName>
  >[]
}

export type MockContract<abi extends Abi> = {
  address: Address
  abi: abi
  read: {
    [functionName in ContractFunctionName<abi, ReadMutability>]: MockReadFunction<
      abi,
      functionName
    >
  }
}

/**
 * One resolver per read function, registered before any `.on()` mock so that
 * `.on()` always overrides it.
 */
export type MockContractDefaults<abi extends Abi> = {
  [functionName in ContractFunctionName<abi, ReadMutability>]?: Resolver<
    abi,
    ContractFunctionArgs<abi, ReadMutability, functionName>,
    ContractFunctionReturnType<abi, ReadMutability, functionName>
  >
}

export type CreateMockContractParameters<abi extends Abi> = {
  abi: abi
  address: Address
  defaults?: MockContractDefaults<abi>
}

/** Internal: the public contract API plus the hook the dispatcher calls. */
export type InternalMockContract<abi extends Abi = Abi> = {
  contract: MockContract<abi>
  matches(address: Address): boolean
  resolve(data: Hex, context: CallContext): Promise<Hex>
}

export function createMockContract<const abi extends Abi>(
  parameters: CreateMockContractParameters<abi>,
): InternalMockContract<abi> {
  const { abi, address, defaults = {} } = parameters
  const handlers: Handler[] = []
  const history: MockCall[] = []

  function register(functionName: string, args: readonly unknown[] | undefined) {
    const abiItem = getAbiItem({
      abi: abi as Abi,
      name: functionName,
      args,
    } as never) as AbiFunction | undefined
    if (!abiItem) throw new Error(`Function "${functionName}" not found on ABI.`)

    const handler: Handler = {
      abiItem,
      selector: toFunctionSelector(abiItem),
      args,
      specificity: specificity(args),
      resolver: undefined,
      hasResolver: false,
    }
    handlers.push(handler)

    const builder = {
      returns(value: Handler['resolver']) {
        handler.resolver = value
        handler.hasResolver = true
      },
      reverts(spec?: RevertSpec) {
        builder.returns(({ revert }: ResolverContext<Abi, unknown>) => revert(spec))
      },
    }
    return builder
  }

  for (const [functionName, resolver] of Object.entries(defaults))
    register(functionName, undefined).returns(resolver)

  // Overloads share one entry, as in viem's `getContract`.
  const read: Record<string, unknown> = {}
  for (const item of abi as Abi) {
    if (item.type !== 'function') continue
    if (item.stateMutability !== 'view' && item.stateMutability !== 'pure') continue
    const functionName = item.name
    if (functionName in read) continue
    read[functionName] = Object.defineProperty(
      (args?: readonly unknown[]) => register(functionName, args),
      'calls',
      { get: () => history.filter((call) => call.functionName === functionName) },
    )
  }

  const contract = { address, abi, read } as unknown as MockContract<abi>

  async function resolve(data: Hex, context: CallContext): Promise<Hex> {
    const selector = slice(data, 0, 4)

    let decoded: { functionName: string; args: readonly unknown[] }
    try {
      const result = decodeFunctionData({ abi: abi as Abi, data })
      decoded = { functionName: result.functionName, args: result.args ?? [] }
    } catch {
      throw new MockNotFoundError(
        `No function with selector ${selector} on mocked contract ${address}.`,
      )
    }

    const call: MockCall = { ...context, ...decoded }
    history.push(call)

    // The most specific matching handler wins; among equally specific ones,
    // the most recently registered wins, so per-test mocks override defaults.
    let handler: Handler | undefined
    for (const h of handlers) {
      if (h.selector !== selector) continue
      if (h.args !== undefined && !isMatch(h.args, decoded.args)) continue
      if (!handler || h.specificity >= handler.specificity) handler = h
    }
    if (!handler || !handler.hasResolver) {
      const registered = handlers
        .filter((h) => h.selector === selector)
        .map((h) => `  ${formatCall(decoded.functionName, h.args)}`)
      throw new MockNotFoundError(
        `No mock for ${formatCall(decoded.functionName, decoded.args)} on ${address}.`,
        {
          details: registered.length
            ? `Registered:\n${registered.join('\n')}`
            : `No mocks registered for "${decoded.functionName}".`,
        },
      )
    }

    let result: unknown
    if (typeof handler.resolver === 'function') {
      const revert = ((spec?: RevertSpec) => {
        throw createRevertError(abi as Abi, spec)
      }) as RevertFn<Abi>
      try {
        result = await handler.resolver({ ...call, revert })
      } catch (error) {
        if (error instanceof MockRevertError) throw error
        throw new MockResolverError(decoded.functionName, error)
      }
    } else result = handler.resolver

    return encodeFunctionResult({
      abi: [handler.abiItem],
      functionName: handler.abiItem.name,
      result,
    } as never)
  }

  return {
    contract,
    matches: (other) => other.toLowerCase() === address.toLowerCase(),
    resolve,
  }
}

/**
 * How narrowly a handler's args constrain a call: the number of leaf values it
 * pins down. Args-less handlers match anything and rank below all others.
 */
function specificity(args: readonly unknown[] | undefined): number {
  if (args === undefined) return -1
  const count = (value: unknown): number => {
    if (Array.isArray(value)) return value.reduce((n: number, v) => n + count(v), 0)
    if (value && typeof value === 'object')
      return Object.values(value).reduce((n: number, v) => n + count(v), 0)
    return 1
  }
  return count(args)
}

/** Deep equality where hex strings (addresses, bytes) compare case-insensitively. */
function isMatch(expected: unknown, actual: unknown): boolean {
  if (typeof expected === 'string' && typeof actual === 'string')
    return expected.toLowerCase() === actual.toLowerCase()
  if (Array.isArray(expected) && Array.isArray(actual))
    return (
      expected.length === actual.length &&
      expected.every((value, i) => isMatch(value, actual[i]))
    )
  if (
    expected &&
    actual &&
    typeof expected === 'object' &&
    typeof actual === 'object'
  )
    return Object.entries(expected).every(([key, value]) =>
      isMatch(value, (actual as Record<string, unknown>)[key]),
    )
  return expected === actual
}

function formatCall(functionName: string, args: readonly unknown[] | undefined) {
  if (args === undefined) return `${functionName}(*)`
  return `${functionName}(${args.map((arg) => (typeof arg === 'bigint' ? `${arg}n` : String(arg))).join(', ')})`
}
