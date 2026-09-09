<p align="center">
  <img src="./assets/logo.svg" width="140" alt="lakonai" />
</p>

<h1 align="center">lakonai</h1>

<h3 align="center">Speak less. Ship more.</h3>

<p align="center">
  <strong>Cut LLM tokens by up to 99.8% — without losing a single identifier.</strong><br/>
  <sub>A 182k-line <code>git diff</code> went <strong>1,513,910 → 2,331 tokens</strong>. Measured, not rounded.</sub>
</p>

<p align="center"><em>Spartan replies for AI agents.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/lakonai"><img src="https://img.shields.io/npm/v/lakonai?color=0F0F0F&label=npm" alt="npm" /></a>
  <a href="https://github.com/bargadev/lakonai"><img src="https://img.shields.io/badge/GitHub-bargadev%2Flakonai-0F0F0F?logo=github" alt="GitHub repo" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0F0F0F" alt="MIT" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A518-0F0F0F" alt="node ≥18" />
  <img src="https://img.shields.io/badge/deps-0-0F0F0F" alt="zero dependencies" />
  <img src="https://img.shields.io/badge/agents-6-0F0F0F" alt="6 AI agents" />
  <img src="https://img.shields.io/badge/tests-832-0F0F0F" alt="832 tests" />
</p>

<p align="center">
  <a href="https://github.com/bargadev/lakonai">
    <img src="./docs/assets/before-after.svg" width="820" alt="lakonai: a 182k-line git diff main…HEAD went 1,513,910 → 2,331 tokens (−99.8%), structure and identifiers intact" />
  </a>
</p>

<p align="center">
  One install. Zero configuration. Every token wasted by your agent — <strong>closed</strong>.<br/>
  Works across <strong>Claude Code, Codex, Cursor, Windsurf, Cline, Gemini CLI</strong>.<br/>
  <strong>Optimized for Claude Code</strong> — four dedicated layers, measured in production.
</p>

---

## Real savings, measured

All numbers from live projects using `lakonai@1.1.1`.

**CLI filters** — output compressed before it reaches the model (React + TipTap + Yjs microfrontend, 2,185 files):

| Command | Raw | Filtered | Saved |
|---|---:|---:|---:|
| `git log -20` | 17,097 tok | 450 tok | **−97%** |
| `git diff HEAD~3` | 10,780 tok | 1,952 tok | **−82%** |
| `git diff main…HEAD` ¹ | 1,513,910 tok | 2,331 tok | **−99.8%** |
| `find src -type f` | 28,392 tok | 707 tok | **−97%** |
| `ls -la` | 913 tok | 212 tok | **−77%** |

¹ 182k-line diff — previously crashed with `ENOBUFS`. Fixed in 1.1.1.

**Read-guard** — compact AST subgraph served instead of the raw file (WhatsApp client SDK, 300 files, 816 nodes):

| File | Raw | Subgraph | Saved |
|---|---:|---:|---:|
| `WAProto/index.js` | 293,256 tok | 13 tok | **−100%** |
| `src/index.js` | 1,849 tok | 69 tok | **−96%** |
| `src/index.d.ts` | 1,470 tok | 37 tok | **−97%** |
| `ProviderPanel.tsx` | 1,400 tok | 33 tok | **−98%** |
| `server/wa-client.js` | 1,134 tok | 9 tok | **−99%** |

**Proxy compression** — what actually reaches the Anthropic API (real session, 49 requests):

| Content type        | Without lakonai | With lakonai | Saved    |
| ------------------- | --------------: | -----------: | -------: |
| npm test (652 tests)|       5,168 tok |       85 tok | **-98%** |
| Build log (80 lines)|       1,298 tok |        8 tok | **-99%** |
| JSON API (120 users)|       2,386 tok |      104 tok | **-96%** |
| Git diff            |      ~3,000 tok |  ~2,880 tok  |   **-4%**|

**Typical coding session:** ~53% savings from proxy alone, ~75% with graph read-guard.

`lakonai gain` shows your own numbers. `/lakonai:stats` shows all layers at once.

---

## Eight fronts, one install

