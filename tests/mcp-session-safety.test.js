'use strict';

// The regression: `lakonai install` rewrote ~/.claude.json — where Claude Code
// keeps per-project session state — non-atomically and while a session was live.
// Users reported losing their session right after installing.
//
// Unit + integration coverage of the three guards: refuse while a session is
// active, write atomically, and validate that no Claude Code state was dropped.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lakon-mcp-'));
}

function freshMcp(home) {
  delete require.cache[require.resolve('../src/install/mcp')];
  process.env.LAKON_HOME = home;
  return require('../src/install/mcp');
}

// A config shaped like the real thing: MCP servers plus the session state that
// must survive untouched.
function seedConfig(home, extra = {}) {
  const cfg = {
    numStartups: 12,
    installMethod: 'npm',
    projects: {
      '/Users/dev/app': {
        allowedTools: ['Bash(git:*)'],
        hasTrustDialogAccepted: true,
        lastSessionId: 'sess-abc-123',
        lastSessionFirstPrompt: 'fix the auth bug',
        mcpServers: {},
      },
      '/Users/dev/other': { lastSessionId: 'sess-def-456' },
    },
    mcpServers: {
      filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
      remote: { url: 'https://example.com/sse' },
    },
    ...extra,
  };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(cfg, null, 2));
  return cfg;
}

function clearSessionEnv() {
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
  delete process.env.CLAUDE_PID;
}

// Pretend the file was last written long ago, so only the env signal is in play.
function ageConfig(home, ms = 120_000) {
  const p = path.join(home, '.claude.json');
  const t = new Date(Date.now() - ms);
  fs.utimesSync(p, t, t);
}

// ── the session guard ────────────────────────────────────────────────────────

test('activeSessionReason: an inherited Claude Code env means a live session', () => {
  const home = freshHome();
  const mcp = freshMcp(home);
  seedConfig(home);
  ageConfig(home);
  const orig = process.env.CLAUDE_CODE_ENTRYPOINT;
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
  assert.match(mcp.activeSessionReason(home), /inside a running Claude Code session/);
  if (orig === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
  else process.env.CLAUDE_CODE_ENTRYPOINT = orig;
  fs.rmSync(home, { recursive: true });
});

test('activeSessionReason: a config written seconds ago means a live session', () => {
  const home = freshHome();
  const mcp = freshMcp(home);
  const saved = { e: process.env.CLAUDE_CODE_ENTRYPOINT, p: process.env.CLAUDE_PID };
  clearSessionEnv();
  seedConfig(home); // just written
  assert.match(mcp.activeSessionReason(home), /wrote ~\/\.claude\.json \d+s ago/);
  ageConfig(home);
  assert.equal(mcp.activeSessionReason(home), null);
  if (saved.e !== undefined) process.env.CLAUDE_CODE_ENTRYPOINT = saved.e;
  if (saved.p !== undefined) process.env.CLAUDE_PID = saved.p;
  fs.rmSync(home, { recursive: true });
});

test('activeSessionReason: no config at all is never a race', () => {
  const home = freshHome();
  const mcp = freshMcp(home);
  const saved = process.env.CLAUDE_CODE_ENTRYPOINT;
  clearSessionEnv();
  assert.equal(mcp.activeSessionReason(home), null);
  if (saved !== undefined) process.env.CLAUDE_CODE_ENTRYPOINT = saved;
  fs.rmSync(home, { recursive: true });
});

test('wrapMcp: refuses to touch the config while a session is live', () => {
  const home = freshHome();
  const mcp = freshMcp(home);
  seedConfig(home);
  ageConfig(home);
  const orig = process.env.CLAUDE_CODE_ENTRYPOINT;
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
  const before = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');

  const res = mcp.wrapMcp(home);
  assert.equal(res.skipped, true);
  assert.equal(res.count, 0);
  assert.match(res.reason, /running Claude Code session/);
  assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), before, 'config must be byte-identical');

  if (orig === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
  else process.env.CLAUDE_CODE_ENTRYPOINT = orig;
  fs.rmSync(home, { recursive: true });
});

test('wrapMcp: --force overrides the guard', () => {
  const home = freshHome();
  const mcp = freshMcp(home);
  seedConfig(home);
  const orig = process.env.CLAUDE_CODE_ENTRYPOINT;
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';

  const res = mcp.wrapMcp(home, { force: true });
  assert.equal(res.skipped, false);
  assert.equal(res.count, 1); // only the stdio server

  if (orig === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
  else process.env.CLAUDE_CODE_ENTRYPOINT = orig;
  fs.rmSync(home, { recursive: true });
});

test('LAKON_NO_MCP=1 still opts out entirely', () => {
  const home = freshHome();
  const mcp = freshMcp(home);
  seedConfig(home);
  process.env.LAKON_NO_MCP = '1';
  const res = mcp.wrapMcp(home, { force: true });
  delete process.env.LAKON_NO_MCP;
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'LAKON_NO_MCP=1');
  fs.rmSync(home, { recursive: true });
});

