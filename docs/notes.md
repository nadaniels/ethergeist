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
      with the defaults the helper sets (`cacheTime: 0`, `retryDelay: 0`).
- [ ] Registering a contract, and `defaults: { read: { … }, simulate: { … } }`.
      This is the first setup code everyone writes, so the docs should lead
      with it and repeat it in examples.
- [ ] `read` vs `simulate` namespaces (view/pure vs nonpayable/payable),
      mirroring `getContract`.

## 3. Mocking contract calls

- [ ] Matching: pinned args, args-less mocks as fallbacks, most specific wins,
      ties go to the most recent.
- [ ] Matchers: `match.any()`, `match.where(predicate, label?)` and
      `match.partial(fields)` in args and in action and method params, typed
      as the value they replace. Show:
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
    or the start of an inline arrow's source (`where((n) => n > 5n)`).
  - Matchers choose which answer a call gets; they aren't assertions. To
    check what the app sent, use `.calls` with `expect`, which gives a real
    diff. Pinning args and relying on `assertAllUsed()` works, but its
    message doesn't show what arrived yet.
  - `partial` for "only these struct fields": at any depth, in structs inside
    arrays, with matchers as field values. Struct args are complete without
    it: omitting a field is a type error, not a wildcard. It ranks by what its
    fields pin, so a full exact struct beats it.
  - Matchers for an array arg (a swap path "contains X" or "starts with X"):
    `where` on the whole array; `partial` is only for structs.
  - Overloads: with matchers, the exact args pick the overload; if they can't,
    registration throws "ambiguous overload". A `partial` doesn't help pick,
    even when only one overload's struct has its fields.
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
    transport. `formatHistory()` shows it as a fault, then a `(retry)`.
  - A retry finding nothing behind a used-up fault: the "not mocked" error
    says it's a retry and gives the transport's `retryCount` (the default
    wording under `fallback()`, which retries itself).

## 5. Node data: `mock.actions` and `mock.method`

- [ ] `getBalance`, `getCode`, `getBlock` and `getTransactionReceipt`, with
      values in viem's types.
- [ ] Generated blocks: what's generated (numbers, linked hashes, timestamps
      from `timestamp` and `chain.blockTime`), and what's zero.
- [ ] Receipts: the defaults (status `"success"`, block, log context), and
      `.returns(null)` for "not found".
- [ ] Strict by default for data the test owns (balances, receipts), and how
      to opt into real-node defaults with args-less mocks.
- [ ] `mock.method()` for any other method, with raw JSON-RPC values.

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
- [ ] Where shared fallbacks go: on contracts, in `defaults`. For actions,
      `method`, and narrowed fallbacks (`fn([match.where(…)])`), which have
      no `defaults`, take a checkpoint after registering them and use
      `restore({ assertAllUsed: true })`. That includes a per-test setup
      function: end it with `mock.checkpoint()` and return the checkpoint.
- [ ] How to read "No mock for …" and its "Registered:" list.
- [ ] Addresses in messages are always checksummed. Address args are
      normalized at registration, which also rejects malformed ones.
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
      when a test fails reads better (the Vitest helper, once it exists).
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
      (Replace this with the vitest helper once it exists.)
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
      `.once()`/`.times(n)` counts, block number, batch ids, fault counts) and what isn't (state that resolvers
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
