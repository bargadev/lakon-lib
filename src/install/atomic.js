'use strict';

// Atomic file writes.
//
// `fs.writeFileSync` truncates the target and then fills it, so a reader that
// looks in that window — or a crash mid-write — sees a half file. That is fine
// for a shim script and catastrophic for `~/.claude.json`, which is where Claude
// Code keeps per-project session state (`lastSessionId`, trust dialogs,
// `allowedTools`): a truncated parse makes it fall back to an empty config and
// the user loses their sessions.
//
// Writing a sibling temp file and renaming it over the target makes the swap
// atomic: a concurrent reader sees either the whole old file or the whole new
// one, never a partial write.

const fs = require('fs');
const path = require('path');

function writeFileAtomic(filePath, data, { encoding = 'utf8' } = {}) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.lakonai-${process.pid}-${Date.now()}.tmp`);

  // Keep the target's permissions — rename replaces the inode, so the temp
  // file's mode is what survives.
  let mode;
  try { mode = fs.statSync(filePath).mode; } catch { /* new file: default mode */ }

  let fd;
  try {
    fd = fs.openSync(tmp, 'w', mode);
    fs.writeFileSync(fd, data, { encoding });
    // Flush before the rename, so a crash cannot leave the renamed file empty.
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath);
  } catch (err) {
    /* istanbul ignore next -- best-effort cleanup of a temp file we may not have opened */
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
    throw err;
  }
  return filePath;
}

module.exports = { writeFileAtomic };