| Front | What it fixes | How |
|-------|--------------|-----|
| **Output** | _"Great question! Let me explain…"_ | Terse-response rule — no preamble, no recap. Auto-clarity for edge cases. |
| **Shell input** | `git log` dumping 1.8k tokens of metadata | Filters **30+ commands** (git/ls/grep/tests/lint/docker/kubectl/aws…) before they hit context |
| **Reads** | `Read pnpm-lock.yaml` → 80k of nothing | Hook blocks lockfiles/`node_modules`, caps huge files and `Grep` |
| **Overflow** | 4k-line build logs no filter knows | Parks on disk, hands the agent a digest — `lakonai peek` reads it back |
| **Proxy** | Every API request carries raw bloat | Local HTTP proxy compresses request bodies before they reach Anthropic |
| **Graph** | File reads load entire source files | AST knowledge graph: serves a compact subgraph instead of the raw file (-87%) |
| **Pixel** | Skill files are verbose markdown | Converts skill bodies to PNG — vision tokens cheaper than text tokens |
| **Context** | MCP catalogs + memory re-paid every turn | Auto-compresses MCP catalogs (`lakonai mcp`); `compress-memory` via local AI CLI |

Auto-learning runs underneath all of this: lakonai detects new heavy commands and enables a safe filter automatically, no config. ([full reference →](docs/reference.md))

---

## Quick start

```bash
npm install -g lakonai
lakonai install
```

That's it. From the next session your agent is terse, shell output is filtered, junk reads are blocked, the proxy compresses API traffic, and the graph intercepts file reads. Watch it in `lakonai gain`.

---

## Layers, explained

### Layer 1 — CLI filters (all agents)

Thirty-plus command filters run as a PATH shim or Claude Code hook before output ever reaches context. `git log -p` becomes three lines. A passing `npm test` suite becomes one.

```bash
lakonai git log -p     # → summary only
lakonai npm test       # → final counts only
lakonai ls -la         # → files without noise
```

### Layer 2 — Graph read-guard (Claude Code)

`lakonai graph build` parses your codebase into an AST knowledge graph — zero LLM, pure AST, works in under a second for most projects. When Claude Code reads a source file, the read-guard intercepts and returns a compact subgraph (symbols, edges, community) instead of the full text.

```
102 files → 512 nodes → 573 edges   built in <0.1s
file read: 2,835 tok raw → 300 tok subgraph  (-89%)
```

```bash
lakonai graph build              # build / rebuild (auto-annotates + embeds)
lakonai graph query "what calls parseFile?"
lakonai graph explain src/foo.js
lakonai graph path src/a.js src/b.js
lakonai graph html               # open interactive viz
lakonai graph watch              # rebuild on file change
lakonai graph annotate           # regenerate LLM docblocks only
```

The graph JSON is auto-added to `.gitignore`. Set `LAKON_GRAPH_CAT=0` to bypass.

**Semantic search** — install `@xenova/transformers` to unlock hybrid BM25 + vector search (BGE-small-en-v1.5, ~23 MB, runs fully local):

```bash
npm install @xenova/transformers
lakonai graph build   # first run downloads the model, subsequent runs are instant
```

On build, lakonai auto-annotates undocumented files via `claude --print` (Haiku, zero config for Claude Code users) and stores one-line search-optimised docblocks in `lakonai-graph/annotations.json` — source files are never modified. Only new or modified files are re-annotated (mtime-based cache).

Benchmark on the lakonai codebase itself (30 queries, 15 literal + 15 semantic):

| Method | Score | Literal | Semantic |
|--------|------:|--------:|---------:|
| BM25 only | 19/30 | 15/15 | 4/15 |
| Hybrid (BM25 + semantic) | **29/30** | 15/15 | 14/15 |

### Layer 3 — Proxy compression (Claude Code)

A local HTTP proxy sits between Claude Code and `api.anthropic.com`. It compresses request bodies before they're sent — the model sees fewer tokens, you pay less.

```
build logs    → -99%   (repetitive lines collapsed)
minified JSON → -96%   (schema-extracted summary)
test output   → -98%   (counts only, no per-test lines)
diffs         →  -4%   (conservative; context preserved)
source code   →   0%   (covered by graph instead)
```

The proxy starts automatically on `lakonai install` and runs silently on port
`41474` (it moves to a free port if that one is taken). No API key exposed. Stats
accumulate in `~/.lakon/proxy-stats.json`.

**It can never break your CLI.** The shell rc does not export
`ANTHROPIC_BASE_URL` directly — it sources `~/.lakon/proxy-env.sh`, which checks
that the proxy is actually listening before pointing anything at it. Proxy down
(reboot, crash, `lakonai proxy stop`) means no compression, and Claude talks to
the API directly as if lakonai were not installed. It also clears a dead lakonai
URL it finds already in the environment, so a shell that inherited one from an
older install heals itself. A base URL you set yourself is never touched.

Manage it with `lakonai proxy`:

```bash
lakonai proxy            # status (exit 1 when it is not serving)
lakonai proxy start      # start it and refresh the shell wiring
lakonai proxy stop       # stop it and unwire the shell
lakonai proxy restart
```

### MCP catalog compression and your Claude Code sessions

