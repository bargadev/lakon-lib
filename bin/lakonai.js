#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const { filterCommand, isSupported, needsStderr, countTokensApprox } = require('../src/filters');
const { install, uninstall, revert } = require('../src/install');
const tracking = require('../src/tracking');
const versionCheck = require('../src/hooks/version-check');

const HELP = `lakonai - spartan replies for AI agents

Usage:
  lakonai <cmd> [args...]    Run <cmd> and filter its output (tracks savings)

  lakonai install            Install rule + hooks for detected GLOBAL platforms
                             (Claude Code / Codex / Gemini - touches ~/ only)
  lakonai install --here     Same as above + per-project rules (Cursor /
                             Windsurf / Cline) written into the current dir
  lakonai install --only <p> Install just one platform by id (any scope)
                             (every install backs up the target file first)
  lakonai upgrade            Update lakonai to the latest version (auto-detects
                             npm/pnpm/yarn/bun) and refresh the rule block
  lakonai uninstall          Strip the lakonai block (keeps rest of file)
  lakonai revert [--only <p>] Restore files to pre-install state from backup

  lakonai compress-memory <file> ["instruction…"]
                             Compress a memory file (CLAUDE.md, notes) in place,
                             saving a <name>.original.md backup first. Manual &
                             opt-in - rewrites your authored text (lossy) using a
                             local AI CLI you already have (Claude/Gemini/Codex/
                             Cursor - no API key). Override with LAKONAI_MEM_CLI.
                             Optional free-text steers it, e.g.
                             \`compress-memory README.md "focus on marketing"\`.
  lakonai revert-memory <file>
                             Restore <file> from its .original.md backup.

  lakonai shim [--off]       Enable (or disable) the universal PATH shim - makes
                             ls/grep/rg/ag/find/cat/tree/head filtering AUTOMATIC
                             for EVERY agent (Codex/Cursor/Windsurf/Cline/Gemini),
                             not just the ones with a hook API. Prepends
                             ~/.lakon/shim to PATH in your shell rc.

  lakonai peek [id]          Read output that was parked in the sandbox. No id
                             lists what's parked. Flags: --offset N --limit N
                             --grep <regex>. Output too big for the context
                             budget is spilled to disk automatically and replaced
                             with a digest - this is how you read the rest.

  lakonai gain               Show token savings - INPUT (shell output, measured)
                             AND OUTPUT (how much terser the model writes; measured
                             weekly via your local AI CLI, no API key)
  lakonai mcp [cmd]          MCP catalog compression: status (default) | wrap |
                             unwrap. Wrapping edits ~/.claude.json, where Claude
                             Code keeps per-project session state, so it is
                             skipped while a session is live - run it after
                             quitting Claude Code (--force overrides).
  lakonai proxy [cmd]        Compression proxy: status (default) | start | stop
                             | restart. The proxy shrinks API request bodies;
                             while it is down lakonai simply stays out of the way
                             and Claude talks to the API directly.
  lakonai doctor             Per-platform health: CLI on PATH, rule, hooks
  lakonai version            Print the installed lakonai version
  lakonai --help             This help

After \`lakonai install\` everything is automatic - your agent's commands are
filtered, junk reads are blocked, and new noisy commands get learned. You rarely
need any command but \`gain\` (to see the savings) and \`doctor\` (to check it).

Supported filters:
  files/search   git (log/status/diff/show), ls, tree, cat, head, tail, grep, rg, ag, find
  test runners   jest, vitest, mocha, pytest, ava; npm/pnpm/yarn/bun test, go test, cargo test
  lint/build     tsc, eslint, ruff, cargo clippy, make
  pkg/cloud      npm/pnpm/yarn/bun install, diff, docker, kubectl, aws
Unsupported commands run unchanged (passthrough, still tracked as 0% savings).

Multi-profile Claude Code (e.g. claude-my / claude-arco wrappers):
  CLAUDE_CONFIG_DIR=$HOME/.claude-my   lakonai install
  CLAUDE_CONFIG_DIR=$HOME/.claude-arco lakonai install

Update notifications:
  SessionStart hook + \`lakonai gain\` / \`lakonai version\` check npm once per day.
  Disable with LAKON_NO_UPDATE_CHECK=1.
`;

