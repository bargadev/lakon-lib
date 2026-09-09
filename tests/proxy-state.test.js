'use strict';

// Unit tests for the proxy state module: state file round-trip (including the
// legacy pid-file fallback), the TCP probe, and the generated shell snippet.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lakon-state-'));
}

function freshState(home) {
  delete require.cache[require.resolve('../src/proxy/state')];
  process.env.LAKON_HOME = home;
  return require('../src/proxy/state');
}

function cleanup(home) {
  try { fs.rmSync(home, { recursive: true }); } catch { /* ok */ }
}

function listenOnce() {
  return new Promise((resolve) => {
    const srv = net.createServer(() => {});
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => new Promise((r) => srv.close(r)) }));
  });
}

// ── state file ───────────────────────────────────────────────────────────────

test('readState: null when nothing on disk', () => {
  const home = freshHome();
  const s = freshState(home);
  assert.equal(s.readState(), null);
  cleanup(home);
});

test('writeState/readState: round-trips pid and port', () => {
  const home = freshHome();
  const s = freshState(home);
  assert.equal(s.writeState({ pid: 4242, port: 41474, startedAt: 'now' }), true);
  assert.deepEqual(s.readState(), { pid: 4242, port: 41474, startedAt: 'now', version: null });
  // The stamp the server writes is what tells an upgrade the daemon is stale.
  assert.equal(s.writeState({ pid: 7, port: 8, version: '9.9.9' }), true);
  assert.equal(s.readState().version, '9.9.9');
  cleanup(home);
});

test('readState: ignores a state file missing pid or port', () => {
  const home = freshHome();
  const s = freshState(home);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(s.stateFile(), JSON.stringify({ pid: 1 }));
  assert.equal(s.readState(), null);
  cleanup(home);
});

test('readState: ignores malformed JSON', () => {
  const home = freshHome();
  const s = freshState(home);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(s.stateFile(), 'not json');
  assert.equal(s.readState(), null);
  cleanup(home);
});

test('readState: falls back to the legacy pid file on the legacy port', () => {
  const home = freshHome();
  const s = freshState(home);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(s.legacyPidFile(), '999\n');
  const st = s.readState();
  assert.equal(st.pid, 999);
  assert.equal(st.port, s.LEGACY_PORT);
  assert.equal(st.legacy, true);
  cleanup(home);
});

test('readState: legacy pid file with junk yields null', () => {
  const home = freshHome();
  const s = freshState(home);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(s.legacyPidFile(), 'garbage');
  assert.equal(s.readState(), null);
  cleanup(home);
});

test('clearState: removes both the new and the legacy file', () => {
  const home = freshHome();
  const s = freshState(home);
  fs.mkdirSync(home, { recursive: true });
  s.writeState({ pid: 1, port: 2 });
  fs.writeFileSync(s.legacyPidFile(), '3');
  s.clearState();
  assert.equal(fs.existsSync(s.stateFile()), false);
  assert.equal(fs.existsSync(s.legacyPidFile()), false);
  s.clearState(); // idempotent
  cleanup(home);
});

test('writeState: returns false when the home is not writable', () => {
  const home = freshHome();
  const s = freshState(home);
  // A file where the directory should be makes mkdirSync throw.
  fs.writeFileSync(home + '-blocked', 'x');
  process.env.LAKON_HOME = home + '-blocked/nested';
  assert.equal(s.writeState({ pid: 1, port: 2 }), false);
  process.env.LAKON_HOME = home;
  try { fs.unlinkSync(home + '-blocked'); } catch { /* ok */ }
  cleanup(home);
});

// ── port probing ─────────────────────────────────────────────────────────────

test('probePort: true for a listening port, false for a dead one', async () => {
  const home = freshHome();
  const s = freshState(home);
  const srv = await listenOnce();
  assert.equal(await s.probePort(srv.port), true);
  await srv.close();
  assert.equal(await s.probePort(srv.port), false);
  cleanup(home);
});

