'use strict';

// Integration: the real daemon lifecycle — spawn a real process, bind a real
// socket, write real files, kill it. No mocks on the I/O boundary.
//
// The regression this file exists for: on a fresh install the proxy could fail
// to bind (port taken — 7474 is Neo4j's) and die silently, while the installer
// had already written `export ANTHROPIC_BASE_URL` into the shell rc. Every later
// `claude` then failed with ECONNREFUSED.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lakon-life-'));
}

function load(home, env = {}) {
  delete require.cache[require.resolve('../src/proxy/daemon')];
  delete require.cache[require.resolve('../src/proxy/state')];
  process.env.LAKON_HOME = home;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return { daemon: require('../src/proxy/daemon'), state: require('../src/proxy/state') };
}

function cleanup(home, daemon) {
  try { if (daemon) return daemon.stop().finally(() => fs.rmSync(home, { recursive: true, force: true })); } catch { /* ok */ }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ok */ }
  return Promise.resolve();
}

function occupy() {
  return new Promise((resolve) => {
    const srv = net.createServer(() => {});
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => new Promise((r) => srv.close(r)) }));
  });
}

const cleanupEnv = () => {
  delete process.env.LAKON_PROXY_PORT;
  delete process.env.LAKON_PROXY_START_TIMEOUT;
};

test('start → status → stop: a real daemon, verified by a real connect', async () => {
  const home = freshHome();
  const { daemon, state } = load(home);
  try {
    const started = await daemon.start();
    assert.equal(started.running, true, `expected the daemon to come up: ${started.error || ''}`);
    assert.ok(started.port > 0);

    // The state file is written by the server itself, only once bound.
    const st = state.readState();
    assert.equal(st.pid, started.pid);
    assert.equal(st.port, started.port);
    assert.equal(await state.probePort(started.port), true);

    // The shell snippet exists and carries the port that was actually bound.
    assert.ok(fs.readFileSync(state.envFile(), 'utf8').includes(`__lakon_port=${started.port}`));

    const live = await daemon.status();
    assert.equal(live.running, true);
    assert.equal(live.listening, true);

    // Ownership is provable from the command line alone, so a wedged daemon
    // that no longer answers can still be stopped.
    assert.equal(daemon.ownsProxy(started.pid, started.port, { listening: false }), true);

    // Starting twice does not spawn a second daemon.
    const again = await daemon.start();
    assert.equal(again.alreadyRunning, true);
    assert.equal(again.pid, started.pid);

    assert.equal(await daemon.stop(), true);
    assert.equal(await state.probePort(started.port), false, 'port must be released');
    assert.equal(fs.existsSync(state.stateFile()), false);
    assert.equal(fs.existsSync(state.envFile()), false);

    const dead = await daemon.status();
    assert.equal(dead.running, false);
  } finally {
    cleanupEnv();
    await cleanup(home, null);
  }
});

test('busy port: the daemon falls back to a free one instead of dying silently', async () => {
  const home = freshHome();
  const squatter = await occupy();
  const { daemon, state } = load(home, { LAKON_PROXY_PORT: String(squatter.port) });
  try {
    const started = await daemon.start();
    assert.equal(started.running, true, `expected a fallback bind: ${started.error || ''}`);
    assert.notEqual(started.port, squatter.port, 'must not claim the occupied port');
    assert.equal(await state.probePort(started.port), true);
    assert.ok(fs.readFileSync(state.envFile(), 'utf8').includes(`__lakon_port=${started.port}`));
    await daemon.stop();
  } finally {
    cleanupEnv();
    await squatter.close();
    await cleanup(home, null);
  }
});

test('restart: comes back on a working port', async () => {
  const home = freshHome();
  const { daemon, state } = load(home);
  try {
    const first = await daemon.start();
    assert.equal(first.running, true);
    const second = await daemon.restart();
    assert.equal(second.running, true);
    assert.notEqual(second.pid, first.pid, 'restart must be a new process');
    assert.equal(await state.probePort(second.port), true);
    await daemon.stop();
  } finally {
    cleanupEnv();
    await cleanup(home, null);
  }
});