// ── session state must survive ───────────────────────────────────────────────

test('wrap/unwrap round trip keeps every project and session id', () => {
  const home = freshHome();
  const mcp = freshMcp(home);
  const original = seedConfig(home);
  const p = path.join(home, '.claude.json');

  assert.equal(mcp.wrapMcp(home, { force: true }).count, 1);
  let after = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepEqual([...Object.keys(after.projects)], [...Object.keys(original.projects)]);
  assert.equal(after.projects['/Users/dev/app'].lastSessionId, 'sess-abc-123');
  assert.equal(after.projects['/Users/dev/app'].lastSessionFirstPrompt, 'fix the auth bug');
  assert.equal(after.projects['/Users/dev/app'].hasTrustDialogAccepted, true);
  assert.deepEqual(after.projects['/Users/dev/app'].allowedTools, ['Bash(git:*)']);
  assert.equal(after.numStartups, 12);
  // The url server is left alone.
  assert.deepEqual(after.mcpServers.remote, { url: 'https://example.com/sse' });
  assert.equal(after.mcpServers.filesystem.command, 'lakonai');

  assert.equal(mcp.unwrapMcp(home, { force: true }).count, 1);
  after = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepEqual(after.mcpServers.filesystem, original.mcpServers.filesystem);
  assert.equal(after.projects['/Users/dev/other'].lastSessionId, 'sess-def-456');
  fs.rmSync(home, { recursive: true });
});

test('preservesState: rejects a rewrite that drops a project or a session id', () => {
  const home = freshHome();
  const mcp = freshMcp(home);
  const before = { a: 1, projects: { '/x': { lastSessionId: 's1' }, '/y': {} } };

  assert.equal(mcp.preservesState(before, JSON.stringify(before)), true);
  assert.equal(mcp.preservesState(before, JSON.stringify({ a: 1, projects: { '/x': { lastSessionId: 's1' } } })), false, 'dropped project');
  assert.equal(mcp.preservesState(before, JSON.stringify({ projects: before.projects })), false, 'dropped top-level key');
  assert.equal(mcp.preservesState(before, JSON.stringify({ a: 1, projects: { '/x': { lastSessionId: 'CHANGED' }, '/y': {} } })), false, 'rewrote a session id');
  assert.equal(mcp.preservesState(before, JSON.stringify({ a: 1 })), false, 'projects gone');
  assert.equal(mcp.preservesState(before, 'not json'), false);
  assert.equal(mcp.preservesState({ a: 1 }, JSON.stringify({ a: 1, projects: {} })), true, 'no projects before is fine');
  fs.rmSync(home, { recursive: true });
});

test('applyToConfig: a transform that would drop state writes nothing', () => {
  const home = freshHome();
  const mcp = freshMcp(home);
  seedConfig(home);
  const p = path.join(home, '.claude.json');
  const before = fs.readFileSync(p, 'utf8');

  // Stand-in for a future bug in a transform: it reports work done but would
  // take the user's projects with it. The validator must veto the write.
  const destructive = (config) => { delete config.projects; return 3; };
  const res = mcp.applyToConfig(home, destructive, { force: true });

  assert.equal(res.skipped, true);
  assert.equal(res.count, 0);
  assert.match(res.reason, /would have dropped Claude Code state/);
  assert.equal(fs.readFileSync(p, 'utf8'), before, 'config untouched');
  fs.rmSync(home, { recursive: true });
});

// ── atomicity on the real path ───────────────────────────────────────────────

test('wrapMcp: the config is replaced by rename, never truncated in place', () => {
  const home = freshHome();
  const mcp = freshMcp(home);
  seedConfig(home);
  const p = path.join(home, '.claude.json');
  const inodeBefore = fs.statSync(p).ino;

  mcp.wrapMcp(home, { force: true });

  assert.notEqual(fs.statSync(p).ino, inodeBefore, 'a rename swaps the inode — proof it was not written in place');
  assert.equal(fs.readdirSync(home).filter((f) => f.includes('.tmp')).length, 0, 'no temp file left behind');
  JSON.parse(fs.readFileSync(p, 'utf8')); // must always parse
  fs.rmSync(home, { recursive: true });
});

