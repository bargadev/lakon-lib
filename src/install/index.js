'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const platforms = require('./platforms');
const { listBackups } = require('./backup');
const { homedir } = require('./paths');
const memCompress = require('../mem-compress');

const RULE_PATH = path.join(__dirname, '..', 'rules', 'lakonai.md');

const OK = '✅';
const FAIL = '❌';
const ARROW = '→';
const BULLET = '•';

function readRule() {
  return fs.readFileSync(RULE_PATH, 'utf8');
}

function shortenPath(p) {
  /* istanbul ignore next */
  if (!p) return p;
  const home = homedir();
  if (p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

function padLabel(label, width = 26) {
  /* istanbul ignore next */
  return label.length >= width ? label : label + ' '.repeat(width - label.length);
}

function detectPlatforms() {
  const home = homedir();
  return platforms.list().filter((p) => p.detect(home));
}

async function install({ only, here = false, upgraded = false } = {}) {
  const rule = readRule();
  const home = homedir();
  const all = platforms.list();

  let targets;
  if (only) {
    targets = all.filter((p) => p.id === only);
  } else {
    targets = detectPlatforms().filter((p) => p.scope === 'global');
    if (here) {
      targets = targets.concat(all.filter((p) => p.scope === 'project'));
    }
  }

  if (!targets.length) {
    if (only) {
      process.stdout.write(`${FAIL} unknown platform "${only}". Run \`lakonai list\` to see options.\n`);
    } else {
      process.stdout.write(`${FAIL} no supported global platforms detected. Install Claude Code, Codex, or Gemini CLI first - or run \`lakonai install --here\` to write per-project rules (Cursor/Windsurf/Cline) in the current directory.\n`);
    }
    process.exitCode = 1;
    return;
  }

  const version = require('../../package.json').version;
  if (upgraded) {
    process.stdout.write(`\nlakonai upgraded to ${version}\n`);
    process.stdout.write('─'.repeat(`lakonai upgraded to ${version}`.length) + '\n');
  } else {
    process.stdout.write('\nlakonai install\n');
    process.stdout.write('───────────────\n');
  }

  const verb = upgraded ? 'refreshed' : ARROW;
  for (const p of targets) {
    try {
      const result = p.install({ home, rule, id: p.id });
      process.stdout.write(`${OK} ${padLabel(p.label)} ${verb} ${shortenPath(result)}\n`);
    } catch (err) {
      process.stdout.write(`${FAIL} ${padLabel(p.label)} ${ARROW} ${err.message}\n`);
      process.exitCode = 1;
    }
  }

  // Start the compression proxy, and only touch the shell rc if it really came
  // up. Wiring ANTHROPIC_BASE_URL to a daemon that failed to bind is what broke
  // fresh installs with ECONNREFUSED on every later `claude` run.
  /* istanbul ignore next -- daemon I/O; logic lives in wireProxy, tested directly */
  try {
    // LAKON_PROXY_DISABLE keeps the test suite (and anyone who wants lakonai
    // without the proxy) from spawning daemons and editing shell rc files.
    if (process.env.LAKON_PROXY_DISABLE !== '1') await wireProxy(require('../proxy/daemon'));
  } catch { /* best-effort; never block install */ }

  process.stdout.write('\n');
  // Upgrade is a refresh, not a first install - keep the output short, skip the
  // getting-started tips a fresh install shows.
  if (upgraded) {
    process.stdout.write(`  ${BULLET} Rule block + hooks refreshed. See changes: \`lakonai version\`.\n`);
    process.stdout.write('\nRestart your AI agent (or open a new session) to pick up the new rule.\n');
    return;
  }
  if (!only && !here) {
    process.stdout.write(`  ${BULLET} Per-project rules (Cursor/Windsurf/Cline) were skipped.\n`);
    process.stdout.write(`    Inside a repo? Run \`lakonai install --here\` to add them in the current directory.\n`);
  }
  process.stdout.write(`  ${BULLET} \`lakonai uninstall\` removes only the lakonai block (keeps your other content).\n`);
  process.stdout.write(`  ${BULLET} \`lakonai revert\`    restores files to pre-install state from backup.\n`);
  process.stdout.write(`  ${BULLET} \`lakonai gain\`      shows how many tokens you've saved.\n`);
  process.stdout.write('\nRestart your AI agent (or open a new session) for the rule to take effect.\n');

  await maybeOfferShim({ targets });
  await maybeOfferCompress({ cwd: process.cwd(), home });
}

// Offer the universal shim ONLY when a hook-less agent was installed — Claude Code
// gets automatic shell filtering from its hooks, so the shim is pointless there.
// Editing the shell rc + shadowing system commands is invasive, so we ask (never
// silent, TTY only).
/* istanbul ignore next -- interactive prompt; gated on TTY */
async function maybeOfferShim({ targets }) {
  if (!process.stdin.isTTY) return;
  const hookless = targets.filter((p) => p.id !== 'claude-code');
  if (!hookless.length) return; // Claude Code only — hooks already cover it
  const names = hookless.map((p) => p.label.trim()).join(', ');
  process.stdout.write(
    `\n  ${BULLET} ${names} have no hook API, so shell filtering there isn't automatic yet.\n` +
      `    The universal shim fixes that (routes ls/grep/find/… through lakonai via PATH).\n` +
      `    It edits your shell rc (~/.zshrc, ~/.bashrc) and shadows those commands.\n`
  );
  const yes = await promptYesNo('    Enable the universal shim now? [y/N] ');
  if (!yes) {
    process.stdout.write('    Skipped. Run `lakonai shim` anytime (or `lakonai shim --off`).\n');
    return;
  }
  try {
    const shim = require('./shim');
    const { dir, touched } = shim.install();
    process.stdout.write(`    ${OK} Shim enabled (${shortenPath(dir)}).`);
    if (touched.length) process.stdout.write(` PATH set in ${touched.map(shortenPath).join(', ')}.`);
    process.stdout.write('\n    Restart your shell for it to take effect.\n');
  } catch (err) {
    process.stdout.write(`    ${FAIL} ${err.message}\n`);
  }
}

// First existing memory file worth compressing: project CLAUDE.md, then the
// user-level one. Backups (*.original.md) are never offered.
function pickMemoryTarget(cwd, home) {
  const candidates = [
    path.join(cwd, 'CLAUDE.md'),
    path.join(home, '.claude', 'CLAUDE.md'),
  ];
  for (const c of candidates) {
    if (memCompress.isBackup(c)) continue;
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* not present */
    }
  }
  return null;
}

/* istanbul ignore next -- thin interactive shell; promptYesNo logic is the testable part */
function promptYesNo(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test((answer || '').trim()));
    });
  });
}

