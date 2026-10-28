# Notes for the documentation

Points the eventual library docs must cover, gathered as features land. Each
section should grow into a docs page or a section of one.

## When to use this, and when to use anvil

- This library answers each request with what a test says, fast and
  deterministically, with no binary and no shared process: per-test answers,
  injected network failures, isolated concurrent tests.
- It never executes anything, and never derives one answer from another: a
  mocked receipt with a `Transfer` log doesn't change any balance, and a
  receipt in block 100 doesn't appear in that block's `transactions`.
- Use anvil, or an anvil fork, when a test needs real execution or real chain
  state.

## Sharing setup across tests: `checkpoint()` and `restore()`

- Register shared contracts and mocks once (at module scope, or in a
  describe's `beforeAll`), call `checkpoint()`, and `restore()` after each
  test. Anything registered at checkpoint time is the baseline: `defaults`,
  mocks with args, `.fails()`, `empty()`, actions, raw methods, faults.
- Run `assertNoUnhandled()` before `restore()`, in the same `afterEach`:
  `restore()` clears history, including `unhandled`.
- `checkpoint()` throws if requests since the last clear went unanswered,
  because a broken setup isn't a baseline. A test that deliberately triggers
  a missing mock, in a file that doesn't restore per test, needs a
  `clearCalls()` before a later checkpoint.
- Nesting:
  - Checkpoints form a stack. Restoring one invalidates every checkpoint taken
    after it, and `reset()` invalidates all of them.
  - Restore at one level only per test. An `afterEach` also runs for nested
    describes, innermost first, so an outer per-test restore wipes a nested
    suite's setup and invalidates its checkpoints. Make describes that restore
    an outer checkpoint per test siblings of describes with their own suite
    setup, not parents of them. (Tested in `test/checkpoint.test.ts`, "module-scope
    setup".)
  - A describe with its own suite setup needs a checkpoint on each side of
    it, so later describes don't inherit it:
    ```ts
    let outer: MockCheckpoint, suite: MockCheckpoint;
    beforeAll(() => {
      outer = rpc.checkpoint();
      registerPools(rpc);
      suite = rpc.checkpoint();
    });
    afterEach(() => {
      rpc.assertNoUnhandled();
      suite.restore();
    });
    afterAll(() => outer.restore());
    ```
- What's restored: registrations, answers given to baseline builders, and
  the mock's own state (block number, batch ids, faults' remaining counts and
  `count`). Mocks, contracts and handles created since are removed; using a
  removed handle to register throws, and its `.calls` can still be read.
- What isn't restored: state a resolver closes over (counters, prices,
  external fixtures). History is cleared, not rolled back, so a checkpoint
  taken mid-test also drops that test's earlier history.
- Requests still in flight when `restore()` runs (fire-and-forget calls from
  the previous test) land in the next test's history and `unhandled`.

## Concurrent tests

- Every `createMockRpc()` is independent; nothing is global. Concurrent tests
  are safe with one mock per test.
- One mock shared by concurrent tests is never safe, with or without
  checkpoints: overrides, `mine()`, `reset()`/`restore()` and history all
  collide. Checkpoints are for serial suites.
- One mock per test, with shared setup and inferred types:
  ```ts
  function setup() {
    const rpc = createMockRpc({ chain: base });
    const quoter = rpc.contract({ abi: quoterAbi, address: QUOTER, defaults: { … } });
    return { rpc, quoter, client: rpc.publicClient() };
  }
  test.concurrent("…", async () => {
    const { quoter, client } = setup();
  });
  ```
  Vitest fixtures (`test.extend`) are the same idea with destructuring.
- If the app under test reads its clients from a global, concurrent tests
  share whichever mock was installed last, whatever the library does. Inject
  clients, or scope them per test (for example with `AsyncLocalStorage`).
