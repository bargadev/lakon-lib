'use strict';

const fs = require('fs');
const path = require('path');
const { backupFile, restoreAllBackups } = require('./backup');
const { installHook, uninstallHook } = require('./claude-hook');
const { installCommands, uninstallCommands } = require('./claude-commands');
const { wrapMcp, unwrapMcp } = require('./mcp');
const { writeFileAtomic } = require('./atomic');
const { claudeConfigDir } = require('./paths');

const MARK_BEGIN = '<!-- lakonai:begin -->';
const MARK_END = '<!-- lakonai:end -->';
const ANY_BEGIN = '<!-- lakon(?:ai)?:begin -->';
const ANY_END = '<!-- lakon(?:ai)?:end -->';

function wrap(rule) {
  return `${MARK_BEGIN}\n${rule.trim()}\n${MARK_END}\n`;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function readSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function hasBlock(filePath) {
  const existing = readSafe(filePath);
  /* istanbul ignore next */
  if (!existing) return false;
  const re = new RegExp(`${ANY_BEGIN}[\\s\\S]*?${ANY_END}`);
  return re.test(existing);
}

function upsertBlock(platformId, filePath, rule) {
  ensureDir(path.dirname(filePath));
  if (fs.existsSync(filePath) && !hasBlock(filePath)) {
    backupFile(platformId, filePath);
  }
  const existing = readSafe(filePath);
  const block = wrap(rule);
  const re = new RegExp(`${ANY_BEGIN}[\\s\\S]*?${ANY_END}\\n?`);
  const next = re.test(existing) ? existing.replace(re, block) : (existing ? `${existing.trim()}\n\n${block}` : block);
  writeFileAtomic(filePath, next);
  return filePath;
}

function stripBlock(filePath) {
  const existing = readSafe(filePath);
  if (!existing) return null;
  const re = new RegExp(`\\n*${ANY_BEGIN}[\\s\\S]*?${ANY_END}\\n?`);
  if (!re.test(existing)) return null;
  const next = existing.replace(re, '').trim();
  if (next) writeFileAtomic(filePath, next + '\n');
  else fs.unlinkSync(filePath);
  return filePath;
}

function revertPlatform(platformId) {
  return restoreAllBackups(platformId);
}

const PLATFORMS = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    scope: 'global',
    rulePath: (home) => path.join(claudeConfigDir(home), 'CLAUDE.md'),
    hasHooks: true,
    detect: (home) => !!process.env.CLAUDE_CONFIG_DIR || dirExists(claudeConfigDir(home)),
    install: ({ home, rule, id }) => {
      const rulePath = upsertBlock(id, path.join(claudeConfigDir(home), 'CLAUDE.md'), rule);
      const hookResult = installHook(home);
      const cmds = installCommands(home);
      const mcp = wrapMcp(home);
      // Deferred, not dropped: the SessionEnd hook (or the next lakonai command
      // run outside a session) applies it, so the user has nothing to remember.
      /* istanbul ignore next */
      if (mcp.skipped && mcp.reason && !mcp.reason.startsWith('LAKON_NO_MCP')) {
        try { require('./pending').enqueue('mcp-wrap'); } catch { /* best-effort */ }
      }
      /* istanbul ignore next */
      const suffixHook = hookResult.settingsMerged ? '+ PreToolUse hook' : `(hook: ${hookResult.note})`;
      /* istanbul ignore next */
      const suffixPruned = hookResult.pruned && hookResult.pruned.length
        ? `+ pruned ${hookResult.pruned.length} stale hook${hookResult.pruned.length > 1 ? 's' : ''}`
        : '';
      /* istanbul ignore next */
      const suffixCmds = cmds.length ? `+ ${cmds.length} slash command${cmds.length > 1 ? 's' : ''}` : '';
      // Never silent: writing ~/.claude.json under a live session can orphan it,
      // so say that MCP compression was deferred and how to apply it later.
      /* istanbul ignore next */
      const suffixMcp = mcp.skipped && mcp.reason && !mcp.reason.startsWith('LAKON_NO_MCP')
        ? `(MCP compression queued - ${mcp.reason}; applied automatically when the session ends)`
        : '';
      return [rulePath, suffixHook, suffixPruned, suffixCmds, suffixMcp].filter(Boolean).join(' ');
    },
    uninstall: ({ home }) => {
      uninstallHook(home);
      uninstallCommands(home);
      unwrapMcp(home);
      return stripBlock(path.join(claudeConfigDir(home), 'CLAUDE.md'));
    },
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    scope: 'global',
    rulePath: (home) => path.join(home, '.codex', 'AGENTS.md'),
    detect: (home) => dirExists(path.join(home, '.codex')),
    install: ({ home, rule, id }) => upsertBlock(id, path.join(home, '.codex', 'AGENTS.md'), rule),
    uninstall: ({ home }) => stripBlock(path.join(home, '.codex', 'AGENTS.md')),
  },
  {
    id: 'cursor',
    label: 'Cursor (per-repo rule)',
    scope: 'project',
    rulePath: () => path.join(process.cwd(), '.cursor', 'rules', 'lakonai.mdc'),
    detect: () => fs.existsSync(path.join(process.cwd(), '.cursor')),
    install: ({ rule, id }) => upsertBlock(id, path.join(process.cwd(), '.cursor', 'rules', 'lakonai.mdc'), rule),
    uninstall: () => {
      stripBlock(path.join(process.cwd(), '.cursor', 'rules', 'lakon.mdc'));
      return stripBlock(path.join(process.cwd(), '.cursor', 'rules', 'lakonai.mdc'));
    },
  },
  {
    id: 'windsurf',
    label: 'Windsurf (per-repo rule)',
    scope: 'project',
    rulePath: () => path.join(process.cwd(), '.windsurf', 'rules', 'lakonai.md'),
    detect: () => fs.existsSync(path.join(process.cwd(), '.windsurf')),
    install: ({ rule, id }) => upsertBlock(id, path.join(process.cwd(), '.windsurf', 'rules', 'lakonai.md'), rule),
    uninstall: () => {
      stripBlock(path.join(process.cwd(), '.windsurf', 'rules', 'lakon.md'));
      return stripBlock(path.join(process.cwd(), '.windsurf', 'rules', 'lakonai.md'));
    },
  },
  {
    id: 'cline',
    label: 'Cline (per-repo rule)',
    scope: 'project',
    rulePath: () => path.join(process.cwd(), '.clinerules', 'lakonai.md'),
    detect: () => fs.existsSync(path.join(process.cwd(), '.clinerules')),
    install: ({ rule, id }) => upsertBlock(id, path.join(process.cwd(), '.clinerules', 'lakonai.md'), rule),
    uninstall: () => {
      stripBlock(path.join(process.cwd(), '.clinerules', 'lakon.md'));
      return stripBlock(path.join(process.cwd(), '.clinerules', 'lakonai.md'));
    },
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    scope: 'global',
    rulePath: (home) => path.join(home, '.gemini', 'GEMINI.md'),
    detect: (home) => dirExists(path.join(home, '.gemini')),
    install: ({ home, rule, id }) => upsertBlock(id, path.join(home, '.gemini', 'GEMINI.md'), rule),
    uninstall: ({ home }) => stripBlock(path.join(home, '.gemini', 'GEMINI.md')),
  },
];

module.exports = { list: () => PLATFORMS, revertPlatform, hasBlock };