/* istanbul ignore next -- interactive; gated on TTY, exercised manually not in CI */
async function maybeOfferCompress({ cwd, home }) {
  if (!process.stdin.isTTY) return; // never block CI / piped installs
  const target = pickMemoryTarget(cwd, home);
  if (!target) return;

  const backup = memCompress.backupPath(target);
  process.stdout.write(
    `\n  ${BULLET} Found memory file ${shortenPath(target)}.\n` +
      `    Compressing it shrinks the tokens it costs every session. A local AI CLI\n` +
      `    rewrites the prose (lossy), so a backup is saved to ${shortenPath(backup)}\n` +
      `    and you can undo with \`lakonai revert-memory ${shortenPath(target)}\`.\n`
  );
  const yes = await promptYesNo('    Compress it now with your local AI CLI? [y/N] ');
  if (!yes) {
    process.stdout.write(`    Skipped. Run \`lakonai compress-memory ${shortenPath(target)}\` anytime.\n`);
    return;
  }
  try {
    const llm = require('../mem-llm');
    const provider = llm.pickProvider();
    process.stdout.write(`    compressing with ${provider.bin} (${provider.platform})…\n`);
    const res = memCompress.compressFile(target, {
      compress: (orig) => llm.compressWith(orig, { provider }),
      fix: (orig, comp, missing) => llm.fixWith(orig, comp, missing, { provider }),
      remote: true,
    });
    const pct = res.beforeTokens ? Math.round((1 - res.afterTokens / res.beforeTokens) * 100) : 0;
    process.stdout.write(
      `    ${OK} Compressed ${res.beforeTokens} ${ARROW} ${res.afterTokens} tokens (~${pct}% smaller). Backup: ${shortenPath(res.backup)}\n`
    );
  } catch (err) {
    process.stdout.write(`    ${FAIL} ${err.message}\n    Run \`lakonai compress-memory ${shortenPath(target)}\` later to retry.\n`);
  }
}

