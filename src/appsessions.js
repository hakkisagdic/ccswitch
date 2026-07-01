'use strict';
// Consolidate the Claude *desktop app*'s Code-session index across accounts.
//
// The app stores its "Recents" as index files at:
//   <appData>/claude-code-sessions/<accountUuid>/<orgUuid>/local_*.json
// keyed by account. Those files embed NO account id (association is purely the
// folder), and each points at a cliSessionId — the account-independent transcript
// in ~/.claude/projects. So we can make every account's Recents show all sessions
// by copying the index files from other accounts into the active account's folder.
//
// macOS desktop app only. The cloud "Chat" conversations (claude.ai) are NOT here —
// they live server-side per account and cannot be merged locally.
const fs = require('fs');
const path = require('path');
const claude = require('./claude');

function listDirs(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }).filter(function (d) { return d.isDirectory(); }).map(function (d) { return d.name; }); }
  catch (e) { return []; }
}
function listIndexFiles(p) {
  try { return fs.readdirSync(p).filter(function (f) { return f.indexOf('local_') === 0 && f.slice(-5) === '.json'; }); }
  catch (e) { return []; }
}
function cliIdOf(file) {
  try { const o = JSON.parse(fs.readFileSync(file, 'utf8')); return o.cliSessionId || o.sessionId || null; }
  catch (e) { return null; }
}
function copyTree(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    fs.readdirSync(src).forEach(function (n) { copyTree(path.join(src, n), path.join(dest, n)); });
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function consolidate(ctx) {
  const appDir = ctx.appDataDir;
  if (!appDir) return { ok: false, merged: 0, reason: 'only the macOS desktop app has this store' };
  const store = path.join(appDir, 'claude-code-sessions');
  if (!fs.existsSync(store)) return { ok: false, merged: 0, reason: 'no app session store found' };

  const cfg = claude.readConfig(ctx.claudeConfigPath);
  const oa = cfg && cfg.oauthAccount;
  if (!oa || !oa.accountUuid || !oa.organizationUuid) {
    return { ok: false, merged: 0, reason: 'no active account (accountUuid/organizationUuid) in ~/.claude.json' };
  }

  const activeDir = path.join(store, oa.accountUuid, oa.organizationUuid);
  fs.mkdirSync(activeDir, { recursive: true });

  // Back up the whole store once before touching it.
  let backup = null;
  try {
    const ts = String(ctx.now()).replace(/[:.]/g, '-');
    backup = path.join(ctx.configDir, 'backups', 'claude-code-sessions-' + ts);
    copyTree(store, backup);
  } catch (e) { backup = null; }

  // Sessions already present in the active account (dedupe by cliSessionId).
  const seen = Object.create(null);
  listIndexFiles(activeDir).forEach(function (f) { const id = cliIdOf(path.join(activeDir, f)); if (id) seen[id] = true; });

  let merged = 0;
  listDirs(store).forEach(function (acct) {
    if (acct === oa.accountUuid) return;
    listDirs(path.join(store, acct)).forEach(function (org) {
      const src = path.join(store, acct, org);
      listIndexFiles(src).forEach(function (f) {
        const id = cliIdOf(path.join(src, f));
        if (id && seen[id]) return;
        const dest = path.join(activeDir, f);
        if (fs.existsSync(dest)) return; // same index file already here
        try {
          fs.copyFileSync(path.join(src, f), dest);
          if (id) seen[id] = true;
          merged += 1;
        } catch (e) { /* skip this one */ }
      });
    });
  });

  return { ok: true, merged: merged, backup: backup, activeDir: activeDir };
}

module.exports = { consolidate: consolidate };