test('waitForPort: resolves true immediately when already in the wanted state', async () => {
  const home = freshHome();
  const s = freshState(home);
  const srv = await listenOnce();
  assert.equal(await s.waitForPort(srv.port, { timeoutMs: 1000 }), true);
  await srv.close();
  assert.equal(await s.waitForPort(srv.port, { timeoutMs: 1000, want: false }), true);
  cleanup(home);
});

test('waitForPort: returns false when the deadline passes', async () => {
  const home = freshHome();
  const s = freshState(home);
  const srv = await listenOnce();
  assert.equal(await s.waitForPort(srv.port, { timeoutMs: 250, want: false, intervalMs: 50 }), false);
  await srv.close();
  cleanup(home);
});

test('isRunning: pid checks', () => {
  const home = freshHome();
  const s = freshState(home);
  assert.equal(s.isRunning(null), false);
  assert.equal(s.isRunning(0), false);
  assert.equal(s.isRunning(999999999), false);
  assert.equal(s.isRunning(process.pid), true);
  cleanup(home);
});

test('sleep: resolves after the delay', async () => {
  const home = freshHome();
  const s = freshState(home);
  const t0 = Date.now();
  await s.sleep(30);
  assert.ok(Date.now() - t0 >= 25);
  cleanup(home);
});

// ── shell snippet ────────────────────────────────────────────────────────────

test('envScript: carries the port and only exports behind a liveness check', () => {
  const home = freshHome();
  const s = freshState(home);
  const script = s.envScript(41474);
  assert.ok(script.includes('__lakon_port=41474'));
  assert.ok(script.includes('export ANTHROPIC_BASE_URL=http://127.0.0.1:$__lakon_port'));
  // The export must be conditional on a live port — that is the whole point.
  assert.ok(script.includes('if __lakon_probe "$__lakon_port"; then'));
  // And it must respect a base URL the user set for another endpoint.
  assert.ok(script.includes('case "$ANTHROPIC_BASE_URL" in'));
  // A dead lakonai URL already in the environment must be cleaned up, including
  // the pre-1.2.3 port.
  assert.ok(script.includes('unset ANTHROPIC_BASE_URL'));
  assert.ok(script.includes('http://127.0.0.1:7474'));
  cleanup(home);
});

test('writeEnvScript/removeEnvScript: create and delete the file', () => {
  const home = freshHome();
  const s = freshState(home);
  assert.equal(s.writeEnvScript(1234), true);
  assert.ok(fs.readFileSync(s.envFile(), 'utf8').includes('__lakon_port=1234'));
  assert.equal(s.removeEnvScript(), true);
  assert.equal(fs.existsSync(s.envFile()), false);
  assert.equal(s.removeEnvScript(), false); // already gone
  cleanup(home);
});

test('writeEnvScript: returns false when the path is unwritable', () => {
  const home = freshHome();
  const s = freshState(home);
  fs.writeFileSync(home + '-file', 'x');
  process.env.LAKON_HOME = home + '-file/nested';
  assert.equal(s.writeEnvScript(1), false);
  process.env.LAKON_HOME = home;
  try { fs.unlinkSync(home + '-file'); } catch { /* ok */ }
  cleanup(home);
});

test('lakonHome: honours LAKON_HOME, else ~/.lakon', () => {
  const home = freshHome();
  const s = freshState(home);
  assert.equal(s.lakonHome(), home);
  delete process.env.LAKON_HOME;
  assert.ok(s.lakonHome().endsWith(path.join('.lakon')));
  process.env.LAKON_HOME = home;
  cleanup(home);
});

test('DEFAULT_PORT is not Neo4j\'s 7474', () => {
  const home = freshHome();
  const s = freshState(home);
  assert.notEqual(s.DEFAULT_PORT, 7474);
  assert.equal(s.LEGACY_PORT, 7474);
  cleanup(home);
});

test('waitForPort: default options are usable (no options object)', async () => {
  const home = freshHome();
  const s = freshState(home);
  const srv = await listenOnce();
  assert.equal(await s.waitForPort(srv.port), true);
  await srv.close();
  cleanup(home);
});