// Returns what the agent should see: the filtered text when it fits the budget,
// otherwise a digest pointing at the parked full output. Falls back to the
// filtered text if the spill can't be written (read-only home, full disk).
function maybeSpill({ cmd, args, exitCode, filtered }) {
  const sandbox = require('../src/sandbox');
  const tokens = countTokensApprox(filtered);
  if (!sandbox.shouldSpill(tokens, sandbox.spillThreshold())) return filtered;
  const parked = sandbox.spill({ cmd, args, exitCode, text: filtered });
  /* istanbul ignore next -- disk failure path */
  if (!parked) return filtered;
  return parked.digest;
}

function runPeek(rest) {
  const sandbox = require('../src/sandbox');
  const [id, ...flags] = rest;
  if (!id) {
    const recent = sandbox.list();
    if (!recent.length) {
      process.stdout.write('lakonai: no parked output yet.\n');
      return;
    }
    process.stdout.write(
      'Parked output (newest first):\n' +
        recent.map((s) => `  ${s.id}  ${Math.round(s.bytes / 1024)}KB`).join('\n') +
        '\n'
    );
    return;
  }
  let text;
  try {
    text = sandbox.read(id);
  } catch {
    process.stderr.write(`lakonai: no parked output with id ${id}. Try \`lakonai peek\` to list.\n`);
    process.exit(1);
  }
  const flag = (name) => {
    const i = flags.indexOf(name);
    return i >= 0 ? flags[i + 1] : undefined;
  };
  const pattern = flag('--grep');
  if (pattern != null) {
    process.stdout.write(sandbox.grep(text, pattern) + '\n');
    return;
  }
  const offset = Number(flag('--offset')) || 1;
  const limit = Number(flag('--limit')) || 100;
  process.stdout.write(sandbox.slice(text, { offset, limit }) + '\n');
}

function runAndFilter(cmd, args) {
  // Universal Read-guard: refuse junk reads (lockfiles/node_modules) done via the
  // shell (`cat pnpm-lock.yaml`) on ANY agent that uses the shim - same deny rules
  // as the Claude Read hook, no platform hook required.
  const denied = require('../src/shim-guard').check(cmd, args);
  if (denied) {
    process.stdout.write(`lakonai: skipped ${denied.path} - ${denied.reason}\n`);
    tracking.record({ cmd, args, rawTokens: 0, filteredTokens: 0 });
    process.exit(0);
  }

  const merge = needsStderr(cmd, args);
  const stdio = merge ? ['inherit', 'pipe', 'pipe'] : ['inherit', 'pipe', 'inherit'];
  // Strip the shim dir from PATH so spawning `cmd` resolves the real system
  // binary, not the lakonai shim that may have invoked us (prevents recursion).
  const { pathWithoutShim } = require('../src/install/shim');
  const env = { ...process.env, PATH: pathWithoutShim(process.env) };
  const child = spawnSync(cmd, args, { encoding: 'utf8', stdio, env, maxBuffer: 200 * 1024 * 1024 });
  if (child.error) {
    /* istanbul ignore next -- requires >200 MB output to trigger; not unit-testable */
    if (child.error.code === 'ENOBUFS') {
      // Output exceeded maxBuffer — pass through raw so nothing is lost.
      const fallback = spawnSync(cmd, args, { stdio: 'inherit', env });
      process.exit(fallback.status ?? 0);
    }
    process.stderr.write(`lakonai: ${child.error.message}\n`);
    process.exit(127);
  }
  /* istanbul ignore next -- defensive empty-stream fallbacks */
  const raw = merge ? (child.stdout || '') + (child.stderr || '') : child.stdout || '';
  const filtered = isSupported(cmd) ? filterCommand(cmd, args, raw) : raw;
  // Last line of defence: the filters have already had their go, and it is STILL
  // too big. Park it on disk and hand back a digest, so the bytes cost nothing
  // per turn but stay one `lakonai peek` away.
  const shown = maybeSpill({ cmd, args, exitCode: child.status, filtered });
  process.stdout.write(shown);
  /* istanbul ignore next */
  if (shown && !shown.endsWith('\n')) process.stdout.write('\n');

  tracking.record({
    cmd,
    args,
    rawTokens: countTokensApprox(raw),
    // What the agent actually pays for is `shown`, not `filtered` — on a spill
    // those differ by orders of magnitude, and `gain` must report the truth.
    filteredTokens: countTokensApprox(shown),
  });

  // Auto-learning off the universal log (throttled hourly) - runs on EVERY agent,
  // not just Claude Code's transcript. Never let it break the command.
  try {
    require('../src/learn').maybeLearnFromLog((c) => isSupported(c));
    /* istanbul ignore next */
  } catch {
    // learning is best-effort
  }

  /* istanbul ignore next */
  process.exit(child.status ?? 0);
}

