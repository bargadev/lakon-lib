'use strict';

// Supervisor for the local compression proxy.
//
// The contract every function here keeps: never report the proxy as up unless a
// TCP connect to its port succeeded. The original version returned
// `{running: true}` straight after `spawn()` and the installer trusted it, so a
// daemon that died on EADDRINUSE still got ANTHROPIC_BASE_URL written into three
// shell rc files — every later `claude` failed with ECONNREFUSED and nothing
// pointed at lakonai as the cause.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const state = require('./state');
const { homedir } = require('../install/paths');

const {
  DEFAULT_PORT,
  MARKER,
  probePort,
  waitForPort,
  isRunning,
  readState,
  clearState,
  envFile,
  writeEnvScript,
  removeEnvScript,
} = state;

const VERSION = require('../../package.json').version;

const START_TIMEOUT_MS = Number(process.env.LAKON_PROXY_START_TIMEOUT) || 6000;
const STOP_TIMEOUT_MS = 3000;

const serverScript = path.join(__dirname, 'server.js');

// Port to ask for: an explicit override, else whatever we bound last time, else
// the default. The server falls back to an OS-assigned port if it is taken.
function preferredPort() {
  const forced = Number(process.env.LAKON_PROXY_PORT);
  if (forced) return forced;
  const s = readState();
  return (s && s.port) || DEFAULT_PORT;
}

// Real health, not a PID guess: the process must be alive AND its port must
// answer. Either half missing means the state on disk is stale.
async function status() {
  const s = readState();
  if (!s) return { running: false, pid: null, port: preferredPort(), listening: false, stale: false, version: null };

  const alive = isRunning(s.pid);
  const listening = await probePort(s.port);
  return {
    running: alive && listening,
    pid: alive ? s.pid : null,
    port: s.port,
    listening,
    stale: !(alive && listening),
    legacy: Boolean(s.legacy),
    // null for a pre-1.2.3 daemon: it never stamped one.
    version: s.version || null,
  };
}

// Start the daemon and wait until it actually serves. Returns
// `{running: false, error}` when it does not — callers must check before
// touching the user's shell rc.
async function start({ allowRestart = true } = {}) {
  const current = await status();
  if (current.running) {
    // A live daemon keeps executing the server.js it was started with, so after
    // an upgrade the running process is stale code — and a pre-1.2.3 daemon is
    // still the one that made the CLI fail. Replace it instead of adopting it.
    if (allowRestart && current.version !== VERSION) {
      await stop();
      return start({ allowRestart: false });
    }
    // The env script is what the shell actually reads; an upgrade that adopts a
    // running daemon must still publish it, or the rc points at a missing file.
    writeEnvScript(current.port);
    return { running: true, pid: current.pid, port: current.port, alreadyRunning: true };
  }

  clearState(); // drop stale pid/port so we don't read the dead daemon's values

  const port = preferredPort();
  const child = spawn(process.execPath, [serverScript], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, LAKON_PROXY_PORT: String(port) },
  });

  let spawnError = null;
  child.on('error', (err) => { spawnError = err; });
  child.unref();

  // The server publishes its state only once it is bound, so poll for that,
  // then confirm with a connect.
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    if (spawnError) {
      return { running: false, pid: null, port, error: `could not spawn the proxy: ${spawnError.message}` };
    }
    const s = readState();
    if (s && (await probePort(s.port))) {
      writeEnvScript(s.port);
      return { running: true, pid: s.pid, port: s.port };
    }
    if (Date.now() >= deadline) break;
    await state.sleep(100);
  }

  // Never leave a half-started child behind holding the port.
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
  clearState();
  return {
    running: false,
    pid: null,
    port,
    error: `the proxy did not come up on 127.0.0.1:${port} within ${START_TIMEOUT_MS}ms`,
  };
}

// Is this pid really our proxy? PIDs get recycled, and the state file is just a
// file — signalling whatever pid it happens to name could kill an unrelated
// process. A pid only counts as ours if it serves the port, or if its command
// line is the proxy server.
function ownsProxy(pid, port, { listening }) {
  if (listening) return true;
  try {
    // status === 0 already implies ps ran and stdout is a string.
    const out = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return out.status === 0 && /proxy[/\\]server\.js/.test(out.stdout);
  } catch {
    /* istanbul ignore next -- ps missing: refuse to signal rather than guess */
    return false;
  }
}

// Stop the daemon and wait for the port to be released, so a restart cannot
// race the old socket.
async function stop() {
  const s = readState();
  const alive = s && isRunning(s.pid);
  const listening = s ? await probePort(s.port) : false;
  if (!alive || !ownsProxy(s.pid, s.port, { listening })) {
    clearState();
    removeEnvScript();
    return false;
  }
  try {
    process.kill(s.pid, 'SIGTERM');
  } catch {
    /* istanbul ignore next -- lost the race with an exiting daemon */
    return false;
  }
  await waitForPort(s.port, { timeoutMs: STOP_TIMEOUT_MS, want: false });
  clearState();
  removeEnvScript();
  return true;
}

async function restart() {
  await stop();
  return start();
}

// ── shell rc wiring ─────────────────────────────────────────────────────────

// The rc sources the generated script instead of exporting the URL directly —
// that script re-checks the port on every shell start, so a dead proxy degrades
// to plain direct API access instead of breaking the CLI.
function envLine() {
  const f = envFile();
  const home = homedir();
  const display = f.startsWith(home) ? '$HOME' + f.slice(home.length) : f;
  return `if [ -r "${display}" ]; then . "${display}"; fi  ${MARKER}`;
}

// Idempotent, and self-healing: any older lakonai proxy line (including the
// unconditional `export ANTHROPIC_BASE_URL=…` of <= 1.2.2) is replaced.
function installEnv(rcFile) {
  try {
    const content = fs.existsSync(rcFile) ? fs.readFileSync(rcFile, 'utf8') : '';
    const kept = content.split('\n').filter((l) => !l.includes(MARKER)).join('\n').replace(/\n+$/, '');
    const next = kept ? `${kept}\n\n${envLine()}\n` : `${envLine()}\n`;
    if (next === content) return false;
    fs.writeFileSync(rcFile, next);
    return true;
  } catch {
    return false;
  }
}

function uninstallEnv(rcFile) {
  try {
    if (!fs.existsSync(rcFile)) return false;
    const content = fs.readFileSync(rcFile, 'utf8');
    const filtered = content.split('\n').filter((l) => !l.includes(MARKER)).join('\n');
    if (filtered === content) return false;
    fs.writeFileSync(rcFile, filtered);
    return true;
  } catch {
    return false;
  }
}

function rcFiles() {
  const home = homedir();
  return [
    path.join(home, '.zshrc'),
    path.join(home, '.bashrc'),
    path.join(home, '.bash_profile'),
  ].filter((f) => fs.existsSync(f));
}

// Remove every trace from the shell: rc lines, generated script, running daemon.
async function unwire() {
  const touched = rcFiles().filter((f) => uninstallEnv(f));
  const stopped = await stop();
  return { touched, stopped };
}

module.exports = {
  start,
  VERSION,
  ownsProxy,
  stop,
  restart,
  status,
  unwire,
  installEnv,
  uninstallEnv,
  rcFiles,
  envLine,
  preferredPort,
  isRunning,
  readState,
  DEFAULT_PORT,
};
