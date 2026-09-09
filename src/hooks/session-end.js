'use strict';

// SessionEnd hook: the first moment it is safe to touch ~/.claude.json.
//
// `lakonai install` run from inside Claude Code cannot wrap MCP servers — that
// would rewrite the file the live session is still using, which is how people
// lost their sessions. It queues the work instead, and this hook drains the
// queue once the session is over, so the user never has to run anything.
//
// Registered with `async: true`: SessionEnd hooks share a 1.5s budget, which is
// not enough to do file work safely, and async hooks are not timed out.

const { homedir } = require('../install/paths');

/* istanbul ignore next -- I/O shell; drainPending is the tested part */
function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => resolve(raw));
    // A hook must never hang the shutdown path waiting for input.
    setTimeout(() => resolve(raw), 500).unref();
  });
}

// The session that triggered this hook is ending, but its process may still be
// flushing state. The pending tasks carry their own safety guards (mcp-wrap
// re-checks how recently ~/.claude.json was written), so a task that is still
// unsafe simply stays queued for the next session end.
function drainPending({ home = homedir() } = {}) {
  try {
    return require('../install/pending').drain(home);
  } catch {
    /* istanbul ignore next -- never let a hook break session shutdown */
    return { done: [], kept: [] };
  }
}

/* istanbul ignore next -- process entry point */
async function main() {
  await readStdin();
  drainPending();
  process.exit(0);
}

/* istanbul ignore next */
if (require.main === module) main();

module.exports = { drainPending };