Wrapping MCP servers means editing `~/.claude.json` — the same file where Claude
Code keeps per-project session state (`lastSessionId`, trust dialogs,
`allowedTools`) and rewrites on every turn. lakonai therefore **never touches it
while a session is live**: `lakonai install` run from inside Claude Code defers
the wrap and says so. Apply it afterwards:

```bash
lakonai mcp             # status: how many servers are wrapped
lakonai mcp wrap        # wrap them (after quitting Claude Code)
lakonai mcp unwrap      # undo
```

Every write to that file is atomic (temp file + rename, never a truncate in
place) and validated first: if the rewrite would drop a project or change a
session id, it is refused. `LAKON_NO_MCP=1` opts out of MCP wrapping entirely.

Upgrading migrates an old install by itself: `lakonai upgrade` replaces a daemon
running a previous version (a running process keeps executing the server code it
was started with), moves it off port 7474, and rewrites the old
`export ANTHROPIC_BASE_URL` line in your rc into the guarded one.

`lakonai uninstall` stops the proxy and removes the wiring. Set
`LAKON_PROXY_DISABLE=1` to keep `lakonai install` from touching your shell at
all.

### Layer 4 — Pixel (Claude Code + Codex)

Skill markdown is verbose. A 3k-token skill file becomes a 170-token PNG tile. Vision tokens are cheaper than text tokens past the ~255-token break-even point.

```bash
lakonai pixel --dry-run      # estimate savings, no writes
lakonai pixel                # convert profitable skills (requires: npm install canvas)
lakonai pixel --agent claude # Claude Code skills only
lakonai pixel --revert       # byte-identical restore from backup
```

### Overflow sandbox (all agents)

When a command's output still exceeds budget after filtering, lakonai parks the full text in `~/.lakon/sandbox/` and gives the agent a digest: head, tail, exit code, how to query. Nothing is lost — it stops being re-paid.

```
lakonai: 4000 lines / 249KB parked in sandbox 30930a0c
$ node build.js  → exit 0

[build] compiling module 0 …
… 3980 lines elided …
[build] compiling module 3999 …

Query it: lakonai peek 30930a0c --grep "error"
```

---

## Agent support

| Feature | Claude Code | Codex | Cursor / Windsurf / Cline | Gemini |
|---------|:-----------:|:-----:|:-------------------------:|:------:|
| CLI filters | ✅ hook | ✅ shim | ✅ shim | ✅ shim |
| Read/Grep guard | ✅ | ✅ shim | ✅ shim | ✅ shim |
| Overflow sandbox | ✅ | — | — | — |
| Proxy compression | ✅ | — | — | — |
| Graph read-guard | ✅ | — | — | — |
| Pixel (skill PNG) | ✅ | ✅ | — | — |
| MCP catalog compression | ✅ | — | — | — |
| Auto-learn new commands | ✅ | ✅ | ✅ | ✅ |

**Primary target: Claude Code.** The proxy and graph layers intercept the Anthropic protocol and are Claude-Code-specific. CLI filters and the universal shim work on every agent. Every install is idempotent and reversible.

---

## Slash commands

After `lakonai install`, these are available in Claude Code:

| Command | What it shows |
|---------|--------------|
| `/lakonai:gain` | Token savings — input (measured) and output (estimated) |
| `/lakonai:stats` | All layers: filters + proxy breakdown by content type |

---

## Full CLI reference

| Command | What it does |
|---------|-------------|
| `lakonai install [--here]` | Install rule + hooks (globals; `--here` adds per-project) |
| `lakonai upgrade` | Update to latest + refresh the rule block |
| `lakonai uninstall` / `revert` | Strip the lakonai block / restore from backup |
| `lakonai shim [--off]` | Universal PATH shim — automatic filtering on every agent |
| `lakonai graph <sub>` | Build / query / watch the AST knowledge graph |
| `lakonai pixel [--dry-run\|--revert\|--agent]` | Convert skill files to PNG |
| `lakonai compress-memory <file>` | Shrink a memory file via your local AI CLI |
| `lakonai peek [id]` | Read output parked in sandbox (`--grep/--offset/--limit`) |
| `lakonai gain` | Token savings across all measured fronts |
| `lakonai inspect <cmd>` | Debug what filter applies to a command |
| `lakonai mcp [wrap\|unwrap]` | MCP catalog compression status/lifecycle |
| `lakonai proxy [start\|stop\|restart]` | Compression proxy status/lifecycle |
| `lakonai doctor` | Health check: CLI on PATH, hooks, rule |

Full flags, filters, env vars, internals: **[docs/reference.md](docs/reference.md)**.

---

## See your savings

