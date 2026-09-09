'use strict';

// Retiring a daemon instead of killing it.
//
// The regression this file exists for: `lakonai install` run from inside a
// Claude Code session upgraded the proxy by killing the old daemon. That daemon
// was the one serving the session doing the upgrading, so the upgrade dropped
// its own API connection. Replacement therefore has to be graceful — and where
// it cannot be (a daemon too old to know SIGUSR2), the old process is left alive
// until nothing is talking to it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { spawn } = require('node:child_process');

const daemon = require('../src/proxy/daemon');

// A live process we own, standing in for an old daemon. It must be ours: pid 1
// is alive but unsignalable, which isRunning() correctly reports as not running.
function fakeDaemon() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  return {
    pid: child.pid,
    alive: () => { try { process.kill(child.pid, 0); return true; } catch { return false; } },
    kill: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } },
  };
}

// A port with one connection open on it — the shape that means "someone is
// mid-request, do not kill".
async function busyPort() {
  const srv = net.createServer(() => {});
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const client = net.connect(port, '127.0.0.1');
  await new Promise((r) => client.on('connect', r));
  return {
    port,
    close: async () => { client.destroy(); await new Promise((r) => srv.close(r)); },
  };
}

function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lakon-retire-'));
  process.env.LAKON_HOME = home;
  return home;
}

function retiredFile(home) {
  return path.join(home, 'proxy-retired.json');
}

let savedHome;
beforeEach(() => { savedHome = process.env.LAKON_HOME; });
afterEach(() => {
  if (savedHome === undefined) delete process.env.LAKON_HOME;
  else process.env.LAKON_HOME = savedHome;
});

describe('supportsRetire', () => {
  test('a daemon that never stamped a version cannot be trusted with SIGUSR2', () => {
    // Node's default disposition for SIGUSR2 is to terminate — sending it to an
    // older daemon would kill it, which is the thing retirement prevents.
    assert.equal(daemon.supportsRetire(null), false);
    assert.equal(daemon.supportsRetire(undefined), false);
    assert.equal(daemon.supportsRetire(''), false);
  });

  test('a malformed version is treated as too old', () => {
    assert.equal(daemon.supportsRetire('1.2'), false);
    assert.equal(daemon.supportsRetire('nope'), false);
    assert.equal(daemon.supportsRetire('1.x.3'), false);
  });

  test('the cutoff is 1.2.6', () => {
    assert.equal(daemon.supportsRetire('1.2.5'), false);
    assert.equal(daemon.supportsRetire('1.2.6'), true, 'the release that added it');
    assert.equal(daemon.supportsRetire('1.2.7'), true);
    assert.equal(daemon.supportsRetire('1.3.0'), true);
    assert.equal(daemon.supportsRetire('2.0.0'), true);
    assert.equal(daemon.supportsRetire('1.1.9'), false);
    assert.equal(daemon.supportsRetire('0.9.9'), false);
  });
});

