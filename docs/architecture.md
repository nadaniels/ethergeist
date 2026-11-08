# Architecture

How `src/` is organized, for anyone changing it. What the library does for its
users is in the docs plan, `docs/notes.md`.

## Layers

Each folder owns one part of the mock, and imports only from its own folder
and the layers before it:

```
shared → mocking → chain → logs → transactions → contracts → actions → history → rpc → viem → (top of src/)
```

- **`shared/`:** what every layer uses: the mock's errors, small value helpers,
  test values (`testAddress`, `testHash`), and the `Part` type (see
  [Adding state](#adding-state)).
- **`mocking/`:** the mock engine that contracts and actions share
  (`handlers.ts`: registering mocks, picking the most specific match, limits
  and usage), plus matching, matchers, faults (`MockFailure`), `zeroResult`,
  outcomes (`MockOutcome`: how a mock answered, which history records), and
  the shared setup checks (`setupChecks.ts`).
- **`chain/`:** the chain's own state (`createChainState`: block number, clock,
  fees) and the node's shapes for blocks, transactions, receipts and errors,
  and for request params (`params.ts`: read to the Ethereum JSON-RPC spec,
  refused as invalid params where it rules them out).
- **`logs/`:** a log's content (`contract.events`, `testLog`), placing
  content as a complete log for `mock.buildLog()`, and how `eth_getLogs`
  filters match logs.
- **`transactions/`:** the chain's transactions, one record each
  (`createTransactionStore`): what `mock.addTransaction` (its fields checked
  in `addTransaction.ts`) and sends put on the chain, and what
  receipts, transactions, blocks and `eth_getLogs` answer from when no mock
  answers first. Every record goes in through `add`, and all mining through
  its `mine`; a record is on the chain once its block is mined (at or below
  the head).
- **`contracts/`:** mocked contracts, their registry, and `eth_call`
  dispatch, multicall included; a contract also takes a turn at the
  estimates and sends of its functions, ahead of the action's own mocks
  (`ContractTurn`). It emits logs, so it sits above `transactions/`; it
  owns `MockCallRecord`, the record of a call it answered.
- **`actions/`:** typed actions (`mock.actions.getBalance`, …), one file each,
  and raw `mock.method()` mocks. Receipts, transactions, blocks and `getLogs`
  read the transaction store and `estimateGas` asks contracts first, so it
  sits above both.
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

`createRequestHandler` knows nothing about viem. It throws answers, which
`isAnswer` in `mocking/outcomes.ts` names (`MockFailure` for faults,
`MockRevertError`, `MockRpcError` for a node's refusal), or the mock's own
errors for what it couldn't answer: the `MockError` family in
`shared/errors.ts`. Anything else thrown while answering is a bug in the mock,
or a value its types don't allow that no check caught. It's wrapped in
`MockInternalError` (`asMockError`), so it's recorded as unhandled
and isn't retried. An adapter turns answers into its client's errors:
`toViemError` in `viem/errors.ts` for viem. Support for another client (wagmi,
ethers) is a new adapter folder beside `viem/`, not a change to the layers
under it.

The mock's errors:

- Every error the mock raises itself is a `MockError`, with a stable `code`
  viem doesn't retry. Setup mistakes throw `MockSetupError`, failed checks
  `MockCheckError`; `test/architecture.test.ts` rejects plain `Error`,
  `TypeError` and `RangeError`.
- The short message says what's wrong; hints (how to fix it, what's
  registered, a list) go in `metaMessages`, a line each. Never `details` or
  `docsPath`: viem matches `details` against node errors, and its wrappers
  take a cause's `docsPath` with their own base URL. A failed check's list
  is the failure, so it stays in the short message: checks never reach viem.
- A request param a node can't parse is `invalidParams` (`chain/params.ts`),
  never a setup error, even when the same check runs at registration.
- Setup checks run once, in the first part that reads a value: the generic
  kinds through `mocking/setupChecks.ts` (`checkAmount`, `checkCount`,
  `checkFields`), domain checks in their layer. They're named `check*`, and
  an entry that takes a value refuses matchers. AGENTS.md ("Setup checks")
  has the rules.

## Naming

1. **A file is named for what it holds.** A file built around one factory names
   it `create` plus that thing, read together with its folder: `transactions/store.ts`
   exports `createTransactionStore`, `contracts/registry.ts` exports `createRegistry`.
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
5. **An exported type gets `Mock` when it's one of the mock's own things**:
   its objects and their registrars, builders and answers (`MockRpc`,
   `MockContract`, `MockReadFunction`, `MockAction`, `MockFunctionBuilder`,
   `MockActionAnswers`, `MockCheckpoint`, `MockFaultHandle`), the values its
   mocks answer with (`MockReceipt`, `MockBlock`, `MockFees`, `MockFault`,
   `MockWriteOutcome`), what it records of the requests it gets
   (`MockHistoryEntry`, `MockCallRecord`, `MockOutcome`, `MockBatch`), what
   it builds for you (`MockEventLog`), and types made from these
   (`MockNodeFault`, `MockTaggedCall`). It keeps `Mock` when it's also a
   parameter (`buildReceipt(MockReceipt)`, `failRequests(MockFault)`).
   **None on what you hand the mock**: parameter, option and context types
   (`RestoreOptions`, `ContractDefaults`, `EventArgs`, `RevertSpec`,
   `CallPins`, `LogsContext`, `WriteResolverContext`), and a request's
   decoded call (`BalanceCall`, `LogsCall`). **None where a qualifier
   already places it**: what's on the chain (`TransactionRecord`,
   `EmittedLog`, `BuiltTransaction`), raw JSON-RPC shapes (`RpcValue`,
   `RpcRequest`), and named sets (`SendErrorName`, `UnhandledRequest`).
   **None on plain callbacks and type helpers** (`RevertFn`, `WithLimits`,
   `PartialStructs`). **Always `Mock` where the bare name is viem's**
   (`MockTransactionType`, `MockTransaction`). A function's parameters type
   is named for the function, as viem names them, so a `Mock` in it is the
   function's, not a prefix: `CreateMockRpcParameters` for
   `createMockRpc()`, `AddTransactionParameters` for
   `mock.addTransaction()`, and `MockPublicClientParameters` for
   `mock.publicClient()`.