test('statusMcp: counts wrapped and unwrapped servers', () => {
  const home = freshHome();
  const mcp = freshMcp(home);
  seedConfig(home);

  let st = mcp.statusMcp(home);
  assert.equal(st.exists, true);
  assert.equal(st.wrapped, 0);
  assert.equal(st.unwrapped, 1);

  mcp.wrapMcp(home, { force: true });
  st = mcp.statusMcp(home);
  assert.equal(st.wrapped, 1);
  assert.equal(st.unwrapped, 0);
  fs.rmSync(home, { recursive: true });
});

test('statusMcp: reports a missing config instead of throwing', () => {
  const home = freshHome();
  const mcp = freshMcp(home);
  const st = mcp.statusMcp(home);
  assert.equal(st.exists, false);
  assert.equal(st.wrapped, 0);
  fs.rmSync(home, { recursive: true });
});

test('wrapMcp: unreadable config is a no-op, not a crash', () => {
  const home = freshHome();
  const mcp = freshMcp(home);
  fs.writeFileSync(path.join(home, '.claude.json'), 'not json at all');
  ageConfig(home);
  const res = mcp.wrapMcp(home, { force: true });
  assert.equal(res.count, 0);
  assert.equal(res.skipped, false);
  fs.rmSync(home, { recursive: true });
});

test('wrapMcp: a config with no stdio servers writes nothing', () => {
  const home = freshHome();
  const mcp = freshMcp(home);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { r: { url: 'https://x' } } }, null, 2));
  const p = path.join(home, '.claude.json');
  const inode = fs.statSync(p).ino;
  const res = mcp.wrapMcp(home, { force: true });
  assert.equal(res.count, 0);
  assert.equal(fs.statSync(p).ino, inode, 'untouched file keeps its inode');
  fs.rmSync(home, { recursive: true });
});

test('our own write is not mistaken for a live session', () => {
  const home = freshHome();
  const mcp = freshMcp(home);
  const saved = { e: process.env.CLAUDE_CODE_ENTRYPOINT, p: process.env.CLAUDE_PID };
  clearSessionEnv();
  seedConfig(home);
  ageConfig(home);

  // wrap writes the config; the very next command must not read that write as
  // "a session just touched the file" and refuse.
  assert.equal(mcp.wrapMcp(home).count, 1);
  assert.equal(mcp.activeSessionReason(home), null, 'our own fresh write must not block us');
  assert.equal(mcp.unwrapMcp(home).count, 1, 'unwrap right after wrap must work');

  // A write by someone else, on the other hand, still blocks.
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }));
  assert.match(mcp.activeSessionReason(home), /wrote ~\/\.claude\.json/);

  if (saved.e !== undefined) process.env.CLAUDE_CODE_ENTRYPOINT = saved.e;
  if (saved.p !== undefined) process.env.CLAUDE_PID = saved.p;
  fs.rmSync(home, { recursive: true });
});

test('preservesState: projects replaced by a non-object is rejected', () => {
  const home = freshHome();
  const mcp = freshMcp(home);
  const before = { projects: { '/x': {} } };
  assert.equal(mcp.preservesState(before, JSON.stringify({ projects: 'oops' })), false);
  assert.equal(mcp.preservesState(before, JSON.stringify({ projects: null })), false);
  fs.rmSync(home, { recursive: true });
});

test('statusMcp: skips entries that are not server objects', () => {
  const home = freshHome();
  const mcp = freshMcp(home);
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ mcpServers: { broken: null, alsoBroken: 'string', good: { command: 'npx' } } }, null, 2)
  );
  const st = mcp.statusMcp(home);
  assert.equal(st.unwrapped, 1);
  assert.equal(st.wrapped, 0);
  fs.rmSync(home, { recursive: true });
});

test('lastWrite marker falls back to ~/.lakon when LAKON_HOME is unset', () => {
  const home = freshHome();
  const mcp = freshMcp(home);
  const savedLakon = process.env.LAKON_HOME;
  const savedHome = process.env.HOME;
  delete process.env.LAKON_HOME;
  process.env.HOME = home; // homedir() resolves here
  // No marker yet, so nothing can look like our own write.
  assert.equal(mcp.isOwnWrite(123), false);
  mcp.recordOwnWrite(path.join(home, 'nope.json')); // missing file: best-effort, must not throw
  process.env.HOME = savedHome;
  if (savedLakon !== undefined) process.env.LAKON_HOME = savedLakon;
  fs.rmSync(home, { recursive: true });
});