describe('hasLiveConnections', () => {
  test('an idle port has none', async () => {
    const srv = net.createServer(() => {});
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    try {
      assert.equal(daemon.hasLiveConnections(port), false);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  test('a port with an open connection reports it, so it is never killed', async () => {
    const srv = net.createServer(() => {});
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const client = net.connect(port, '127.0.0.1');
    await new Promise((r) => client.on('connect', r));
    try {
      assert.equal(daemon.hasLiveConnections(port), true);
    } finally {
      client.destroy();
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('the retired list', () => {
  test('reads as empty when there is no file, and never throws', () => {
    const home = freshHome();
    try {
      assert.deepEqual(daemon.readRetired(), []);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('corrupt or wrongly-shaped content reads as empty', () => {
    const home = freshHome();
    try {
      fs.writeFileSync(retiredFile(home), 'not json');
      assert.deepEqual(daemon.readRetired(), []);

      fs.writeFileSync(retiredFile(home), JSON.stringify({ pid: 1 }));
      assert.deepEqual(daemon.readRetired(), [], 'an object is not a list');

      // Entries missing a pid or a port are useless — drop them.
      fs.writeFileSync(retiredFile(home), JSON.stringify([
        { pid: 111, port: 222 }, { pid: 333 }, { port: 444 }, null,
      ]));
      assert.deepEqual(daemon.readRetired(), [{ pid: 111, port: 222 }]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('retire', () => {
  test('a daemon that is not running is already gone', async () => {
    const home = freshHome();
    try {
      assert.equal(await daemon.retire(null), 'gone');
      assert.equal(await daemon.retire({ pid: 4194303, port: 1, version: '1.2.6' }), 'gone');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('a daemon too old to retire, still in use, is left running and remembered', async () => {
    const home = freshHome();
    const old = fakeDaemon();
    const busy = await busyPort();
    try {
      const how = await daemon.retire({ pid: old.pid, port: busy.port, version: '1.2.5' });
      assert.equal(how, 'left-running');
      assert.equal(old.alive(), true, 'the session mid-request must not be dropped');
      assert.deepEqual(daemon.readRetired(), [{ pid: old.pid, port: busy.port }],
        'remembered so a later run can finish the job');
    } finally {
      old.kill();
      await busy.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('a daemon too old to retire, with nobody connected, is stopped', async () => {
    const home = freshHome();
    const old = fakeDaemon();
    const srv = net.createServer(() => {});
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    await new Promise((r) => srv.close(r));
    try {
      const how = await daemon.retire({ pid: old.pid, port, version: '1.2.5' });
      assert.equal(how, 'stopped');
      assert.deepEqual(daemon.readRetired(), [], 'nothing left to reap later');
    } finally {
      old.kill();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('remembering the same daemon twice does not duplicate it', async () => {
    const home = freshHome();
    const old = fakeDaemon();
    const busy = await busyPort();
    try {
      await daemon.retire({ pid: old.pid, port: busy.port, version: '1.2.5' });
      await daemon.retire({ pid: old.pid, port: busy.port, version: '1.2.5' });
      assert.deepEqual(daemon.readRetired(), [{ pid: old.pid, port: busy.port }]);
    } finally {
      old.kill();
      await busy.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('reapRetired', () => {
  test('a retired daemon that has died is forgotten and its file removed', () => {
    const home = freshHome();
    try {
      fs.writeFileSync(retiredFile(home), JSON.stringify([{ pid: 4194303, port: 65000 }]));
      const res = daemon.reapRetired();
      assert.deepEqual(res.reaped, [4194303]);
      assert.deepEqual(res.kept, []);
      assert.equal(fs.existsSync(retiredFile(home)), false, 'an empty list leaves no file');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('a retired daemon still serving someone is kept for the next run', async () => {
    const home = freshHome();
    const old = fakeDaemon();
    const busy = await busyPort();
    try {
      fs.writeFileSync(retiredFile(home), JSON.stringify([{ pid: old.pid, port: busy.port }]));
      const res = daemon.reapRetired();
      assert.deepEqual(res.kept, [old.pid]);
      assert.deepEqual(res.reaped, []);
      assert.equal(old.alive(), true, 'still in use, so still alive');
      assert.deepEqual(daemon.readRetired(), [{ pid: old.pid, port: busy.port }], 'still on the list');
    } finally {
      old.kill();
      await busy.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('a retired daemon gone idle is finally stopped', async () => {
    const home = freshHome();
    const old = fakeDaemon();
    const srv = net.createServer(() => {});
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    await new Promise((r) => srv.close(r));
    try {
      fs.writeFileSync(retiredFile(home), JSON.stringify([{ pid: old.pid, port }]));
      const res = daemon.reapRetired();
      assert.deepEqual(res.reaped, [old.pid]);
      assert.deepEqual(res.kept, []);
      assert.equal(fs.existsSync(retiredFile(home)), false);
    } finally {
      old.kill();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('nothing retired is a cheap no-op', () => {
    const home = freshHome();
    try {
      assert.deepEqual(daemon.reapRetired(), { reaped: [], kept: [] });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// The graceful path, against a real daemon of the current version: the whole
// point of retirement is that this process stops listening without dropping the
// connections it is already serving.
describe('retire (real daemon, SIGUSR2)', () => {
  const savedTimeout = process.env.LAKON_PROXY_START_TIMEOUT;
  afterEach(() => {
    if (savedTimeout === undefined) delete process.env.LAKON_PROXY_START_TIMEOUT;
    else process.env.LAKON_PROXY_START_TIMEOUT = savedTimeout;
    delete process.env.LAKON_PROXY_PORT;
  });

  test('a current daemon retires and frees its port', async () => {
    const home = freshHome();
    // Bind an ephemeral port so the test never collides with the real proxy.
    const probe = net.createServer(() => {});
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    process.env.LAKON_PROXY_PORT = String(probe.address().port);
    await new Promise((r) => probe.close(r));

    let started;
    try {
      started = await daemon.start();
      assert.equal(started.running, true, `daemon should come up: ${started.error || ''}`);

      const how = await daemon.retire({
        pid: started.pid,
        port: started.port,
        version: daemon.VERSION,
      });
      assert.ok(['exited', 'draining'].includes(how), `graceful retirement, got "${how}"`);

      // Whichever of the two it was, the port is free for the replacement.
      const stillListening = await require('../src/proxy/state').probePort(started.port);
      assert.equal(stillListening, false, 'a retired daemon stops accepting new connections');
    } finally {
      if (started && started.pid) {
        try { process.kill(started.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
