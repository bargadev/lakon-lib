'use strict';

// Picking up an upgrade that npm only half-applied.
//
// `npm i -g lakonai` swaps files on disk and stops there: no postinstall, and
// the daemon already running keeps serving the code it was started with. The
// user ends up with a new CLI and an old proxy, which is how a shipped fix
// fails to reach the sessions it was written for. SessionStart is the trigger
// that closes the gap, and these tests pin the three things it must get right:
// only act on a real mismatch, never let a proxy problem break a session, and
// tell the user plainly what was replaced.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const refresh = require('../src/proxy/refresh');
const daemon = require('../src/proxy/daemon');
const state = require('../src/proxy/state');

const VERSION = require('../package.json').version;

// ---------------------------------------------------------------- unit layer

describe('refreshStaleDaemon', () => {
  test('does nothing when no daemon is running', async () => {
    let started = false;
    const res = await refresh.refreshStaleDaemon({
      status: async () => ({ running: false, version: null, port: 7474 }),
      start: async () => { started = true; return { running: true }; },
    });
    assert.equal(res, null);
    assert.equal(started, false, 'starting a proxy is not this hook’s job');
  });

  test('does nothing when the running daemon is already current', async () => {
    let started = false;
    const res = await refresh.refreshStaleDaemon({
      status: async () => ({ running: true, version: '9.9.9', port: 7474 }),
      start: async () => { started = true; return { running: true }; },
      version: '9.9.9',
    });
    assert.equal(res, null);
    assert.equal(started, false);
  });

  test('replaces a daemon left behind by an upgrade', async () => {
    let started = 0;
    const res = await refresh.refreshStaleDaemon({
      status: async () => ({ running: true, version: '1.2.5', port: 7474 }),
      start: async () => { started += 1; return { running: true, port: 7474, replaced: 'exited' }; },
      version: '1.2.6',
    });
    assert.equal(started, 1);
    assert.equal(res.refreshed, true);
    assert.equal(res.from, '1.2.5');
    assert.equal(res.to, '1.2.6');
    assert.equal(res.port, 7474);
    assert.equal(res.movedPort, null);
    assert.equal(res.replaced, 'exited');
  });

  test('an unstamped daemon counts as stale', async () => {
    // Pre-1.2.3 daemons wrote no version. daemon.start() treats that as a
    // mismatch; this must agree with it or those daemons live forever.
    const res = await refresh.refreshStaleDaemon({
      status: async () => ({ running: true, version: null, port: 7474 }),
      start: async () => ({ running: true, port: 7474 }),
      version: '1.2.6',
    });
    assert.equal(res.refreshed, true);
    assert.equal(res.from, null);
  });

  test('reports the port the old daemon would not give up', async () => {
    const res = await refresh.refreshStaleDaemon({
      status: async () => ({ running: true, version: '1.2.5', port: 7474 }),
      start: async () => ({ running: true, port: 53210, replaced: 'left-running' }),
      version: '1.2.6',
    });
    assert.equal(res.movedPort, 7474, 'the caller has to be told the canonical port moved');
    assert.equal(res.port, 53210);
  });

  test('a start that fails is reported, not thrown', async () => {
    const res = await refresh.refreshStaleDaemon({
      status: async () => ({ running: true, version: '1.2.5', port: 7474 }),
      start: async () => ({ running: false, error: 'did not come up within 6000ms' }),
      version: '1.2.6',
    });
    assert.equal(res.refreshed, false);
    assert.match(res.error, /did not come up/);
  });

  test('a start that throws is reported, not thrown', async () => {
    const res = await refresh.refreshStaleDaemon({
      status: async () => ({ running: true, version: '1.2.5', port: 7474 }),
      start: async () => { throw new Error('spawn EACCES'); },
      version: '1.2.6',
    });
    assert.equal(res.refreshed, false);
    assert.equal(res.error, 'spawn EACCES');
  });

  test('a start that resolves to nothing is still reported', async () => {
    const res = await refresh.refreshStaleDaemon({
      status: async () => ({ running: true, version: '1.2.5', port: 7474 }),
      start: async () => undefined,
      version: '1.2.6',
    });
    assert.equal(res.refreshed, false);
    assert.match(res.error, /did not come back up/);
  });

  test('a status probe that throws never reaches the session', async () => {
    const res = await refresh.refreshStaleDaemon({
      status: async () => { throw new Error('state unreadable'); },
      start: async () => ({ running: true }),
    });
    assert.equal(res, null);
  });

  test('a status probe that returns nothing is treated as no daemon', async () => {
    const res = await refresh.refreshStaleDaemon({ status: async () => null, start: async () => ({ running: true }) });
    assert.equal(res, null);
  });

  test('defaults to the real daemon module and this package version', () => {
    assert.equal(refresh.VERSION, VERSION);
  });
});

