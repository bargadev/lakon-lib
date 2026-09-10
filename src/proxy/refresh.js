'use strict';

// Replacing a daemon left behind by an upgrade.
//
// `npm i -g lakonai` only swaps files on disk. The daemon already running keeps
// executing the `server.js` it was started with, so after an upgrade the CLI is
// new and the process serving every session is old code — the fix the user just
// installed is not the one answering their requests.
//
// `daemon.start()` already knows how to replace a version-mismatched daemon
// (retire the old one, rebind the same port). Nothing was calling it after an
// upgrade: npm runs no postinstall, and the only callers are `lakonai install`
// and `lakonai proxy start|restart`. This module is the missing trigger, run
// from the SessionStart hook — the moment a new session is about to depend on
// the proxy, and the cheapest place to notice the mismatch.

const daemon = require('./daemon');

const VERSION = require('../../package.json').version;

// Deps are injected so the unit tests can drive every branch without spawning
// a real daemon; production callers pass nothing.
async function refreshStaleDaemon({
  status = daemon.status,
  start = daemon.start,
  version = VERSION,
} = {}) {
  let current;
  try {
    current = await status();
  } catch {
    return null; // a status probe that throws is not a reason to fail a session
  }

  // Nothing running: starting one here is not this hook's job. A session that
  // needs the proxy gets it from `lakonai install` / `lakonai proxy start`.
  if (!current || !current.running) return null;

  // Same comparison daemon.start() makes: an unstamped daemon (pre-1.2.3) is
  // stale by definition, so `null !== version` correctly counts as a mismatch.
  if (current.version === version) return null;

  const from = current.version;
  const fromPort = current.port;

  let res;
  try {
    res = await start();
  } catch (err) {
    return { refreshed: false, from, to: version, error: err.message };
  }

  if (!res || !res.running) {
    return { refreshed: false, from, to: version, error: (res && res.error) || 'the proxy did not come back up' };
  }

  return {
    refreshed: true,
    from,
    to: version,
    port: res.port,
    // The old daemon held the port and was too old to hand it over, so the new
    // one landed somewhere else. Sessions already pinned to `fromPort` keep
    // talking to the old process until it goes idle and gets reaped.
    movedPort: res.port !== fromPort ? fromPort : null,
    replaced: res.replaced || null,
  };
}

function formatRefreshNotice(result) {
  if (!result) return null;

  const from = result.from || 'an unstamped build';

  if (!result.refreshed) {
    return `lakonai proxy: the running daemon is still ${from} after the upgrade to ${result.to}, and restarting it failed (${result.error}).\nRun \`lakonai proxy restart\` to pick up the new code.`;
  }

  const lines = [`lakonai proxy: replaced the ${from} daemon left over by the upgrade — now serving ${result.to} on 127.0.0.1:${result.port}.`];
  if (result.movedPort) {
    lines.push(`The old daemon was too old to release port ${result.movedPort} and is still draining there; sessions pinned to it keep working and it is reaped once idle.`);
  }
  return lines.join('\n');
}

module.exports = { refreshStaleDaemon, formatRefreshNotice, VERSION };
