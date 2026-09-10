#!/usr/bin/env node
/* istanbul ignore file -- thin SessionStart I/O shell: stdin + version check */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { checkForUpdate, formatNotice } = require('./version-check');

// Walk up from cwd to find the git root. Returns null if not in a git repo.
function findGitRoot(dir) {
  let cur = dir;
  while (true) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// Trigger a background graph build and return a notice string.
// Fire-and-forget — never blocks the session start.
function triggerGraphBuild(gitRoot) {
  try {
    const lakonai = process.execPath === process.argv[0]
      ? 'lakonai'
      : process.execPath;
    spawn('lakonai', ['graph', 'build', gitRoot], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    }).unref();
    return `lakonai graph: new project detected — building graph for ${gitRoot} in background.\nRun \`lakonai graph query\` once done.`;
  } catch {
    return null;
  }
}

/* istanbul ignore next */
async function readStdin() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

/* istanbul ignore next */
async function main() {
  try {
    await readStdin();

    const parts = [];

    const update = await checkForUpdate();
    if (update) parts.push(formatNotice(update));

    // An upgrade leaves the old daemon running its old code; this is where a
    // new session notices and replaces it.
    if (!process.env.LAKON_NO_PROXY_REFRESH) {
      try {
        const { refreshStaleDaemon, formatRefreshNotice } = require('../proxy/refresh');
        const notice = formatRefreshNotice(await refreshStaleDaemon());
        if (notice) parts.push(notice);
      } catch { /* best-effort */ }
    }

    try {
      const learnReport = require('../learn-report');
      const summary = learnReport.maybeGetUnseen();
      if (summary) parts.push(`lakonai learn: ${summary}`);
    } catch { /* best-effort */ }

    // Auto-build graph for new git projects that don't have one yet.
    if (!process.env.LAKON_NO_AUTO_GRAPH) {
      try {
        const gitRoot = findGitRoot(process.cwd());
        if (gitRoot) {
          const graphJson = path.join(gitRoot, 'lakonai-graph', 'graph.json');
          if (!fs.existsSync(graphJson)) {
            const notice = triggerGraphBuild(gitRoot);
            if (notice) parts.push(notice);
          }
        }
      } catch { /* best-effort */ }
    }

    if (!parts.length) process.exit(0);

    const response = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: parts.join('\n\n'),
      },
    };
    process.stdout.write(JSON.stringify(response));
    process.exit(0);
    /* istanbul ignore next */
  } catch {
    process.exit(0);
  }
}

/* istanbul ignore next */
if (require.main === module) main();
