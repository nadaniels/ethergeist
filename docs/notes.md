# Documentation to write

The pages the library docs need, and what each must cover. Items are added as
features land; tick them off as pages get written.

## 1. Overview: when to use this, and when to use anvil

- [ ] What it is: a viem transport that answers each JSON-RPC request with
      what the test registered. Fast and deterministic, with no binary and no
      shared process.
- [ ] What it isn't: nothing executes, and no answer is derived from another.
      For example, an added transaction with a `Transfer` log doesn't change any
      balance; state a test wants to change is the test's (section 11).
- [ ] When to use anvil (or an anvil fork) instead: tests that need real
      execution or real chain state.

## 2. Getting started

- [ ] `createMockRpc({ chain, blockNumber, timestamp })`, then
      `mock.publicClient()`, or `createPublicClient({ transport: mock.transport() })`
      with the defaults the helper sets (`cacheTime: 0`, `pollingInterval: 50`,
      `retryDelay: 0`). Say why `cacheTime: 0` matters: a client made
      without it (the app's own, or a wagmi config) caches the block number
      for seconds, so after `restore()` rolls the chain back (say from block
      13 to 10) it asks for logs from block 13, and the mock refuses the
      range as beyond the head, as a node would. Give test clients
      `cacheTime: 0`.
- [ ] Registering a contract, and
      `defaults: { read: { … }, simulate: { … }, estimateGas: { … } }`.
      This is the first setup code everyone writes, so the docs should lead
      with it and repeat it in examples.
      An entry set to `undefined` is no default, as an explicit `undefined`
      is a key left out in a mock's answers and options: write a zero
      default as a value (`balanceOf: 0n`). `.returns()` and
      `.returns(undefined)` are the zero answer, since that's an argument
      left out of a call, not a key.
- [ ] `read` vs `simulate` namespaces (view/pure vs nonpayable/payable),
      mirroring `getContract`, and `estimateGas` (the same functions as
      `simulate`, for `estimateContractGas` and a write's prepare). A
      `simulate` mock doesn't answer estimates: a node runs them
      separately, and the mock doesn't derive one answer from another.
      Estimates answer gas (`.returns(65_000n)`) and revert like `simulate`.
      Every call of every namespace is in `contract.calls` and `mock.calls`,
      in order, each a copy tagged with its `namespace` (`"read"`,
      `"simulate"`, `"estimateGas"`), e.g.
      `usdc.calls.map((call) => call.namespace)`; a function's list is its
      own and untagged: `estimateGas.transfer.calls` holds only its
      estimates, so a `toEqual` on it needs no `namespace`.
- [ ] Test values: `testAddress("alice")` and `testHash("swap-1")`, stable
      and realistic (checksummed, full-width). Say why not random (faker):
      random values rarely find bugs fixed ones miss, and they make messages
      and snapshots change between runs; why not `0x…0001`: it hides
      case-comparison and sorting bugs. Several at once:
      ``Array.from({ length: 3 }, (_, i) => testAddress(`user-${i + 1}`))``.
      The address belongs to a key derived from the label (signing later).
      `testLog("noise")` is a log that matches no event, for a transaction's
      noise; `testLog("noise", { address: USDC })` for an unknown event at a
      contract the code does know (any address).

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
- [ ] Pinning the sender and value: `fn(args, { from, value })` on every
      namespace, e.g. `token.read.balanceOf([bob], { from: alice })` for a
      `msg.sender`-dependent view, `weth.write.deposit([], { value:
      parseEther("1") })`, `token.write.transfer(undefined, { from: alice })`
      for any args from alice. Show:
  - Pins match like args (matchers allowed) and count toward specificity:
    `transfer([bob, 5n], { from: alice })` beats `transfer([bob, 5n])`,
    which beats `transfer(undefined, { from: alice })`.
  - `from` is compared checksummed, in any casing. It doesn't match a
    request without one: viem's `readContract` without an `account` sends
    none, so a pinned `from` needs the app's account on the read.
  - In a multicall, a sub-call is from the Multicall3 address (its
    `msg.sender` on chain), and the batch's sender is `batch.from`, which no
    pin matches. viem's `batch.multicall` only batches reads without an
    account anyway; `client.multicall({ account })` sets `batch.from`.
  - `value` is typed only on payable functions, and a value pinned on a
    nonpayable one throws at registration (an ABI without `as const` types
    it everywhere). A request without a value has `0n`, so `{ value: 0n }`
    matches it.
  - A write mock's pins narrow the estimate it implies or reverts too: a
    send's estimate from someone else isn't implied, and the miss says the
    write mock's `from` didn't match.
  - Messages show pins after the call: `transfer(*) { from: 0x… }`, `← {
    from } didn't match` (braced, so it can't be read as an input named
    `from`, as in `transferFrom`), and the call's own `from` or `value`
    where they differ.
  - `defaults` take no pins: they're one answer per function.
- [ ] Return values: named outputs as objects, partial structs zero-filled,
      `zeroResult`, resolvers that receive the call.
- [ ] Reverts: reason strings, custom errors, panics, raw data, `revert()` in
      resolvers, and what viem throws.
- [ ] Multicall: batching, `batch` info on calls, how reverts and faults
      behave inside a batch.
- [ ] Writes: `usdc.write.transfer([bob, 5n]).emits([log])` answers the
      app's `writeContract`, then `waitForTransactionReceipt`, with nothing
      for gas, fees or the nonce. Show:
  - A write mock answers a send of its function (`eth_sendTransaction`,
    `eth_sendRawTransaction`) to the contract. Only write mocks and
    `defaults.write` answer it: `mock.actions.sendTransaction` doesn't,
    so a send the write mocks miss is the contract's miss, which names the
    `sendTransaction` mocks that match it. The catch-all
    for a function is an args-less `write.transfer()` or `defaults.write`.
    The transaction is mined in a new block, as every send is (section 5,
    "Sends").
  - `.returns()` takes what the chain did, as a send mock's does (`{ logs,
    status, gasUsed, effectiveGasPrice }`), not the function's return
    value: nothing on chain reads that, and `simulate` has its own mock.
    `write.transfer().returns(true)` is a type error. A call to a contract
    has no `contractAddress`.
  - Resolvers get the call (`from` is the sender) and `emit(logs)`, which
    adds logs to the transaction; `mock.addTransaction()` and
    `contract.emit` are refused inside one (up to its first `await`; code
    elsewhere can still add transactions while it waits), as they would
    place a transaction of their own mid-send. `revert(spec)` mines
    it reverted, dropping what it emitted. Send mocks' resolvers get both
    too.
  - The estimate: a matching write mock answers the transaction's
    `eth_estimateGas` with 100,000 gas when no estimate mock of the
    contract's does (`estimateGas.fn()`, `defaults.estimateGas`; an
    action's `mock.actions.estimateGas` never answers a contract's
    function), without running it or using up a `.once()`; it's recorded
    as an `estimateGas` call, and doesn't count as used for
    `assertAllUsed`. A `.reverts()` one reverts it instead, before any
    estimate mock (below).
  - Reverts, by client path: `.reverts(spec)` reverts the estimate, before
    any estimate mock (the contract's own `estimateGas` mocks and defaults
    included), so a local account's `writeContract` throws the decoded
    error before sending. That revert is the mock's answer: it counts as
    used for `assertAllUsed`, and spends a `.once()`, so an app's own
    estimate before the write (a fee preview) spends it too, and the
    write's estimate gets the next answer. With `gas` set, or
    from a node's account, nothing estimates and it's mined reverted.
    `.returns({ status: "reverted" })` passes the estimate (an `estimateGas`
    mock then sets its number) and mines it reverted for any client. A resolver's
    `revert()` runs only at the send, so it's always mined reverted: for an
    estimate-time revert, add `estimateGas.fn(args).reverts(spec)`.
    `.refuses("insufficientFunds")` (or `"nonceTooLow"`, and the other names
    a send takes) is the node refusing the send: nothing goes on the chain.
  - `simulate` is separate: wagmi's simulate-then-write needs both
    registered, and the `eth_call` wagmi replays for a reverted receipt
    answers from `simulate`.
  - `defaults.write`, like other defaults, answers every send of a
    function and is exempt from `assertAllUsed`.
  - Calls: `write.fn.calls` holds the function's calls (`from` always
    set); nonce, gas and fees are on `mock.actions.sendTransaction.calls`,
    and what was mined on `mock.transactions`. `contract.calls` and
    `mock.calls` tag them `namespace: "write"`.
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
  - A request a mock answered uses its answer even when it then fails or
    is refused: a `.fails()` or `.refuses()`, a resolver that throws, or a
    send refused after its mock answered (a log at an `empty()` address).
    The chain doesn't change, but the `.once()` is spent. That's what makes
    `.once().fails(…)` then a normal mock test a retry.
  - `clearCalls()` keeps counts; `restore()` refills them, so a baseline
    `.once()` is fresh in every test.
  - `assertAllUsed()`: answering at least once counts as used; messages show
    what's left (`3 times, 2 left`).

## 4. Failures: `.fails()`, `.refuses()` and `.reverts()`

- [ ] A fault is a network failure. It throws `HttpRequestError`,
      `RpcRequestError` or `TimeoutError`, viem retries it by its own rules,
      and it fails a whole multicall batch.
- [ ] A refusal is the node declining a transaction before running it,
      by name: `.refuses(name)`, and `refuse(name)` in a resolver. It
      throws viem's class for it (below), is never retried, and history
      records it as its own outcome, `✗ refused: nonceTooLow`. `.fails()`
      takes only faults: a name there is a setup error that points at
      `.refuses()`.
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
      `.refuses("insufficientFunds" | "feeCapTooLow" | "tipAboveFeeCap")`
      (and `refuse(name)` in resolvers) on `estimateGas`, `simulate`,
      `write` and `sendTransaction` mocks. Each sends reth's code and
      message, which is what viem names them by (`InsufficientFundsError`,
      `FeeCapTooLowError`, `TipAboveFeeCapError`); writing the text by hand
      gets you `UnknownNodeError` if it's off. Each name is typed where a
      node says it:
  - On sends only (`write`, `mock.actions.sendTransaction`), as a node's
    transaction pool refuses them: `"nonceTooLow"` and `"alreadyKnown"` (a
    double submit), both viem's `NonceTooLowError`, which apps handle by
    resyncing the nonce; `"nonceTooHigh"` (`NonceTooHighError`). An
    estimate or a call doesn't check the nonce. A refused send changes
    nothing: no transaction, no block, and its nonce isn't taken.
  - `"intrinsicGasTooLow"` (`IntrinsicGasTooLowError`): a `gas` below the
    transaction's base cost, on sends and `simulate`. An estimate reports
    it as `"gasExceedsAllowance"`.
  - `"gasExceedsAllowance"` (`ExecutionRevertedError`, viem's revert
    class): the call needs more gas than the request's `gas` allows, on
    `estimateGas` and `simulate`, saying `gas required exceeds allowance
    (<gas>)`; without a `gas` (viem never sends one with an estimate), the
    node's cap, 50,000,000. Not on sends: a send with too little gas is
    mined and runs out, `.returns({ status: "reverted", gasUsed })`
    with its gas limit.
  - Replacement underpriced, underpriced and exceeds block gas limit stay
    faults, `.fails({ code: -32000, message })`: viem shows them as a
    generic `InvalidInputRpcError`, so a name adds nothing.
  - `"insufficientFunds"` is reth's balance check, `insufficient funds for
    gas * price + value: have 0 want <value>`, with or without fees. Reth
    sends `EVM error: OutOfFunds` for a request without fees, which viem
    names `InsufficientFundsError` only from 2.57.12; the balance check's
    wording, every viem does. The balance it reports is always 0: it
    doesn't read `getBalance` mocks.
  - Not on reads or other actions, where no node says them: their types
    have no `.refuses()`. For anything else a node says,
    `.fails({ code, message })`.
  - Assert the class, e.g. `err.walk((e) => e instanceof
    InsufficientFundsError)`, not the code or text: those are reth's, and
    other clients send other codes and wordings that viem names the same.
    Checked against captures (2026-10-31) from geth, an OP Stack geth fork
    (Mantle), Arbitrum Nitro, Erigon and Nethermind: the first three names
    give the same viem class. Besu wasn't checked (no public endpoint ran
    it). The rest send geth's messages, which viem's patterns match; they
    weren't captured.
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
    transport (`mock.publicClient({ retryCount: 0 })` or
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
- [ ] You don't have to use the chain: it holds only what the test
      (`mock.addTransaction`, `contract.emit`) or the app's sends put there,
      and every read can be mocked without it, a receipt with logs included
      (`.returns({ logs })`). An empty chain answers only what's mocked
      (`getLogs` answers `[]`). The rules, for every mock:
  - **The chain answers from its records.** A record is what
    `mock.addTransaction`, `contract.emit` and the app's sends put there;
    receipts, transactions, blocks and `getLogs` agree because they read
    the same record.
  - **A mock answers one method, over what the chain would answer that
    request: its fields win, the rest is the chain's.** For a block past
    the head, a hash the chain doesn't have, or a receipt for one it
    hasn't mined, "the chain's" is zeros, in the block current when a static mock was
    registered or when a resolver answers. `null` and `fail` replace the
    answer whole. A scalar or a list has no fields: the mock is the answer
    (`getBalance`, `getTransactionCount`, `getLogs`). So the order of
    registering a mock and adding its transaction doesn't matter: the
    answer changes when the transaction is mined, as a node's does.
  - **Methods may disagree.** A receipt mock's logs are that receipt's;
    `getLogs` and watchers read the chain. For every method to agree, put
    it on the chain: `mock.addTransaction({ hash, logs })`. For a hash
    that's placed but not mined, a transaction mock answers over the
    pending transaction (its real `from`), while a receipt mock answers
    over zeros (a pending transaction has no receipt), so the two disagree
    on `from` until it's mined.
  - **An answer places its parts.** A receipt's `blockNumber`,
    `blockHash`, `transactionHash` and `transactionIndex` place its logs,
    with that block's timestamp, and their `logIndex` counts on from the
    logs of the chain's transactions before it in that block, whether
    they're the chain's logs or the mock's own. It's counted when the
    receipt answers (or is built), so a transaction added before it later
    shifts it. A mock's logs over a record may still share an index with
    the block's later logs in `getLogs` (methods may disagree); for logs
    every method agrees on, use `mock.addTransaction`. A
    block's `number`, `hash` and `timestamp` place the transactions it
    lists. That's within one answer: a `getBlock` mock's `timestamp` doesn't
    move a receipt's logs, and `getTransaction` for a transaction it lists
    still answers the chain's block. Nothing else is
    derived: `gasUsed` doesn't change `cumulativeGasUsed`, and the bloom
    stays zero.
  - **Every answer is one a node could send, as an object:** a reverted
    transaction has no logs, a pending transaction has no block, hash,
    index or timestamp, and a log is placed once (mocks take a log's
    content). Whether it's the right answer for the request is the test's
    business: a receipt whose `transactionHash` isn't the one asked for is
    allowed.
  - A node's refusals don't run under a mock: a `getLogs`, `getBlock` or
    `getFeeHistory` mock answers past the head, where the chain would
    refuse or find nothing.
- [ ] Receipts: the defaults (status `"success"`, block), and
      `.returns(null)` for "not found".
  - Over a transaction on the chain, a mock changes only what it names:
    `.returns({ status: "reverted" })` keeps the sender, gas and block. A
    reverted status over a transaction with logs is refused (a reverted
    transaction has none): answer this receipt without them,
    `{ status: "reverted", logs: [] }`, or add it reverted,
    `mock.addTransaction({ …, status: "reverted" })`, so every method agrees.
  - `logs` takes their content (`contract.events`, `contractEvents()`,
    `testLog()`), placed in the receipt's block and transaction, indexed
    after the logs of the chain's transactions before it in that block; a
    log that's already placed is refused, and so
    are logs on a reverted receipt. Over a transaction on the chain, they
    replace its logs in that receipt only (`logs: []` is none); `getLogs`
    still answers the chain's.
  - A static receipt for a hash not mined yet, or a static transaction for
    a hash not on the chain, is mined at `.returns()`: it stays in that block as `mine()` adds more, so
    confirmations count up (`waitForTransactionReceipt({ confirmations: 2 })`,
    ethers `wait(2)`). A resolver's is in the block current when it answers,
    and a builder's when it's built.
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
  - Pitfall: for a hash not on the chain, a transaction and its receipt are
    separate mocks; pin both to the same hash and keep their fields
    consistent yourself (the mock doesn't sync them), or add the
    transaction, whose receipt and transaction agree, and mock over it. `waitForTransactionReceipt` asks for the
    transaction only while the receipt is missing, and
    `getTransactionConfirmations` whenever it's given a hash.
  - Lookups by block and index, or by sender and nonce, aren't typed yet:
    `mock.method()`.
- [ ] Event logs for receipts: `contract.events.Transfer({ from, to, value })`
      builds a log's content (address, topics, data) with no position; the
      transaction it goes in places it. Show:
  - Indexed args are required (filters match on them, so a zero would
    quietly miss); the rest may be left out, at any depth of a struct, and
    are zero-filled as in `.returns()`. Unnamed inputs take every arg, in
    order. Args are optional when none is indexed.
  - Indexed `string` and `bytes` args take the value, but decode as its
    keccak256 hash (viem's types say `string`). Indexed structs and arrays
    aren't supported yet.
  - Overloaded events use the overload the args fit; "ambiguous" when
    several do.
  - A log that's already placed (e.g. a `mock.buildLog()` result) is
    refused: it's placed once.
  - For a receipt with logs for a hash the app has, mock its receipt with
    `logs`, which answer that receipt only, or add its transaction,
    `mock.addTransaction({ hash, logs })`, whose receipt, transaction,
    block and `getLogs` answer from it. A transaction mock over one placed
    in a block not mined yet answers over the pending transaction, which
    has no block or index: to answer it mined, give `blockNumber` (and
    `transactionIndex`, 0 otherwise).
  - `mock.buildLog(content, placement?)` places a log's content (from
    `contract.events`, `contractEvents()` or `testLog()`) as a complete viem
    log where no mock places it (`toEqual`, Storybook props, a function that
    parses logs, a `getLogs` mock's answer). `placement` is in a log's own
    words, `{ blockNumber, transactionHash, transactionIndex, logIndex }`:
    left out, the current block and zeros, with nothing counted from the
    chain, so give `logIndex` to match a block with other logs. Receipt
    mocks, added transactions and writes place logs themselves, so they take
    content, and refuse a built log. For a receipt's
    logs from a contract the app decodes but never calls (an indexer, a
    receipt parser), `contractEvents({ abi, address })` builds the same logs
    without registering it, so it doesn't answer `getCode`, claim its
    address, or show in "Registered" lists; `addTransaction` takes them too. And
    `mock.buildReceipt(fields)` for the receipt `.returns(fields)` answers
    for a hash not on the chain (pass `transactionHash` to match the
    request's); its `logs` take content, placed in it. A built receipt is a
    whole receipt: returned over a transaction on the chain, it answers its
    own fields, and no logs. One built with logs is refused at `.returns()`
    (a resolver's throws at the request), since its logs are placed and a
    receipt mock places its own. Both default to the mock's current block.
    Both share the mock's encoding and
    defaults, so `toEqual` against what the app got works.
- [ ] Emitting logs and adding transactions: `contract.emit.Transfer(args,
      options)` for one event, or `mock.addTransaction({ logs, … })` for
      several logs in one transaction (e.g. a swap's transfers and its
      `Swap`), or another transaction the app didn't send. Show:
  - One call is one transaction, placed like a sent one: in a newly mined
    block, so watchers see it. Two `contract.emit` calls are two
    transactions in two blocks: a swap's logs from several contracts go in
    one `mock.addTransaction({ logs: [a, b] })`.
  - `mock.addTransaction(fields)` takes a send's words, all optional:
    `from`, `to`, `value`, `data`, `nonce` from the call; `logs`, `status`
    and `gasUsed` from the outcome; and `blockNumber` and `hash` for where
    it goes. `mock.addTransaction()` is a placeholder: a success from and
    to the zero address, with no input, value, gas or logs. It returns the
    record `mock.transactions` lists, where `data` reads back as
    `fields.input`, as in viem. A reverted one has no logs, and deploys
    (`to: null`) aren't supported. E.g. a wallet's replacement:
    `mock.addTransaction({ from, nonce, to, data, hash })`.
  - Its `hash` is the transaction's, and `contract.emit`'s options take the
    same `blockNumber` and `hash` (`transactionHash` is refused there,
    pointing at `hash`). A log's position is spelled a log's way only in
    `mock.buildLog()`'s placement.
  - Each one mines a block, so it moves a pending
    `waitForTransactionReceipt({ confirmations })` on by one, and the
    clock by one block time: seeding 100 transfers moves `latest`'s
    timestamp by 20 minutes. Seed history with `{ blockNumber }` instead.
  - `{ blockNumber }` places it in that block without mining, after the
    transactions already there: an earlier block for history, the current
    one to share a block, or a later one, which is on the chain once
    `mine()` reaches it (until then its receipt is `null` and its
    transaction pending). So `{ blockNumber: mock.blockNumber + 1n }`
    places a transaction in the next block, while a plain one mines that
    block, after the ones placed there.
  - Positions are assigned: `logIndex` counts per block, each call is the
    block's next transaction, with a generated hash. Pass a hash the app
    already has (one from a URL); a hash already placed is refused,
    since a transaction's receipt never grows.
  - Its receipt, transaction and block answer from it, from its fields or
    their defaults. A receipt or transaction mock for its hash answers over
    it. A `getBlock` mock still lists the block's added transactions,
    placed in the block it answers, unless it sets `transactions`.
  - `contract.emit` returns the placed log, and `addTransaction` the record
    with its placed logs, which equal what `getLogs` and the receipt
    answer.
  - Logs come from any address, registered or not (`contractEvents()`,
    `testLog()`), except one marked `empty()`, which has no code to emit
    them. `getLogs` answers for any address: `[]` where nothing emitted, as
    a node does (viem checks a result's event and args, never its address,
    so a wrong address shows only as no logs).
  - Filtering is a node's: addresses, topics (`null` for any, arrays for
    any of several), and blocks. Without a range, only the current block
    (a common production bug the mock reproduces).
  - Refusals are reth's, as viem's errors: a range past the head or
    ending before it starts, a block hash with a range, an unknown block
    hash, more than 4 topics. They're answers, not unhandled; history shows
    `✗ rpc error`.
  - `mock.logs` lists every emitted log, and `mock.transactions` every
    transaction on the chain, added or sent. They're state: `restore()`
    removes what was added or sent since the checkpoint, `reset()` all of
    it; `clearCalls()` and `historyLimit` keep them.
  - Logs carry `blockTimestamp` (reth sends it; some nodes don't), from the
    generated block: in `getLogs`, in receipts, and from `mock.buildLog()`,
    so an emitted log equals the receipt's. A `getBlock` mock with another
    timestamp doesn't change it.
  - Testing for a node that doesn't send it (older versions, some L2s and
    providers; viem types it optional): give a log `blockTimestamp:
    undefined`, in a `getLogs` mock's answer, e.g.
    `{ ...log, blockTimestamp: undefined }`. The mock answers it without one.
- [ ] `mock.actions.getLogs(pins)` for one request rather than the logs:
      faults, limits, and overrides. Show:
  - Pins match the decoded filter (`address`, `topics`, `fromBlock`,
    `toBlock` as resolved bigints, `blockHash`), with matchers.
  - A mock answers before the emitted logs and the node's rules, so an
    override works for a range past the head. `.returns([...])` takes
    placed logs (from `mock.logs` or `mock.buildLog()`), not `contract.events` content; `.returns()` is `[]`.
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
  - A watcher only reads blocks mined after it started, which a plain emit
    is. Logs from before it started aren't delivered, as on a real chain,
    and nor are ones emitted with `{ blockNumber }` into a block it has
    already read. Several blocks mined between polls arrive together (or
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
- [ ] Strict by default for data the test owns (balances, receipts), and how
      to opt into real-node defaults with args-less mocks.
- [ ] Block tags: calls at a block keep the tag they asked for (`getBalance`,
      `getCode`, `getStorageAt`, `getTransactionCount`, `getBlock`, `getFeeHistory`,
      `estimateGas`): `"latest"` when none was given, and none for a block
      number. A pin without a tag matches any block.
- [ ] Nonces follow sends: unmocked, `getTransactionCount` answers one past
      the highest nonce of the address's transactions (0 if none), so a local
      account's writes take 0, 1, … with no mock. Show:
  - At a block (number or hash), it counts the transactions mined at or
    before it; `"pending"` counts all of them (the same until pending mode, 077).
    viem asks for `"pending"` when preparing a transaction for a local
    account. A transaction added with a `from` counts for it, as a send
    does: without a `nonce` it takes the sender's next, so adds from one
    sender count up; with one, it's taken as given. Added without a
    `from`, it counts for no one.
  - Nonces are taken as sent, unchecked: a raw transaction with nonce 5
    makes the next count 6. A node's refusal is `.refuses("nonceTooLow")`.
  - An `eth_sendTransaction` without a nonce takes the chain's count, as
    a wallet fills it, whatever `getTransactionCount` mocks answer; to
    send a specific one, pass `nonce`.
  - A mock answers first: `.returns(7)` is the answer and doesn't count
    up, so a local account's two identical writes sign the same bytes and
    are one transaction. For a starting nonce that does count up, a
    resolver reads `count`, the chain's answer:
    `.returns(({ count }) => Math.max(7, count))` (the count already
    includes the sends from 7 on). It starts only the sends that ask for
    the nonce: an `eth_sendTransaction` without one still takes the
    chain's count. Pin `blockTag: "pending"`
    apart from `"latest"`, e.g. for a stuck transaction.
- [ ] Gas estimates: `mock.actions.estimateGas({ from, to, value, data })`
      answers `estimateGas` and the gas viem prepares a transaction with.
      Unmocked, a plain transfer (no data) to an address without code is
      21000 gas, as a node estimates it, so sending ETH needs no mock;
      anything else isn't answered.
  - 21000 is what reth, geth, Erigon, Nethermind and Arbitrum estimate. On
    zkSync Era a plain transfer estimates far higher (146780 when
    captured): mock the estimate if a test there depends on the number.
  - The sender is `from`, as the request and a write mock's pins say it
    (viem's `account` option is what sets it). The call has the request's
    fees and nonce when it sent them, e.g. for a resolver; `value` is `0n`
    when it sent none, so pinning `value: 0n` matches those.
  - Answers are gas, a bigint: there's no `.returns()` without a value,
    since a node never estimates zero.
  - `.reverts(spec)` reverts the estimate, as a contract's estimate
    revert does (code 3 with the revert data, viem's
    `ExecutionRevertedError`), so a client that estimates first (a local
    account) throws before it sends: a test of "simulation fails, the
    wallet isn't asked" for calldata to an address that isn't a
    registered contract. A JSON-RPC account's send isn't estimated by
    viem, and the mock's send doesn't ask estimate mocks, so it isn't
    refused. Without an ABI it takes a reason, a panic code or raw data,
    like a send's `.reverts()`; a custom error is
    `{ data: encodeErrorResult(…) }`. A resolver's `revert(spec)` takes
    the same forms and reverts the estimate too, e.g.
    `.returns(({ value, revert }) => value > cap ? revert("too much") :
    50_000n)`; a spec viem can't encode fails that request, as a
    resolver's error does.
  - Which answers: a registered contract owns its nonpayable and payable
    functions, so an estimate of one is the contract's: its write mock's
    `.reverts()`, then its `estimateGas` mocks and defaults, then the
    100,000 its write mock implies. Action mocks never answer it. Every
    other estimate is the actions': ETH sent with no data, a selector not
    on a registered contract's ABI, an estimate of a view function, and
    anything to another address. There a `sendTransaction` mock's
    `.reverts()` comes first, then `mock.actions.estimateGas` mocks, then
    21000 for a plain transfer to an address without code, then the
    100,000 a `sendTransaction` mock implies (below). Only the side that
    owns the transaction is asked, so its miss is the one reported. The
    contract's miss names the action mocks that match the estimate or its
    send, which don't answer it. The action's miss, on data sent to a
    registered contract, says the contract is registered and that this
    isn't a call to one of its nonpayable or payable functions; for an
    estimate with `from`, it then lists the `sendTransaction` mocks, which
    imply the estimate of a send they match, each with what it missed on.
    A number for a contract's writes goes on the contract, per function:
    `token.estimateGas.transfer().returns(n)` or `defaults.estimateGas`.
    An args-less `mock.actions.estimateGas().returns(100_000n)` sets no
    write's number, and `assertAllUsed()` reports it if nothing else used
    it. To refuse an estimate of a contract's function, refuse it there:
    `token.estimateGas.transfer().refuses("insufficientFunds")`.
  - Estimating with a local account first prepares the transaction, which
    asks for the nonce: the chain's count answers it.
  - A write or send mock that would answer the transaction implies its
    estimate (below, and section 3, "Writes"), when no estimate mock
    answers: 100,000 gas (21000 for a plain transfer to an address without
    code). Nothing runs and no `.once()` is used up. A `.reverts()` one
    reverts it instead, before any estimate mock (above): that's its
    answer, so it counts as used and spends a `.once()`. The send's mock is
    found on the send's own side (a contract's write mock for its
    functions, else a `sendTransaction` mock), with its pins, once per
    estimate, so its predicates run once;
    they run on every estimate of a send it could answer, even one an
    estimate mock then answers, since it could revert it.
- [ ] Sends: `mock.actions.sendTransaction({ from, to, value, data })`
      answers `eth_sendTransaction` (a node's account, unsigned, with
      `from`) and `eth_sendRawTransaction` (a local account's signed bytes),
      for `sendTransaction`, `writeContract` and `deployContract`. The
      call's `from` is the sender: the request's, or a raw send's signer,
      recovered from its signature.
  - A local account's `sendTransactionSync` and `writeContractSync` send
    `eth_sendRawTransactionSync` (EIP-7966): the same send, by the same
    mocks, answered with its receipt from the chain instead of its hash.
    A `getTransactionReceipt` mock doesn't answer it (the app asked for no
    receipt, and can't know the hash before sending); it still answers the
    app's own requests for that hash. A node's account sends
    `eth_sendTransaction` and polls the receipt instead, which a receipt
    mock does answer. A send is mined as it's answered, so it never times
    out, and its timeout param is ignored, as a node ignores an invalid
    one. A reverted receipt comes back as a receipt: viem throws
    `TransactionReceiptRevertedError` only with `throwOnReceiptRevert:
    true`.
  - Sends always go on the chain: a successful send is a transaction
    mined in a new block, and its receipt, transaction, block and logs
    answer from it, so `waitForTransactionReceipt` resolves on its first
    poll, and `getTransaction` answers from the moment of the send. Any of
    them can still be mocked over it. There's no mode that answers a hash
    without a transaction: a hash the chain doesn't know hangs every
    client's polling. Only a send that's failed or refused (`.fails()`,
    `.refuses()`, a send nothing answers) leaves the chain as it was.
  - `.returns()` takes what the chain did, not an ABI value:
    `{ logs, status, gasUsed, effectiveGasPrice, contractAddress }`, all
    optional; the rest of the receipt comes from where it's mined.
    `.emits(log)` or `.emits([a, b])` is `.returns({ logs: [a, b] })`, and a
    resolver's `emit()` takes either too; `.returns({ status:
    "reverted" })` mines it reverted (no logs). `.reverts(spec)` reverts the
    estimate, before any estimate mock, so a local account throws before
    sending, and mines it
    reverted if it's sent anyway (`gas` set, or a node's account). A
    resolver returns the same, or nothing for a success.
  - Only a registered contract's `write` mocks answer sends of its
    functions (section 3, "Writes"); `sendTransaction` mocks answer the
    rest, ETH sent to the contract without data and a selector not on its
    ABI included. Their misses say which side it was: the contract's names
    the `sendTransaction` mocks that match, and the action's, for data
    sent to the contract, says the contract is registered and that this
    isn't a call to one of its nonpayable or payable functions.
  - Unmocked, a send without data to an address without code succeeds
    (sending ETH needs no mock); anything else isn't answered, with a hint:
    data to an unknown or `empty()` address, a registered contract's
    function (its `write` mocks), a deploy, Multicall3.
  - The receipt's gas: `gasUsed` is the gas it was sent with,
    `effectiveGasPrice` the base fee plus the tip at its block (capped at
    its max fee), `cumulativeGasUsed` summed over its block. A deploy's
    `contractAddress` is `getContractAddress({ from, nonce })`.
  - A raw send's hash is `keccak256` of its bytes (ethers checks it), and
    its sender is recovered from its signature. The same bytes sent again
    answer the same hash (or receipt), without a second transaction.
  - An `eth_sendTransaction` without a nonce takes the sender's next one
    on the chain (above, "Nonces follow sends"), and without gas 100,000.
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
  - `wallet_sendTransaction` and `wallet_sendCalls`, which nodes don't
    support. viem retries an `eth_sendTransaction` that fails with
    `-32000`, `-32602`, `-32601` or `-32004` as `wallet_sendTransaction`;
    refused, it rethrows the send's own error, so a test's
    `mock.actions.sendTransaction().refuses(…)` is what the app sees.
    viem remembers the refusal per client, so it retries only once.
    `sendCalls` with `experimental_fallback` sends each call with
    `eth_sendTransaction` instead; without it, it rejects as unsupported.

## 6. Assertions and error messages

- [ ] `assertNoUnhandled()` (catches errors the app swallowed) and
      `assertAllUsed()` (catches mocks that never answered: wrong args, or a
      call the app no longer makes).
- [ ] What `assertNoUnhandled()`'s list shows (as do `restore()`'s check
      and `checkpoint()`'s refusal): each miss with its error's hints
      indented under it, so a test whose app kept the error (wagmi holds it
      in query state) still sees what was registered and which arg missed.
      Identical misses show once with `(×n)`, in the order first seen; a
      list under a header ("Registered:") shows its first 3 lines and
      `… n more`. Show an example:

      ```
      The mock couldn't answer 3 request(s):
        - No mock for previewRedeem(3900000n) on Vault (0x6B17…).
            Registered:
              previewRedeem(2000000000000000000n)  ← shares didn't match
              previewRedeem(5n)  ← shares didn't match
        - No mock for getBalance({ address: 0xa41f…, … }) (×2).
            Registered:
              getBalance({ address: 0x4292… })  ← address didn't match
      ```

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
      encoded, a reverted receipt over a transaction with logs) leaves the mock registered
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
      for the message. An estimate of a contract's function that nothing
      answers also lists the function's write mocks, with why each missed:
      a write mock that matches the send implies its estimate, so the miss
      is usually there. An estimate that's the actions' and that nothing
      answers lists the `sendTransaction` mocks the same way, under
      "sendTransaction mocks, which imply the estimate of a send they
      match:", after its `estimateGas` mocks or its hint, and those the
      last restore removed after its own. An estimate without `from` is no
      send's, so it lists none. A contract's miss also names the action
      mocks that match the call, under "Action mocks that match, which
      don't answer a registered contract's functions:", by exact values:
      their predicates aren't run, and those used up or without an answer
      aren't listed.
- [ ] How to read "answered no call": usage counts from the last clear
      (`clearCalls()`, `restore()`, `reset()`), so a `.times(n)` mock that
      answered before it can read "3 times, 2 left". Under each unused mock, the calls
      its function received (up to 3, then a count) and the first arg, field
      or param that didn't match, by its ABI name; "matches; another mock
      answered it" for a shadowed mock; "received no calls" when the app never
      made it. Args that matched show as `…`, so the line shows what differed
      (the whole call when everything matched). Show an example.
- [ ] The mock's own errors, all `MockError`s (viem's `BaseError`), each
      with a stable `code` viem doesn't retry: `MockSetupError` (the mock's
      API called wrong: a bad value or option, a removed mock, or a static
      answer that doesn't fit a request, as a reverted receipt for a hash
      mined with logs after it's registered),
      `MockCheckError` (a failed check), `MockNotFoundError` (not mocked),
      `MockResolverError` (a resolver or predicate threw; its cause is what
      it threw) and `MockInternalError` (a bug in the mock, unless it was
      given a value its types don't allow: report it).
      Everything else is viem's: reverts, faults and a node's refusals reach
      the app as viem's own classes, as in production, and viem's and ox's
      validation errors (an invalid address at registration) pass through.
      A setup message names the call and field it's about
      ("mock.addTransaction()'s gasUsed must be a non-negative bigint"). A
      matcher can't stand in for a value: `match.any()` type-checks in any
      field, but it's refused outside args, params and pins.
      A message is its short message, then hint lines (`metaMessages`, which
      viem's errors carry too); `details` is always empty, so viem never
      mistakes a hint for a node error. Assert with `toThrow(MockSetupError)`
      (or its `code`), not the message text: messages are for reading,
      and their wording can improve in any release.
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
- [ ] Hashes (a transaction's, a block's, a log's) are lowercase in answers
      and records, as nodes send them, however they were given:
      `addTransaction({ hash })`, a mock's `transactionHash` or `blockHash`.
      A request's hash finds its transaction in any case.
- [ ] `contract({ …, name: "USDC" })`: names show in every message (and in
      history), next to the address.

## 7. Seeing what the app asked: history and debug output

- [ ] `mock.history`: one entry per JSON-RPC request, discriminated by
      `type` (`call`, `multicall`, `action`, `method`, `builtIn`), each with an
      `outcome` (`result` in viem's types, `revert` decoded, `fault` with its
      source, `rpcError`, `unhandled`, `pending`). `unhandled` holds a
      `MockError`: not mocked, a resolver threw, or the mock itself failed.
      Retries are separate entries.
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
      `namespace` and `abiItem` on each contract call record.
- [ ] Writes in history: a contract's function is labeled by the namespace
      it's recorded in (a send of it is `write`, whichever mock answered),
      so a local account's write reads `estimateGas USDC.transfer(…) → 100000n`, then
      `write USDC.transfer(…) → 0xa4a9…c417 (mined in block 11n, 1 log)`.
      A send's outcome is the request's, its hash, even when it was mined
      reverted: `(mined in block 12n, reverted)`. The mined state is looked
      up on the chain as the line is formatted, never copied into the entry.
      A send that's failed or refused (`.fails()`, `.refuses()`, not
      mocked) shows how, and placed nothing. An implied estimate is an
      `estimateGas` call, recorded by what was asked; `assertAllUsed()`
      counts a write mock used by its send, not by the estimate it implied
      (a `.reverts()` one's revert of the estimate is its answer, so that
      counts). Show the whole sequence of a viem local account's write
      (`eth_fillTransaction` refused, nonce, block, tip, estimate, send) as
      the example: it explains requests the app didn't write itself.
- [ ] `historyLimit` (default 1,000 per list, `Infinity` for no limit):
      every record (`history`, `calls`, `unhandled`, each action's and
      function's `.calls`) keeps its last N; each function and each overload
      has its own list, so a busy poller can't push out a quiet function's
      calls. History keeps its numbering (`#68001`) and says how
      many it dropped; checks count every request ("3 request(s) (the last 2
      kept)"). The default warns once, on the first drop, so a test that
      relied on every request hears about it; a chosen number never warns.
      Why a default at all: a page polling every 50ms makes about 68k requests
      an hour. Measured per request across all records: about 3 KB for a
      single read, about 21 KB for a 10-call multicall (one entry carries the
      whole batch). Unlimited, a demo left open all day holds hundreds of MB
      or more; at the default, about 3 MB and 21 MB. The limit counts
      entries, not bytes. Why 1,000 and not more: it keeps multicall demos
      small, while `restore()` after each test clears the records, so a
      single test rarely reaches it; one that does gets the warning, and
      `Infinity` keeps everything. Not records: registered mocks,
      `mock.logs` and `mock.transactions`, which grow only as code adds to
      them: `clearCalls()` keeps them, and a send dropped from history is
      still on the chain.

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
      didn't run, since an unconditional one removes nested suites' setup.
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
      still removes a nested describe's `beforeAll` setup after its first
      test.
- [ ] `checkpoint()` throws on unanswered requests since the last clear, and
      tests that trigger a missing mock on purpose need `clearCalls()`.
- [ ] `clearCalls()` isn't a per-test reset. It's Vitest's `mockClear()`:
      history and usage go, registrations and the chain stay. Used in a
      `beforeEach` instead of a checkpoint, each test's overrides pile up
      on the last one's (the newest answers), `assertAllUsed()` reports
      earlier tests' mocks that a later one shadowed, and transactions carry
      over. Use `checkpoint()` and `restore()` for that.
- [ ] Nesting:
  - checkpoints form a stack, and `reset()` invalidates all of them;
  - restoring an invalid checkpoint throws, saying whether an earlier
    checkpoint's restore or `reset()` invalidated it, with the usual cause:
    a parent describe's per-test restore;
  - the mock remembers what the last `restore()` or `reset()` removed
    (contracts, mocks and transactions; the next one replaces it). "No
    mocked contract at …" for an address it removed says so, and a "No
    mock for …" lists the removed mocks that match the call; both then give
    the layout as a condition ("If this test is in a nested describe, …"),
    since a flat file that forgot to register it gets the same error: in
    the nested layout, that's the nested describe's second test;
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
      `.once()`/`.times(n)` counts, block number, fees, the chain's
      transactions and logs, and so nonces, batch ids, fault counts) and
      what isn't (state that resolvers close over). History is cleared, not
      rolled back.