/* istanbul ignore next -- spawns the global package manager + a fresh install; logic in src/upgrade */
function runUpgrade() {
  const { detectManager, upgradeArgs } = require('../src/upgrade');
  const pm = detectManager();
  const [bin, args] = upgradeArgs(pm);
  process.stdout.write(`lakonai: upgrading via ${bin} (${bin} ${args.join(' ')})…\n\n`);
  const up = spawnSync(bin, args, { stdio: 'inherit' });
  if (up.error || up.status !== 0) {
    process.stderr.write(
      `\nlakonai: upgrade via ${bin} failed. Run it yourself:\n  ${bin} ${args.join(' ')}\n` +
        `(or set LAKON_PM=npm|pnpm|yarn|bun if the wrong manager was detected)\n`
    );
    process.exit(up.status || 1);
  }
  // Re-run install in a FRESH process so the just-installed version writes the
  // refreshed rule block (the running process is still the old code).
  process.stdout.write('\nlakonai: refreshing the rule block…\n');
  const refresh = spawnSync('lakonai', ['install', '--upgraded'], { stdio: 'inherit' });
  process.exit(refresh.status ?? 0);
}

// Refresh the output-side benchmark from inside `gain` - at most weekly, only at
// a human TTY (never blocks a piped/scripted gain), via the local AI CLI (no API
// key). Best-effort: skips silently if no CLI or on any error.
/* istanbul ignore next -- TTY-gated real LLM calls; measure() is unit-tested with an injected call */
async function maybeRefreshOutputBench() {
  try {
    const ob = require('../src/output-bench');
    if (!process.stdout.isTTY || process.env.LAKON_NO_OUTPUT_BENCH === '1') return;
    if (!ob.isStale(Date.now())) return;
    const llm = require('../src/mem-llm');
    let provider;
    try {
      provider = llm.pickProvider();
    } catch {
      return; // no local AI CLI → leave the hint
    }
    process.stderr.write(
      `measuring output savings with ${provider.bin} (one-off, ~a minute, no API key)…\n`
    );
    // Both arms run rule-free (so the CLI's own config doesn't auto-load the
    // installed terse rule and pollute the baseline) from an empty cwd (so no
    // project CLAUDE.md leaks in). The terse arm differs ONLY by the rule appended
    // as a system prompt. Auth stays on the real Keychain credential — see
    // callAgent's ruleFree note for why we don't redirect the config dir.
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lakon-bench-'));
    let res;
    try {
      res = ob.measure({
        call: (p, system) =>
          llm.callAgent(p, { provider, systemPrompt: system, ruleFree: true, cwd: emptyCwd }),
      });
    } finally {
      try {
        fs.rmSync(emptyCwd, { recursive: true, force: true });
      } catch {
        /* temp dir cleanup is best-effort */
      }
    }
    ob.writeCache({ ...res, at: Date.now(), cli: provider.bin });
  } catch {
    // best-effort; never break gain
  }
}

function runShim(args) {
  const shim = require('../src/install/shim');
  const off = args.includes('--off');
  if (off) {
    const { touched } = shim.uninstall();
    process.stdout.write(`✅ shim removed (${shim.shimDir()})\n`);
    if (touched.length) process.stdout.write(`   cleaned PATH block from: ${touched.join(', ')}\n`);
    process.stdout.write('   Restart your shell (or your agent) for it to take effect.\n');
    return;
  }
  const { dir, touched } = shim.install();
  process.stdout.write(
    `✅ universal shim enabled - ${shim.WRAPPED.join('/')} now filtered for ANY agent that inherits PATH.\n` +
      `   shims: ${dir}\n`
  );
  if (touched.length) {
    process.stdout.write(`   PATH prepended in: ${touched.join(', ')}\n`);
  } else {
    process.stdout.write(`   PATH block already present.\n`);
  }
  process.stdout.write(
    '   Restart your shell (or your agent) for it to take effect. Disable: `lakonai shim --off`.\n'
  );
}

