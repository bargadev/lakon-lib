'use strict';

// Deferred work: the queue, and the SessionEnd hook that drains it.
//
// Why this exists: `lakonai install` cannot wrap MCP servers while a Claude Code
// session is live — that means rewriting ~/.claude.json under the session that
// is still writing it, which is how people lost sessions. Refusing is correct,
// but leaving the user a command to remember is not. So the work is queued and
// drained later. The queue must therefore be exactly as durable as that promise:
// a task that still cannot run stays queued, and nothing here may ever throw.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// The queue's contract is "what does it do with what the task returns", so the
// task is the thing worth controlling. `pending` requires ./mcp lazily, inside
// run(), so spying on the module object is enough — and Jest keeps its own
// module registry, so poking require.cache would do nothing here.
const pending = require('../src/install/pending');
const mcp = require('../src/install/mcp');

function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lakon-pending-'));
  process.env.LAKON_HOME = home;
  return home;
}

function stubMcp(impl) {
  const spy = jest.spyOn(mcp, 'wrapMcp').mockImplementation(impl);
  return () => spy.mockRestore();
}

let savedHome;
beforeEach(() => { savedHome = process.env.LAKON_HOME; });
afterEach(() => {
  if (savedHome === undefined) delete process.env.LAKON_HOME;
  else process.env.LAKON_HOME = savedHome;
});

