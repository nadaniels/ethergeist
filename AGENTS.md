<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Running Scripts

Run TypeScript and JavaScript files with `vpx <file>`, for example `vpx ./scripts/seed.ts --dry-run`. It handles enums, decorators, JSX, and tsconfig `paths`, so do not add `tsx` or `ts-node` to run scripts. `vpx --watch <file>` reruns the file when a file it uses changes, in place of `tsx watch`. `vp node <file>` runs plain Node.js.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# Project Conventions

Read `docs/architecture.md` before changing `src/`: the layers, naming, and how to add an action or a piece of state.

## Checks

- Run `vp check`, `vp run knip` and `vp run test` before handing a change over. The pre-commit hook runs `vp staged` and then `vp run knip`, so a commit fails if Knip isn't satisfied.
- Run `vp run smoke` when a change touches the public types, `exports`, `package.json` or the build. CI runs it on every push; it takes about 30 s and needs the network.
- `vp run knip` runs [Knip](https://knip.dev) twice: the default mode (all code, tests included), then `--production --strict` (only what ships: `src/` minus colocated tests, with dependencies checked against what ships). Config is in `knip.json`.
- Fix findings rather than configure around them: remove an `export` nothing outside its file uses, delete an unused file, add or remove the dependency. A file that a tool or a person runs directly is an `entry` in `knip.json`.
- `vp run mutate` runs [Stryker](https://stryker-mutator.io) mutation testing (config in `stryker.config.mjs`; reports in `reports/mutation/`). It's slow, so it isn't part of the checks: run it before an engine or matching change, on the files the change touches (`vp run mutate --mutate "src/contracts/**/*.ts"`). Close the gaps it finds with tests of behavior the change keeps, through the public API in `test/` where possible, so they outlive the refactor; skip survivors in code the change removes, in error wording and display formatting (history lines, thresholds like where hex is shortened), and in answer fields viem doesn't read (see "Fidelity").
- An export only a unit test needs gets `@internal` in its doc comment, which production mode skips. Don't export a value just so a test can read it back: a test should pin documented values as literals, or it can't catch them changing.

## Addresses

- Normalize and compare addresses with viem's `getAddress` (checksummed) wherever they need to be valid: registration, lookups, address-keyed sets and maps. `getAddress` validates the input, so a malformed address fails at registration instead of silently never matching, and it accepts any casing.
- Don't compare addresses with `.toLowerCase()`.
- The exception is matching arbitrary hex values, like `isMatch` in `src/mocking/matching.ts`. Those may be `bytes` or `bytes32` rather than addresses, so they compare case-insensitively.
- Addresses in answers (receipts, logs, blocks) go out lowercase, as nodes send them: validate with `getAddress`, then lowercase with `nodeAddress` in `src/shared/values.ts`. Compare them after `getAddress`, never as sent.
- Hashes (transaction, block, log and root hashes) have no checksum, so lowercase is their only form: addresses are checksummed to compare, hashes lowercase; both go out lowercase. Validate and lowercase a hash where it comes in (`nodeHash` in `src/chain/hashes.ts` for the mock's API and a mock's answers, `hashParam` for a request's), so records and lookups hold only lowercase and compare with `===`. Not calldata, `bytes` or topics: they aren't identifiers, and keep their case.

## Values left out

- `undefined` never means anything of its own: an explicit `undefined` behaves exactly as if the key or argument were left out. For a setup field or option, that's its default; in args, params and pins, it's not pinned (any value matches); for a required value, it's the same refusal as leaving it out. A `defaults:` entry that's `undefined` is no default.
- Consumers rarely set `exactOptionalPropertyTypes`, so their types let an explicit `undefined` into any optional field, and a spread of a partial fixture puts one there. Strip it before a mock's fields spread over defaults or a record (`withoutUndefined` and `leftOut` in `src/shared/values.ts`): a plain spread lets `undefined` override.
- A value that means something is `null` or a named value, never `undefined`: `null` for a pending transaction or a deploy's `to`, `false` for `historyOnFailure`.

## Setup checks

These are runtime checks on the values a test hands the mock's setup API.

- Check a value where a mistake would otherwise be silent (ignored, coerced, or merged into a plausible answer) or blamed on the wrong party, including values the types rule out: tests cast often, and the mock transforms what it's given. Drop a one-off check that only repeats what fails loudly and clearly anyway (viem's own error naming the value, or a check a line later). Where a shared helper covers the kind, use it regardless, so every setup mistake is a `MockSetupError`.
- Check once, in the first part that reads the value, never in the composition root. The generic kinds use the helpers in `src/mocking/setupChecks.ts`: `checkAmount` (a non-negative bigint), `checkCount` (a safe integer of 0 or 1 or more) and `checkFields` (an object of known fields, holding no matcher). Domain checks (logs, statuses, reverts, faults, hashes) stay in their layer.
- Name a setup check `check*`: it throws `MockSetupError` and narrows (`asserts`). `assert*` is for the public checks, which throw `MockCheckError`.
- A message's subject names the value as the user wrote it, qualified by the call that took it: "mock.addTransaction()'s gasUsed", "times()'s count", "getBalance's answer". Each kind has one form, which its helper words: "`<subject>` must be a non-negative bigint; got `<value>`." A subject mid-sentence stays lowercase ("Expected an object for a send's outcome").
- An entry that takes a value refuses matchers (`match.any()` type-checks in any field) with `checkNoMatchers`, naming the place; args, params and pins take them.

## Errors

- Throw the `MockError` family from `src/shared/errors.ts`, never a plain `Error`, `TypeError` or `RangeError` (`test/architecture.test.ts` checks): `MockSetupError` for the mock's API called wrong, `MockCheckError` for failed checks. A request param a node would refuse is `invalidParams` instead (`src/chain/params.ts`).
- The short message says what's wrong, as one sentence. Hints (how to fix it, what's registered, lists) go in `metaMessages`, a line each; never in `details` or `docsPath`. See "Clients and errors" in `docs/architecture.md`.
- The exception is a failed check (`MockCheckError`): its list is the failure, so it stays in the short message, and the recent requests are its `metaMessages`. Checks never reach viem, so its reasons for the rule don't apply.
- viem's and ox's own validation errors (e.g. `getAddress` at registration) pass through unwrapped.

## Request params

- Read a request's params to the Ethereum JSON-RPC spec ([ethereum/execution-apis](https://github.com/ethereum/execution-apis), `src/schemas`), with the helpers in `src/chain/params.ts`: accept what it allows, refuse what it rules out with `invalidParams`, treat hex digits as case-insensitive, read `data` as the spec's `input` (clients send `data`), read a `null` at the end of the params as a param left out (as `JSON.stringify` writes one), and ignore what the spec doesn't define. Check each method's block form there (`BlockForm`). Refusals use the mock's own wording: viem classifies them by code. What the mock answers (shapes, errors, messages) still imitates reth.
- Why the spec and not reth: viem and ethers send spec-shaped requests, so they never hit a refusal, and a hand-written request has to conform instead of relying on one node's leniency. Reth is the lenient outlier: it alone accepts JSON-number quantities, and only it and zkSync accept leading zeros, where geth, Erigon, Nethermind and Arbitrum Nitro refuse both.

## Fidelity: what's worth matching a node for

- The mock is a stub, not an emulator: it answers what's mocked, and imitates a node only where the app would see the difference.
- Capture or match node behavior only where it changes what viem shows the app: the error class viem gives it, or the shape of an answer viem parses. Requests viem never sends, and the wording of errors nobody reads, get the spec rule above and nothing more: no captures, no cross-client sweeps, no exact messages.
- Still worth matching: errors apps react to, like a log range too large (apps retry with a smaller one), and every answer shape viem decodes.

## Bugs

- Fix bugs red/green: first write a test that reproduces the bug and watch it fail for the reason reported, then fix the code and watch it pass. A bug that's only in a doc comment gets a test that pins the real behavior, where practical.
- Fix bugs real use plausibly hits: what viem, ethers or an app sends, or what a test author would write (casts of fixtures and partial objects included, since tests cast often). A failure only contrived input reaches (a hand-built cyclic object, a request no client sends, a matcher where nobody would put one) isn't worth new machinery: leave it, or take it only if the fix removes code or is a one-line swap. Before fixing, say how real use reaches it.

## Independent review

Any change beyond a trivial one (anything that changes behavior, types, matching, the engines or the public API; not a typo, a rename or a one-line doc fix) gets an independent review before it's reported as done. Scale it to the risk: engine, matching and public-API changes get the full loop below; a narrow change (one decoder, one message, a simplification) gets one round. Gather new evidence (node captures, cross-client sweeps) only when the owner asks for it.

1. **When:** once the change is green (`vp check` and `vp run knip` clean, `vp run test` passing), before handing it over to commit.
2. **Who:** a separate agent, briefed from scratch, so its read isn't anchored on the author's. It's read-only on the repo; probes go in a scratch directory outside the repo.
3. **The brief:** what the change is meant to do, the constraints and invariants it must keep (e.g. "predicates run only while a mock is in contention"), where the diff is (`git diff`), and `docs/architecture.md`. Give it the code and the intent, not your conclusions about it. Ask for:
   - **correctness:** is everything it claims true, across the tricky cases (list the ones you can think of, and ask for more);
   - **architectural fit:** does it follow the existing patterns and layers, and is there a better seam;
   - **code quality:** naming, comments, consistency, missing tests;
   - **the smallest change:** whether the same full feature could be done with less code overall: a few lines in an existing place instead of a new module, a helper, an option or a layer. Count the code that exists after the change, not the size of the diff: a different seam or a small architecture shift that leaves less machinery behind is worth naming, even if it means more churn now. Ask for each piece that could shrink or go, and what it would cost. This is about less machinery, not fewer lines: never condense code so it reads worse.

   Ask for findings ranked most important first, each marked bug, design or nit, with a concrete failing scenario. A bug's scenario is one real use plausibly hits (see "Bugs"); ask the reviewer to say how real use reaches it, and to mark a failure that needs contrived input as a nit, not a bug.

4. **Verify before acting:** check each finding against the code yourself, and reproduce bugs red/green. Judge each one on its merits: decline any that don't hold up, and say why. A reviewer that's asked to find problems will always find something. An architecture shift is never taken as a cheap fix: bring it to the owner with what it saves and what it churns.
5. **Fix, then send it back to the same reviewer** with what changed and where the risk is (new call sites, changed signatures). A re-review covers only the fixes and what they touch; it isn't a fresh review of everything.
6. **When to stop:**
   - **Stop when a pass finds no bugs.** A bug is something wrong, with a concrete failing scenario that real use plausibly hits. Design suggestions and nits don't keep the loop going: take them if they're clearly better and cheap, otherwise list them as declined or deferred.
   - **At most three rounds.** If a third round still finds bugs, stop and bring them to the owner instead of continuing.
   - **If a round contradicts an earlier one,** or a fix undoes an earlier fix, stop and bring both to the owner. Going back and forth makes the code worse, not better. A fix that introduces a new bug is different: fix it in the next round, within the three.
7. **Report** what each round found and what was done about it, including findings that were declined and why.
