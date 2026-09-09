'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer, readStats, writeStats, mergeStats } = require('../src/proxy/server');

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lakon-proxy-'));
}

function withHome(home, fn) {
  const orig = process.env.LAKON_HOME;
  process.env.LAKON_HOME = home;
  try { return fn(); } finally {
    if (orig === undefined) delete process.env.LAKON_HOME;
    else process.env.LAKON_HOME = orig;
  }
}

// Start a fake upstream (plain HTTP) + proxy pointing at it.
function startPair(upstreamHandler) {
  return new Promise((resolve, reject) => {
    const upstream = http.createServer(upstreamHandler);
    upstream.listen(0, '127.0.0.1', () => {
      const upstreamPort = upstream.address().port;
      const proxy = createServer(0, { host: '127.0.0.1', port: upstreamPort, protocol: 'http' });
      proxy.listen(0, '127.0.0.1', () => {
        resolve({
          proxyPort: proxy.address().port,
          close: (cb) => { proxy.close(() => upstream.close(cb)); },
        });
      });
      proxy.on('error', reject);
    });
    upstream.on('error', reject);
  });
}

function post(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── stats helpers ─────────────────────────────────────────────────────────────

test('readStats: returns default when no file', () => {
  const home = freshHome();
  withHome(home, () => {
    const s = readStats();
    assert.equal(s.rawTokens, 0);
    assert.equal(s.requests, 0);
  });
});

test('writeStats + readStats roundtrip', () => {
  const home = freshHome();
  withHome(home, () => {
    writeStats({ rawTokens: 100, outTokens: 60, requests: 1, byType: { log: { raw: 100, out: 60, count: 1 } } });
    const s = readStats();
    assert.equal(s.rawTokens, 100);
    assert.equal(s.byType.log.count, 1);
  });
});

test('mergeStats: accumulates correctly', () => {
  const existing = { rawTokens: 100, outTokens: 60, requests: 1, byType: { log: { raw: 100, out: 60, count: 1 } } };
  const delta = { rawTokens: 50, outTokens: 30, byType: { log: { raw: 50, out: 30, count: 1 }, code: { raw: 0, out: 0, count: 0 } } };
  mergeStats(existing, delta);
  assert.equal(existing.rawTokens, 150);
  assert.equal(existing.requests, 2);
  assert.equal(existing.byType.log.count, 2);
  assert.ok('code' in existing.byType);
});

// ── proxy: request forwarding ─────────────────────────────────────────────────

test('Integration: proxy forwards non-messages request unchanged', (done) => {
  const home = freshHome();
  let receivedBody = null;

  startPair((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      receivedBody = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  }).then(({ proxyPort, close }) => {
    withHome(home, () => {
      post(proxyPort, '/v1/other', { foo: 'bar' }).then((result) => {
        assert.equal(result.status, 200);
        assert.ok(result.body.includes('ok'));
        assert.ok(receivedBody.includes('foo'));
        close(done);
      }).catch(done);
    });
  }).catch(done);
});

test('Integration: proxy compresses /v1/messages tool_result', (done) => {
  const home = freshHome();
  let upstreamBody = null;

  const logOutput = Array(200).fill('INFO: polling').concat(['ERROR: db timeout']).join('\n');
  const requestBody = {
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: logOutput }] }],
  };

  startPair((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      upstreamBody = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"msg_test","type":"message"}');
    });
  }).then(({ proxyPort, close }) => {
    withHome(home, () => {
      post(proxyPort, '/v1/messages', requestBody).then((result) => {
        assert.equal(result.status, 200);
        const sent = JSON.parse(upstreamBody);
        const sentContent = sent.messages[0].content[0].content;
        assert.ok(sentContent.length < logOutput.length, 'compressed content must be shorter');
        assert.ok(sentContent.includes('ERROR: db timeout'), 'ERROR line must survive');
        const stats = readStats();
        assert.ok(stats.rawTokens > 0, 'stats must be written');
        assert.ok(stats.outTokens <= stats.rawTokens);
        close(done);
      }).catch(done);
    });
  }).catch(done);
});