function runMemory(cmd, args) {
  const mem = require('../src/mem-compress');
  const prune = args.includes('--prune');
  const rewrite = args.includes('--rewrite');
  const nonFlags = args.filter((a) => !a.startsWith('--'));
  const file = nonFlags[0];
  // Anything after the file path is a freeform steering instruction, e.g.
  //   lakonai compress-memory README.md "focus on marketing, keep the voice"
  const instruction = nonFlags.slice(1).join(' ').trim();
  if (!file) {
    process.stderr.write(`lakonai: ${cmd} needs a file path. e.g. \`lakonai ${cmd} CLAUDE.md\`\n`);
    process.exit(1);
  }
  try {
    if (cmd === 'revert-memory') {
      const { file: f, backup } = mem.revertFile(file);
      process.stdout.write(`✅ restored ${f} from ${backup}\n`);
      return;
    }
    // The compressor is whichever local AI CLI the user has (no API key).
    const llm = require('../src/mem-llm');
    const provider = llm.pickProvider();
    process.stdout.write(
      `compressing ${file} with ${provider.bin} (${provider.platform})${instruction ? ` - "${instruction}"` : ''}…\n`
    );
    const res = mem.compressFile(file, {
      tokenize: countTokensApprox,
      compress: (orig) => llm.compressWith(orig, { provider, instruction }),
      fix: (orig, comp, missing) => llm.fixWith(orig, comp, missing, { provider }),
      remote: true,
      prune,
      rewrite,
    });
    const pct = res.beforeTokens ? Math.round((1 - res.afterTokens / res.beforeTokens) * 100) : 0;
    process.stdout.write(
      `✅ compressed ${res.file}: ${res.beforeTokens} → ${res.afterTokens} tokens (~${pct}% smaller)\n` +
        `   backup: ${res.backup}\n   undo:   lakonai revert-memory ${res.file}\n`
    );
  } catch (err) {
    process.stderr.write(`lakonai: ${err.message}\n`);
    process.exit(1);
  }
}

function printVersion() {
  const pkg = require('../package.json');
  process.stdout.write(`${pkg.name} ${pkg.version}\n`);
}

function maybePrintUpdateHint() {
  try {
    const update = versionCheck.getCachedUpdate();
    if (update) {
      /* istanbul ignore next */
      const color = !process.env.NO_COLOR && process.stderr.isTTY;
      const msg = versionCheck.formatNotice(update);
      /* istanbul ignore next */
      process.stderr.write(color ? `\n\x1b[33m${msg}\x1b[0m\n` : `\n${msg}\n`);
    }
    /* istanbul ignore next */
  } catch {
    // never let update hint break a command
  }
}

// oh-my-zsh style: at a human TTY, offer to update right now. Falls back to the
// passive notice when non-interactive / snoozed / opted out. Decision logic is
// pure (src/update-prompt); this is the interactive shell around it.
/* istanbul ignore next -- interactive TTY prompt + spawn */
async function maybeOfferUpdate() {
  let update;
  try {
    update = versionCheck.getCachedUpdate();
  } catch {
    return;
  }
  const { decideUpdateAction, SNOOZE_MS } = require('../src/update-prompt');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const home = process.env.LAKON_HOME || path.join(os.homedir(), '.lakon');
  const snoozeFile = path.join(home, '.update-snooze');
  let snoozeUntil = 0;
  try {
    snoozeUntil = Number(JSON.parse(fs.readFileSync(snoozeFile, 'utf8')).until) || 0;
  } catch {
    /* no snooze yet */
  }
  const action = decideUpdateAction({
    update,
    ttyIn: process.stdin.isTTY,
    ttyOut: process.stderr.isTTY,
    disabled: process.env.LAKON_NO_AUTOUPDATE === '1',
    snoozeUntil,
    now: Date.now(),
  });
  if (action === 'none') return;
  if (action === 'notice') {
    maybePrintUpdateHint();
    return;
  }
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((res) =>
    rl.question(
      `\nlakonai ${update.latest} available (you have ${update.current}). Update now? [Y/n] `,
      (a) => {
        rl.close();
        res(a);
      }
    )
  );
  if (/^\s*(y(es)?)?\s*$/i.test(answer)) {
    runUpgrade(); // upgrades + exits
  } else {
    try {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(snoozeFile, JSON.stringify({ until: Date.now() + SNOOZE_MS }));
    } catch {
      /* snooze is best-effort */
    }
    process.stderr.write('Skipped. Run `lakonai upgrade` anytime.\n');
  }
}

