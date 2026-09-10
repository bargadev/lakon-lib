# Changelog

All notable changes to **lakonai** are recorded here. The version log lives in
this file (no git tags). Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project uses semver.

## [Unreleased]

## [1.2.7] - 2026-09-09

### Fixed
- **An upgrade never reached the running proxy.** `npm i -g lakonai` swaps files
  on disk and runs no postinstall, and the daemon already running keeps
  executing the `server.js` it was started with. The result was a new CLI in
  front of an old proxy: 1.2.6 shipped the port-reclaim fix, and the daemon
  actually serving every session was still 1.2.5. `start()` already knew how to
  replace a version-mismatched daemon — nothing called it. The SessionStart hook
  now does (`src/proxy/refresh.js`), so the first new session after an upgrade
  retires the stale daemon and puts the code you installed in the path. It acts
  only on a real mismatch, never starts a proxy that was not already running,
  never breaks a session when the proxy misbehaves, and is disabled with
  `LAKON_NO_PROXY_REFRESH=1`.
- **Replacing a stale daemon moved the port and stranded live sessions.** The
  same defect 1.2.6 fixed for a *dead* daemon was still present on the
  retire-and-replace path: it calls `clearState()` and then recurses into
  `start()`, which re-read the port from the state that had just been cleared
  and fell back to `DEFAULT_PORT`. Any daemon not already on the default moved,
  and every session pinned to the old port — `ANTHROPIC_BASE_URL` is read once,
  at launch, and held for life — was left on ECONNREFUSED. The port is now
  carried across the clear explicitly.


## [1.2.6] - 2026-09-09

### Fixed
- **A restart moved the proxy to a different port and stranded every running
  session.** `start()` cleared the stale state *before* reading the port to bind,
  so a daemon that had died on port 7474 was replaced by one on the default
  (41474). That matters because a Claude Code process reads
  `ANTHROPIC_BASE_URL` once, at launch, and holds it for life — nothing can
  re-point it. So every session started against the old port kept retrying a
  refused connection until the user quit it, even though a healthy proxy was up
  the whole time. The port is now read before the state is cleared, and a
  restart reclaims it.
- **`proxy status` reported a dead proxy as "nothing broken".** That is true
  only for sessions started afterwards. `proxy status` now looks for sessions
  still pinned to the dead port, names their pids, and says they are failing
  with ConnectionRefused and that `lakonai proxy start` recovers them.
- **Upgrading from inside Claude Code could drop your own session.** Replacing
  the proxy killed the running daemon — the one serving the session doing the
  upgrading. The daemon now retires gracefully instead (SIGUSR2: stop listening,
  finish the connections already open). A daemon too old to understand that
  signal is left alive while anything is still connected, remembered in
  `~/.lakon/proxy-retired.json`, and reaped on a later start once it is idle.
- **Stale hook launchers from older versions crashed on every event.** When a
  hook was removed from the package, its generated launcher and its
  `settings.json` entry stayed behind. `install` owns the `lakon-` namespace, so
  it now prunes launchers and entries it no longer ships, and reports how many.

### Added
- **Deferred work is applied automatically instead of asking you to remember a
  command.** `lakonai install` cannot wrap MCP servers while a session is live
  (that means rewriting `~/.claude.json` under the session still using it), so
  it queues the work and a new `SessionEnd` hook drains the queue once the
  session ends. Any `lakonai` command run outside a session drains it too, so a
  machine whose sessions never end cleanly still converges. Install now says
  "MCP compression queued — applied automatically when the session ends" rather
  than naming a command to run later.

## [1.2.5] - 2026-09-09

### Fixed
- **A shell that already carried a dead `ANTHROPIC_BASE_URL` stayed broken after
  upgrading.** 1.2.3 stopped lakonai from *setting* a base URL to a proxy that
  is not listening, but the generated snippet left an existing one alone — and
  the users hit by the original bug have exactly that: a terminal exporting
  `http://127.0.0.1:7474` from the old install, inherited by every shell started
  from it. `~/.lakon/proxy-env.sh` now unsets an inherited
  `http://127.0.0.1:<current port|7474>` when nothing answers there, so such a
  shell heals itself instead of failing every `claude` with ECONNREFUSED. A live
  proxy on that port is kept, and a base URL pointing anywhere else is still
  never touched.

## [1.2.4] - 2026-09-09

