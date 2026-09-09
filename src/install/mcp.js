'use strict';

// Automatic MCP catalog compression. On install, lakonai finds the user's
// configured MCP servers (~/.claude.json) and transparently wraps each stdio
// server so its tool/prompt/resource descriptions are compressed before they hit
// context (via `lakonai __mcp <original-cmd>`). Backed up first, fully reversible
// on uninstall. Only stdio servers (a string `command`) are touched; url/sse
// servers and tool-call results are never altered. Opt out with LAKON_NO_MCP=1.
//
// ~/.claude.json is NOT just MCP config — Claude Code keeps per-project session
// state there (`lastSessionId`, `lastSessionFirstPrompt`, `hasTrustDialogAccepted`,
// `allowedTools`) and rewrites it on every turn. A read-modify-write from here
// while a session is live silently discards whatever Claude Code wrote in
// between, which orphans the session (`claude --resume` no longer finds it).
// So this module: refuses to write while a session is active, writes atomically,
// and validates that no project survived the round trip missing.

const fs = require('fs');
const path = require('path');
const { backupFile } = require('./backup');
const { writeFileAtomic } = require('./atomic');

// A session that wrote the config this recently is treated as live.
const RECENT_WRITE_MS = 30_000;

// Where we record the mtime of our own last write, so we do not mistake it for
// a Claude Code session and refuse the very next command.
function lastWritePath() {
  const home = process.env.LAKON_HOME || path.join(require('./paths').homedir(), '.lakon');
  return path.join(home, 'mcp-last-write.json');
}

function recordOwnWrite(configPath) {
  try {
    const { mtimeMs } = fs.statSync(configPath);
    fs.mkdirSync(path.dirname(lastWritePath()), { recursive: true });
    fs.writeFileSync(lastWritePath(), JSON.stringify({ mtimeMs }));
  } catch { /* best-effort: the worst case is one over-cautious refusal */ }
}

function isOwnWrite(mtimeMs) {
  try {
    return JSON.parse(fs.readFileSync(lastWritePath(), 'utf8')).mtimeMs === mtimeMs;
  } catch {
    return false;
  }
}

function mcpConfigPath(home) {
  return path.join(home, '.claude.json');
}

// Why it is unsafe to write ~/.claude.json right now, or null when it is safe.
// The env check catches the common case by far: `lakonai install` typed inside a
// Claude Code session. The mtime check catches a session running in another
// terminal.
function activeSessionReason(home, { now = Date.now() } = {}) {
  if (process.env.CLAUDE_CODE_ENTRYPOINT || process.env.CLAUDE_PID) {
    return 'this shell is inside a running Claude Code session';
  }
  try {
    // A file timestamp can land a hair AHEAD of Date.now() (clock/fs
    // granularity), so a negative age means "just written", not "stale" — and
    // erring toward "a session is live" is the safe direction anyway.
    const { mtimeMs } = fs.statSync(mcpConfigPath(home));
    const age = now - mtimeMs;
    if (age < RECENT_WRITE_MS && !isOwnWrite(mtimeMs)) {
      return `a Claude Code session wrote ~/.claude.json ${Math.round(Math.max(age, 0) / 1000)}s ago`;
    }
  } catch { /* no config yet: nothing can be racing us */ }
  return null;
}

// Collect every `mcpServers` map anywhere in the config (top-level + per-project).
function collectServerMaps(obj, out) {
  if (!obj || typeof obj !== 'object') return out;
  if (obj.mcpServers && typeof obj.mcpServers === 'object') out.push(obj.mcpServers);
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && v !== obj.mcpServers) collectServerMaps(v, out);
  }
  return out;
}

// Wrap stdio servers in place. Returns how many were wrapped.
function wrapServers(config) {
  let n = 0;
  for (const map of collectServerMaps(config, [])) {
    for (const name of Object.keys(map)) {
      const s = map[name];
      if (!s || typeof s !== 'object' || s._lakonai) continue;
      if (typeof s.command !== 'string') continue; // url/sse server — skip
      const origArgs = Array.isArray(s.args) ? s.args : [];
      s.args = ['__mcp', s.command, ...origArgs];
      s.command = 'lakonai';
      s._lakonai = true;
      n++;
    }
  }
  return n;
}