// Bring the proxy up and, only on success, point the shell rc at it. Returns
// what happened so the installer can say so out loud instead of failing silent.
async function wireProxy(daemon, { write = (t) => process.stdout.write(t) } = {}) {
  const res = await daemon.start();
  if (!res.running) {
    write(`${FAIL} ${padLabel('compression proxy')} ${ARROW} not started (${res.error})\n`);
    write(`   ${' '.repeat(25)} Shell left untouched — Claude talks to the API directly.\n`);
    return { started: false, touched: [] };
  }
  const touched = daemon.rcFiles().filter((rc) => daemon.installEnv(rc));
  write(`${OK} ${padLabel('compression proxy')} ${ARROW} listening on 127.0.0.1:${res.port}\n`);
  return { started: true, port: res.port, touched };
}

async function uninstall() {
  const home = homedir();
  process.stdout.write('\nlakonai uninstall\n');
  process.stdout.write('─────────────────\n');
  let any = false;
  for (const p of platforms.list()) {
    try {
      const result = p.uninstall({ home });
      if (result) {
        process.stdout.write(`${OK} ${padLabel(p.label)} ${ARROW} removed from ${shortenPath(result)}\n`);
        any = true;
      }
    } catch (err) {
      process.stdout.write(`${FAIL} ${padLabel(p.label)} ${ARROW} ${err.message}\n`);
    }
  }
  // The proxy wiring lives in the shell rc, not in a platform file — strip it
  // here too, otherwise uninstalling lakonai leaves ANTHROPIC_BASE_URL behind.
  /* istanbul ignore next -- daemon I/O; unwire itself is tested in proxy-daemon.test.js */
  try {
    if (process.env.LAKON_PROXY_DISABLE === '1') throw new Error('proxy disabled');
    const { touched, stopped } = await require('../proxy/daemon').unwire();
    if (touched.length || stopped) {
      process.stdout.write(`${OK} ${padLabel('compression proxy')} ${ARROW} ${stopped ? 'stopped' : 'not running'}`);
      if (touched.length) process.stdout.write(`, unwired from ${touched.map(shortenPath).join(', ')}`);
      process.stdout.write('\n');
      any = true;
    }
  } catch { /* best-effort */ }
  if (!any) process.stdout.write('  (nothing installed)\n');
}

async function revert({ only } = {}) {
  const targets = only
    ? platforms.list().filter((p) => p.id === only)
    : platforms.list();

  process.stdout.write('\nlakonai revert\n');
  process.stdout.write('──────────────\n');

  let any = false;
  for (const p of targets) {
    const entries = platforms.revertPlatform(p.id);
    if (entries && entries.length) {
      for (const entry of entries) {
        const when = new Date(entry.ts).toISOString().replace('T', ' ').slice(0, 19);
        process.stdout.write(`${OK} ${padLabel(p.label)} ${ARROW} ${shortenPath(entry.source)}\n`);
        process.stdout.write(`   ${' '.repeat(25)} (restored from backup taken ${when})\n`);
      }
      any = true;
    }
  }
  if (!any) {
    process.stdout.write(`${FAIL} no backups found. (Backups only exist for files that already had content before install.)\n`);
  }
}

function backupsReport() {
  const lines = ['', 'lakonai - backup history', '────────────────────────'];
  let any = false;
  for (const p of platforms.list()) {
    const entries = listBackups(p.id);
    if (!entries.length) continue;
    any = true;
    lines.push('');
    lines.push(`${p.label} (${p.id}):`);
    for (const e of entries) {
      const when = new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19);
      lines.push(`  ${when}  ${shortenPath(e.source)}`);
      lines.push(`      ${ARROW} ${shortenPath(e.backup)}`);
    }
  }
  if (!any) lines.push('\n  (no backups yet)');
  return lines.join('\n') + '\n';
}

function listPlatforms() {
  return platforms.list().map((p) => {
    const detected = p.detect(homedir());
    const mark = detected ? OK : ' ';
    const scope = p.scope === 'project' ? '[project]' : '[global] ';
    return `${mark}  ${p.id.padEnd(14)} ${scope} ${p.label}`;
  });
}

module.exports = { install, uninstall, revert, listPlatforms, backupsReport, pickMemoryTarget, wireProxy };