### Fixed
- **Installing lakonai could cost you your Claude Code session.** `lakonai
  install` wraps MCP servers by rewriting `~/.claude.json` — the same file where
  Claude Code keeps per-project session state (`lastSessionId`,
  `lastSessionFirstPrompt`, `hasTrustDialogAccepted`, `allowedTools`) and which
  it rewrites on every turn. The wrap was a non-atomic read-modify-write, run
  unconditionally, and people typically install from inside a running session.
  Two ways that lost work: anything Claude Code wrote between the read and the
  write was discarded (orphaning the session, so `claude --resume` no longer
  found it), and `fs.writeFileSync` truncates before filling, so an interrupted
  or concurrently-read write left invalid JSON and Claude Code fell back to an
  empty config. Three guards now:
  1. **No write while a session is live.** `lakonai install` from inside Claude
     Code defers the MCP wrap and says so, with the command to run afterwards.
     Detection: `CLAUDE_CODE_ENTRYPOINT`/`CLAUDE_PID`, or the config having been
     written in the last 30s by someone other than us (our own writes are
     fingerprinted, so `mcp wrap` followed by `mcp unwrap` still works).
  2. **Atomic writes.** `src/install/atomic.js` writes a sibling temp file,
     fsyncs and renames, so a reader sees the whole old file or the whole new
     one. Used for `~/.claude.json`, `~/.claude/settings.json` and the rule
     blocks — every file a running agent may read.
  3. **State validation.** The bytes are parsed and checked before the rename:
     if a top-level key, a project, or a session id would change, the write is
     refused.

### Added
- **`lakonai mcp [status|wrap|unwrap] [--force]`** — inspect and apply MCP
  catalog compression on your own terms; `status` reports how many servers are
  wrapped and whether a live session is holding the wrap back. Previously
  wrapping only happened as a silent side effect of `lakonai install`, with no
  way to see it, defer it, or apply it later.
- `src/install/atomic.js` — `writeFileAtomic`, at 100% coverage.

### Changed
- `wrapMcp`/`unwrapMcp` return `{ count, skipped, reason }` instead of a bare
  count, so callers can tell "nothing to do" from "deliberately skipped".

## [1.2.3] - 2026-09-09

### Fixed
- **The proxy could break every `claude` run on a fresh install.** `lakonai
  install` started the compression proxy and wrote
  `export ANTHROPIC_BASE_URL=http://127.0.0.1:7474` into `~/.zshrc`,
  `~/.bashrc` and `~/.bash_profile` — unconditionally, and without ever checking
  that the daemon had come up. `daemon.start()` returned `{running: true}`
  straight after `spawn()` (stdio ignored, no `error` handler), so a server that
  died on `EADDRINUSE` left the shell pointing at a dead port. Every later
  Claude Code request then failed with
  `Connection refused — a firewall or proxy may be blocking it`, with nothing
  naming lakonai as the cause. The only way out was `unset ANTHROPIC_BASE_URL`.
  Now: the supervisor waits for a real TCP connect before reporting success, and
  the installer wires the shell only if that succeeded.
- **The shell can no longer be pointed at a dead proxy.** The rc sources
  `~/.lakon/proxy-env.sh`, which re-checks the port on every shell start (zsh
  `ztcp` → bash `/dev/tcp` → `nc`) and exports `ANTHROPIC_BASE_URL` only while
  the proxy answers. A dead proxy costs compression, not the CLI. Old
  unconditional export lines are migrated away on the next install/start.
- **Default port moved from 7474 to 41474.** 7474 is Neo4j's HTTP port — a
  likely collision on a developer machine, and the trigger for the failure
  above. On `EADDRINUSE` the server now binds an OS-assigned free port instead
  of exiting.
- **`ANTHROPIC_BASE_URL` set by the user is respected** — the snippet takes over
  only when nothing is set, or when what is set is our own local proxy.
- **`lakonai uninstall` now unwires the proxy.** `daemon.stop()` and
  `daemon.uninstallEnv()` existed but were dead code: uninstalling left the rc
  export and a running daemon behind.
- **`proxy stop` will not signal a PID it cannot prove is ours** (it must serve
  the port or run `proxy/server.js`) — PIDs get recycled.
- **`status()` probes the port, not just the PID.** A live-but-not-listening pid
  now reads as stale instead of healthy.

