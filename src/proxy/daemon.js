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

// The release that taught the server to retire gracefully (SIGUSR2). Sending it
// to anything older would just kill the process — Node's default disposition for
// SIGUSR2 is to terminate — which is exactly what retirement exists to avoid.
const RETIRE_SINCE = [1, 2, 6];

function supportsRetire(version) {
  if (!version) return false; // pre-1.2.3 daemons stamped nothing
  const parts = String(version).split('.').map((n) => parseInt(n, 10));
  if (parts.length < 3 || parts.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) {
    if (parts[i] > RETIRE_SINCE[i]) return true;
    if (parts[i] < RETIRE_SINCE[i]) return false;
  }
  return true;
}

// Does anything still hold a connection to this port? Used before killing a
// daemon too old to retire on its own: a live connection means a session is
// mid-request, and killing it produces the ECONNREFUSED this whole subsystem
// exists to prevent. Unknown (no lsof) counts as "yes" — the cautious answer.
function hasLiveConnections(port) {
  try {
    const out = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED'], { encoding: 'utf8' });
    if (out.error || typeof out.stdout !== 'string') return true;
    return out.stdout.trim().split('\n').filter((l) => l && !l.startsWith('COMMAND')).length > 0;
  } catch {
    /* istanbul ignore next -- lsof missing: assume a connection rather than kill */
    return true;
  }
}

// Replace a daemon without dropping anyone's in-flight requests.
//   'exited'       — retired gracefully and is already gone
//   'draining'     — stopped listening, still serving open connections
//   'left-running' — too old to retire and still in use; reaped later
//   'stopped'      — too old to retire, nothing connected, terminated
//   'gone'         — was not running
async function retire(s) {
  if (!s || !isRunning(s.pid)) return 'gone';

  if (supportsRetire(s.version)) {
    try { process.kill(s.pid, 'SIGUSR2'); } catch { return 'gone'; }
    // It stops listening immediately, so the port frees up for the new daemon
    // while the old connections finish on the old process.
    await waitForPort(s.port, { timeoutMs: STOP_TIMEOUT_MS, want: false });
    return isRunning(s.pid) ? 'draining' : 'exited';
  }

  if (hasLiveConnections(s.port)) {
    rememberRetired(s);
    return 'left-running';
  }
  try { process.kill(s.pid, 'SIGTERM'); } catch { /* already gone */ }
  await waitForPort(s.port, { timeoutMs: STOP_TIMEOUT_MS, want: false });
  return 'stopped';
}

// Old daemons we could not stop safely, remembered so a later run can finish the
// job once they are idle.
function retiredFile() {
  return path.join(state.lakonHome(), 'proxy-retired.json');
}

function rememberRetired(s) {
  try {
    const list = readRetired().filter((r) => r.pid !== s.pid);
    list.push({ pid: s.pid, port: s.port });
    fs.mkdirSync(state.lakonHome(), { recursive: true });
    fs.writeFileSync(retiredFile(), JSON.stringify(list));
  } catch { /* best-effort */ }
}

function readRetired() {
  try {
    const list = JSON.parse(fs.readFileSync(retiredFile(), 'utf8'));
    return Array.isArray(list) ? list.filter((r) => r && r.pid && r.port) : [];
  } catch {
    return [];
  }
}

// Kill off retired daemons that have finally gone idle. Cheap, silent, and run
// on every start so the leftovers do not accumulate.
function reapRetired() {
  const reaped = [];
  const kept = [];
  for (const r of readRetired()) {
    if (!isRunning(r.pid)) { reaped.push(r.pid); continue; }
    if (hasLiveConnections(r.port)) { kept.push(r); continue; }
    try { process.kill(r.pid, 'SIGTERM'); reaped.push(r.pid); } catch { /* gone */ }
  }
  try {
    if (kept.length) fs.writeFileSync(retiredFile(), JSON.stringify(kept));
    else fs.unlinkSync(retiredFile());
  } catch { /* best-effort */ }
  return { reaped, kept: kept.map((r) => r.pid) };
}

