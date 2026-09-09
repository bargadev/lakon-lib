'use strict';

// Work that could not be done safely when it was asked for, kept until a safe
// moment arrives.
//
// The case this exists for: wrapping MCP servers means writing ~/.claude.json,
// which is unsafe while a Claude Code session is live (it holds the session
// state that session is still writing). Refusing is correct — but leaving the
// user to remember a command is not. So `install` queues the task and lakonai
// drains it itself: on SessionEnd, and opportunistically at the start of any
// lakonai command that runs outside a session.
//
// Draining never forces and never blocks: a task that still cannot run stays
// queued.

const fs = require('fs');
const path = require('path');
const { homedir } = require('./paths');

const TASKS = {
  // id -> { label, run(home) -> { done, reason } }
  'mcp-wrap': {
    label: 'wrap MCP servers for catalog compression',
    run(home) {
      const { wrapMcp } = require('./mcp');
      const res = wrapMcp(home);
      // `skipped` means the guard said not yet — keep it queued. A count of 0
      // with no skip means there was nothing to do, which is also done.
      return { done: !res.skipped, reason: res.reason };
    },
  },
};

function lakonHome() {
  return process.env.LAKON_HOME || path.join(homedir(), '.lakon');
}

function queuePath() {
  return path.join(lakonHome(), 'pending.json');
}

function read() {
  try {
    const q = JSON.parse(fs.readFileSync(queuePath(), 'utf8'));
    return Array.isArray(q.tasks) ? q.tasks.filter((t) => TASKS[t]) : [];
  } catch {
    return [];
  }
}

function write(tasks) {
  try {
    fs.mkdirSync(lakonHome(), { recursive: true });
    if (!tasks.length) {
      try { fs.unlinkSync(queuePath()); } catch { /* already gone */ }
      return true;
    }
    fs.writeFileSync(queuePath(), JSON.stringify({ tasks }));
    return true;
  } catch {
    return false;
  }
}

function enqueue(id) {
  if (!TASKS[id]) return false;
  const tasks = read();
  if (tasks.includes(id)) return false;
  tasks.push(id);
  write(tasks);
  return true;
}

function list() {
  return read().map((id) => ({ id, label: TASKS[id].label }));
}

// Try every queued task. Returns what ran and what stayed. Errors in a task are
// swallowed on purpose — a drain runs in the background and must never be the
// reason a command fails.
function drain(home = homedir()) {
  const tasks = read();
  if (!tasks.length) return { done: [], kept: [] };

  const done = [];
  const kept = [];
  for (const id of tasks) {
    let result;
    try {
      result = TASKS[id].run(home);
    } catch {
      /* istanbul ignore next -- a task that throws is kept for the next attempt */
      result = { done: false, reason: 'task threw' };
    }
    if (result && result.done) done.push(id);
    else kept.push(id);
  }
  write(kept);
  return { done, kept };
}

module.exports = { enqueue, drain, list, queuePath, TASKS };