### Changed
- **Upgrading now migrates an existing install.** The server stamps the version
  it is running into `~/.lakon/proxy.json`; `daemon.start()` replaces a daemon
  whose stamp is not the installed version — including a pre-1.2.3 one, which
  has no stamp at all. Without this, `lakonai upgrade` adopted the old process:
  the fixed server never actually ran, and the daemon stayed on port 7474.
  Adopting a current daemon also (re)writes `~/.lakon/proxy-env.sh`, so the
  migrated rc line never points at a missing file.

### Added
- **`lakonai proxy [status|start|stop|restart]`** — inspect and control the
  compression proxy; `status` exits 1 when it is not serving. Previously the
  daemon could only be started as a side effect of `lakonai install`, with no
  way to check or restart it.
- `LAKON_PROXY_DISABLE=1` skips all proxy wiring in `install`/`uninstall` (and
  keeps the test suite from spawning daemons or editing real rc files);
  `LAKON_PROXY_FALLBACK=0` makes a busy port a hard failure instead of a move.
- `src/proxy/state.js` — shared proxy state, TCP probing, and the generated
  shell snippet, with 100% coverage.

## [1.2.2] - 2026-09-02

### Changed
- **README (npm-facing):** embedded a self-contained before/after SVG at the top
  showing the real `git diff main…HEAD` measurement (1,513,910 → 2,331 tokens,
  −99.8%); replaced the "up to 94%" hero with the measured 99.8% number; added an
  explicit GitHub link to the first fold; reframed the Credits section so lakonai
  reads as an original zero-dependency tool (prior art credited as inspiration,
  not vendored/forked). Corrected the stale test counts (725/47 → 751/48).

## [1.2.1] - 2026-08-26

### Fixed
- **Windows: hooks never ran** (`command not found`). Claude Code executes `"type": "command"` hooks through bash (Git Bash) on Windows, which strips the backslashes in a native path (`C:\Users\…\lakon-stop-hook.js` → `C:Users…lakon-stop-hook.js`) and cannot exec a `.js` by path. The installer now emits `node "<forward-slash-path>"` on win32 (POSIX unchanged — the executable hook file runs directly via its shebang). Without this, every hook silently failed, so auto-filtering never applied and only explicit `lakonai <cmd>` invocations were compressed.

## [1.2.0] - 2026-08-24

