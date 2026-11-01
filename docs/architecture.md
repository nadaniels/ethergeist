# Architecture

How `src/` is organized, for anyone changing it. What the library does for its
users is in the docs plan, `docs/notes.md`.

## Layers

Each folder owns one part of the mock, and imports only from its own folder
and the layers before it:

```
shared → mocking → chain → logs → contracts → actions → history → rpc → viem → (top of src/)
```

- **`shared/`:** what every layer uses: the mock's errors, small value helpers,
  test values (`testAddress`, `testHash`), and the `Part` type (see
  [Adding state](#adding-state)).
- **`mocking/`:** the mock engine that contracts and actions share
  (`handlers.ts`: registering mocks, picking the most specific match, limits
  and usage), plus matching, matchers, faults (`MockFailure`), `zeroResult`,
  and outcomes (`MockOutcome`: how a mock answered, which history records).
- **`chain/`:** the chain's own state (`createChainState`: block number, clock,
  fees) and the node's shapes for blocks, transactions, receipts and errors.
- **`logs/`:** emitted logs and how `eth_getLogs` filters find them.
- **`contracts/`:** mocked contracts, their registry, and `eth_call` dispatch,
  multicall included. It emits logs, so it sits above `logs/`; it owns
  `MockCallRecord`, the record of a call it answered.
- **`actions/`:** typed actions (`mock.actions.getBalance`, …), one file each,
  and raw `mock.method()` mocks. `getLogs` reads the log store and
  `estimateGas` asks contracts first, so it sits above both.
- **`history/`:** what the mock received and how it answered: the recorder,
  history entries, and formatting.
- **`rpc/`:** the request pipeline (`createRequestHandler`, a
  `RequestHandler`), `failRequests()` faults, checkpoints, and the assertions.
- **`viem/`:** the viem adapter: `request`, `transport` and `publicClient`, and
  turning the mock's errors into viem's.
- **The top of `src/`:**
  - `createMockRpc.ts`, the composition root: it creates each part, wires them
    together, and returns the `MockRpc` object; it holds no logic of its own;
  - `types.ts`, the public `MockRpc` type and its documentation;
  - `builders.ts`, the mock's `buildTransaction`, `buildReceipt` and `buildLog`;
  - `index.ts`, the only public entry point: anything users need, types
    included, is exported from there.

`test/architecture.test.ts` checks the layers: every folder in `src/` must be
one, and no import may point up. A new folder goes into its list, in its place.
Lint separately rejects import cycles between files, type-only ones included
(`import/no-cycle`). When something lower needs a type or helper from higher
up, move it down to where both can use it, as `MockOutcome` moved to
`mocking/`.

### Clients and errors

`createRequestHandler` knows nothing about viem. It throws the mock's own
errors: `MockFailure` for faults, `MockRevertError`, `MockRpcError` for a node's
refusal, and `MockNotFoundError` or `MockResolverError` for what it couldn't
answer. An adapter turns them into its client's errors: `toViemError` in
`viem/errors.ts` for viem. Support for another client (wagmi, ethers) is a new
adapter folder beside `viem/`, not a change to the layers under it.

## Naming

1. **A file is named for what it holds.** A file built around one factory names
   it `create` plus that thing, read together with its folder: `logs/store.ts`
   exports `createLogStore`, `contracts/registry.ts` exports `createRegistry`.
2. **A folder's entry point, or a file whose thing has no good noun, is named
   for its factory:** `actions/createActions.ts`,
   `contracts/createMockContract.ts`, `contracts/createContractApi.ts`,
   `createMockRpc.ts`.
3. **`build*` builds values** (`buildLog`, `buildReceipt`, `buildTransaction`);
   **`create*` creates stateful parts.**
4. **A name says what it does where it's used.** Read a method with the object
   it's called on (`checkpoints.addCheckpoint()`, `mocks.findAnswering()`), and
   avoid bare verbs that could mean anything on their own (`save`, `take`,
   `run`), or that read like a built-in (`push`). Callback parameters are named
   for what they hold (`handler`, not `h`), except `(a, b)` in a sort
   comparator and `i` for an index.

## Adding an action

1. Add its file in `actions/`, named for the action (`getGasPrice.ts`). It
   exports a function that takes the `ActionsContext` (`state`, `registry`,
   `logStore`) and returns its `Definition<call, rpc>`: how to decode the call,
   encode and view answers, and what to answer when it isn't mocked. `call` is
   its decoded call's type and `rpc` its JSON-RPC answer's, so its members get
   them typed, without casts.
2. Add it to the `typedActions` catalog in `actions/typedActions.ts`, with the
   JSON-RPC methods it answers.
3. Add its mock's type, with its documentation, to `MockActions` in the same
   file.
4. Add its decoded call's type to `ActionCalls` in `actions/types.ts`. History
   entries and `mock.calls` are typed from it, and the catalog checks that the
   definition decodes to it.
5. Export any new public types from `index.ts`.

## Adding state

Anything that holds state is a `Part` (`shared/parts.ts`), with any of:

- `snapshot()`: saves what it holds, returning a `restore()`;
- `clearCalls()`: forgets what it recorded, keeping what's registered;
- `unusedMocks()`: mocks that never answered a call, for `assertAllUsed()`.

Add the part to the list passed to `createCheckpoints` in `createMockRpc.ts`.
`checkpoint()`, `reset()`, `clearCalls()` and `assertAllUsed()` then handle it
with every other part; nothing else needs to change. `reset()` restores a
snapshot taken when the mock was created, so a part needs no `reset()` of its
own.

A **snapshot** is saved state, nothing more: each part's, or every part's at
once. A **checkpoint** is what `mock.checkpoint()` returns: a snapshot of every
part on a stack, where restoring one invalidates the checkpoints added after
it.

## Lint rules as guidelines

`import/max-dependencies` warns when a file imports more than 10 modules (type
imports don't count). It's a prompt to check whether a file is taking on too
much, not a limit to design around: if splitting the file or moving code
elsewhere would read worse than the imports, leave it, and if needed exempt the
file in `vite.config.ts`. Two files are exempt because importing everything is
their job: `createMockRpc.ts`, the composition root, and
`actions/typedActions.ts`, the catalog of actions.
