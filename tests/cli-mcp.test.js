'use strict';

// E2E: `lakonai mcp …` as a real process. The user-visible contract is that a
// live Claude Code session makes the command refuse, loudly, instead of
// rewriting ~/.claude.json underneath it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'lakonai.js');

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lakon-cli-mcp-'));
}

// A clean env: no inherited Claude Code session markers.
function run(args, home, extraEnv = {}) {
  const env = { ...process.env, HOME: home, LAKON_HOME: path.join(home, '.lakon') };
  // Drop inherited session markers BEFORE applying the test's own env, so a
  // test can deliberately simulate a live session.
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_PID;
  delete env.LAKON_NO_MCP;
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...env, ...extraEnv } });
}

function seed(home) {
  const cfg = {
    projects: { '/app': { lastSessionId: 'sess-1', hasTrustDialogAccepted: true } },
    mcpServers: { fs: { command: 'npx', args: ['-y', 'server-fs'] } },
  };
  const p = path.join(home, '.claude.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  // Age it so only the env signal decides.
  const t = new Date(Date.now() - 120_000);
  fs.utimesSync(p, t, t);
  return p;
}

test('mcp status: reports counts', () => {
  const home = freshHome();
  seed(home);
  const res = run(['mcp', 'status'], home);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /0 wrapped, 1 not wrapped/);
  fs.rmSync(home, { recursive: true });
});

test('mcp status: no config is stated plainly, not a crash', () => {
  const home = freshHome();
  const res = run(['mcp', 'status'], home);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /no Claude Code config/);
  fs.rmSync(home, { recursive: true });
});

test('mcp wrap: refuses inside a live session and leaves the config byte-identical', () => {
  const home = freshHome();
  const p = seed(home);
  const before = fs.readFileSync(p, 'utf8');

  const res = run(['mcp', 'wrap'], home, { CLAUDE_CODE_ENTRYPOINT: 'cli' });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /skipped/);
  assert.match(res.stdout, /session state|sessions/);
  assert.match(res.stdout, /--force/);
  assert.equal(fs.readFileSync(p, 'utf8'), before);
  fs.rmSync(home, { recursive: true });
});

test('mcp wrap → unwrap: round trips and keeps session state', () => {
  const home = freshHome();
  const p = seed(home);

  const wrapped = run(['mcp', 'wrap'], home);
  assert.equal(wrapped.status, 0, wrapped.stdout + wrapped.stderr);
  assert.match(wrapped.stdout, /wrapped 1 server/);

  let cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(cfg.mcpServers.fs.command, 'lakonai');
  assert.equal(cfg.projects['/app'].lastSessionId, 'sess-1');
  assert.equal(cfg.projects['/app'].hasTrustDialogAccepted, true);

  const unwrapped = run(['mcp', 'unwrap'], home);
  assert.equal(unwrapped.status, 0);
  cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(cfg.mcpServers.fs.command, 'npx');
  assert.deepEqual([...cfg.mcpServers.fs.args], ['-y', 'server-fs']);
  assert.equal(cfg.projects['/app'].lastSessionId, 'sess-1');
  fs.rmSync(home, { recursive: true });
});

test('mcp wrap --force: overrides the session guard', () => {
  const home = freshHome();
  const p = seed(home);
  const res = run(['mcp', 'wrap', '--force'], home, { CLAUDE_CODE_ENTRYPOINT: 'cli' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /wrapped 1 server/);
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).mcpServers.fs.command, 'lakonai');
  fs.rmSync(home, { recursive: true });
});

test('mcp wrap: nothing to do is said plainly', () => {
  const home = freshHome();
  const p = path.join(home, '.claude.json');
  fs.writeFileSync(p, JSON.stringify({ mcpServers: { r: { url: 'https://x' } } }, null, 2));
  const t = new Date(Date.now() - 120_000);
  fs.utimesSync(p, t, t);
  const res = run(['mcp', 'wrap'], home);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /nothing to wrap/);
  fs.rmSync(home, { recursive: true });
});

test('mcp: unknown subcommand exits 1', () => {
  const home = freshHome();
  const res = run(['mcp', 'bogus'], home);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /unknown subcommand "bogus"/);
  fs.rmSync(home, { recursive: true });
});

test('help lists the mcp command', () => {
  const res = spawnSync('node', [CLI, '--help'], { encoding: 'utf8' });
  assert.match(res.stdout, /lakonai mcp \[cmd\]/);
});
