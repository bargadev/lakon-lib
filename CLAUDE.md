# CLAUDE.md — lakonai

Guidance for AI agents working in this repository.

## Keep the lakonai-spec agent current (always)

`.claude/agents/lakonai-spec.md` is the canonical knowledge base for this
codebase. **Whenever you change how lakonai works, update that agent in the same
change** — its file map, dispatch order, filter layers, learning thresholds, and
conventions must always match the code. Triggers to update it:

- adding/removing a filter, engine def, or supported command;
- changing the dispatch order, hook behavior, or the auto-learning thresholds/flow;
- moving files or renaming exported symbols.

Treat a stale agent as a bug. If you touch internals and don't update the agent,
the change is incomplete.

## Keep the README current (always)

`README.md` is the public face — it must never claim something the code doesn't
do. **Whenever you change user-facing behavior, update the README in the same
change.** Specifically keep these in sync with reality:

- the supported-command list, counts ("30 commands"), and the savings tables;
- feature claims (auto-learning, hooks, aliases) — never advertise a removed or
  unbuilt feature;
- numbers that drift: test count, coverage, version, default caps/thresholds;
- install/usage commands and flags.

A README that overstates or lies about a feature is worse than no README — it
burns trust. Verify the number before writing it (run the suite, grep the
constant). Treat a stale or inaccurate README as a release-blocking bug.

**Keep the npm page ("About") in sync too.** The npmjs.com package page renders
`README.md`, but **only re-renders it on a new publish** — editing the README
locally does NOT update what visitors see on npm. So a user-facing README change
is not "done" until it ships in a published version. Whenever you change the
README, treat the npm About as part of the same task: bump the version + add a
CHANGELOG entry and publish (see Releasing) so npm shows the current copy. Never
leave npm displaying a stale README while the repo has a newer one.

## Releasing (merge + CHANGELOG, no tags)

**NEVER `npm publish` from the terminal.** Publishing is the CI pipeline's
("esteira") job — the **Publish to npm** GitHub Action runs on merge to `main`.
Your scope is, at most: bump the version, write the CHANGELOG entry, commit, open
a PR, and merge it. Do not run `npm publish` (or `npm version` with a tag, or any
direct registry push) yourself, even when you have credentials — a manual publish
desyncs the registry from `main` and makes the next CI publish fail (it errors if
the version already exists on npm). If a publish is needed, land the version bump
on `main` and let the Action do it.

The version log lives in **`CHANGELOG.md`** — there are no git tags. To cut a
release:

1. On a branch, bump the version: `npm version <patch|minor|major> --no-git-tag-version`.
2. Add a matching `CHANGELOG.md` entry under a new `## [x.y.z] - YYYY-MM-DD` heading.
3. Open a PR and merge it (main is protected — PRs only).

On merge, the **Publish to npm** action publishes when `package.json` carries a
new version, no-ops when the version is unchanged, and **fails** if the version
was bumped to one that already exists on npm. Never bump the version without a
CHANGELOG entry in the same PR.

## Test types — every new feature needs all three layers

For every new feature or subsystem, provide tests at three levels:

1. **Unit** — test the pure logic directly (no I/O, no subprocess). One `describe` block per module/function. Cover edge cases: empty input, nil/falsy, boundary values.
2. **Integration** — test the feature wired to real I/O (real FS, real JSON, real in-process module graph). No mocks on I/O boundaries. Confirm files are written, data round-trips correctly, modules interact as expected.
3. **E2E / CLI** — spawn the real CLI process (`spawnSync('node', ['bin/lakonai.js', ...])`) and assert on stdout/stderr/exit code. Prove the wire-up from the user's perspective.

**Do not ship a feature that has only unit tests.** Integration proves the glue; E2E proves the UX. All three levels must be present before a commit is ready.

## Testing policy — tests before commit (only at commit time)

This project uses **Jest** with a coverage gate. The rule:

- **When the user asks you to commit** new feature work, FIRST make sure the
  feature is covered by tests, then commit. Do not commit a new feature without
  accompanying tests.
- **Only at the end, at commit time.** Do not stop to write tests during
  incremental/iterative work — build the feature first, iterate freely. Tests
  are a precondition of the *commit*, not of every intermediate step.
- This applies to **new features**. Pure refactors, docs, and config tweaks that
  don't add behavior don't require new tests (but must not break existing ones).

Concretely, before running `git commit` for a feature:

1. Add/extend Jest tests covering the new behavior (happy path + edge cases).
2. Run `npm test` — it must exit green.
3. Run `npm run test:coverage` — global gate is **≥ 80%**, but the target for
   every new file is **100%**. Write tests until coverage reaches 100% for the
   files you touched; only then is the commit ready.
4. Then commit.

## Coverage target: 100% per new file, 80% global gate

The goal is **100% coverage on every new file**. The global Jest threshold that
actually fails CI is **80%** (`coverageThreshold.global` in `jest.config.js`) —
the 100% figure is the per-file target you write tests to, not the gate.
`/* istanbul ignore next */` is allowed only for: I/O entry points (`main`,
`readStdin`), best-effort tracking blocks that must never throw, and platform
detection branches that can't be simulated in the test environment (document
the reason inline).

For integration tests that spawn subprocesses (`spawnSync('node', [hook])`):
coverage instrumentation does not track the child — add a companion in-process
unit test for the same logic so the module shows coverage. Both test types are
valuable: integration proves the wire-up, unit proves the logic and drives coverage.

## Test commands

```bash
npm test                      # run the Jest suite
npm run test:coverage          # suite + coverage table (text + HTML in ./coverage)
npm run test:coverage:check    # same; fails if below the 80% global threshold
```

Coverage thresholds live in `jest.config.js` (`coverageThreshold.global`, 80% on
lines/branches/functions/statements).
The HTML report is written to `coverage/index.html`.

## Testing conventions

- Tests live in `tests/**/*.test.js`. Jest provides `test`/`describe` as globals;
  assertions use `node:assert/strict`.
- **Prefer in-process unit tests over spawning subprocesses.** Coverage
  instrumentation does not track child processes — a hook tested only via
  `spawnSync('node', [hook])` shows 0% coverage even when it passes. Export the
  pure logic from a module and call it directly in the test.
- Hook entry points guard their runtime with `if (require.main === module)` so the
  module can be `require()`d in tests without executing `main()`. Wrap the I/O
  shell (`main`, `readStdin`) and best-effort tracking with `/* istanbul ignore
  next */` rather than asserting on `process.exit` side effects.
- Resolve the home directory via `homedir()` from `src/install/paths.js`
  (`process.env.HOME || os.homedir()`), not bare `os.homedir()` — the latter
  ignores a test-set `process.env.HOME` under Jest's sandbox and breaks home
  isolation.

## Layout

- `bin/lakonai.js` — CLI entry (run + filter, install, gain, inspect).
- `src/filters/` — per-command output filters (`git`, `ls`, `cat`, `grep`,
  `test`, shared `utils`).
- `src/hooks/` — Claude Code hooks (bash-rewrite, read-guard, grep-guard,
  session-start, stop-hook, throttle).
- `src/install/` — installer for platform rules + hooks.