### Added
- **Semantic graph query** (restored from orphaned branches #17–#21) — BGE-small-en-v1.5 embeddings, hybrid BM25 + RRF fusion, source boost, docblock/param indexing, auto-annotate via `claude --print`. Benchmark: 19/30 BM25-only → 29/30 hybrid.
- **`lakonai graph annotate`** — LLM-generated one-line docblocks stored in `lakonai-graph/annotations.json`; source files never modified; mtime-based cache.
- **30-query benchmark** (`scripts/benchmark-query.js`) — 15 literal + 15 semantic.

### Changed
- README: real-world benchmarks from live projects (React+TipTap 182k-line diff −99.8%, WhatsApp SDK `WAProto/index.js` 293k tok → 13 tok −100%).

## [1.1.1] - 2026-08-24

### Fixed
- CI tests for `session-start` and `learn-report-integration` now pass `LAKON_NO_AUTO_GRAPH=1` to suppress the auto-build notice in environments without a real project context.

## [1.1.0] - 2026-08-24

### Added
- **Auto graph build on session start** — on `SessionStart`, lakonai detects the git root and automatically triggers `lakonai graph build` in the background for projects that don't have a graph yet. Fire-and-forget; never blocks the session. Existing projects see no change.

### Fixed
- **ENOBUFS on large diffs** — `spawnSync` maxBuffer raised from 1 MB to 200 MB. If still exceeded, falls back to `stdio: 'inherit'` passthrough so output is never lost.

## [1.0.2] - 2026-08-24

### Fixed
- README: corrected "zero LLM" claim — `graph build` auto-annotate uses Haiku once per undocumented file (mtime-cached).

## [1.0.1] - 2026-08-24

### Fixed
- CI publish no longer fails due to `proxy-stats.json` assertion running unconditionally in environments where the proxy has never been started.

## [1.0.0] - 2026-08-24

### Added
- **Semantic graph query** — hybrid BM25 + vector search powered by BGE-small-en-v1.5 (~23 MB, fully local via `@xenova/transformers`). Install the optional dep and rebuild to unlock. Benchmark: 19/30 BM25-only → 29/30 hybrid on the lakonai codebase.
- **`lakonai graph annotate`** — generates search-optimised one-line docblocks for undocumented files via `claude --print` (zero config for Claude Code users), `ANTHROPIC_API_KEY`, or Ollama. Stored in `lakonai-graph/annotations.json`; source files are never modified.
- **Auto-annotate on build** — `lakonai graph build` automatically annotates new and modified files (mtime-based cache) before generating embeddings. Only changed files incur LLM calls.
- **Function param indexing** — function parameter names are included in the embedding text for richer semantic retrieval.
- **Source boost** — non-source nodes (tests, scripts, bin) are penalised 0.5× in semantic ranking to surface production code first.
- **RRF hybrid fusion** — asymmetric Reciprocal Rank Fusion (k_sem=60, k_bm25=300) combines BM25 and semantic results; BM25 capped at top-10 to suppress noise.

## [0.17.1] - 2026-07-16

### Fixed
- **0.17.0 never reached npm.** Its publish workflow ran `npm test` before
  `npm publish`, and a test in this release hung the CI runner instead of
  failing: it pointed `LAKON_HOME` at `/proc/nonexistent-lakon/deep` to force a
  write failure, which fails fast on macOS (`/proc` doesn't exist there) but on
  the Linux Actions runner made `mkdirSync` hang instead of throwing. Jest never
  exited, `npm test` never completed, and the job sat until the Actions 6h
  global timeout killed it — silently, with no error pointing at the cause.
  Replaced the OS-dependent path with a deterministic `fs.mkdirSync` mock, and
  added `forceExit`/`testTimeout` (15s) to `jest.config.js` so a stuck test
  fails fast instead of blocking every subsequent publish for hours.
- This release carries 0.17.0's changes (sandbox spill, the read-guard and git
  filter fixes below) plus this CI fix, since 0.17.0 itself was never published.

## [0.17.0] - 2026-07-15

### Added
- **Sandbox spill — output that survives the filters stops costing context.** When
  a command's output is still over budget after filtering, the full text is parked
  in `~/.lakon/sandbox/<id>.txt` and the agent gets a digest instead: head, tail,
  exit code, and how to query the rest. Nothing is lost — it just stops being
  re-paid every turn. Measured on a 4000-line build log: **4000 lines / 120KB in,
  29 lines out.**
- **`lakonai peek [id]`** — read parked output back: `--offset N`, `--limit N`,
  `--grep <regex>`. No id lists what's parked. Spills are garbage-collected (newest
  50, 24h).
- **The spill is universal, not allowlist-bound.** A new `PostToolUse` hook
  (`output-spill.js`) runs after ANY tool and receives the real result, so it nets
  what the `PreToolUse` rewrite structurally cannot: unrouted Bash (`terraform
  plan`, `./deploy.sh`), **stderr**, and `Read`/`Grep`/`Glob`/`WebFetch`/`Task`
  output. `PostToolUse` is the only event that can replace a tool result
  (`updatedToolOutput`) — PreToolUse fires before the output exists.
  `Edit`/`Write`/`TodoWrite` are excluded: structural results, not bulk.
- `LAKON_SPILL_TOKENS` tunes the budget; **`0` disables spilling entirely.**

### Fixed
- **`read-guard` let wide-line files through untouched.** The auto-cap counted
  *lines* (`AUTO_CAP_LINES`, 800) and ignored how wide they were, so a 100-line ×
  5000-char JSON — 100 lines, under the cap, **~124k tokens** — sailed straight
  into context. The cap now also enforces a byte budget (`READ_TOKEN_BUDGET`,
  8000): the limit is derived from `size/lines`, and the tighter of the two
  ceilings wins. Ordinary code is unaffected (800 lines of ~40-byte lines is
  already ~8k tokens, so the line cap still bites first).
  - A file whose **single line** already blows the budget (minified bundle,
    one-line JSON dump) is now **denied**: `Read` slices by line, so even
    `limit: 1` would hand over the whole file. The denial points at `jq`/`grep -o`,
    which can cut inside a line.
  - Honest scope: the 124k figure is a constructed worst case. Replayed against a
    real 6k-command log, the measurable recovery was ~5.7k tokens — most capped
    Reads there were ordinary-width files the line cap already handled, and 14 of
    20 candidate files no longer existed to test. This closes a demonstrated hole;
    it is not a large across-the-board win.
- **`fileLineCount` slurped whole files into RAM** just to count `\n` — on the very
  files this guard exists for. Past `FULL_READ_LIMIT` (4MB) it now samples a 64KB
  prefix and extrapolates; the number only feeds a cap decision, and a 500MB file
  is getting capped regardless of the exact count.