function runPixel(args) {
  const pixel = require('../src/pixel/convert');
  const dryRun = args.includes('--dry-run');
  const revert = args.includes('--revert');
  const agentIdx = args.indexOf('--agent');
  const agent = agentIdx >= 0 ? args[agentIdx + 1] : null;

  if (dryRun) {
    const results = pixel.dryRun({ agent });
    process.stdout.write(pixel.formatDryRun(results));
    return;
  }
  if (revert) {
    const results = pixel.revertAll({ agent });
    process.stdout.write(pixel.formatRevert(results));
    return;
  }
  const results = pixel.convert({ agent });
  process.stdout.write(pixel.formatConvert(results));
}

function runMcp(args) {
  const mcp = require('../src/install/mcp');
  const { homedir } = require('../src/install/paths');
  const home = homedir();
  const sub = args[0] || 'status';
  const force = args.includes('--force');

  if (sub === 'status') {
    const st = mcp.statusMcp(home);
    if (!st.exists) {
      process.stdout.write(`lakonai mcp: no Claude Code config at ${st.config}\n`);
      return;
    }
    process.stdout.write(`lakonai mcp: ${st.wrapped} wrapped, ${st.unwrapped} not wrapped (${st.config})\n`);
    if (st.blockedBy) {
      process.stdout.write(`  wrapping is on hold — ${st.blockedBy}\n`);
      process.stdout.write('  ~/.claude.json holds your session state; run `lakonai mcp wrap` after quitting Claude Code.\n');
    }
    return;
  }

  if (sub === 'wrap' || sub === 'unwrap') {
    const res = sub === 'wrap' ? mcp.wrapMcp(home, { force }) : mcp.unwrapMcp(home, { force });
    if (res.skipped) {
      process.stdout.write(`lakonai mcp: skipped — ${res.reason}\n`);
      process.stdout.write('  ~/.claude.json carries your Claude Code sessions; rewriting it now could orphan them.\n');
      process.stdout.write(`  Quit Claude Code and run \`lakonai mcp ${sub}\` again (or pass --force).\n`);
      process.exitCode = 1;
      return;
    }
    const verb = sub === 'wrap' ? 'wrapped' : 'unwrapped';
    process.stdout.write(
      res.count ? `lakonai mcp: ${verb} ${res.count} server${res.count > 1 ? 's' : ''}\n` : `lakonai mcp: nothing to ${sub}\n`
    );
    return;
  }

  process.stdout.write(`lakonai mcp: unknown subcommand "${sub}" (use status|wrap|unwrap)\n`);
  process.exitCode = 1;
}

async function runProxy(args) {
  const daemon = require('../src/proxy/daemon');
  const sub = args[0] || 'status';

  if (sub === 'status') {
    const s = await daemon.status();
    if (s.running) {
      process.stdout.write(`lakonai proxy: running (pid ${s.pid}) on http://127.0.0.1:${s.port}\n`);
      return;
    }
    if (s.stale) {
      process.stdout.write(`lakonai proxy: NOT serving on 127.0.0.1:${s.port} (stale state${s.pid ? `, pid ${s.pid} alive but not listening` : ''})\n`);
    } else {
      process.stdout.write('lakonai proxy: not running\n');
    }
    // "Nothing broken" is only true for sessions that start from here on. A
    // session already pointed at the dead port cannot be re-pointed — it is
    // stuck on ECONNREFUSED — so say so instead of reporting a clean fallback.
    const stranded = daemon.sessionsOnPort(s.port);
    if (stranded.length) {
      const plural = stranded.length > 1 ? 's' : '';
      process.stdout.write(`  ${stranded.length} Claude session${plural} still pointed at it (pid ${stranded.map((x) => x.pid).join(', ')}) — those are failing with ConnectionRefused.\n`);
      process.stdout.write('  `lakonai proxy start` rebinds the same port and recovers them.\n');
      process.stdout.write('  New sessions are unaffected: they talk to the API directly.\n');
    } else {
      process.stdout.write('  Claude talks to the API directly — no compression, nothing broken.\n');
      process.stdout.write('  Start it with `lakonai proxy start`.\n');
    }
    process.exitCode = 1;
    return;
  }

  if (sub === 'start' || sub === 'restart') {
    const res = sub === 'restart' ? await daemon.restart() : await daemon.start();
    if (!res.running) {
      process.stdout.write(`lakonai proxy: failed to start — ${res.error}\n`);
      process.exitCode = 1;
      return;
    }
    const verb = res.alreadyRunning ? 'already running' : 'started';
    process.stdout.write(`lakonai proxy: ${verb} (pid ${res.pid}) on http://127.0.0.1:${res.port}\n`);
    const touched = daemon.rcFiles().filter((rc) => daemon.installEnv(rc));
    if (touched.length) process.stdout.write(`  shell wiring refreshed in ${touched.join(', ')}\n`);
    return;
  }

  if (sub === 'stop') {
    const stopped = await daemon.stop();
    process.stdout.write(stopped ? 'lakonai proxy: stopped\n' : 'lakonai proxy: was not running\n');
    return;
  }

  process.stdout.write(`lakonai proxy: unknown subcommand "${sub}" (use status|start|stop|restart)\n`);
  process.exitCode = 1;
}