test('a daemon killed behind our back reads as stale, never as running', async () => {
  const home = freshHome();
  const { daemon, state } = load(home);
  try {
    const started = await daemon.start();
    assert.equal(started.running, true);
    process.kill(started.pid, 'SIGKILL'); // SIGKILL: no cleanup handler runs
    await state.waitForPort(started.port, { timeoutMs: 3000, want: false });

    const s = await daemon.status();
    assert.equal(s.running, false, 'a dead daemon must never report as running');
    assert.equal(s.stale, true);
  } finally {
    cleanupEnv();
    await cleanup(home, null);
  }
});

test('the generated snippet exports only while the proxy is up (real shell)', async () => {
  const home = freshHome();
  const { daemon, state } = load(home);
  const sh = (script) => spawnSync('sh', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, ANTHROPIC_BASE_URL: '' },
  }).stdout.trim();
  try {
    const started = await daemon.start();
    assert.equal(started.running, true);
    const envSh = state.envFile();

    const up = sh(`. ${envSh}; echo "\${ANTHROPIC_BASE_URL:-NONE}"`);
    assert.equal(up, `http://127.0.0.1:${started.port}`);

    // Same snippet, pointed at a port nothing serves: it must decline to export
    // rather than send the CLI at a dead port. (A port of our own, verified
    // closed — the suite runs workers in parallel, so the daemon's own port may
    // be re-taken by another test.)
    const spare = await occupy();
    const deadPort = spare.port;
    await spare.close();
    assert.equal(await state.probePort(deadPort), false);

    const copy = path.join(home, 'kept-env.sh');
    fs.writeFileSync(copy, state.envScript(deadPort));
    await daemon.stop();
    const down = sh(`. ${copy}; echo "\${ANTHROPIC_BASE_URL:-NONE}"`);
    assert.equal(down, 'NONE');

    // And it never overrides a base URL the user set themselves.
    const custom = spawnSync('sh', ['-c', `. ${copy}; echo "$ANTHROPIC_BASE_URL"`], {
      encoding: 'utf8',
      env: { ...process.env, ANTHROPIC_BASE_URL: 'https://gateway.example' },
    }).stdout.trim();
    assert.equal(custom, 'https://gateway.example');
  } finally {
    cleanupEnv();
    await cleanup(home, null);
  }
});

test('wireProxy: writes the rc only when the daemon really started', async () => {
  const home = freshHome();
  const rc = path.join(home, '.zshrc');
  fs.writeFileSync(rc, '# mine\n');
  const { daemon } = load(home);
  const { wireProxy } = require('../src/install');

  const out = [];
  const write = (t) => out.push(t);

  try {
    // Failure path: the rc must stay untouched.
    const failing = { start: async () => ({ running: false, error: 'nope' }), rcFiles: daemon.rcFiles, installEnv: daemon.installEnv };
    const bad = await wireProxy(failing, { write });
    assert.equal(bad.started, false);
    assert.equal(fs.readFileSync(rc, 'utf8'), '# mine\n', 'a failed proxy must not touch the shell');
    assert.ok(out.join('').includes('not started'));

    // Success path: rc gets the guarded source line.
    const ok = await wireProxy({ start: async () => ({ running: true, pid: 1, port: 41474 }), rcFiles: () => [rc], installEnv: daemon.installEnv }, { write });
    assert.equal(ok.started, true);
    assert.deepEqual(ok.touched, [rc]);
    const content = fs.readFileSync(rc, 'utf8');
    assert.ok(content.includes('# mine'));
    assert.ok(content.includes('# lakonai proxy'));
    assert.ok(!content.includes('export ANTHROPIC_BASE_URL'));
  } finally {
    cleanupEnv();
    await cleanup(home, null);
  }
});

test('ROOT server script is the one the supervisor spawns', () => {
  // Guards against a rename silently turning start() into a permanent failure.
  assert.ok(fs.existsSync(path.join(ROOT, 'src', 'proxy', 'server.js')));
});