// Start the daemon and wait until it actually serves. Returns
// `{running: false, error}` when it does not — callers must check before
// touching the user's shell rc.
async function start({ allowRestart = true } = {}) {
  reapRetired();
  const current = await status();
  if (current.running) {
    // A live daemon keeps executing the server.js it was started with, so after
    // an upgrade the running process is stale code — and a pre-1.2.3 daemon is
    // still the one that made the CLI fail. Replace it instead of adopting it.
    if (allowRestart && current.version !== VERSION) {
      // Retire, do not kill: an upgrade run from inside a Claude Code session
      // would otherwise drop that session's own connection to the proxy.
      const how = await retire({ pid: current.pid, port: current.port, version: current.version });
      clearState();
      const next = await start({ allowRestart: false });
      return { ...next, replaced: how };
    }
    // The env script is what the shell actually reads; an upgrade that adopts a
    // running daemon must still publish it, or the rc points at a missing file.
    writeEnvScript(current.port);
    return { running: true, pid: current.pid, port: current.port, alreadyRunning: true };
  }

  // Read the port BEFORE clearing: a session launched against the dead daemon
  // has its ANTHROPIC_BASE_URL pinned to that port for its whole life, and it
  // cannot be told to look elsewhere. Rebinding the same port is the only thing
  // that brings those sessions back; clearing first would send us to the
  // default and strand every one of them on ECONNREFUSED.
  const port = preferredPort();
  clearState(); // drop stale pid/port so we don't read the dead daemon's values
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

// Read one environment variable out of another process. A process's env is
// fixed at exec time, so this reports what the process was actually launched
// with — not what the current shell would give it.
function processEnv(pid, key) {
  // Linux: the kernel exposes it directly, NUL-separated. Exactly one of these
  // two branches is dead on any given platform, so neither can be covered on
  // both — the test suite exercises whichever one this machine actually uses.
  /* istanbul ignore next -- platform branch */
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    for (const kv of raw.split('\0')) {
      if (kv.startsWith(`${key}=`)) return kv.slice(key.length + 1);
    }
    return null;
  } catch { /* not Linux, or the process is gone */ }

  // macOS: `ps e` appends the environment after the command line.
  try {
    const out = spawnSync('ps', ['eww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    if (out.error || typeof out.stdout !== 'string') return null;
    const m = out.stdout.match(new RegExp(`(?:^|\\s)${key}=(\\S*)`));
    return m ? m[1] : null;
  } catch {
    /* istanbul ignore next -- no ps: we simply cannot tell */
    return null;
  }
}

// Claude Code sessions pinned to a given local proxy port.
//
// A session reads ANTHROPIC_BASE_URL once, at launch, and keeps it for life.
// Nothing can re-point a process that is already running — not a hook, not a
// fresh env script, not a proxy that came back on a different port. So when the
// port they hold is dead, these sessions are not quietly falling back to direct
// API access: each retries a refused connection until the user quits it.
//
// The caller decides what the port's state means; this only answers "who is
// holding it". Best-effort by construction: an empty list means "none found",
// never a guarantee that none exist.
function sessionsOnPort(port) {
  if (!port) return [];

  let pids = [];
  try {
    const out = spawnSync('pgrep', ['-f', 'claude'], { encoding: 'utf8' });
    if (typeof out.stdout !== 'string') return [];
    pids = out.stdout.split('\n').map((l) => parseInt(l.trim(), 10)).filter(Boolean);
  } catch {
    /* istanbul ignore next -- no pgrep: we simply cannot tell */
    return [];
  }

  const found = [];
  for (const pid of pids) {
    if (pid === process.pid) continue;
    const url = processEnv(pid, 'ANTHROPIC_BASE_URL');
    if (!url) continue;
    // A remote gateway is the user's own routing decision, not ours to report.
    const m = url.match(/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)\/?$/);
    if (!m || Number(m[1]) !== Number(port)) continue;
    found.push({ pid, port: Number(port), url });
  }
  return found;
}

module.exports = {
  start,
  sessionsOnPort,
  processEnv,
  VERSION,
  ownsProxy,
  retire,
  reapRetired,
  readRetired,
  supportsRetire,
  hasLiveConnections,
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
