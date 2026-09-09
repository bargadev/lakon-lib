'use strict';

const fs = require('fs');
const path = require('path');
const { backupFile } = require('./backup');
const { claudeConfigDir } = require('./paths');
const { writeFileAtomic } = require('./atomic');

const HOOKS = [
  {
    basename: 'lakon-bash-rewrite.js',
    src: path.join(__dirname, '..', 'hooks', 'bash-rewrite.js'),
    event: 'PreToolUse',
    matcher: 'Bash',
  },
  {
    basename: 'lakon-read-guard.js',
    src: path.join(__dirname, '..', 'hooks', 'read-guard.js'),
    event: 'PreToolUse',
    matcher: 'Read',
  },
  {
    basename: 'lakon-grep-guard.js',
    src: path.join(__dirname, '..', 'hooks', 'grep-guard.js'),
    event: 'PreToolUse',
    matcher: 'Grep',
  },
  {
    // The universal net: PostToolUse is the only event that can replace a tool
    // result, so this is the one place Read/Grep/WebFetch/unrouted-Bash output
    // can be parked. The PreToolUse hooks above cannot — they run before the
    // output exists.
    basename: 'lakon-output-spill.js',
    src: path.join(__dirname, '..', 'hooks', 'output-spill.js'),
    event: 'PostToolUse',
    matcher: 'Bash|Read|Grep|Glob|WebFetch|Task',
  },
  {
    basename: 'lakon-stop-hook.js',
    src: path.join(__dirname, '..', 'hooks', 'stop-hook.js'),
    event: 'Stop',
    matcher: null,
  },
  {
    basename: 'lakon-session-start.js',
    src: path.join(__dirname, '..', 'hooks', 'session-start.js'),
    event: 'SessionStart',
    matcher: null,
  },
  {
    // Drains work that could not be done while the session was live — chiefly
    // the MCP wrap, which must not rewrite ~/.claude.json under a running
    // session. Async because SessionEnd hooks share a 1.5s budget and async
    // ones are not timed out.
    basename: 'lakon-session-end.js',
    src: path.join(__dirname, '..', 'hooks', 'session-end.js'),
    event: 'SessionEnd',
    matcher: null,
    async: true,
  },
];

const SUPPORT_FILES = [
  { basename: 'throttle.js', src: path.join(__dirname, '..', 'hooks', 'throttle.js') },
  { basename: 'version-check.js', src: path.join(__dirname, '..', 'hooks', 'version-check.js') },
];

const ALL_BASENAMES = [...HOOKS.map((h) => h.basename), ...SUPPORT_FILES.map((s) => s.basename)];

function hookDest(home, basename) {
  return path.join(claudeConfigDir(home), 'hooks', basename);
}

function settingsPath(home) {
  return path.join(claudeConfigDir(home), 'settings.json');
}