// Reverse wrapServers. Returns how many were unwrapped.
function unwrapServers(config) {
  let n = 0;
  for (const map of collectServerMaps(config, [])) {
    for (const name of Object.keys(map)) {
      const s = map[name];
      if (!s || typeof s !== 'object' || !s._lakonai) continue;
      const a = Array.isArray(s.args) ? s.args : [];
      s.command = a[1];
      s.args = a.slice(2);
      delete s._lakonai;
      n++;
    }
  }
  return n;
}

// Last line of defence before the rename: the bytes we are about to write must
// parse, and must still carry every project (with its session pointers) and
// every top-level key the file had. Anything less means a bug here would be
// destroying the user's Claude Code state.
function preservesState(before, serialized) {
  let after;
  try { after = JSON.parse(serialized); } catch { return false; }

  for (const k of Object.keys(before)) {
    if (!(k in after)) return false;
  }
  const oldProjects = before.projects && typeof before.projects === 'object' ? before.projects : null;
  if (oldProjects) {
    const newProjects = after.projects;
    if (!newProjects || typeof newProjects !== 'object') return false;
    for (const p of Object.keys(oldProjects)) {
      if (!(p in newProjects)) return false;
      if (oldProjects[p] && oldProjects[p].lastSessionId && newProjects[p].lastSessionId !== oldProjects[p].lastSessionId) {
        return false;
      }
    }
  }
  return true;
}

// Returns { count, skipped, reason }. `count` is how many servers changed;
// `skipped` says the config was deliberately left alone.
function applyToConfig(home, transform, { force = false } = {}) {
  if (process.env.LAKON_NO_MCP === '1') return { count: 0, skipped: true, reason: 'LAKON_NO_MCP=1' };

  const p = mcpConfigPath(home);
  if (!force) {
    const reason = activeSessionReason(home);
    if (reason) return { count: 0, skipped: true, reason };
  }

  // Back up before reading, so the copy on disk is never newer than what we read.
  backupFile('claude-code-mcp', p);

  let raw;
  let config;
  try {
    raw = fs.readFileSync(p, 'utf8');
    config = JSON.parse(raw);
  } catch {
    return { count: 0, skipped: false, reason: null }; // no config / unreadable -> nothing to do
  }

  // Read → transform → write with nothing slow in between: every millisecond
  // here is a millisecond of Claude Code writes we would clobber.
  const before = JSON.parse(raw);
  const n = transform(config);
  if (n === 0) return { count: 0, skipped: false, reason: null };

  const serialized = JSON.stringify(config, null, 2) + '\n';
  if (!preservesState(before, serialized)) {
    return { count: 0, skipped: true, reason: 'refused: the rewrite would have dropped Claude Code state' };
  }

  writeFileAtomic(p, serialized);
  recordOwnWrite(p);
  return { count: n, skipped: false, reason: null };
}

function wrapMcp(home, opts) {
  return applyToConfig(home, wrapServers, opts);
}
function unwrapMcp(home, opts) {
  return applyToConfig(home, unwrapServers, opts);
}

// How many servers are currently wrapped / wrappable — for `lakonai mcp status`.
function statusMcp(home) {
  const p = mcpConfigPath(home);
  let config;
  try { config = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { config: p, exists: false, wrapped: 0, unwrapped: 0 }; }
  let wrapped = 0;
  let unwrapped = 0;
  for (const map of collectServerMaps(config, [])) {
    for (const name of Object.keys(map)) {
      const s = map[name];
      if (!s || typeof s !== 'object') continue;
      if (s._lakonai) wrapped++;
      else if (typeof s.command === 'string') unwrapped++;
    }
  }
  return { config: p, exists: true, wrapped, unwrapped, blockedBy: activeSessionReason(home) };
}

module.exports = {
  applyToConfig,
  wrapMcp,
  unwrapMcp,
  statusMcp,
  wrapServers,
  unwrapServers,
  collectServerMaps,
  mcpConfigPath,
  activeSessionReason,
  preservesState,
  isOwnWrite,
  recordOwnWrite,
};