- **`git status --short` reported a dirty tree as `clean`.** `filterStatus` keys on
  long-format section headers ("Changes not staged", "Untracked files:"), which
  `--short`/`-s`/`--porcelain` never emit — so nothing was parsed and it fell
  through to a hardcoded `'clean'`. It now only says clean when git actually said
  so, and passes the (already terse) short formats through untouched, preserving
  the significant leading column (` M` unstaged vs `M ` staged). A filter that
  invents state is worse than no filter.

### Notes
- The spill reaches **routed commands only** (first word must be one lakonai
  knows), and **stdout only except for test runners** — `needsStderr()` is false
  for `npm run build`/`docker logs`, so their stderr bypasses the spill and still
  costs context. Both limits are documented in the README rather than papered over.
- The digest reports measured lines + KB, never an estimated token count:
  `countTokensApprox()` splits on whitespace and undercounts a real tokenizer by
  ~35% on prose. A tool that exists to be honest about token cost should not quote
  a number it cannot stand behind.

## [0.16.5] - 2026-06-09

### Fixed
- **`lakonai gain` no longer hangs forever on the output benchmark.** The
  benchmark fires several `claude --print` calls back-to-back, but `callAgent`
  ran `spawnSync` with no timeout — a single stalled CLI (auth prompt, network
  stall) blocked `gain` (and memory compression) indefinitely. Calls now carry a
  default 120s wall-clock cap (`SIGKILL` on expiry), so a hung agent aborts the
  bench instead of freezing the command. Override with `LAKONAI_LLM_TIMEOUT_MS`
  (set `0` to disable). On timeout the bench is skipped silently and `gain`
  finishes normally.

## [0.16.4] - 2026-06-02

### Fixed
- **`lakonai upgrade` no longer reinstalls the old version from a stale npm cache.**
  The npm path now passes `--prefer-online`, forcing npm to revalidate cached
  registry metadata before resolving `lakonai@latest`. Without it, a cached
  packument could keep `latest` pinned to a previous version (npm served `latest →
  0.16.2` even after 0.16.3 shipped), so `upgrade` silently no-op'd. No full
  `npm cache clean` — that wipes every package's cache and is discouraged;
  `--prefer-online` is the surgical fix.

## [0.16.3] - 2026-06-02

### Changed
- **`homepage` now points to the marketing site** (`https://bargadev.github.io/lakonai-site`)
  instead of the GitHub repo, so the npm page links to the landing page. The
  repository and bug-tracker links still point to GitHub.

## [0.16.2] - 2026-06-02

### Changed
- **README output-savings section now matches what `lakonai gain` actually shows.**
  After 0.16.1 fixed the bench, `gain` reports the rule's effect against a rule-free
  Claude baseline (~52% on prose prompts), not the old "~10% marginal vs an
  already-concise agent" framing. The section is rewritten honestly: the ~52% is
  labelled a best-case on prose turns, with the real workload landing between the
  deterministic input savings (~46%) and that ceiling. Example block refreshed to
  the current output format.

## [0.16.1] - 2026-06-02

### Fixed
- **Output benchmark in `lakonai gain` now actually measures (was stuck on "not
  measured yet").** The bench isolated the baseline arm from the installed terse
  rule by pointing `CLAUDE_CONFIG_DIR` at an empty dir — but on macOS that switches
  the Claude CLI to file-based auth, leaving it "Not logged in" (the credential
  lives in the Keychain, keyed to the default config dir). The CLI exited 1, the
  error was swallowed, and the figure never appeared. We now isolate the rule via
  the CLI's own flag instead (`--setting-sources project`, dropping the `user`
  source) plus an empty `cwd`, keeping Keychain auth intact. `callAgent` gains
  `ruleFree`/`cwd` options; the `cleanConfigDir`/`cleanEnvVar` path is removed.

## [0.16.0] - 2026-06-02

### Added
- **`compress-memory` takes a freeform instruction + validation levels.**
  `lakonai compress-memory <file> "focus on marketing"` steers the rewrite. Three
  safety levels: default (protect code+inline+URL - lossless), `--prune` (protect
  fenced code only - may drop sentences/spans), `--rewrite` (no validation, free
  restructure - backup only). Lets the LLM restructure/cut, not just shorten prose.