```
lakonai - saved 196.8k tok (46% smaller) across 1910 commands

  today      984 tok saved  (17%)
  this week  124.5k tok saved  (57%)

  top: grep 55.3k · tail 55.1k · Read 34.3k · git 23.4k · cat 15.2k

  output (terse rule): ~52% fewer tokens (1332 → 634, 4 prompts) [claude]
```

Input is measured and deterministic. Output is estimated by your local AI CLI (no key, weekly). Both sides, one number.

---

## vs. similar tools

| Feature | lakonai | caveman | graphify | rtk | Manual CLAUDE.md |
|---------|:-------:|:-------:|:--------:|:---:|:----------------:|
| Terse-response rule | ✅ | ✅ | — | — | ⚠️ manual |
| CLI output filters (30+ commands) | ✅ | — | — | ✅ | — |
| Auto-learning (new heavy commands) | ✅ | — | — | — | — |
| Lockfile / node_modules guard | ✅ | — | — | — | ⚠️ manual |
| Overflow sandbox (large outputs) | ✅ | — | — | — | — |
| Proxy compression (logs/JSON/diffs) | ✅ | ✅ | — | — | — |
| AST knowledge graph | ✅ | — | ✅ | — | — |
| Graph read-guard (subgraph on reads) | ✅ | — | — | — | — |
| BM25 NL graph query (zero LLM) | ✅ | — | ⚠️ LLM | — | — |
| Community detection (Leiden) | ✅ | — | ✅ | — | — |
| Interactive graph viz (HTML) | ✅ | — | ✅ | — | — |
| Skill PNG conversion (pixel) | ✅ | ✅ | — | — | — |
| MCP catalog compression | ✅ | — | — | — | — |
| Zero config after install | ✅ | ✅ | — | ⚠️ | ⚠️ |
| Works with Cursor/Windsurf/Codex | ✅ | ✅ | — | ✅ | ✅ |
| Optimised for Claude Code | ✅ | ✅ | — | — | — |
| Pure JS, no native deps for core | ✅ | ✅ | — | ✅ | — |
| npm install + one command | ✅ | ✅ | — | ⚠️ | — |

**caveman** — terse rule, auto-clarity, proxy compression, pixel mode (MIT). Absorbed with credit.  
**graphify** — AST knowledge graph, Leiden community detection, force-directed HTML viz, NL query. Reimplemented in Node.js; lakonai replaces LLM-based query with BM25 (zero cost).  
**rtk** — CLI output filtering approach; lakonai extends with auto-learning and 30+ built-in filters.  
**Manual CLAUDE.md** — works, but you write and maintain it; lakonai installs and updates automatically.

---

## Test suite

832 tests across 54 suites — all passing, no mocks on I/O boundaries.

| Type | Suites | Tests |
|------|--------|-------|
| Unit | 13 | 170 |
| Integration (module + real FS) | 33 | 530 |
| E2E / CLI (spawn + real process) | 2 | 51 |
| **Total** | **48** | **751** |

Coverage: **95% statements · 89% branches · 97% functions**

Branch ceiling is ~90% — the remaining gaps are canvas-native rendering, platform-specific `fs.watch` fallback, and the HTTPS transport branch (all marked `/* istanbul ignore next */` with justification).

---

## Why "lakonai"

In 346 BC, Philip II of Macedon warned Sparta: _"If I invade Lakonía, I will raze your cities."_ The Spartans replied with one word: _"If."_ Their region, **Lakonía**, gave English the word **laconic** — using as few words as possible.

Your AI agent isn't laconic. It opens with _"Sure! I'd be happy to help…"_, repeats your question, reads `git log` in full, and sends every line of your test suite to the API. lakonai closes all of it.

---

## Credits

lakonai is an original, zero-dependency tool written from scratch. Several of its
layers were **inspired by** prior art — none of it is vendored or forked, and the
compression engine, auto-learning, read-guard, overflow sandbox, and BM25 graph
query are lakonai's own:

- [**caveman**](https://github.com/juliusbrussee/caveman) (MIT) — inspired the terse-response rule, auto-clarity, and pixel skill mode
- [**graphify**](https://github.com/Bklieger/graphify) — inspired the AST knowledge graph and community detection; lakonai reimplements it in Node.js and drops the LLM at query time for zero-cost BM25
- [**rtk**](https://github.com/rtk-ai/rtk) — inspired the CLI-filtering approach; lakonai goes further with auto-learning and 30+ built-in filters

Where an idea carries a license (caveman is MIT), credit stays. Everything else —
the declarative filter engine, the hook dispatch, savings tracking, and the four
layers of compression — is built here.

MIT — see [LICENSE](LICENSE).
