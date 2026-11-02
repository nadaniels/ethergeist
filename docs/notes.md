# Documentation to write

The pages the library docs need, and what each must cover. Items are added as
features land; tick them off as pages get written.

## 1. Overview: when to use this, and when to use anvil

- [ ] What it is: a viem transport that answers each JSON-RPC request with
      what the test registered. Fast and deterministic, with no binary and no
      shared process.
- [ ] What it isn't: nothing executes, and no answer is derived from another.
      For example, a mocked receipt with a `Transfer` log doesn't change any
      balance.
- [ ] When to use anvil (or an anvil fork) instead: tests that need real
      execution or real chain state.

## 2. Getting started

- [ ] `createMockRpc({ chain, blockNumber, timestamp })`, then
      `mock.publicClient()`, or `createPublicClient({ transport: mock.transport() })`
      with the defaults the helper sets (`cacheTime: 0`, `pollingInterval: 50`,
      `retryDelay: 0`).
- [ ] Registering a contract, and
      `defaults: { read: { … }, simulate: { … }, estimateGas: { … } }`.
      This is the first setup code everyone writes, so the docs should lead
      with it and repeat it in examples.
- [ ] `read` vs `simulate` namespaces (view/pure vs nonpayable/payable),
      mirroring `getContract`, and `estimateGas` (the same functions as
      `simulate`, for `estimateContractGas` and a write's prepare). A
      `simulate` mock doesn't answer estimates: a node runs them
      separately, and the mock doesn't derive one answer from another.
      Estimates answer gas (`.returns(65_000n)`), revert like `simulate`,
      and are their own calls: `estimateGas.transfer.calls`, not
      `contract.calls`.
- [ ] Test values: `testAddress("alice")` and `testHash("swap-1")`, stable
      and realistic (checksummed, full-width). Say why not random (faker):
      random values rarely find bugs fixed ones miss, and they make messages
      and snapshots change between runs; why not `0x…0001`: it hides
      case-comparison and sorting bugs. Several at once:
      ``Array.from({ length: 3 }, (_, i) => testAddress(`user-${i + 1}`))``.
      The address belongs to a key derived from the label (signing later).
      `testLog("noise")` is a log that matches no event, for a receipt's
      noise; `testLog("noise", { address: USDC })` for an unknown event at a
      contract the code does know (any address; `emit()` needs it
      registered).

## 3. Mocking contract calls

- [ ] Matching: pinned args, args-less mocks as fallbacks, most specific wins,
      ties go to the most recent.
- [ ] Matchers: `match.any()`, `match.where(predicate, label?)` and
      `match.partial(fields)` in args and in action and method params, typed
      as the value they replace. Show:
  - Not Jest's or Vitest's: `expect.any(String)` and the like are refused
    at registration, pointing to `match.any()`/`match.where()`. They're
    typed `any`, so they'd type-check and then never match.
  - Ranking: exact values, then predicates, then `any`, compared in that
    order (one exact value beats any number of predicates); a mock with args,
    even all `any`, beats an args-less one.
  - Ties between equally specific matchers go to the most recent: `[X, any]`
    and `[any, Y]` both match `[X, Y]`.
  - Predicates get decoded values in viem's types. Addresses arrive
    checksummed: compare with `isAddressEqual`, never `===` (a lowercase
    literal never equals, so `!==` matches everything).
  - Predicates should be cheap and pure. They run only for a mock still in
    contention (its exact values match, every better mock failed); one that
    throws is reported as unhandled, naming it.
  - Names in messages: the `label`, the function's name (`where(isLarge)`),
    or an inline arrow's source, cut to 60 characters
    (`where((n) => n > 5n)`).
  - Matchers choose which answer a call gets; they aren't assertions. To
    check what the app sent, use `.calls` with `expect`, which gives a real
    diff. Pinning args and relying on `assertAllUsed()` also works: its
    message lists what the function received instead (section 6).
  - Say explicitly: a pin checks args only when the test registers it. In
    shared setup it's exempt from `assertAllUsed` (baseline or `defaults`),
    and a fallback answers the calls that don't match, so a wrong pin passes
    silently (measured in dogfooding: 98/98 green with a deliberately wrong
    shared pin).
  - Invariants on a shared mock ("every swap uses this token"): loop over
    `.calls` with `expect` in an `afterEach`, before the `restore()` that
    clears them. The app still gets its answers, the runner shows a real
    diff, and the cause is reported even when the test body passed.
  - The fallback, an `expect` inside a resolver, works but fails the app's
    call: the first error reported is the symptom (e.g. an HTTP 500 from the
    app), with the cause second.
  - `partial` for "only these struct fields": at any depth, in structs inside
    arrays, with matchers as field values. Struct args are complete without
    it: omitting a field is a type error, not a wildcard. It ranks by what its
    fields pin, so a full exact struct beats it.
  - Matchers for an array arg (a swap path "contains X" or "starts with X"):
    `where` on the whole array; `partial` is only for structs.
  - Overloads: with matchers, the exact args pick the overload; if they can't,
    registration throws "ambiguous overload". A `partial` doesn't help pick,
    even when only one overload's struct has its fields.
  - An args-less mock (`fn()`) on an overloaded function throws "ambiguous
    overload": pin args, e.g. `[match.any()]`, to choose one. A default for
    an overloaded name answers every overload.
  - Matchers can't be return values.
- [ ] Return values: named outputs as objects, partial structs zero-filled,
      `zeroResult`, resolvers that receive the call.
- [ ] Reverts: reason strings, custom errors, panics, raw data, `revert()` in
      resolvers, and what viem throws.
- [ ] Multicall: batching, `batch` info on calls, how reverts and faults
      behave inside a batch.
- [ ] `mock.empty(address)` for addresses without code.
- [ ] Limits: `.once()` and `.times(n)` before the answer, on every builder
      (contracts, actions, `method`). Show:
  - Sequences: limited mocks go ahead of unlimited ones as specific, oldest
    first, so `once().reverts(…)` then `returns(…)` plays out as written,
    in either registration order (like Vitest's `mockReturnValueOnce`).
    Specificity still comes first.
  - A used-up mock steps aside; with nothing behind it, the call isn't
    mocked, and "Registered:" shows `once, used up`.
  - Each multicall sub-call uses an answer.
  - `clearCalls()` keeps counts; `restore()` refills them, so a baseline
    `.once()` is fresh in every test.
  - `assertAllUsed()`: answering at least once counts as used; messages show
    what's left (`3 times, 2 left`).

## 4. Failures: `.fails()` vs `.reverts()`

- [ ] A fault is a network failure. It throws `HttpRequestError`,
      `RpcRequestError` or `TimeoutError`, viem retries it by its own rules,
      and it fails a whole multicall batch.
- [ ] A revert is the contract refusing. It throws
      `ContractFunctionRevertedError`, is never retried, and fails only its
      own result in a multicall.
- [ ] Errors match a real node's, and how far that's checked: reverts reach
      viem as the `RpcRequestError` (code 3) a node causes through the `http`
      transport, worded as reth words them (Ethereum's and Base's public
      endpoints run reth); faults use the `http` transport's own errors, with
      the same retries. Tested against responses captured from reth, geth and
      its forks (Arbitrum, Avalanche, Linea), BSC, zkSync and Scroll.
- [ ] Classify errors by viem's classes and decoded data
      (`ContractFunctionRevertedError`, `errorName`, `reason`), never by
      message text: the wording differs by node (`<empty>` vs an empty
      reason, panic descriptions, BSC appending the data), in production too.
- [ ] Test error handling through the transport, not with hand-built viem
      errors, which are easy to get subtly wrong. A dogfood app modelled a
      rate limit as a JSON-RPC error with code 429, which providers rarely
      send, instead of the HTTP 429 response viem raises as
      `HttpRequestError`. Its handler turned real 429s into outages, and its
      tests never noticed. With `failRequests({ status: 429 })` and the other
      fault kinds, the app's handling runs against the errors viem really
      throws. Show each fault kind next to the error it produces.
- [ ] Known difference: Scroll sends a bare `revert()` (no data) as `-32000`,
      so viem gives no `ContractFunctionRevertedError` there; the mock, like
      reth, does.
- [ ] A node's refusals by name, where a node refuses a transaction:
      `.fails("insufficientFunds" | "feeCapTooLow" | "tipAboveFeeCap")` (and
      `fail(name)` in resolvers) on `estimateGas` mocks and `simulate` mocks.
      Each sends reth's code and message, which is what viem names them by
      (`InsufficientFundsError`, `FeeCapTooLowError`, `TipAboveFeeCapError`);
      writing the text by hand gets you `UnknownNodeError` if it's off.
  - `"insufficientFunds"` words it as reth does: `EVM error: OutOfFunds`
    for a request without fees, and `insufficient funds for gas * price +
    value: have 0 want <value>` for one with them (a local account's
    always has them). The balance it reports is always 0: it doesn't read
    `getBalance` mocks. viem names both the same.
  - Not on reads or other actions, where no node says them. For anything
    else a node says, `fails({ code, message })`.
  - Assert the class, e.g. `err.walk((e) => e instanceof
    InsufficientFundsError)`, not the code or text: those are reth's, and
    other clients send other codes and wordings that viem names the same.
    Checked against captures (2026-10-31) from geth, an OP Stack geth fork
    (Mantle), Arbitrum Nitro, Erigon and Nethermind: all three names give
    the same viem class. Besu wasn't checked (no public endpoint ran it).
  - Known difference: zkSync Era sends insufficient funds as code 3 (a
    revert, `data: "0x"`), so viem gives `ExecutionRevertedError` there, not
    `InsufficientFundsError`; and it doesn't check fee caps in estimates,
    so it never says the other two. An app on zkSync that handles
    insufficient funds by class needs a revert branch too, in production
    as well as in tests.
  - Most clients check the balance against the fee cap first: from an
    empty account, geth-family nodes say "insufficient funds" for any
    estimate with fees, before any fee-cap error.
- [ ] `failRequests()` for transport-wide faults, versus `.fails()` and
      `fail()` for one function.
- [ ] Recovering after a failure: `.once().fails(…)` or `.times(n).fails(…)`
      next to a mock that answers. Retries use up answers, so with viem's
      default 3 retries, `.times(3)` still succeeds and `.times(4)` fails the
      call. Plain `.fails()` fails every retry.
- [ ] The retry footgun, both ways:
  - Expecting the app to see an error, but a limited fault let viem's retry
    succeed: the mock can't tell (nothing went wrong on its side), so say it
    plainly. `.once().fails()` tests recovery; to test the app seeing the
    error, use `.fails()` without a limit, or `retryCount: 0` on the
    transport (`mock.publicClient({}, { retryCount: 0 })` or
    `mock.transport({ retryCount: 0 })`). `formatHistory()` shows it as a
    fault, then a `(retry)`.
  - A retry finding nothing behind a used-up fault: the "not mocked" error
    says it's a retry and gives the transport's `retryCount` (the default
    wording under `fallback()`, which retries itself).

## 5. Node data: `mock.actions` and `mock.method`

- [ ] `getBalance`, `getCode`, `getStorageAt`, `getBlock`, `getTransactionReceipt`, `getTransaction`, `getTransactionCount` and the fee actions, with
      values in viem's types.
- [ ] Generated blocks: what's generated (numbers, linked hashes, timestamps
      from `timestamp` and `chain.blockTime`, the base fee from `fees`), and
      what's zero.
- [ ] Fees: `createMockRpc({ fees: { baseFeePerGas, maxPriorityFeePerGas } })`,
      default 10 gwei and 1 gwei. Every fee answer follows from them, as on a
      node: blocks' `baseFeePerGas`, `eth_maxPriorityFeePerGas` (the tip),
      and `eth_gasPrice` (their sum, as reth suggests). So viem's
      `estimateFeesPerGas()` works unmocked: `maxFeePerGas` = base × 1.2 + tip
      = 13 gwei (the multiplier is viem's, or `chain.fees.baseFeeMultiplier`).
      `eth_blobBaseFee` is 1 wei. Show:
  - Set `fees` rather than mocking one answer: a mocked `getGasPrice` doesn't
    change the blocks' base fee, so answers that a node keeps consistent
    stop agreeing.
  - `mock.setFees({ … })` changes them mid-test or per test on a shared
    mock (e.g. a fee spike for a "gas is high" warning), from the current
    block on: earlier blocks keep theirs, so fee histories show the change.
    Fees left out stay; `restore()` and `reset()` undo it.
  - Mock answers for what `fees` can't say: `mock.actions.getGasPrice()`,
    `estimateMaxPriorityFeePerGas()`, `getBlobBaseFee()`, e.g. `.fails(…)`.
  - Pitfall: viem's `estimateMaxPriorityFeePerGas()` (and so
    `estimateFeesPerGas()`) doesn't fail when `eth_maxPriorityFeePerGas`
    does; it falls back to `eth_gasPrice` minus the base fee. To test a
    failure, fail both.
  - `getFeeHistory`: the generated blocks' base fees (plus the next
    block's), no gas used, and zero rewards, as a node reports empty
    blocks. reth's shape: blob fields too, `reward` only
    with `rewardPercentiles`, counts capped at 1024 and at block 0. Refused
    as reth refuses them: a newest block past the head, percentiles out of
    order or outside 0–100. Mock fields merge over the generated history,
    e.g. `.returns({ gasUsedRatio: [0.9] })`.
  - Recipe for apps with their own fee estimator, which reads rewards (and
    would suggest a zero tip unmocked, as on a quiet chain):
    `mock.actions.getFeeHistory().returns(({ blockCount }) => ({ reward:
    Array.from({ length: blockCount }, () => [parseGwei("1")]) }))`, for
    counts within the cap and the chain's length.
  - Pitfall (in production too): `getFeeHistory({ blockCount: 0 })` throws
    a `TypeError` in viem: reth answers a count of 0 without `baseFeePerGas`,
    which viem's formatter reads.
  - Chains with their own fee logic in viem (Linea, Celo; HyperEVM's
    multiplier) send other requests, e.g. `linea_estimateGas`: mock those
    with `mock.method()`.
- [ ] Receipts: the defaults (status `"success"`, block, log context), and
      `.returns(null)` for "not found".
- [ ] Transactions: `mock.actions.getTransaction({ hash }).returns(fields)`,
      by hash only. Defaults: an `"eip1559"` transaction mined in the current
      block at index 0, with the block's timestamp, that paid the suggested
      fees from `fees` (tip, and a max fee of base + tip, so its effective
      `gasPrice` is base + tip), a zero signature, and zero for the rest.
  - Typed by `type`: each of viem's five types takes only its own fields
    (`{ type: "legacy", maxFeePerGas }` is a type error, and throws for
    untyped callers). The type is never guessed from the fields.
  - viem types an EIP-1559 transaction's `gasPrice` as `undefined`, though
    nodes send it and viem returns it; it's derived from the fees here.
  - Pending: `blockNumber: null`, with a null block hash and index and no
    timestamp; it's priced at its max fee, as a node can't know the
    effective one yet (not captured from a node yet).
  - `mock.buildTransaction(fields)` is what `.returns(fields)` answers, typed
    as viem's transaction of that type, for `toEqual` and props. Like
    every builder it's on the mock, because its defaults come from the
    mock: the current block, its timestamp and fees, and the chain. Where
    there's no mock (props, a parser's unit test), `createMockRpc()` needs
    no client or transport.
  - Pitfall: a transaction and its receipt are separate mocks; pin both to
    the same hash and keep their fields consistent yourself (the mock
    doesn't sync them). `waitForTransactionReceipt` asks for the
    transaction only while the receipt is missing, and
    `getTransactionConfirmations` whenever it's given a hash.
  - Lookups by block and index, or by sender and nonce, aren't typed yet:
    `mock.method()`.
- [ ] Event logs for receipts: `contract.events.Transfer({ from, to, value })`
      builds a log's content (address, topics, data) with no position; the
      receipt places it. Show:
  - Indexed args are required (filters match on them, so a zero would
    quietly miss); the rest may be left out, at any depth of a struct, and
    are zero-filled as in `.returns()`. Unnamed inputs take every arg, in
    order. Args are optional when none is indexed.
  - Indexed `string` and `bytes` args take the value, but decode as its
    keccak256 hash (viem's types say `string`). Indexed structs and arrays
    aren't supported yet.
  - Overloaded events use the overload the args fit; "ambiguous" when
    several do.
  - A receipt's log that names another block or transaction throws (e.g. a
    `mock.buildLog()` result for another block). An emitted log fits the
    receipt of its own transaction; one emitted as a block's second
    transaction needs the receipt's `transactionIndex: 1` too.
  - `mock.buildLog({ abi, address, eventName, args, blockNumber, … })` for a
    complete viem log where no mock places it (`toEqual`, Storybook props,
    a function that parses logs). Inside a mock, receipts and `emit` place
    logs themselves, so they take `contract.events` values. For a receipt's
    logs from a contract the app decodes but never calls (an indexer, a
    receipt parser), `contractEvents({ abi, address })` builds the same logs
    without registering it, so it doesn't answer `getCode`, claim its
    address, or show in "Registered" lists. `emit` still needs the contract
    registered (`mock.contract({ abi, address })`, no mocks needed), since
    `getLogs` treats an unknown address as unmocked. And
    `mock.buildReceipt(fields)` for the receipt `.returns(fields)` answers
    (pass `transactionHash` to match the request's). Both default to the
    mock's current block. Both share the mock's encoding and
    defaults, so `toEqual` against what the app got works.
- [ ] Emitting logs for `getLogs`: `contract.emit.Transfer(args, options)`, or
      `mock.emit(logs, options)` for several logs in one transaction
      (e.g. a swap's transfers and its `Swap`). Show:
  - One call is one transaction in one block: the current block, a
    `blockNumber`, or a newly mined one with `{ mine: true }` (what a
    watcher needs: it only reads blocks mined after its last poll). Logs
    in a block after the head appear once `mine()` reaches it.
  - Positions are assigned: `logIndex` counts per block, each call is the
    block's next transaction, with a generated hash. Pass `transactionHash`
    to match a mocked receipt, or to add logs to the block's last
    transaction. A block's transactions go in order.
  - `emit` returns the placed logs, which equal what `getLogs` answers and
    can go into a mocked receipt.
  - Logs come only from registered contracts; `getLogs` for an address
    with no mocked contract is unhandled (a real node would quietly answer
    `[]`, hiding the wrong address; viem checks a result's event and args,
    never its address). `empty()` addresses have no logs.
  - Filtering is a node's: addresses, topics (`null` for any, arrays for
    any of several), and blocks. Without a range, only the current block
    (a common production bug the mock reproduces).
  - Refusals are reth's, as viem's errors: a range past the head or
    ending before it starts, a block hash with a range, an unknown block
    hash, more than 4 topics. They're answers, not unhandled; history shows
    `✗ rpc error`.
  - `mock.logs` lists every emitted log. `restore()` removes logs emitted
    since the checkpoint; `clearCalls()` keeps them.
  - Logs carry `blockTimestamp` (reth sends it; some nodes don't), from the
    generated block: in `getLogs`, in receipts, and from `mock.buildLog()`,
    so an emitted log equals the receipt's. A receipt log with another
    block's timestamp is refused, like one with another block. A `getBlock`
    mock with another timestamp doesn't change it.
  - Testing for a node that doesn't send it (older versions, some L2s and
    providers; viem types it optional): give a log `blockTimestamp:
    undefined`, in a receipt's logs or a `getLogs` mock's answer, e.g.
    `{ ...log, blockTimestamp: undefined }`. The mock answers it without one.
- [ ] `mock.actions.getLogs(pins)` for one request rather than the logs:
      faults, limits, and overrides. Show:
  - Pins match the decoded filter (`address`, `topics`, `fromBlock`,
    `toBlock` as resolved bigints, `blockHash`), with matchers.
  - A mock answers before the emitted logs and the node's rules, so an
    override works for an address without a contract or a range past the
    head. `.returns([...])` takes placed logs (from `emit()` or
    `mock.buildLog()`), not `contract.events` content; `.returns()` is `[]`.
  - Recipes: a block range cap, with a resolver that fails big ranges and
    answers `logs` (the emitted logs the filter matches) otherwise; a
    result cap, failing when `logs` is too long; and `.once().fails(…)` for
    one failed request. Use a real node's error so the app's range-splitting
    code sees what production sends: reth's `-32602 "query exceeds max
    results 20000, retry with the range A-B"`, or Linea's `-32602 "range
    49999 exceeds limit of 10000"`.
  - Reading `logs` for a filter the store refuses throws that refusal, as
    if unmocked; it's not reported as the resolver's error.
- [ ] Watching events (`watchContractEvent`, `watchEvent`, wagmi's
      `useWatchContractEvent`). Show:
  - No websockets needed: on a custom transport viem polls. Filters
    (`eth_newFilter` and the rest) aren't supported; the mock refuses them
    as many public RPC endpoints do (`-32601`, not unhandled), so viem's
    watchers poll `eth_getLogs` for new blocks, as they would against
    those endpoints. To test code that uses filters directly, mock the
    methods with `mock.method()` (you keep the filter's state).
  - A watcher only reads blocks mined after it started: emit with
    `{ mine: true }`. Logs from before it started aren't delivered, as on
    a real chain. Several blocks mined between polls arrive together (or
    one log per call with `batch: false`).
  - Timing: `mock.publicClient()` polls every 50ms; viem's default is up to
    4s, longer than `vi.waitFor`'s 1s timeout, so clients you build
    yourself (wagmi configs) want a short `pollingInterval`. Wait with
    `vi.waitFor(…)`, or use fake timers and run one poll at a time,
    whatever the interval: `vi.useFakeTimers()`, then
    `await vi.runOnlyPendingTimersAsync()` once before emitting (the
    watcher notes the current block) and once after (it reads the new
    one). Advancing by a fixed time instead runs one poll per interval.
  - Pitfall (a viem bug, in production too): viem's polling skips a fetch
    when the previous block number is `0n` (it checks it for truthiness).
    Watching from block 0 loses the logs in block 1; later ones arrive.
    `fromBlock: 1n` loses the whole backfill. The mock starts at block 1,
    so only `createMockRpc({ blockNumber: 0n })` or `fromBlock: 1n` hit it;
    use `fromBlock: 0n` to backfill from the start. Remove once viem fixes
    it (reported upstream; link the issue).
- [ ] Strict by default for data the test owns (balances, receipts, nonces), and how
      to opt into real-node defaults with args-less mocks.
- [ ] Block tags: calls at a block keep the tag they asked for (`getBalance`,
      `getCode`, `getStorageAt`, `getTransactionCount`, `getBlock`, `getFeeHistory`,
      `estimateGas`): `"latest"` when none was given, and none for a block
      number. A pin without a tag matches any block.
- [ ] Nonces: pin `getTransactionCount`'s `{ address, blockTag: "pending" }`
      apart from `"latest"` (a node counts transactions waiting to be mined
      in `"pending"`), e.g. for a stuck transaction. viem asks for `"pending"` when preparing a transaction
      for a local account. Nonces don't follow sends yet: mock them.
- [ ] Gas estimates: `mock.actions.estimateGas({ account, to, value, data })`
      answers `estimateGas` and the gas viem prepares a transaction with.
      Unmocked, a plain transfer (no data) to an address without code is
      21000 gas, as a node estimates it, so sending ETH needs no mock;
      anything else isn't answered.
  - 21000 is what reth, geth, Erigon, Nethermind and Arbitrum estimate. On
    zkSync Era a plain transfer estimates far higher (146780 when
    captured): mock the estimate if a test there depends on the number.
  - The call has the request's fees and nonce when it sent them, e.g. for
    a resolver; `value` is `0n` when it sent none, so pinning `value: 0n`
    matches those.
  - Answers are gas, a bigint: there's no `.returns()` without a value,
    since a node never estimates zero.
  - A registered contract owns its functions: its `estimateGas` mocks and
    defaults answer estimates of them first, and action mocks answer the
    rest, by the usual rules. So an args-less
    `mock.actions.estimateGas().returns(100_000n)` in shared setup is a
    fallback for every write, and a test's contract mock overrides it. To
    fail an estimate of a function the contract mocks, fail it there:
    `token.estimateGas.transfer().fails("insufficientFunds")`.
  - Estimating with a local account first prepares the transaction, which
    asks for the nonce: mock `getTransactionCount` too.
- [ ] Storage: `mock.actions.getStorageAt({ address, slot }).returns(value)`.
      Slots in pins and requests are compared as 32 bytes (`"0x0"` matches
      slot zero written in full); values are up to 32 bytes, padded to 32 as
      a node sends them, so `.returns("0x1")` or `.returns(address)` works.
      Unmocked, an `empty()` address reads as zero, as for any address
      without code; registered contracts and unknown addresses aren't
      answered.
  - Recipe: a proxy's EIP-1967 implementation slot (`keccak256(
    "eip1967.proxy.implementation") - 1`), returning the implementation's
    address; the app reads it with `getAddress(slice(value, 12))`.
- [ ] `mock.method()` for any other method, with raw JSON-RPC values.
- [ ] Methods the mock refuses as unsupported (`-32601`, not unhandled), so
      clients use ones it answers: filters (above) and `eth_fillTransaction`.
      viem tries `eth_fillTransaction` first when preparing a transaction for
      a local account (writes, and `estimateGas` with a local account) and,
      once refused, fills the nonce, fees, and gas with their own requests,
      which are what tests mock. Mock it with
      `mock.method("eth_fillTransaction")` to test code that relies on it.
  - In production it varies (captured 2026-10-31): reth, geth, Nethermind
    and zkSync support it; Arbitrum and Erigon refuse it with `-32601`, as
    the mock does, which viem remembers per client. Some gateways refuse it
    another way (Base's public RPC with HTTP 401, Mantle's with HTTP 403),
    and geth-family nodes fail it for an empty account; after those, viem
    falls back without remembering, so it tries again on every prepare. The
    transaction viem builds is the same either way.

## 6. Assertions and error messages

- [ ] `assertNoUnhandled()` (catches errors the app swallowed) and
      `assertAllUsed()` (catches mocks that never answered: wrong args, or a
      call the app no longer makes).
- [ ] What `assertAllUsed()` checks: every registration, args-less ones and
      `.fails()`/`.reverts()` overrides included, except contract `defaults`.
      Explain why: defaults are shared setup, answers many tests use but no
      single test must, like the checkpoint baseline. Not "never hit".
      Show the surprise case: a fallback shadowed by a more specific mock
      (`fn()` plus `fn([x])`, only ever called with `x`) is reported.
- [ ] Registering and answering are separate calls: `fn(args)` registers
      the mock, then `.returns(value)` answers it. A mock registered without
      an answer is reported ("without an answer", with how to give it one),
      and steps aside for any mock that has one. A call that throws changes
      nothing, so a rejected `.returns(value)` (a value that can't be
      encoded, a receipt log placed elsewhere) leaves the mock registered
      without an answer. App tests never see this beyond the throw itself.
      A test of a helper that registers mocks and is expected to throw
      (`expect(() => receiptFor(mock, bad)).toThrow()`) should use a mock of
      its own, or a checkpoint around the throw, if an `afterEach` runs
      `assertAllUsed()`.
- [ ] Where shared fallbacks go: on contracts, in `defaults`. For actions,
      `method`, and narrowed fallbacks (`fn([match.where(…)])`), which have
      no `defaults`, take a checkpoint after registering them and use
      `restore({ assertAllUsed: true })`. That includes a per-test setup
      function: end it with `mock.checkpoint()` and return the checkpoint.
- [ ] How to read "No mock for …" and its "Registered:" list: each mock
      registered for the function, with why it didn't answer. A mock whose
      args differ says which (`← owner didn't match`, by the ABI's input
      names, `arg N` for unnamed ones, the key for action params), as
      matching found it, including the predicate that said no. A mock used
      up or without an answer says so, and still names an exact arg that
      differs (it wouldn't have matched either); its predicates aren't run
      for the message.
- [ ] How to read "never answered a call": under each unused mock, the calls
      its function received (up to 3, then a count) and the first arg, field
      or param that didn't match, by its ABI name; "matches; another mock
      answered it" for a shadowed mock; "received no calls" when the app never
      made it. Args that matched show as `…`, so the line shows what differed
      (the whole call when everything matched). Show an example.
- [ ] Failed checks' stacks start at the caller (the test or hook), not in
      the mock, so the runner's code frame points at the test.
- [ ] Addresses in messages are always checksummed. Address args are
      normalized at registration, which also rejects malformed ones.
- [ ] Addresses in answers (receipts, their logs, emitted logs, blocks) are
      lowercase, as nodes send them; viem passes them through as is. So
      `log.address === USDC` fails against the mock as it does in
      production: compare with `isAddressEqual`. Builders' logs and receipts
      are lowercase too, so they still equal what the app got. Decoded
      values (event args, call results) are checksummed by viem.
- [ ] `contract({ …, name: "USDC" })`: names show in every message (and in
      history), next to the address.

## 7. Seeing what the app asked: history and debug output

- [ ] `mock.history`: one entry per JSON-RPC request, discriminated by
      `type` (`call`, `multicall`, `action`, `method`, `builtIn`), each with an
      `outcome` (`result` in viem's types, `revert` decoded, `fault` with its
      source, `unhandled`, `error`, `pending`). Retries are separate entries.
- [ ] `mock.formatHistory({ builtIns })` for `console.log` while debugging,
      with an example of its output.
- [ ] `createMockRpc({ debug })`: `true` for `console.log`, or a function
      `(line, entry) => …` to use any logger, with examples for pino- and
      winston-style loggers and `process.stdout`. Warn that entries contain
      bigints, which `JSON.stringify` rejects.
- [ ] When to use which: `formatHistory()` after a failure, `debug` when a
      test times out before it could print anything. Under Vitest, `debug`
      gets a `stdout | file > test` header per line, so printing history only
      when a test fails reads better.
- [ ] `historyOnFailure` (default 10, `false` to turn off): the mock's own
      failed checks (`assertNoUnhandled()`, `assertAllUsed()`, `restore()`'s
      checks, `checkpoint()`) end with the last requests, numbered as in
      `formatHistory()`, without built-ins. Request errors ("No mock for …")
      don't, since they reach the app and already list what's registered.
- [ ] For a failing `expect` in the test body, which the mock can't see: one
      line in the runner's failure hook, e.g. Vitest's
      `onTestFailed(() => console.log(mock.formatHistory({ builtIns: false })))`.
      Jest has no equivalent hook; print in `afterEach` when needed.
- [ ] What history shows: `(retry)` after a fault, named outputs by name
      (the value stays the tuple viem returns), `(no outputs)`, and
      `abiItem` on each contract call record.

## 8. Sharing setup across tests: `checkpoint()` and `restore()`

- [ ] The pattern: register shared contracts and mocks once (at module scope,
      or in a describe's `beforeAll`), then `checkpoint()`, then
      `restore({ assertNoUnhandled: true, assertAllUsed: true })` in
      `afterEach`. Everything registered at checkpoint time is the baseline.
- [ ] Why the checks go in `restore()`: it checks, restores, then throws.
      Vitest skips the remaining `afterEach` hooks once one throws, so a
      separate assertion hook that fails leaves later tests running on stale
      mocks, and one failure shows up as many.
- [ ] `assertAllUsed` in `restore()` checks only mocks registered since the
      checkpoint; the standalone `assertAllUsed()` checks everything but
      `defaults`.
- [ ] Other `afterEach` hooks that throw can still skip the restore. Explain
      when a `beforeEach` backstop is safe: only when the previous restore
      didn't run, since an unconditional one wipes nested suites' setup.
- [ ] The whole pattern as copyable code, Vitest and Jest side by side (the
      hooks are the same; `node:test` names them `before`/`afterEach`):
      `checkpoint()` in `beforeAll`, `restore({ checks })` in `afterEach`, and
      a `beforeEach` backstop guarded by a flag the `afterEach` sets. There's
      no runner-specific helper; this is the supported way. Vitest's
      `afterEach` can read the test's result (`task.result?.state`) to print
      history only on failure; Jest's can't see the result, so its recipe
      prints always, or behind an env flag.
- [ ] Say plainly that the conditional backstop prevents one failure turning
      into many, but doesn't make nesting safe: an outer per-test restore
      still wipes a nested describe's `beforeAll` setup after its first test.
- [ ] `checkpoint()` throws on unanswered requests since the last clear, and
      tests that trigger a missing mock on purpose need `clearCalls()`.
- [ ] Nesting:
  - checkpoints form a stack, and `reset()` invalidates all of them;
  - restore at one level only per test, so describes that restore an outer
    checkpoint per test are siblings of describes with their own setup, not
    parents of them;
  - a describe with its own setup takes a checkpoint on each side of it:
    ```ts
    let outer: MockCheckpoint, suite: MockCheckpoint;
    beforeAll(() => {
      outer = rpc.checkpoint();
      registerPools(rpc);
      suite = rpc.checkpoint();
    });
    afterEach(() => suite.restore({ assertNoUnhandled: true }));
    afterAll(() => outer.restore());
    ```
- [ ] What's restored (registrations, baseline builders' answers and limits,
      `.once()`/`.times(n)` counts, block number, fees, batch ids, fault counts) and what isn't (state that resolvers
      close over). History is cleared, not rolled back.
- [ ] Removed handles throw when used to register. Their `.calls` can still
      be read.
- [ ] Requests still in flight at `restore()` time land in the next test's
      history.

## 9. Concurrent tests

- [ ] Every `createMockRpc()` is independent, with no global state, so one
      mock per concurrent test is safe.
- [ ] One mock shared by concurrent tests is never safe, with or without
      checkpoints. Checkpoints are for serial suites.
- [ ] The per-test setup factory (inferred types, no `let`s), and vitest
      fixtures (`test.extend`) as the same idea:
      `ts
      function setup() {
        const rpc = createMockRpc({ chain: base });
        const quoter = rpc.contract({ abi: quoterAbi, address: QUOTER, defaults: { … } });
        return { rpc, quoter, client: rpc.publicClient() };
      }
      test.concurrent("…", async () => {
        const { quoter, client } = setup();
      });
      `
- [ ] Setup functions that register fallbacks other than `defaults` end with
      a checkpoint, so `restore({ assertAllUsed: true })` checks only the
      test's own mocks (see section 6).
- [ ] Apps that read clients from a global share them across concurrent
      tests whatever the mock does: inject clients, or scope them per test
      (e.g. `AsyncLocalStorage`).

## 10. Recipes

- [ ] A contract whose address is only known at run time: register it per
      test, next to the fixture that creates it.
- [ ] One mock per chain, for code that talks to several chains.
- [ ] A shared file of app-specific presets (a price feed, a quoter) that
      tests reuse.
- [ ] Replacing hand-built `vi.mock` fakes of `getTransactionReceipt` and
      `getBlock` with receipts and generated blocks.
- [ ] An answer that changes during a suite (a live price): a default whose
      resolver reads the current value on every call, rather than per-test
      overrides outside `defaults`, which `assertAllUsed()` reports when a
      test doesn't use them.