- [ ] Removed handles throw when used to register. Their `.calls` can still
      be read.
- [ ] Requests still in flight at `restore()` time land in the next test's
      history. With writes the common case is a receipt wait: the app sends
      and starts `waitForTransactionReceipt` without the test awaiting it.
      `restore()` removes the transaction, and viem keeps retrying with its
      own backoff (about 12 s with its defaults) before it gives up. Those
      requests go unanswered in the next test, whose `restore({
      assertNoUnhandled: true })` then fails on a `getTransactionReceipt`
      for a hash it never sent. Await the wait (or whatever the app exposes
      to settle), stop the watcher, or pass the wait a `timeout`. The
      not-found errors for a hash the last restore removed say so (as do
      a call, estimate or send to a contract it removed), and
      `assertNoUnhandled` (on its own or in `restore()`) ends with a line
      when a request it lists got one of these hints (this one, the
      removed-contract one or the removed mocks), so exactly what they
      cover: a request missing what the last restore removed and that isn't
      back.
- [ ] A hash the chain doesn't know isn't an instant failure either: viem's
      receipt wait retries it the same way, so under Vitest's 5 s default
      the test times out before viem rejects. `mock.unhandled` (or history
      printed on failure) shows the repeated `✗ not mocked` lookups.

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
- [ ] A long-running demo page: the default `historyLimit` already suits
      it; set it to silence the warning, or lower it for a page that
      multicalls many functions per poll. Change answers over time with
      a resolver that reads app state, or by calling `.returns()` again on a
      kept builder, never by registering a new mock on a timer: each
      registration is kept (and matched against) for good. Likewise, adding
      transactions on a timer grows `mock.logs`, which `getLogs` searches on every poll.

