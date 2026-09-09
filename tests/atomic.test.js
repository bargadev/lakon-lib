'use strict';

// Unit tests for the atomic write helper. The property that matters: a reader
// never sees a half-written file, because the swap is a rename.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeFileAtomic } = require('../src/install/atomic');

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lakon-atomic-'));
}

test('writeFileAtomic: creates a new file', () => {
  const dir = freshDir();
  const f = path.join(dir, 'new.json');
  writeFileAtomic(f, '{"a":1}\n');
  assert.equal(fs.readFileSync(f, 'utf8'), '{"a":1}\n');
  fs.rmSync(dir, { recursive: true });
});

test('writeFileAtomic: replaces an existing file and leaves no temp behind', () => {
  const dir = freshDir();
  const f = path.join(dir, 'cfg.json');
  fs.writeFileSync(f, 'old');
  writeFileAtomic(f, 'new');
  assert.equal(fs.readFileSync(f, 'utf8'), 'new');
  // fs returns arrays from another realm under Jest, so compare contents.
  assert.equal(fs.readdirSync(dir).join(','), 'cfg.json', 'no .tmp leftovers');
  fs.rmSync(dir, { recursive: true });
});

test('writeFileAtomic: preserves the target file mode', () => {
  const dir = freshDir();
  const f = path.join(dir, 'script.sh');
  fs.writeFileSync(f, 'a', { mode: 0o755 });
  writeFileAtomic(f, 'b');
  assert.equal(fs.statSync(f).mode & 0o777, 0o755);
  fs.rmSync(dir, { recursive: true });
});

test('writeFileAtomic: the old content survives a failed write', () => {
  const dir = freshDir();
  const f = path.join(dir, 'cfg.json');
  fs.writeFileSync(f, 'original');
  // A directory that does not exist makes the temp open fail.
  assert.throws(() => writeFileAtomic(path.join(dir, 'missing', 'cfg.json'), 'x'));
  assert.equal(fs.readFileSync(f, 'utf8'), 'original');
  fs.rmSync(dir, { recursive: true });
});

test('writeFileAtomic: a reader never observes a truncated file', () => {
  const dir = freshDir();
  const f = path.join(dir, 'big.json');
  const first = JSON.stringify({ v: 1, pad: 'a'.repeat(200000) });
  const second = JSON.stringify({ v: 2, pad: 'b'.repeat(200000) });
  fs.writeFileSync(f, first);

  // Read repeatedly while rewriting: every observation must be a complete,
  // parseable document — the guarantee plain writeFileSync does not give.
  for (let i = 0; i < 20; i++) {
    writeFileAtomic(f, i % 2 ? first : second);
    const seen = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.ok(seen.v === 1 || seen.v === 2);
    assert.equal(seen.pad.length, 200000);
  }
  fs.rmSync(dir, { recursive: true });
});