- **Smarter shim offer.** `lakonai install` now offers the universal shim **only
  when a hook-less agent is detected** (Codex/Cursor/Windsurf/Cline/Gemini) -
  Claude Code's hooks already cover shell filtering, so the shim is pointless
  there. Consensual prompt (TTY only), never silent.

- **`lakonai gain` now shows OUTPUT savings too**, not just input. Measures how
  much terser the model writes with the rule, via your local AI CLI (no API key),
  the rule injected as a system prompt (`claude --append-system-prompt`), at most
  weekly, TTY-only (never blocks a piped gain), cached in
  `~/.lakon/output-bench.json` (`src/output-bench.js`). No separate command: `gain`
  shows everything. Opt-out `LAKON_NO_OUTPUT_BENCH=1`. The figure is modest (single
  digits) because agent CLIs are already concise; shown honestly, not inflated
  (`docs/output-bench-vs-caveman.md`). Drops the old "offline / never measures
  output" stance; `deps-0` still holds (the AI CLI is external).
- **`lakonai upgrade`** updates via the detected package manager (npm/pnpm/yarn/
  bun) + refreshes the rule block (distinct "upgraded" output). oh-my-zsh-style: at
  a TTY, `gain`/`version` offer `Update now? [Y/n]` (`src/upgrade.js`,
  `src/update-prompt.js`; opt-out `LAKON_NO_AUTOUPDATE=1`).

