'use strict';

// E2E: `lakonai proxy …` driven as a real process, asserting on stdout and exit
// codes — the user's view of the fix.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'lakonai.js');

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lakon-cli-proxy-'));
}

function run(args, home, extraEnv = {}) {
  return spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LAKON_HOME: home, HOME: home, ...extraEnv },
  });
}

function cleanup(home) {
  run(['proxy', 'stop'], home);
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ok */ }
}

test('proxy status: exits 1 and explains the fallback when not running', () => {
  const home = freshHome();
  try {
    const res = run(['proxy', 'status'], home);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /not running/);
    assert.match(res.stdout, /directly/, 'must say the CLI still works without it');
    assert.match(res.stdout, /lakonai proxy start/);
  } finally {
    cleanup(home);
  }
});

test('proxy start → status → stop over the real CLI', () => {
  const home = freshHome();
  try {
    const started = run(['proxy', 'start'], home);
    assert.equal(started.status, 0, started.stdout + started.stderr);
    const port = /127\.0\.0\.1:(\d+)/.exec(started.stdout);
    assert.ok(port, `no port in output: ${started.stdout}`);

    const status = run(['proxy', 'status'], home);
    assert.equal(status.status, 0);
    assert.match(status.stdout, /running \(pid \d+\)/);
    assert.ok(status.stdout.includes(`127.0.0.1:${port[1]}`));

    const stopped = run(['proxy', 'stop'], home);
    assert.equal(stopped.status, 0);
    assert.match(stopped.stdout, /stopped/);

    assert.equal(run(['proxy', 'status'], home).status, 1);
  } finally {
    cleanup(home);
  }
});

test('proxy start: writes the guarded line into the shell rc, not a bare export', () => {
  const home = freshHome();
  const rc = path.join(home, '.zshrc');
  fs.writeFileSync(rc, '# user content\n');
  try {
    const res = run(['proxy', 'start'], home);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const content = fs.readFileSync(rc, 'utf8');
    assert.ok(content.includes('# user content'), 'existing rc content must survive');
    assert.ok(content.includes('# lakonai proxy'));
    assert.ok(!content.includes('export ANTHROPIC_BASE_URL'), 'the unconditional export is the bug');
  } finally {
    cleanup(home);
  }
});

test('proxy stop: says so plainly when nothing was running', () => {
  const home = freshHome();
  try {
    const res = run(['proxy', 'stop'], home);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /was not running/);
  } finally {
    cleanup(home);
  }
});

test('proxy restart: works from a cold start', () => {
  const home = freshHome();
  try {
    const res = run(['proxy', 'restart'], home);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /started \(pid \d+\)/);
  } finally {
    cleanup(home);
  }
});

test('proxy: unknown subcommand exits 1 with the valid list', () => {
  const home = freshHome();
  try {
    const res = run(['proxy', 'bogus'], home);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /unknown subcommand "bogus"/);
    assert.match(res.stdout, /status\|start\|stop\|restart/);
  } finally {
    cleanup(home);
  }
});

test('proxy status: a stale state file never reads as running', () => {
  const home = freshHome();
  try {
    fs.mkdirSync(home, { recursive: true });
    // Alive pid (this test process), port nothing serves.
    fs.writeFileSync(path.join(home, 'proxy.json'), JSON.stringify({ pid: process.pid, port: 1 }));
    const res = run(['proxy', 'status'], home);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /NOT serving/);
  } finally {
    cleanup(home);
  }
});

test('help lists the proxy command', () => {
  const res = spawnSync('node', [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /lakonai proxy \[cmd\]/);
});

test('upgrade path: an old install is migrated end to end by `proxy start`', () => {
  const home = freshHome();
  const rc = path.join(home, '.zshrc');
  // A pre-1.2.3 machine: the unconditional export, pointing at the old port.
  fs.writeFileSync(rc, '# my stuff\nexport ANTHROPIC_BASE_URL=http://127.0.0.1:7474  # lakonai proxy\nalias k=kubectl\n');
  try {
    const res = run(['proxy', 'start'], home);
    assert.equal(res.status, 0, res.stdout + res.stderr);

    const content = fs.readFileSync(rc, 'utf8');
    assert.ok(!content.includes('export ANTHROPIC_BASE_URL'), 'the dangerous export must be gone');
    assert.ok(content.includes('proxy-env.sh'), 'replaced by the guarded source line');
    assert.ok(content.includes('# my stuff') && content.includes('alias k=kubectl'), 'user content preserved');

    // The file that line sources must exist, and carry the port really bound.
    const port = /127\.0\.0\.1:(\d+)/.exec(res.stdout)[1];
    assert.ok(fs.readFileSync(path.join(home, 'proxy-env.sh'), 'utf8').includes(`__lakon_port=${port}`));
    assert.notEqual(port, '7474');
  } finally {
    cleanup(home);
  }
});
