import {
  type Abi,
  type AbiFunction,
  type Address,
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
import { MockNotFoundError } from './errors.js'

type ReadMutability = 'pure' | 'view'

export type CallContext = {
  from: Address | undefined
  blockNumber: bigint
}

export type MockCall<args = readonly unknown[]> = CallContext & {
  functionName: string
  args: args
}

type Resolver<args, result> = result | ((call: MockCall<args>) => result)

type Handler = {
  abiItem: AbiFunction
  selector: Hex
  args: readonly unknown[] | undefined
  resolver: Resolver<readonly unknown[], unknown> | undefined
  hasResolver: boolean
}

export type MockFunction<args, result> = {
  returns(value: Resolver<args, result>): void
}

/** Mirrors `getContract(...).read.<functionName>(args)`, but registers a mock. */
export type MockReadFunction<
  abi extends Abi,
  functionName extends ContractFunctionName<abi, ReadMutability>,
> = {
  <const args extends ContractFunctionArgs<abi, ReadMutability, functionName>>(
    args?: args,
  ): MockFunction<
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
      resolver: undefined,
      hasResolver: false,
    }
    handlers.push(handler)

    return {
      returns(value: Handler['resolver']) {
        handler.resolver = value
        handler.hasResolver = true
      },
    }
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

    // Most recently registered matching handler wins, so later (more specific
    // or per-test) mocks override earlier defaults.
    const handler = handlers.findLast(
      (h) =>
        h.selector === selector &&
        (h.args === undefined || isMatch(h.args, decoded.args)),
    )
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

    const result =
      typeof handler.resolver === 'function'
        ? await handler.resolver(call)
        : handler.resolver

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