describe('queue', () => {
  test('enqueue writes the task and list names it', () => {
    const home = freshHome();
    try {
      assert.equal(pending.enqueue('mcp-wrap'), true);
      assert.deepEqual(pending.list(), [
        { id: 'mcp-wrap', label: 'wrap MCP servers for catalog compression' },
      ]);
      assert.deepEqual(JSON.parse(fs.readFileSync(pending.queuePath(), 'utf8')), { tasks: ['mcp-wrap'] });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('enqueuing the same task twice is a no-op', () => {
    const home = freshHome();
    try {
      assert.equal(pending.enqueue('mcp-wrap'), true);
      assert.equal(pending.enqueue('mcp-wrap'), false, 'already queued');
      assert.deepEqual(pending.list().map((t) => t.id), ['mcp-wrap']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('an unknown task id is refused, not stored', () => {
    const home = freshHome();
    try {
      assert.equal(pending.enqueue('not-a-task'), false);
      assert.deepEqual(pending.list(), []);
      assert.equal(fs.existsSync(pending.queuePath()), false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('an empty or corrupt queue file reads as empty, never throws', () => {
    const home = freshHome();
    try {
      fs.writeFileSync(pending.queuePath(), 'not json at all');
      assert.deepEqual(pending.list(), []);

      fs.writeFileSync(pending.queuePath(), JSON.stringify({ tasks: 'nope' }));
      assert.deepEqual(pending.list(), []);

      // Ids that no longer exist in this version are dropped on read.
      fs.writeFileSync(pending.queuePath(), JSON.stringify({ tasks: ['mcp-wrap', 'retired-task'] }));
      assert.deepEqual(pending.list().map((t) => t.id), ['mcp-wrap']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('drain', () => {
  test('an empty queue drains to nothing and does no work', () => {
    const home = freshHome();
    const restore = stubMcp(() => { throw new Error('must not run'); });
    try {
      assert.deepEqual(pending.drain(home), { done: [], kept: [] });
    } finally {
      restore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('a task that succeeds is run once and removed from the queue', () => {
    const home = freshHome();
    let calls = 0;
    const restore = stubMcp(() => { calls += 1; return { skipped: false, count: 2 }; });
    try {
      pending.enqueue('mcp-wrap');
      assert.deepEqual(pending.drain(home), { done: ['mcp-wrap'], kept: [] });
      assert.equal(calls, 1);
      assert.equal(fs.existsSync(pending.queuePath()), false, 'an empty queue removes its file');
      // A second drain has nothing left to do.
      assert.deepEqual(pending.drain(home), { done: [], kept: [] });
      assert.equal(calls, 1);
    } finally {
      restore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('a task the guard still refuses stays queued for the next attempt', () => {
    const home = freshHome();
    const restore = stubMcp(() => ({ skipped: true, reason: 'a session is live' }));
    try {
      pending.enqueue('mcp-wrap');
      assert.deepEqual(pending.drain(home), { done: [], kept: ['mcp-wrap'] });
      assert.deepEqual(pending.list().map((t) => t.id), ['mcp-wrap'], 'still queued');
    } finally {
      restore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('nothing to wrap counts as done, not as a permanent retry', () => {
    const home = freshHome();
    const restore = stubMcp(() => ({ skipped: false, count: 0 }));
    try {
      pending.enqueue('mcp-wrap');
      assert.deepEqual(pending.drain(home), { done: ['mcp-wrap'], kept: [] });
    } finally {
      restore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('a queue that cannot be written is reported, not thrown', () => {
    // LAKON_HOME under a regular file: mkdir fails with ENOTDIR, and every path
    // through the queue has to survive that quietly.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lakon-pending-'));
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    process.env.LAKON_HOME = path.join(blocker, 'lakon');
    try {
      let queued;
      assert.doesNotThrow(() => { queued = pending.enqueue('mcp-wrap'); });
      assert.equal(queued, true, 'enqueue still reports the intent');
      assert.deepEqual(pending.list(), [], 'but nothing could be persisted');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a task that throws is kept, and the drain itself never throws', () => {
    const home = freshHome();
    const restore = stubMcp(() => { throw new Error('disk on fire'); });
    try {
      pending.enqueue('mcp-wrap');
      let res;
      assert.doesNotThrow(() => { res = pending.drain(home); });
      assert.deepEqual(res, { done: [], kept: ['mcp-wrap'] });
      assert.deepEqual(pending.list().map((t) => t.id), ['mcp-wrap']);
    } finally {
      restore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('drain defaults to the real home when called with no argument', () => {
    const home = freshHome();
    const seen = [];
    const restore = stubMcp((h) => { seen.push(h); return { skipped: false, count: 1 }; });
    try {
      pending.enqueue('mcp-wrap');
      pending.drain();
      assert.equal(seen.length, 1, 'the task ran');
      assert.equal(typeof seen[0], 'string');
    } finally {
      restore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('SessionEnd hook', () => {
  test('drainPending forwards to the queue', () => {
    const home = freshHome();
    const restore = stubMcp(() => ({ skipped: false, count: 1 }));
    try {
      pending.enqueue('mcp-wrap');
      const hook = require('../src/hooks/session-end');
      assert.deepEqual(hook.drainPending({ home }), { done: ['mcp-wrap'], kept: [] });
    } finally {
      restore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('drainPending defaults to the real home when called bare', () => {
    const home = freshHome();
    const restore = stubMcp(() => ({ skipped: false, count: 1 }));
    try {
      const hook = require('../src/hooks/session-end');
      let res;
      assert.doesNotThrow(() => { res = hook.drainPending(); });
      assert.deepEqual(res, { done: [], kept: [] }, 'nothing queued in a fresh home');
    } finally {
      restore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('a broken queue never breaks session shutdown', () => {
    const home = freshHome();
    const spy = jest.spyOn(pending, 'drain').mockImplementation(() => {
      throw new Error('queue exploded');
    });
    try {
      const hook = require('../src/hooks/session-end');
      let res;
      assert.doesNotThrow(() => { res = hook.drainPending({ home }); });
      assert.deepEqual(res, { done: [], kept: [] });
    } finally {
      spy.mockRestore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('the hook runs as a real process and exits clean on empty stdin', () => {
    const home = freshHome();
    try {
      const res = spawnSync(process.execPath, [path.join(ROOT, 'src', 'hooks', 'session-end.js')], {
        input: JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'exit' }),
        encoding: 'utf8',
        env: { ...process.env, LAKON_HOME: home },
        timeout: 10000,
      });
      assert.equal(res.status, 0, `hook should exit 0: ${res.stderr}`);
      assert.equal(res.stderr.trim(), '', 'a hook must stay silent on stderr');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