test('Integration: proxy passes through malformed JSON body unchanged', (done) => {
  const home = freshHome();
  let upstreamCalled = false;

  startPair((req, res) => {
    upstreamCalled = true;
    req.resume();
    req.on('end', () => { res.writeHead(200); res.end('ok'); });
  }).then(({ proxyPort, close }) => {
    withHome(home, () => {
      post(proxyPort, '/v1/messages', 'not json at all').then(() => {
        assert.ok(upstreamCalled, 'upstream must be called even with bad JSON');
        close(done);
      }).catch(done);
    });
  }).catch(done);
});

test('Integration: proxy compresses system prompt', (done) => {
  const home = freshHome();
  let upstreamBody = null;

  const longSystem = Array(200).fill('INFO: system instruction line').join('\n');
  const requestBody = { model: 'claude-sonnet-4-5', system: longSystem, messages: [] };

  startPair((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      upstreamBody = Buffer.concat(chunks).toString();
      res.writeHead(200);
      res.end('{}');
    });
  }).then(({ proxyPort, close }) => {
    withHome(home, () => {
      post(proxyPort, '/v1/messages', requestBody).then(() => {
        const sent = JSON.parse(upstreamBody);
        assert.ok(sent.system.length < longSystem.length, 'system prompt must be compressed');
        close(done);
      }).catch(done);
    });
  }).catch(done);
});

// ── bindServer ───────────────────────────────────────────────────────────────

test('bindServer: binds the requested port when it is free', async () => {
  const { bindServer } = require('../src/proxy/server');
  const http = require('node:http');
  const probe = http.createServer(() => {});
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const free = probe.address().port;
  await new Promise((r) => probe.close(r));

  const server = require('../src/proxy/server').createServer(free);
  const bound = await bindServer(server, free);
  assert.equal(bound, free);
  await new Promise((r) => server.close(r));
});

test('bindServer: falls back to a free port when the requested one is taken', async () => {
  const { createServer, bindServer } = require('../src/proxy/server');
  const squatter = require('node:http').createServer(() => {});
  await new Promise((r) => squatter.listen(0, '127.0.0.1', r));
  const taken = squatter.address().port;

  const server = createServer(taken);
  const bound = await bindServer(server, taken);
  assert.notEqual(bound, taken);
  assert.ok(bound > 0);

  await new Promise((r) => server.close(r));
  await new Promise((r) => squatter.close(r));
});

test('bindServer: rejects instead of falling back when fallback is off', async () => {
  const { createServer, bindServer } = require('../src/proxy/server');
  const squatter = require('node:http').createServer(() => {});
  await new Promise((r) => squatter.listen(0, '127.0.0.1', r));
  const taken = squatter.address().port;

  const server = createServer(taken);
  await assert.rejects(() => bindServer(server, taken, { allowFallback: false }), /EADDRINUSE/);

  await new Promise((r) => squatter.close(r));
});

test('mergeStats: seeds a byType bucket that does not exist yet', () => {
  const home = freshHome();
  withHome(home, () => {
    const existing = { rawTokens: 0, outTokens: 0, requests: 0, byType: {} };
    mergeStats(existing, { rawTokens: 10, outTokens: 4, byType: { diff: { raw: 10, out: 4, count: 1 } } });
    mergeStats(existing, { rawTokens: 5, outTokens: 1, byType: { diff: { raw: 5, out: 1, count: 1 } } });
    assert.equal(existing.requests, 2);
    assert.deepEqual(existing.byType.diff, { raw: 15, out: 5, count: 2 });
    mergeStats(existing, { rawTokens: 1, outTokens: 1 }); // no byType at all
    assert.equal(existing.requests, 3);
  });
});