function readSettings(home) {
  const p = settingsPath(home);
  if (!fs.existsSync(p)) return { ok: true, data: {} };
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function writeSettings(home, data) {
  // settings.json is read by a running Claude Code; a truncated read would drop
  // the user's permissions and hooks.
  writeFileAtomic(settingsPath(home), JSON.stringify(data, null, 2) + '\n');
}

function entryHasHook(entry, basename) {
  /* istanbul ignore next */
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((h) => h && typeof h.command === 'string' && h.command.includes(basename));
}

// Build the hook command string for settings.json.
// On Windows, Claude Code executes "command" hooks through bash (Git Bash),
// which strips backslashes ("C:\Users\...\x.js" -> "C:Users...x.js" -> command
// not found) and cannot exec a .js by path. Use `node` with a forward-slash
// path, which works in bash and node accepts on Windows. On POSIX the executable
// hook file (shebang + chmod 0755) runs directly.
function hookCommand(dest) {
  if (process.platform === 'win32') {
    return `node "${dest.split(path.sep).join('/')}"`;
  }
  return dest;
}

function hookEntry(hookDef, dest) {
  const entry = { type: 'command', command: hookCommand(dest) };
  if (hookDef.async) entry.async = true;
  return entry;
}

function mergeHook(data, hookDef, dest) {
  /* istanbul ignore next */
  const eventKey = hookDef.event || 'PreToolUse';
  data.hooks = data.hooks || {};
  data.hooks[eventKey] = data.hooks[eventKey] || [];

  if (hookDef.matcher) {
    const existing = data.hooks[eventKey].find((e) => e.matcher === hookDef.matcher);
    if (existing) {
      if (!entryHasHook(existing, hookDef.basename)) {
        /* istanbul ignore next */
        existing.hooks = existing.hooks || [];
        existing.hooks.push(hookEntry(hookDef, dest));
      }
    } else {
      data.hooks[eventKey].push({
        matcher: hookDef.matcher,
        hooks: [hookEntry(hookDef, dest)],
      });
    }
  } else {
    const existing = data.hooks[eventKey].find(
      (e) => !e.matcher && entryHasHook(e, hookDef.basename)
    );
    if (!existing) {
      data.hooks[eventKey].push({
        hooks: [hookEntry(hookDef, dest)],
      });
    }
  }
}

// Launchers this version does not ship are leftovers from an older lakonai: the
// file was removed from the package, but the generated launcher and its
// settings.json entry stayed behind and now crash on every event they are wired
// to. `install` owns the `lakon-` namespace, so it prunes them — nothing else
// will, and the user has no way to know which stale entry is failing.
function pruneOrphanHooks(home, data) {
  const dir = path.join(claudeConfigDir(home), 'hooks');
  const removed = [];

  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { /* no hooks dir yet */ }
  for (const f of entries) {
    if (!f.startsWith('lakon-') || !f.endsWith('.js')) continue;
    if (ALL_BASENAMES.includes(f)) continue;
    try { fs.unlinkSync(path.join(dir, f)); removed.push(f); } catch { /* leave it */ }
  }

  // Drop settings entries pointing at any lakon- launcher we no longer provide,
  // whether or not its file was still on disk.
  const isOrphan = (cmd) => {
    if (typeof cmd !== 'string') return false;
    const m = cmd.match(/lakon-[\w.-]+\.js/);
    return Boolean(m) && !ALL_BASENAMES.includes(m[0]);
  };
  if (data && data.hooks && typeof data.hooks === 'object') {
    for (const eventKey of Object.keys(data.hooks)) {
      if (!Array.isArray(data.hooks[eventKey])) continue;
      data.hooks[eventKey] = data.hooks[eventKey]
        .map((entry) => {
          if (!entry || !Array.isArray(entry.hooks)) return entry;
          const keep = entry.hooks.filter((h) => {
            if (!h || !isOrphan(h.command)) return true;
            const m = h.command.match(/lakon-[\w.-]+\.js/);
            if (m && !removed.includes(m[0])) removed.push(m[0]);
            return false;
          });
          if (keep.length === 0) return null;
          return { ...entry, hooks: keep };
        })
        .filter(Boolean);
      if (data.hooks[eventKey].length === 0) delete data.hooks[eventKey];
    }
  }
  return removed;
}

function installHook(home) {
  const sp = settingsPath(home);
  if (fs.existsSync(sp)) backupFile('claude-code', sp);

  const { ok, data, error } = readSettings(home);
  if (!ok) {
    return { hookFile: null, settingsMerged: false, note: `settings.json could not be parsed (${error}). Add hook entries manually — see README.` };
  }

  const installed = [];
  for (const s of SUPPORT_FILES) {
    const dest = hookDest(home, s.basename);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(s.src, dest);
    fs.chmodSync(dest, 0o644);
  }
  for (const h of HOOKS) {
    const dest = hookDest(home, h.basename);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Launcher: run the packaged hook in place (as the main module) so its
    // relative requires (../filters, ../learn, ../mode) resolve inside the
    // package. A flat copy would break those requires.
    fs.writeFileSync(
      dest,
      `#!/usr/bin/env node\n// lakonai hook launcher (generated)\nrequire('module')._load(${JSON.stringify(h.src)}, null, true);\n`
    );
    fs.chmodSync(dest, 0o755);
    mergeHook(data, h, dest);
    installed.push(dest);
  }

  const pruned = pruneOrphanHooks(home, data);

  writeSettings(home, data);

  try {
    const { writeInstalledVersionMarker } = require('../hooks/version-check');
    writeInstalledVersionMarker(require('../../package.json').version);
    /* istanbul ignore next */
  } catch {
    // never let marker write break install
  }

  return { hookFile: installed.join(', '), settingsMerged: true, pruned };
}

function uninstallHook(home) {
  const { ok, data } = readSettings(home);
  if (ok && data.hooks && typeof data.hooks === 'object') {
    for (const eventKey of Object.keys(data.hooks)) {
      /* istanbul ignore next */
      if (!Array.isArray(data.hooks[eventKey])) continue;
      data.hooks[eventKey] = data.hooks[eventKey]
        .map((entry) => {
          /* istanbul ignore next */
          if (!Array.isArray(entry.hooks)) return entry;
          const remaining = entry.hooks.filter(
            (h) => !(h.command && ALL_BASENAMES.some((b) => h.command.includes(b)))
          );
          if (remaining.length === 0) return null;
          return { ...entry, hooks: remaining };
        })
        .filter(Boolean);
      if (data.hooks[eventKey].length === 0) delete data.hooks[eventKey];
    }
    if (Object.keys(data.hooks).length === 0) delete data.hooks;
    /* istanbul ignore next -- settings file is always present on this path */
    if (fs.existsSync(settingsPath(home))) writeSettings(home, data);
  }

  for (const h of [...HOOKS, ...SUPPORT_FILES]) {
    const dest = hookDest(home, h.basename);
    if (fs.existsSync(dest)) {
      try { fs.unlinkSync(dest); /* istanbul ignore next */ } catch {}
    }
  }
}

module.exports = { installHook, uninstallHook, hookDest, pruneOrphanHooks, HOOK_BASENAMES: ALL_BASENAMES };