### Changed
- README rewritten lean: 442 to ~170 lines (smaller than caveman's), deep
  reference moved to `docs/reference.md`. Removed em dashes project-wide.

### Removed
- `lakonai backups` command (low value; `revert` is what matters; the
  `backupsReport` helper stays internal).

## [0.15.1] - 2026-05-30

### Changed
- README: promoted the slogan **"Speak less. Ship more."** from a footer `<sub>`
  to a hero `<h3>` (a footer line nobody scrolls to isn't a slogan), and trimmed
  the redundant tagline.

## [0.15.0] - 2026-05-30

### Added
- **Platform-agnostic auto-learning.** Beyond the Claude-transcript learner,
  lakonai now also learns from `~/.lakon/log.jsonl` - appended to by every
  `lakonai` call (shim wrappers + rule-prefixed commands) on ANY agent. A heavy,
  frequent non-builtin command gets promoted to the filtered set automatically,
  everywhere, throttled hourly (`learn.analyzeLog` / `maybeLearnFromLog`, called
  from `runAndFilter`). Disable with `LAKON_NO_LEARN=1`. With the shim, all four
  input-side features now run automatically on every agent for shell-mediated
  work; only guarding the agent's own non-shell Read tool stays Claude-only.

### Changed
- Trimmed the Claude Code install line: shows `+ N slash commands` instead of
  listing every command.

### Notes
- Releases now publish **only via CI** on merge to `main` (no manual `npm
  publish`) - documented in CLAUDE.md.

## [0.14.0] - 2026-05-30

### Added
- **Universal Read-guard on the shell path** (`src/shim-guard.js`). `lakonai cat`
  /`head`/`tail`/`less`/`more`/`bat` now refuse junk reads (lockfiles,
  `node_modules/…`, build artifacts) using the **same deny rules as the Claude
  Read hook**. Combined with the shim, junk-read protection is now automatic on
  **every agent** for shell-mediated reads (`cat pnpm-lock.yaml` → skipped with a
  one-line reason), not just Claude Code's Read tool. An agent's own non-shell
  Read tool still needs a hook (Claude only); auto-learning stays Claude-only (it
  needs the agent's command stream) and is largely moot elsewhere since the shim
  already filters the standard heavy commands.

## [0.13.0] - 2026-05-30

### Added
- **Universal PATH shim** - `lakonai shim` (and `lakonai shim --off`). Makes
  shell-output filtering **automatic on every agent**, not just Claude Code:
  it drops executable wrappers for `ls`/`grep`/`rg`/`ag`/`find`/`cat`/`tree`/`head`
  into `~/.lakon/shim/` and prepends that dir to PATH in your shell rc, so any
  agent (Codex, Cursor, Windsurf, Cline, Gemini CLI) that runs those commands
  through a shell gets them routed through lakonai - no hook API, no model
  cooperation. `git`/`tail` are excluded (editors / streaming); recursion is
  prevented by stripping the shim dir from PATH when lakonai spawns the real
  binary (`pathWithoutShim`). Opt-in (it edits your shell rc); only reaches
  agents that inherit your shell's PATH. (`src/install/shim.js`.)
- The honest capability matrix now shows shell filtering as automatic on all six
  agents via the shim. Read/Grep guards + auto-learning remain Claude-Code-only
  (they act on the agent's own tool calls, which needs a call-rewriting hook -
  today only Claude Code's; Codex is blocked upstream, see openai/codex#18491).

## [0.12.1] - 2026-05-30

### Changed
- **README - sellable marketing pass.** Reframed the pitch as **four fronts** of
  token waste (model output · shell input · file reads · context catalogs+memory)
  and surfaced the two newest, most differentiating capabilities high up:
  automatic MCP catalog compression and `compress-memory` (no API key). No feature
  or number was invented; dropped a stale test-count/coverage claim.
- **CLAUDE.md** - added a rule to keep the npm package page ("About") in sync:
  npm only re-renders the README on publish, so a user-facing README change isn't
  done until it ships in a published version.

## [0.12.0] - 2026-05-30

### Added
- **Memory-file compression** - `lakonai compress-memory <file>` (+ `revert-memory`).
  Manual, opt-in compression of *user-authored* memory (`CLAUDE.md`, notes) using a
  local AI CLI you already have: `claude` / `gemini` / `codex` / `cursor-agent`,
  auto-detected on PATH (override `LAKONAI_MEM_CLI`; model via `LAKONAI_MEM_MODEL`).
  **No API key.** A `<name>.original.md` backup is written first; the output is
  **validated** so every fenced/inline code span and URL survives byte-for-byte -
  on a miss it runs one fix pass, else aborts untouched. Sensitive-looking
  filenames (`.env`, `*api-key*`, …) are refused. `install` offers a one-time
  opt-in prompt to compress a detected `CLAUDE.md`. Unlike the MCP catalog shrink,
  this rewrites authored prose with an LLM, so it is **never automatic**
  (`src/mem-llm.js` + `src/mem-compress.js`). Measured: ~59% on a verbose file,
  ~2% on an already-terse one.
- **Automatic MCP catalog compression.** On Claude Code install, lakonai finds
  the MCP servers in `~/.claude.json` and transparently wraps each stdio server
  (`lakonai __mcp <cmd>`) so its tool/prompt/resource **descriptions** are
  compressed before they reach context (offline, regex; `src/mcp-shrink.js` +
  `src/install/mcp.js`). Backed up, reversible on `uninstall`, opt-out
  `LAKON_NO_MCP=1`. Requests and tool-call results are never altered. (Caveman's
  MCP shrinker is manual config; this is automatic.)
- **Benchmark preview in `lakonai gain`** - when there's no usage logged yet,
  `gain` prints a reproducible, offline filter-savings benchmark so you see the
  value immediately (no separate command).

### Removed (simplification - back to one command set)
- `lakonai mode`, `compress`, `shrink`, `shell-init`/`shell-uninit`, `inspect`,
  `reset`, `list` commands and the `UserPromptSubmit` per-turn reinforcement hook
  and the terse subagents. These were caveman-parity experiments that diluted the
  "`install` → automatic savings" identity. Core surface is now `install`,
  `uninstall`, `revert`, `backups`, `gain`, `doctor`, `version` (+ the internal
  `lakonai <cmd>` filter engine). Filtering, Read/Grep guards and auto-learning
  are unchanged.

## [0.11.0] - 2026-05-30

### Added
- **`lakonai shrink <mcp-server-cmd>`** - a stdio MCP proxy that compresses tool/
  prompt/resource `description` fields before they enter context (offline, regex;
  `src/shrink.js`). Requests and tool-call results pass through untouched; code,
  URLs, paths and identifiers preserved exactly.

### Changed
- The MCP shrinker is now **bundled into lakonai** as a subcommand instead of a
  separate `lakonai-shrink` package - one install, one version, reuses the terse
  compressor. Fixed a description-compression bug (identifier over-matching +
  placeholder restore) found while folding it in.

## [0.10.0] - 2026-05-30

### Added
- **`lakonai doctor`** - per-platform health check: CLI on PATH, rule installed,
  hooks registered (`src/doctor.js`).
- **Honest capability matrix** in the README: exactly what each of the 6 agents
  gets (hooks are Claude-Code-only; elsewhere it's the rule + `lakonai` prefix).
- **`lakonai shell-init` / `shell-uninit`** - opt-in shell wrapper that
  auto-filters read-only commands when `LAKON_SHELL=1`, for platforms without a
  hook API (`src/shell.js`).
- **Terse subagents** (cavecrew-style) installed on Claude Code:
  `lakonai-investigator` / `lakonai-builder` / `lakonai-reviewer`, with compact
  output contracts (`src/install/claude-agents.js`).
- **OUTPUT benchmark harness** - `scripts/bench-output.js` measures how much less
  the model writes under the rule via your own `claude` CLI (3 arms: baseline /
  concise / lakonai; honest delta = vs concise), and `scripts/bench-measure.js`
  aggregates a committed snapshot offline (CI-safe). `npm run bench` /
  `bench:output` / `bench:measure`.

### Related (separate package)
- **`lakonai-shrink`** - a standalone, zero-dep stdio MCP proxy that compresses
  tool/prompt/resource `description` fields (offline). Ships independently.

## [0.9.0] - 2026-05-29

### Added (caveman-inspired, output/memory side)
- **Per-turn reinforcement** - a `UserPromptSubmit` hook (`src/hooks/prompt-reinforce.js`)
  re-injects the terse rule each turn so the model doesn't drift back to verbose
  prose mid-session. Opt out with `LAKON_NO_REINFORCE=1`.
- **Intensity levels** - `lakonai mode <lite|full|ultra>` (`src/mode.js`,
  persisted at `~/.lakon/mode`, override with `$LAKON_MODE`). The reinforcement
  reminder reflects the active level.
- **Formalized auto-clarity carve-outs** in the terse rule (security/irreversible
  confirmations, order-sensitive sequences, ambiguity, confusion).
- **`lakonai compress <file>`** (`src/compress.js`) - shrink memory files
  (CLAUDE.md/notes). Default is near-lossless and offline (blank/whitespace
  collapse, code/inline-code preserved). `--llm` rewrites prose tersely via the
  user's existing `claude` CLI (`claude --print`, no separate API key, no new
  dep); `--dry-run` previews savings without writing. Backs up to `<file>.bak`.
- **Terse workflow commands** `/lakonai:commit` and `/lakonai:review`.
- **Benchmark harness** (`scripts/bench.js` + `tests/fixtures/bench/`) - runs a
  fixed corpus through the filters and reports savings; `tests/bench.test.js`
  fails CI if a filter regresses below its threshold.

### Fixed
- **Installed hooks were broken** when they required the shared module graph
  (`bash-rewrite`→`../filters`, `stop-hook`→`../learn`). Installed hooks are now
  launchers that run the packaged hook in place, so relative requires resolve.

## [0.8.0] - 2026-05-29

### Added
- **Declarative filter engine** (`src/filters/engine.js` + `src/filters/defs.js`)
  - a 9-stage pipeline driven by data; adding a simple command filter is now one
  entry in `defs.js`.
- **Test-runner filtering** wired into the dispatch with stderr capture: jest,
  vitest, mocha, pytest, ava, `npm/pnpm/yarn/bun test`, `go test`, `cargo test` -
  collapse passes, keep failures + the summary.
- **Lint / build / cloud filters** via the engine: `tsc`, `eslint`, `ruff`,
  `cargo clippy`, `make`, `diff`, `docker`, `kubectl`, `aws`, package installs.
- **`find` filter** that groups matched paths by directory.
- **Auto-learning** (`src/learn.js` + `src/filters/auto.js`): reads the session
  transcript at session end, accumulates per-command output stats across sessions,
  and automatically enables a conservative, near-lossless filter for chatty
  unfiltered commands once they cross a floor. Opt out with `LAKON_NO_LEARN=1`.
- `dedupConsecutive` and `groupByDir` primitives in `utils`.
- `.claude/agents/lakonai-spec.md` - full-codebase knowledge agent.
- npm publish GitHub Action on merge to main (version-guarded) + branch
  protection (PRs only).

### Changed
- Coverage expanded from 4 commands to ~30.
- Migrated the test suite from `node:test` + c8 to **Jest**; suite at **270
  tests, 100% coverage**.
- Renamed the package/repo references from `lakonai-lib` to **lakonai**.

### Removed
- The legacy `lakon` and `lak` command aliases - use `lakonai`.

## [0.7.x] - earlier

Pre-changelog baseline: terse-output rule + filtered CLI output for `git`, `ls`,
`cat`, `grep`, plus the Read/Grep guards, session tracking, and the installer.