test('no fallback + busy port: start reports failure, and the rc stays untouched', async () => {
  const home = freshHome();
  const squatter = await occupy();
  // The exact shape of the shipped bug: the port is taken and the server cannot
  // move. start() must say so instead of returning `{running: true}`.
  const { daemon, state } = load(home, {
    LAKON_PROXY_PORT: String(squatter.port),
    LAKON_PROXY_FALLBACK: '0',
    LAKON_PROXY_START_TIMEOUT: '1500',
  });
  const rc = path.join(home, '.zshrc');
  fs.writeFileSync(rc, '# untouched\n');
  try {
    const res = await daemon.start();
    assert.equal(res.running, false);
    assert.match(res.error, /did not come up/);
    assert.equal(state.readState(), null, 'no stale state may be left behind');
    assert.equal(fs.existsSync(state.envFile()), false);

    const { wireProxy } = require('../src/install');
    const out = [];
    await wireProxy(daemon, { write: (t) => out.push(t) });
    assert.equal(fs.readFileSync(rc, 'utf8'), '# untouched\n');
    assert.ok(out.join('').includes('Shell left untouched'));
  } finally {
    delete process.env.LAKON_PROXY_FALLBACK;
    cleanupEnv();
    await squatter.close();
    await cleanup(home, null);
  }
});

test('upgrade: a daemon running stale code is replaced, not adopted', async () => {
  const home = freshHome();
  const { daemon, state } = load(home);
  try {
    const first = await daemon.start();
    assert.equal(first.running, true);

    // Rewrite the stamp to an older version — exactly what an upgraded lakonai
    // finds: the process in memory is still the previous release's server.js.
    const st = state.readState();
    state.writeState({ ...st, version: '1.2.2' });

    const second = await daemon.start();
    assert.equal(second.running, true);
    assert.notEqual(second.pid, first.pid, 'the stale daemon must be replaced');
    assert.equal(state.readState().version, daemon.VERSION);
    await daemon.stop();
  } finally {
    cleanupEnv();
    await cleanup(home, null);
  }
});

test('upgrade: a pre-1.2.3 daemon (legacy pid file, no version) is migrated', async () => {
  const home = freshHome();
  const { daemon, state } = load(home);
  try {
    const old = await daemon.start();
    assert.equal(old.running, true);
    // Recreate the pre-1.2.3 world: only ~/.lakon/proxy.pid, no stamp, and the
    // rc pointing at a bare export.
    fs.unlinkSync(state.stateFile());
    fs.writeFileSync(state.legacyPidFile(), String(old.pid));
    state.removeEnvScript();

    const s = await daemon.status();
    assert.equal(s.legacy, true);
    assert.equal(s.version, null);

    const migrated = await daemon.start();
    assert.equal(migrated.running, true);
    assert.notEqual(migrated.pid, old.pid, 'the legacy daemon must be replaced');
    assert.equal(fs.existsSync(state.legacyPidFile()), false, 'legacy pid file must be cleaned up');
    // And the shell snippet the migrated rc line reads must now exist.
    assert.ok(fs.readFileSync(state.envFile(), 'utf8').includes(`__lakon_port=${migrated.port}`));
    await daemon.stop();
  } finally {
    cleanupEnv();
    await cleanup(home, null);
  }
});

test('start: adopting a current daemon still (re)publishes the env script', async () => {
  const home = freshHome();
  const { daemon, state } = load(home);
  try {
    const first = await daemon.start();
    assert.equal(first.running, true);
    // The rc sources this file; if it goes missing the shell silently loses the
    // proxy even though the daemon is healthy.
    state.removeEnvScript();

    const again = await daemon.start();
    assert.equal(again.alreadyRunning, true);
    assert.equal(again.pid, first.pid);
    assert.ok(fs.existsSync(state.envFile()), 'env script must be restored');
    await daemon.stop();
  } finally {
    cleanupEnv();
    await cleanup(home, null);
  }
});