describe('formatRefreshNotice', () => {
  test('says nothing when there was nothing to do', () => {
    assert.equal(refresh.formatRefreshNotice(null), null);
  });

  test('names both versions and the port now serving', () => {
    const msg = refresh.formatRefreshNotice({ refreshed: true, from: '1.2.5', to: '1.2.6', port: 7474, movedPort: null });
    assert.match(msg, /1\.2\.5/);
    assert.match(msg, /1\.2\.6/);
    assert.match(msg, /127\.0\.0\.1:7474/);
    assert.doesNotMatch(msg, /draining/);
  });

  test('explains a port move instead of leaving it a mystery', () => {
    const msg = refresh.formatRefreshNotice({ refreshed: true, from: '1.2.5', to: '1.2.6', port: 53210, movedPort: 7474 });
    assert.match(msg, /127\.0\.0\.1:53210/);
    assert.match(msg, /7474/);
    assert.match(msg, /draining/);
  });

  test('describes an unstamped predecessor in words, not as null', () => {
    const msg = refresh.formatRefreshNotice({ refreshed: true, from: null, to: '1.2.6', port: 7474, movedPort: null });
    assert.match(msg, /unstamped build/);
    assert.doesNotMatch(msg, /null/);
  });

  test('a failure tells the user the command that fixes it', () => {
    const msg = refresh.formatRefreshNotice({ refreshed: false, from: '1.2.5', to: '1.2.6', error: 'boom' });
    assert.match(msg, /boom/);
    assert.match(msg, /lakonai proxy restart/);
  });
});

// --------------------------------------------------------- integration layer

// A stand-in for the old daemon: a real process, really listening, recorded in
// a real state file. status() demands both halves, so nothing less will do.
function freePort() {
  const s = spawnSync(process.execPath, ['-e', `
    const net = require('net');
    const srv = net.createServer(() => {});
    srv.listen(0, '127.0.0.1', () => { process.stdout.write(String(srv.address().port)); srv.close(); });
  `], { encoding: 'utf8' });
  return Number(s.stdout.trim());
}

const strays = [];

function oldDaemonOn(port) {
  const child = spawn(process.execPath, ['-e', `
    const net = require('net');
    net.createServer(() => {}).listen(${port}, '127.0.0.1');
    setTimeout(() => {}, 60000);
  `], { stdio: 'ignore' });
  strays.push(child);
  return child;
}

// status() is satisfied only by a pid that is alive AND a port that answers.
// Waiting on the pid alone races the bind and reads as "no daemon running".
async function daemonUp(child, port) {
  return waitFor(async () => daemon.isRunning(child.pid) && (await state.probePort(port)));
}

