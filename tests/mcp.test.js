'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const shrink = require('../src/mcp-shrink');
const mcp = require('../src/install/mcp');

// --- mcp-shrink (description compression) ---------------------------------

test('shrink drops filler/lead, keeps code/URLs/identifiers', () => {
  const out = shrink.shrink('This tool is used to please read the `config.json` at https://x.io/d and call getUserById');
  assert.match(out, /`config\.json`/);
  assert.match(out, /https:\/\/x\.io\/d/);
  assert.match(out, /getUserById/);
  assert.doesNotMatch(out, /\bplease\b/i);
  assert.doesNotMatch(out, /this tool is used to/i);
});

test('shrink no-op on non-strings', () => {
  assert.equal(shrink.shrink(''), '');
  assert.equal(shrink.shrink(undefined), undefined);
});

test('shrinkMessage rewrites list descriptions, leaves results/names', () => {
  const msg = {
    result: {
      tools: [{ name: 'r', description: 'Use this tool to read a file.' }, { name: 'noDesc' }, 'junk'],
      prompts: [{ name: 'p', description: 'Just a prompt.' }],
      resources: [{ uri: 'x', description: 'A really long resource.' }],
    },
  };
  const out = shrink.shrinkMessage(msg, ['description']);
  assert.doesNotMatch(out.result.tools[0].description, /use this tool to/i);
  assert.equal(out.result.tools[0].name, 'r');
  const callResult = { result: { content: [{ text: 'the real output' }] } };
  assert.deepEqual(shrink.shrinkMessage(callResult, ['description']), callResult);
  assert.equal(shrink.shrinkMessage(null, ['description']), null);
  const bad = { result: { tools: [null] } };
  assert.deepEqual(shrink.shrinkMessage(bad, ['description']), bad);
});

test('transformLine passes through blank/malformed; shrinks valid lines', () => {
  assert.equal(shrink.transformLine('not json', ['description']), 'not json');
  assert.equal(shrink.transformLine('  ', ['description']), '  ');
  const line = JSON.stringify({ result: { tools: [{ name: 't', description: 'Please do the thing.' }] } });
  assert.doesNotMatch(JSON.parse(shrink.transformLine(line, ['description'])).result.tools[0].description, /\bplease\b/i);
});

test('fields: default + env override', () => {
  const prev = process.env.LAKONAI_SHRINK_FIELDS;
  delete process.env.LAKONAI_SHRINK_FIELDS;
  assert.deepEqual(shrink.fields(), ['description']);
  process.env.LAKONAI_SHRINK_FIELDS = 'description, title ,';
  assert.deepEqual(shrink.fields(), ['description', 'title']);
  if (prev !== undefined) process.env.LAKONAI_SHRINK_FIELDS = prev;
  else delete process.env.LAKONAI_SHRINK_FIELDS;
});

// --- install/mcp (auto-wrap config) --------------------------------------

test('wrapServers/unwrapServers round-trip, skip url servers + idempotent', () => {
  const config = {
    mcpServers: {
      fs: { command: 'npx', args: ['@mcp/fs', '/p'] },
      api: { type: 'sse', url: 'https://x' }, // not stdio -> skip
    },
    projects: { '/repo': { mcpServers: { db: { command: 'psql-mcp' } } } },
  };
  assert.equal(mcp.wrapServers(config), 2); // fs + db
  assert.deepEqual(config.mcpServers.fs.args, ['__mcp', 'npx', '@mcp/fs', '/p']);
  assert.equal(config.mcpServers.fs.command, 'lakonai');
  assert.equal(config.mcpServers.fs._lakonai, true);
  assert.equal(config.mcpServers.api.command, undefined); // url server untouched
  assert.equal(mcp.wrapServers(config), 0); // idempotent

  assert.equal(mcp.unwrapServers(config), 2);
  assert.equal(config.mcpServers.fs.command, 'npx');
  assert.deepEqual(config.mcpServers.fs.args, ['@mcp/fs', '/p']);
  assert.equal(config.mcpServers.fs._lakonai, undefined);
  assert.equal(config.projects['/repo'].mcpServers.db.command, 'psql-mcp');
});

test('collectServerMaps handles non-objects safely', () => {
  assert.deepEqual(mcp.collectServerMaps(null, []), []);
  assert.deepEqual(mcp.collectServerMaps({ a: 1, b: 'x' }, []), []);
});

test('wrap/unwrap tolerate junk server entries and wrapped-without-args', () => {
  const config = { mcpServers: { junk: 'not-an-object', ok: { command: 'c' } } };
  assert.equal(mcp.wrapServers(config), 1); // only the object stdio server
  // a previously-wrapped server that somehow lost its args
  const w = { mcpServers: { x: { command: 'lakonai', _lakonai: true } } };
  assert.equal(mcp.unwrapServers(w), 1);
  assert.deepEqual(w.mcpServers.x.args, []);
});

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lakon-mcp-'));
  const prevHome = process.env.LAKON_HOME;
  const prevNo = process.env.LAKON_NO_MCP;
  process.env.LAKON_HOME = home; // backup dir
  delete process.env.LAKON_NO_MCP;
  try {
    return fn(home);
  } finally {
    if (prevHome !== undefined) process.env.LAKON_HOME = prevHome;
    if (prevNo !== undefined) process.env.LAKON_NO_MCP = prevNo;
  }
}

// wrapMcp/unwrapMcp return { count, skipped, reason } and refuse to write while
// a Claude Code session is live — these tests force past that guard on purpose;
// tests/mcp-session-safety.test.js covers the guard itself.
test('wrapMcp/unwrapMcp edit ~/.claude.json (backed up) and reverse', () => {
  withHome((home) => {
    const cfg = path.join(home, '.claude.json');
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['s'] } } }));
    assert.equal(mcp.wrapMcp(home, { force: true }).count, 1);
    let data = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    assert.equal(data.mcpServers.fs.command, 'lakonai');
    assert.equal(mcp.unwrapMcp(home, { force: true }).count, 1);
    data = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    assert.equal(data.mcpServers.fs.command, 'npx');
  });
});

test('wrapMcp: no-op when config missing, no servers, or opted out', () => {
  withHome((home) => {
    assert.equal(mcp.wrapMcp(home, { force: true }).count, 0); // no ~/.claude.json
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ other: 1 }));
    assert.equal(mcp.wrapMcp(home, { force: true }).count, 0); // no mcpServers
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { x: { command: 'c' } } }));
    process.env.LAKON_NO_MCP = '1';
    const optedOut = mcp.wrapMcp(home, { force: true });
    assert.equal(optedOut.count, 0); // opted out
    assert.equal(optedOut.reason, 'LAKON_NO_MCP=1');
    delete process.env.LAKON_NO_MCP;
  });
});
