'use strict';

// Sessions stranded on a dead proxy port.
//
// The regression this file exists for: `proxy status` reported a dead daemon as
// "Claude talks to the API directly — nothing broken". That is true only for
// sessions started afterwards. A session launched while the proxy was up has
// ANTHROPIC_BASE_URL burned into its process environment for life, so when the
// daemon dies it does not fall back to anything — it retries a refused
// connection until the user kills it. The status output has to say that.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const daemon = require('../src/proxy/daemon');

// A process pgrep will match on 'claude', holding a chosen base URL in its env
// and doing nothing until we kill it.
function fakeSession(baseUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lakon-claude-'));
  const script = path.join(dir, 'claude-fake-session.js');
  fs.writeFileSync(script, 'setTimeout(() => {}, 60000);\n');
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ANTHROPIC_BASE_URL: baseUrl },
    stdio: 'ignore',
  });
  return {
    pid: child.pid,
    kill: () => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
    },
  };
}

// pgrep/ps need a moment before a just-spawned process is visible.
function settle(ms = 400) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('processEnv', () => {
  test('reads a variable out of a live process', async () => {
    const s = fakeSession('http://127.0.0.1:5555');
    try {
      await settle();
      assert.equal(daemon.processEnv(s.pid, 'ANTHROPIC_BASE_URL'), 'http://127.0.0.1:5555');
    } finally {
      s.kill();
    }
  });

  test('returns null for a variable the process does not have', async () => {
    const s = fakeSession('http://127.0.0.1:5556');
    try {
      await settle();
      assert.equal(daemon.processEnv(s.pid, 'LAKON_NOT_SET_ANYWHERE'), null);
    } finally {
      s.kill();
    }
  });

  test('returns null for a pid that does not exist', () => {
    // A pid far above the wrap-around range: nothing is running there.
    assert.equal(daemon.processEnv(4194303, 'ANTHROPIC_BASE_URL'), null);
  });
});

describe('sessionsOnPort', () => {
  test('finds a session holding the port', async () => {
    const s = fakeSession('http://127.0.0.1:5557');
    try {
      await settle();
      const found = daemon.sessionsOnPort(5557).find((x) => x.pid === s.pid);
      assert.ok(found, 'the fake session should be reported as holding 5557');
      assert.equal(found.port, 5557);
      assert.equal(found.url, 'http://127.0.0.1:5557');
    } finally {
      s.kill();
    }
  });

  test('a session on a different port is not reported', async () => {
    const s = fakeSession('http://127.0.0.1:5558');
    try {
      await settle();
      const found = daemon.sessionsOnPort(5999).find((x) => x.pid === s.pid);
      assert.equal(found, undefined, 'only the asked-for port counts');
    } finally {
      s.kill();
    }
  });

  test('no port means no answer', () => {
    assert.deepEqual(daemon.sessionsOnPort(null), []);
    assert.deepEqual(daemon.sessionsOnPort(0), []);
    assert.deepEqual(daemon.sessionsOnPort(undefined), []);
  });

  test('a remote endpoint is left alone — not ours to report on', async () => {
    const s = fakeSession('https://gateway.example.com');
    try {
      await settle();
      const all = daemon.sessionsOnPort(443).concat(daemon.sessionsOnPort(80));
      assert.equal(all.find((x) => x.pid === s.pid), undefined);
    } finally {
      s.kill();
    }
  });

  test('a session with no base URL at all is ignored', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lakon-claude-'));
    const script = path.join(dir, 'claude-fake-bare.js');
    fs.writeFileSync(script, 'setTimeout(() => {}, 60000);\n');
    const env = { ...process.env };
    delete env.ANTHROPIC_BASE_URL;
    const child = spawn(process.execPath, [script], { env, stdio: 'ignore' });
    try {
      await settle();
      const found = daemon.sessionsOnPort(5561).find((x) => x.pid === child.pid);
      assert.equal(found, undefined);
    } finally {
      try { child.kill('SIGKILL'); } catch { /* ok */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  test('localhost and ::1 count as the same local proxy', async () => {
    const a = fakeSession('http://localhost:5559');
    const b = fakeSession('http://[::1]:5560');
    try {
      await settle();
      assert.ok(daemon.sessionsOnPort(5559).some((x) => x.pid === a.pid), 'localhost form');
      assert.ok(daemon.sessionsOnPort(5560).some((x) => x.pid === b.pid), '[::1] form');
    } finally {
      a.kill();
      b.kill();
    }
  });
});

describe('proxy status (CLI)', () => {
  function statusWith(home) {
    return spawnSync(process.execPath, [path.join(ROOT, 'bin', 'lakonai.js'), 'proxy', 'status'], {
      encoding: 'utf8',
      env: { ...process.env, LAKON_HOME: home },
    });
  }

  test('warns about stranded sessions instead of claiming nothing is broken', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lakon-home-'));
    // pid 1 is alive but is not listening: the "stale state" shape.
    fs.writeFileSync(path.join(home, 'proxy.json'), JSON.stringify({ pid: 1, port: 5561 }));
    const s = fakeSession('http://127.0.0.1:5561');
    try {
      await settle();
      const res = statusWith(home);
      assert.equal(res.status, 1, 'a dead proxy is still a non-zero exit');
      assert.match(res.stdout, /NOT serving on 127\.0\.0\.1:5561/);
      assert.match(res.stdout, new RegExp(`pid ${s.pid}`), 'names the stranded session');
      assert.match(res.stdout, /ConnectionRefused/);
      assert.match(res.stdout, /rebinds the same port/);
      assert.doesNotMatch(res.stdout, /nothing broken/,
        'must not claim a clean fallback while a session is stuck');
    } finally {
      s.kill();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('with no stranded session it still reports the harmless fallback', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lakon-home-'));
    // A port nothing is pinned to.
    fs.writeFileSync(path.join(home, 'proxy.json'), JSON.stringify({ pid: 1, port: 5562 }));
    try {
      const res = statusWith(home);
      assert.equal(res.status, 1);
      assert.match(res.stdout, /nothing broken/);
      assert.match(res.stdout, /lakonai proxy start/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