6. **`index.ts` exports every type a consumer's inferred declarations can
   end up naming**, used or not: a type a public signature names, and one
   a file-local alias inside a public type uses (TypeScript writes the
   local alias out, naming what's in it). A consumer's declarations can
   only name what the package exports. For anything else, TypeScript
   writes the type out in full, which makes declarations unreadable, or
   fails where it can't (a `unique symbol`, a recursive type).
   `vp run smoke` checks it by compiling a consumer against `src/` with
   `declaration: true` and failing on a name its declarations take from a
   file that `index.ts` doesn't export. To keep a helper internal, spell
   it out in the file-local alias that uses it, as `NamedOutputs` in
   `contracts/types.ts` spells out "all named".

## Tests

Unit tests for a module sit next to it, as `name.test.ts` in the same
folder, and import it directly. `test/` holds the tests of the public API,
which import only from `src/index.ts` and are the main suite. Packaging
leaves `*.test.ts` out of what ships.

## A call that throws changes nothing

Every public call either does all of what it says or nothing: it validates
first, then changes state. `.times(n)` checks `n` before setting the limit,
`mock.contract()` checks the address before registering, `.returns()` checks
the value before replacing the answer. So there's never a half-done state to
explain. Registering and answering are separate calls (`fn(args)`, then
`.returns()`), so a rejected answer leaves the mock registered without one,
which `assertAllUsed()` reports. A new feature should keep the rule: check
everything, then mutate.

## Adding an action

1. Add its file in `actions/`, named for the action (`getGasPrice.ts`). It
   exports a function that takes the `ActionsContext` (`state`, `registry`,
   `transactions`, and `mockFor`, another action's mock that would answer a
   call) and returns its `Definition<call, rpc>`: how to decode the
   call, encode and view answers, and what to answer when it isn't mocked
   (`fallback`), or, rarely, what it refuses before any mock answers
   (`refuse`: an estimate reverts for its send's `.reverts()` mock).
   `call` is its decoded call's type and `rpc` its JSON-RPC answer's, so its
   members get them typed, without casts. If `encode` checks the answer against the call
   (as a receipt refuses a reverted status over its transaction's own logs),
   also give `pinnedCall`, so a static answer that can't fit fails at
   `.returns()` instead of at request time. If a static answer takes a
   default from the chain as it stands at registration, which a node would
   never change, give `fixAtRegistration`: receipts and transactions keep
   the head beside the value, as the block a hash not on the chain is
   mined in. A mock that answers over the chain's own answer (a block, a
   receipt, a transaction) follows the rules in `docs/notes.md` ("You don't
   have to use the chain"): it answers one method, over what the chain
   would answer at that request, its fields winning (methods may
   disagree); its answer places its parts (a receipt its logs, a block its
   transactions), and nothing else is derived; and each answer is one a
   node could send, as an object.
   An action that changes the chain (a send) answers in two steps: `encode`
   checks the answer, as at registration, and `commit` places it on the
   chain once it's chosen, answering the JSON-RPC value; its `Definition`
   takes that answer's type as a third parameter.
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
`actions/typedActions.ts`, the catalog of actions. A third,
`contracts/createMockContract.ts`, is the contract engine, answering every
namespace's mocks, `write`'s outcomes included; splitting it would scatter
one engine across files.