// Work queued while a Claude Code session was live (chiefly the MCP wrap) is
// applied here too, not only by the SessionEnd hook — a machine whose sessions
// never end cleanly would otherwise keep the task forever. Silent and
// best-effort: it must never delay or break the command the user actually ran.
/* istanbul ignore next -- opportunistic I/O; drain() itself is tested */
function drainPendingWork() {
  if (process.env.CLAUDE_CODE_ENTRYPOINT || process.env.CLAUDE_PID) return;
  try { require('../src/install/pending').drain(); } catch { /* best-effort */ }
}

async function main() {
  const argv = process.argv.slice(2);
  drainPendingWork();
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
    printVersion();
    await versionCheck.checkForUpdate().catch(/* istanbul ignore next */ () => {});
    await maybeOfferUpdate();
    return;
  }

  const [first, ...rest] = argv;

  if (first === 'install') {
    const onlyIdx = rest.indexOf('--only');
    /* istanbul ignore next */
    const only = onlyIdx >= 0 ? rest[onlyIdx + 1] : null;
    const here = rest.includes('--here');
    const upgraded = rest.includes('--upgraded');
    await install({ only, here, upgraded });
    return;
  }
  if (first === 'uninstall') {
    await uninstall();
    return;
  }
  if (first === 'revert') {
    const onlyIdx = rest.indexOf('--only');
    /* istanbul ignore next */
    const only = onlyIdx >= 0 ? rest[onlyIdx + 1] : null;
    await revert({ only });
    return;
  }
  if (first === 'compress-memory' || first === 'revert-memory') {
    runMemory(first, rest);
    return;
  }
  if (first === 'shim') {
    runShim(rest);
    return;
  }
  if (first === 'upgrade') {
    runUpgrade();
    return;
  }
  if (first === 'gain' || first === 'stats') {
    process.stdout.write(tracking.report());
    // Output side: measure how much terser the model writes (weekly, TTY-only,
    // via the local AI CLI), then show it alongside the input savings.
    await maybeRefreshOutputBench();
    process.stdout.write('\n' + require('../src/output-bench').summaryLine() + '\n');
    // No real usage yet? Show the reproducible filter benchmark as a preview.
    if (!tracking.readEntries().length) {
      const bench = require('../src/bench');
      process.stdout.write('\nWhat the filters do (sample benchmark):\n' + bench.format(bench.runBench()));
    }
    await versionCheck.checkForUpdate().catch(/* istanbul ignore next */ () => {});
    await maybeOfferUpdate();
    return;
  }
  if (first === 'mcp') {
    runMcp(rest);
    return;
  }
  if (first === 'proxy') {
    await runProxy(rest);
    return;
  }
  if (first === 'doctor') {
    const doctor = require('../src/doctor');
    process.stdout.write(doctor.format(doctor.report()));
    return;
  }
  if (first === 'peek') {
    runPeek(rest);
    return;
  }
  /* istanbul ignore next -- long-running stdio MCP proxy; logic tested via src/mcp-shrink */
  if (first === '__mcp') {
    require('../src/mcp-shrink').runProxy(rest);
    return;
  }
  if (first === 'graph') {
    require('../src/graph').runGraph(rest);
    return;
  }
  if (first === 'pixel') {
    runPixel(rest);
    return;
  }

  runAndFilter(first, rest);
}

/* istanbul ignore next */
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`lakonai: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { runAndFilter, printVersion, main, runProxy, runMcp, HELP };
