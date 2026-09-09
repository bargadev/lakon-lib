'use strict';

// Unit tests for the proxy supervisor: rc wiring (pure FS) and the status logic
// that must never call the proxy healthy on a PID alone. The real spawn/stop
// lifecycle lives in tests/proxy-lifecycle.test.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lakon-daemon-'));
}

function freshDaemon(home) {
  delete require.cache[require.resolve('../src/proxy/daemon')];
  delete require.cache[require.resolve('../src/proxy/state')];
  process.env.LAKON_HOME = home;
  return require('../src/proxy/daemon');
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

// ── envLine / installEnv / uninstallEnv ───────────────────────────────────────

test('envLine: sources the generated script, never exports directly', () => {
  const home = freshHome();
  const d = freshDaemon(home);
  const line = d.envLine();
  assert.ok(line.includes('proxy-env.sh'));
  assert.ok(line.includes('# lakonai proxy'));
  // The pre-1.2.3 unconditional export is what broke fresh installs.
  assert.ok(!line.includes('export ANTHROPIC_BASE_URL'));
  cleanup(home);
});

test('installEnv: appends the source line to an rc file', () => {
  const home = freshHome();
  const d = freshDaemon(home);
  const rc = path.join(home, '.zshrc');
  fs.writeFileSync(rc, '# existing content\n');
  assert.equal(d.installEnv(rc), true);
  const content = fs.readFileSync(rc, 'utf8');
  assert.ok(content.includes('# existing content'));
  assert.ok(content.includes('# lakonai proxy'));
  cleanup(home);
});

test('installEnv: idempotent — second call is a no-op', () => {
  const home = freshHome();
  const d = freshDaemon(home);
  const rc = path.join(home, '.zshrc');
  fs.writeFileSync(rc, '');
  d.installEnv(rc);
  assert.equal(d.installEnv(rc), false);
  const content = fs.readFileSync(rc, 'utf8');
  assert.equal((content.match(/# lakonai proxy/g) || []).length, 1);
  cleanup(home);
});

test('installEnv: migrates the old unconditional export line', () => {
  const home = freshHome();
  const d = freshDaemon(home);
  const rc = path.join(home, '.zshrc');
  fs.writeFileSync(rc, '# top\nexport ANTHROPIC_BASE_URL=http://127.0.0.1:7474  # lakonai proxy\n# bottom\n');
  assert.equal(d.installEnv(rc), true);
  const content = fs.readFileSync(rc, 'utf8');
  assert.ok(!content.includes('export ANTHROPIC_BASE_URL'), 'legacy export must be gone');
  assert.equal((content.match(/# lakonai proxy/g) || []).length, 1);
  assert.ok(content.includes('# top') && content.includes('# bottom'));
  cleanup(home);
});

test('installEnv: works on a non-existent file', () => {
  const home = freshHome();
  const d = freshDaemon(home);
  const rc = path.join(home, '.bashrc');
  assert.equal(d.installEnv(rc), true);
  assert.ok(fs.readFileSync(rc, 'utf8').startsWith('if [ -r '));
  cleanup(home);
});

test('installEnv: returns false when the rc is not writable', () => {
  const home = freshHome();
  const d = freshDaemon(home);
  const rc = path.join(home, 'nested-dir-that-is-a-file', '.zshrc');
  fs.writeFileSync(path.join(home, 'nested-dir-that-is-a-file'), 'x');
  assert.equal(d.installEnv(rc), false);
  cleanup(home);
});

test('uninstallEnv: removes the lakonai line, keeps the rest', () => {
  const home = freshHome();
  const d = freshDaemon(home);
  const rc = path.join(home, '.zshrc');
  fs.writeFileSync(rc, '# stuff\nexport ANTHROPIC_BASE_URL=http://127.0.0.1:7474  # lakonai proxy\n# more\n');
  assert.equal(d.uninstallEnv(rc), true);
  const content = fs.readFileSync(rc, 'utf8');
  assert.ok(!content.includes('ANTHROPIC_BASE_URL'));
  assert.ok(content.includes('# stuff') && content.includes('# more'));
  cleanup(home);
});

test('uninstallEnv: false when the line is absent or the file is missing', () => {
  const home = freshHome();
  const d = freshDaemon(home);
  const rc = path.join(home, '.zshrc');
  fs.writeFileSync(rc, '# no proxy here\n');
  assert.equal(d.uninstallEnv(rc), false);
  assert.equal(d.uninstallEnv(path.join(home, '.nonexistent')), false);
  cleanup(home);
});

test('uninstallEnv: returns false when the file cannot be read', () => {
  const home = freshHome();
  const d = freshDaemon(home);
  const dir = path.join(home, 'a-directory');
  fs.mkdirSync(dir);
  assert.equal(d.uninstallEnv(dir), false); // reading a directory throws
  cleanup(home);
});

test('rcFiles: only existing files, under the resolved home', () => {
  const home = freshHome();
  const origHome = process.env.HOME;
  process.env.HOME = home;
  const d = freshDaemon(home);
  fs.writeFileSync(path.join(home, '.zshrc'), '');
  const files = d.rcFiles();
  assert.deepEqual(files, [path.join(home, '.zshrc')]);
  process.env.HOME = origHome;
  cleanup(home);
});

// ── status ───────────────────────────────────────────────────────────────────

test('status: not running when there is no state', async () => {
  const home = freshHome();
  const d = freshDaemon(home);
  const s = await d.status();
  assert.equal(s.running, false);
  assert.equal(s.pid, null);
  assert.equal(s.stale, false);
  assert.equal(s.port, d.DEFAULT_PORT);
  cleanup(home);
});

test('status: a live pid that is NOT listening reads as stale, not running', async () => {
  const home = freshHome();
  const d = freshDaemon(home);
  const state = require('../src/proxy/state');
  // Our own pid is certainly alive; port 1 is certainly not ours.
  state.writeState({ pid: process.pid, port: 1 });
  const s = await d.status();
  assert.equal(s.running, false, 'a recycled/alive pid must not imply a serving proxy');
  assert.equal(s.listening, false);
  assert.equal(s.stale, true);
  cleanup(home);
});

test('status: running when the pid is alive and the port answers', async () => {
  const home = freshHome();
  const d = freshDaemon(home);
  const state = require('../src/proxy/state');
  const srv = await listenOnce();
  state.writeState({ pid: process.pid, port: srv.port });
  const s = await d.status();
  assert.equal(s.running, true);
  assert.equal(s.listening, true);
  assert.equal(s.pid, process.pid);
  await srv.close();
  cleanup(home);
});

test('status: dead pid reports no pid and stale state', async () => {
  const home = freshHome();
  const d = freshDaemon(home);
  const state = require('../src/proxy/state');
  state.writeState({ pid: 999999999, port: 1 });
  const s = await d.status();
  assert.equal(s.running, false);
  assert.equal(s.pid, null);
  assert.equal(s.stale, true);
  cleanup(home);
});

test('preferredPort: override wins, then last-bound port, then default', () => {
  const home = freshHome();
  const d = freshDaemon(home);
  const state = require('../src/proxy/state');
  assert.equal(d.preferredPort(), d.DEFAULT_PORT);
  state.writeState({ pid: 1, port: 43210 });
  assert.equal(d.preferredPort(), 43210);
  process.env.LAKON_PROXY_PORT = '44444';
  assert.equal(d.preferredPort(), 44444);
  delete process.env.LAKON_PROXY_PORT;
  cleanup(home);
});

// ── stop / unwire without a live daemon ──────────────────────────────────────

test('stop: false and state cleaned when nothing is running', async () => {
  const home = freshHome();
  const d = freshDaemon(home);
  const state = require('../src/proxy/state');
  state.writeState({ pid: 999999999, port: 1 });
  state.writeEnvScript(1);
  assert.equal(await d.stop(), false);
  assert.equal(fs.existsSync(state.stateFile()), false);
  assert.equal(fs.existsSync(state.envFile()), false);
  cleanup(home);
});

test('unwire: strips rc lines and reports nothing was running', async () => {
  const home = freshHome();
  const origHome = process.env.HOME;
  process.env.HOME = home;
  const d = freshDaemon(home);
  const rc = path.join(home, '.zshrc');
  fs.writeFileSync(rc, '# keep me\n');
  d.installEnv(rc);
  const { touched, stopped } = await d.unwire();
  assert.deepEqual(touched, [rc]);
  assert.equal(stopped, false);
  const content = fs.readFileSync(rc, 'utf8');
  assert.ok(content.includes('# keep me'));
  assert.ok(!content.includes('# lakonai proxy'));
  process.env.HOME = origHome;
  cleanup(home);
});

test('start: reports the failure instead of claiming success when it cannot spawn', async () => {
  const home = freshHome();
  const d = freshDaemon(home);
  const origExec = process.execPath;
  // Point the supervisor at a binary that does not exist: spawn emits 'error'.
  Object.defineProperty(process, 'execPath', { value: path.join(home, 'no-such-node'), configurable: true });
  const res = await d.start();
  Object.defineProperty(process, 'execPath', { value: origExec, configurable: true });
  assert.equal(res.running, false);
  assert.match(res.error, /could not spawn|did not come up/);
  cleanup(home);
});

test('stop: refuses to signal a pid that is not our proxy (PID recycling)', async () => {
  const home = freshHome();
  const d = freshDaemon(home);
  const state = require('../src/proxy/state');
  // This very test process: alive, but it is not the proxy and serves no port.
  // Surviving the call IS the assertion — the old code would have SIGTERMed it.
  state.writeState({ pid: process.pid, port: 1 });
  assert.equal(await d.stop(), false);
  assert.equal(fs.existsSync(state.stateFile()), false);
  cleanup(home);
});

test('ownsProxy: listening port is proof enough; a foreign pid is not', () => {
  const home = freshHome();
  const d = freshDaemon(home);
  assert.equal(d.ownsProxy(process.pid, 1, { listening: true }), true);
  assert.equal(d.ownsProxy(process.pid, 1, { listening: false }), false);
  cleanup(home);
});

test('stop: no state file at all is a clean no-op', async () => {
  const home = freshHome();
  const d = freshDaemon(home);
  assert.equal(await d.stop(), false);
  cleanup(home);
});

test('ownsProxy: a dead pid is not ours (ps reports nothing)', () => {
  const home = freshHome();
  const d = freshDaemon(home);
  assert.equal(d.ownsProxy(999999999, 1, { listening: false }), false);
  cleanup(home);
});