afterEach(() => {
  while (strays.length) {
    const child = strays.pop();
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

async function waitFor(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('refreshStaleDaemon against the real daemon', () => {
  let home;
  let savedHome;
  let savedPort;

  beforeEach(() => {
    savedHome = process.env.LAKON_HOME;
    savedPort = process.env.LAKON_PROXY_PORT;
    delete process.env.LAKON_PROXY_PORT; // never let a test touch the user's 7474
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lakon-refresh-'));
    process.env.LAKON_HOME = home;
  });

  afterEach(async () => {
    try { await daemon.stop(); } catch { /* nothing to stop */ }
    if (savedHome === undefined) delete process.env.LAKON_HOME; else process.env.LAKON_HOME = savedHome;
    if (savedPort === undefined) delete process.env.LAKON_PROXY_PORT; else process.env.LAKON_PROXY_PORT = savedPort;
  });

  test('an idle stale daemon is replaced on its own port by a current one', async () => {
    const port = freePort();
    const old = oldDaemonOn(port);
    assert.ok(await daemonUp(old, port), 'the stand-in daemon should be up and listening');

    state.writeState({ pid: old.pid, port, startedAt: new Date().toISOString(), version: '1.0.0' });

    const res = await refresh.refreshStaleDaemon();

    assert.ok(res, 'a stale daemon must produce a result');
    assert.equal(res.refreshed, true, res.error || '');
    assert.equal(res.from, '1.0.0');
    assert.equal(res.to, VERSION);

    // The state on disk is the contract the shell and the next session read.
    const after = state.readState();
    assert.equal(after.version, VERSION, 'the new daemon must stamp itself');
    assert.notEqual(after.pid, old.pid, 'a new process must be serving');
    // Regression: the replacement used to re-read the port after clearState()
    // and land on DEFAULT_PORT, stranding every session pinned to the old one.
    assert.equal(after.port, port, 'the replacement must keep the port sessions are pinned to');

    const live = await daemon.status();
    assert.equal(live.running, true);

  }, 30000);

  test('a current daemon is left alone, pid and all', async () => {
    const port = freePort();
    const old = oldDaemonOn(port);
    assert.ok(await daemonUp(old, port));
    state.writeState({ pid: old.pid, port, startedAt: new Date().toISOString(), version: VERSION });

    const res = await refresh.refreshStaleDaemon();

    assert.equal(res, null, 'no mismatch, no restart');
    assert.equal(state.readState().pid, old.pid, 'the running daemon must be untouched');

  }, 30000);
});

// ------------------------------------------------------------------ e2e layer

describe('the SessionStart hook end to end', () => {
  const hook = path.join(__dirname, '..', 'src', 'hooks', 'session-start.js');

  function runHook(env) {
    return spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ hook_event_name: 'SessionStart' }),
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        LAKON_NO_UPDATE_CHECK: '1',
        LAKON_NO_AUTO_GRAPH: '1',
        ...env,
      },
    });
  }

  test('reports the replacement in the context it hands the session', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lakon-refresh-e2e-'));
    const port = freePort();
    const old = oldDaemonOn(port);
    assert.ok(await daemonUp(old, port));
    fs.writeFileSync(
      path.join(home, 'proxy.json'),
      JSON.stringify({ pid: old.pid, port, startedAt: new Date().toISOString(), version: '1.0.0' }),
    );

    const run = runHook({ LAKON_HOME: home, LAKON_PROXY_PORT: '' });

    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /lakonai proxy: replaced the 1\.0\.0 daemon/);
    assert.match(ctx, new RegExp(VERSION.replace(/\./g, '\\.')));

    // Clean up the daemon the hook really started.
    const savedHome = process.env.LAKON_HOME;
    process.env.LAKON_HOME = home;
    try { await daemon.stop(); } catch { /* already down */ }
    if (savedHome === undefined) delete process.env.LAKON_HOME; else process.env.LAKON_HOME = savedHome;
  }, 60000);

  test('LAKON_NO_PROXY_REFRESH keeps the hook out of the proxy entirely', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lakon-refresh-off-'));
    const port = freePort();
    const old = oldDaemonOn(port);
    assert.ok(await daemonUp(old, port));
    fs.writeFileSync(
      path.join(home, 'proxy.json'),
      JSON.stringify({ pid: old.pid, port, startedAt: new Date().toISOString(), version: '1.0.0' }),
    );

    const run = runHook({ LAKON_HOME: home, LAKON_NO_PROXY_REFRESH: '1' });

    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout || '', /lakonai proxy: replaced/);
    const after = JSON.parse(fs.readFileSync(path.join(home, 'proxy.json'), 'utf8'));
    assert.equal(after.pid, old.pid, 'the opt-out must leave the daemon running');

  }, 30000);
});