## 11. State your test owns (controlled mocks)

- [ ] Why: nothing executes, so no answer follows from another. A mined
      `Transfer` changes no balance, and a payable call or a plain ETH
      transfer moves no ETH. State a test wants to change (balances,
      allowances, a vault's shares) is the test's: it lives in a closure,
      resolvers that read answer from it, and a write's resolver changes it.
      No `createLedger()` helper: a `Map` is the whole ledger.
- [ ] The worked example, ERC-20 balances (in `test/write.test.ts`, "state
      the test owns"). Show:
  - The closure, the read that answers from it, and the write that changes
    it. `erc20Abi` has no errors, so the ABI adds the one it reverts with:
    ```ts
    const tokenAbi = [
      ...erc20Abi,
      ...parseAbi([
        "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
      ]),
    ] as const;
    const token = mock.contract({ abi: tokenAbi, address: TOKEN, name: "Token" });
    const balances = new Map([[alice, parseEther("10")]]);
    token.read.balanceOf().returns(({ args: [who] }) => balances.get(who) ?? 0n);
    token.write.transfer().returns(({ from, args: [to, amount], emit, revert }) => {
      const have = balances.get(from) ?? 0n;
      if (have < amount)
        revert({ errorName: "ERC20InsufficientBalance", args: [from, have, amount] });
      emit(token.events.Transfer({ from, to, value: amount }));
      balances.set(from, have - amount);
      balances.set(to, (balances.get(to) ?? 0n) + amount);
    });
    ```
  - The app's `writeContract` then `readContract` sees the balances move,
    and `getContractEvents` the `Transfer`. Too large a transfer is mined
    reverted (the receipt's `status: "reverted"`, no logs) and changes
    nothing.
  - That's not what a node does for a local account: its estimate reverts,
    so `writeContract` throws before sending. For that path (an app's
    "insufficient balance" error), add an estimate that reads the same map
    and only answers (an estimate's `from` is optional):
    ```ts
    token.estimateGas.transfer().returns(({ from = zeroAddress, args: [, amount], revert }) => {
      const have = balances.get(from) ?? 0n;
      if (have < amount)
        revert({ errorName: "ERC20InsufficientBalance", args: [from, have, amount] });
      return 50_000n;
    });
    ```
  - `from` and decoded address args are checksummed, so key the map with
    checksummed addresses (`testAddress`, `getAddress`).
- [ ] Why only a write's resolver changes state: it runs once per
      transaction, at the send. Read and simulate resolvers run whenever the
      app asks, any number of times (polling, re-renders, wagmi's simulate
      before its write), so a change there counts twice. The estimate a
      write mock implies doesn't run its resolver, so estimating first
      changes nothing; an `estimateGas` mock's resolver, like a simulate's,
      runs per estimate and only answers.
- [ ] Change state last, after every `revert()`, `fail()` and `refuse()`
      check. `revert()` mines the transaction reverted and drops what was
      emitted, but the mock can't undo the closure: a change made before it
      stays. A resolver that throws, `fail()`s or `refuse()`s puts nothing
      on the chain, yet keeps what it changed too, so the app's next attempt
      starts from a ledger that already moved.
- [ ] Native balances: `mock.actions.getBalance().returns(({ address }) =>
      native.get(address) ?? 0n)`, and a payable write's resolver moves
      `value` (`vault.write.deposit().returns(({ from, value }) => { … })`).
      A plain transfer (no data) to an address without code, which needs no
      mock, moves nothing unless a `mock.actions.sendTransaction` resolver
      does it.
- [ ] What the mock won't do for you: move `value`, deduct gas or fees,
      check a balance before a send. Each depends on execution or on a
      policy the mock would have to invent, and the mock stores facts and
      derives nothing (what a request or the test put on the chain). The
      test writes what it needs; most need far less than a ledger.
- [ ] The closure is the test's, so `restore()` doesn't reset it (section
      8): create it per test, in the setup factory (section 9) or a
      `beforeEach`, next to the mocks that read it. With baseline mocks
      registered once (section 8), keep one map and re-seed it in
      `beforeEach` (`balances.clear()`, then `set`): a new map is one the
      baseline resolvers never see.
