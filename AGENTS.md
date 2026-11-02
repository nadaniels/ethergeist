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

## Addresses

- Normalize and compare addresses with viem's `getAddress` (checksummed) wherever they need to be valid: registration, lookups, address-keyed sets and maps. `getAddress` validates the input, so a malformed address fails at registration instead of silently never matching, and it accepts any casing.
- Don't compare addresses with `.toLowerCase()`.
- The exception is matching arbitrary hex values, like `isMatch` in `src/mocking/matching.ts`. Those may be `bytes` or `bytes32` rather than addresses, so they compare case-insensitively.
- Addresses in answers (receipts, logs, blocks) go out lowercase, as nodes send them: validate with `getAddress`, then lowercase with `nodeAddress` in `src/shared/values.ts`. Compare them after `getAddress`, never as sent.

## Bugs

- Fix bugs red/green: first write a test that reproduces the bug and watch it fail for the reason reported, then fix the code and watch it pass. A bug that's only in a doc comment gets a test that pins the real behavior, where practical.

## Independent review

Any change beyond a trivial one (anything that changes behavior, types, matching, the engines or the public API; not a typo, a rename or a one-line doc fix) gets an independent review before it's reported as done:

1. **When:** once the change is green (`vp check` clean, `vp run test` passing), before handing it over to commit.
2. **Who:** a separate agent, briefed from scratch, so its read isn't anchored on the author's. It's read-only on the repo; probes go in a scratch directory outside the repo.
3. **The brief:** what the change is meant to do, the constraints and invariants it must keep (e.g. "predicates run only while a mock is in contention"), where the diff is (`git diff`), and `docs/architecture.md`. Give it the code and the intent, not your conclusions about it. Ask for:
   - **correctness:** is everything it claims true, across the tricky cases (list the ones you can think of, and ask for more);
   - **architectural fit:** does it follow the existing patterns and layers, and is there a better seam;
   - **code quality:** naming, comments, consistency, missing tests.

   Ask for findings ranked most important first, each marked bug, design or nit, with a concrete failing scenario.

4. **Verify before acting:** check each finding against the code yourself, and reproduce bugs red/green. Judge each one on its merits: decline any that don't hold up, and say why. A reviewer that's asked to find problems will always find something.
5. **Fix, then send it back to the same reviewer** with what changed and where the risk is (new call sites, changed signatures). A re-review covers only the fixes and what they touch; it isn't a fresh review of everything.
6. **When to stop:**
   - **Stop when a pass finds no bugs.** A bug is something wrong, with a concrete failing scenario. Design suggestions and nits don't keep the loop going: take them if they're clearly better and cheap, otherwise list them as declined or deferred.
   - **At most three rounds.** If a third round still finds bugs, stop and bring them to the owner instead of continuing.
   - **If a round contradicts an earlier one,** or a fix undoes an earlier fix, stop and bring both to the owner. Going back and forth makes the code worse, not better. A fix that introduces a new bug is different: fix it in the next round, within the three.
7. **Report** what each round found and what was done about it, including findings that were declined and why.
