'use strict';
// Helpers for `keyflip login` — capture the credential minted by an isolated,
// OFFICIAL `claude auth login` (run with CLAUDE_CONFIG_DIR=<temp>). Claude writes
// the token to <temp>/.credentials.json; on macOS it may migrate to a Keychain
// item named "Claude Code-credentials-<sha256(dir)[:8]>". We read whichever
// exists, so the user's real login is never touched.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// macOS Keychain service name Claude derives for a non-default CLAUDE_CONFIG_DIR.
function isoKeychainService(dir) {
  return 'Claude Code-credentials-' + crypto.createHash('sha256').update(String(dir)).digest('hex').slice(0, 8);
}

// Return the blob unchanged if it's a well-formed OAuth credential, else null.
function validBlob(s) {
  try {
    const d = JSON.parse(s);
    return d && d.claudeAiOauth && typeof d.claudeAiOauth.accessToken === 'string' && d.claudeAiOauth.accessToken.trim() ? s : null;
  } catch (e) { return null; }
}

// Read the credential an isolated `claude auth login` produced. Order: the
// plaintext file first (Linux/Windows always, macOS before migration), then the
// hashed macOS Keychain item. `opts.run` is exec.run; `opts.platform` selects OS.
function readIsolatedCredential(dir, opts) {
  opts = opts || {};
  const platform = opts.platform || process.platform;
  try {
    const s = fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8');
    const v = validBlob(s);
    if (v) return v;
  } catch (e) { /* not a file — try keychain */ }
  if (platform === 'darwin' && opts.run) {
    const svc = isoKeychainService(dir);
    const r = opts.run('/usr/bin/security', ['find-generic-password', '-s', svc, '-w'], undefined, { timeoutMs: 8000 });
    if (r && r.code === 0 && r.stdout) {
      const v = validBlob(String(r.stdout).trim());
      if (v) return v;
    }
  }
  return null;
}

// Parse `claude auth status` JSON output → { email, orgId, orgName, plan } | null.
function parseAuthStatus(stdout) {
  try {
    const j = JSON.parse(String(stdout || '').trim());
    if (!j || typeof j !== 'object') return null;
    return { email: j.email || null, orgId: j.orgId || null, orgName: j.orgName || null, plan: j.subscriptionType || null, loggedIn: !!j.loggedIn };
  } catch (e) { return null; }
}

// Best-effort removal of the hashed Keychain item Claude may have created.
function cleanIsolatedKeychain(dir, opts) {
  opts = opts || {};
  if ((opts.platform || process.platform) !== 'darwin' || !opts.run) return;
  try { opts.run('/usr/bin/security', ['delete-generic-password', '-s', isoKeychainService(dir)], undefined, { timeoutMs: 8000 }); } catch (e) { /* ignore */ }
}

module.exports = {
  isoKeychainService: isoKeychainService,
  validBlob: validBlob,
  readIsolatedCredential: readIsolatedCredential,
  parseAuthStatus: parseAuthStatus,
  cleanIsolatedKeychain: cleanIsolatedKeychain,
};
