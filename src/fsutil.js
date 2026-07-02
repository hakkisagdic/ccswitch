'use strict';
// Cross-platform "write a file as safely as we can".
// POSIX: temp + atomic rename. Windows: rename onto an open/existing file can
// fail (EPERM/EACCES/EBUSY), so fall back to an in-place write.
const fs = require('fs');
const path = require('path');

let seq = 0; // process-unique suffix component (avoids Date.now/Math.random)

function atomicWrite(filePath, data, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // When the caller doesn't pin a mode, preserve the existing file's permission
  // bits (default 0600 for a new file) rather than silently re-setting them.
  if (mode === undefined || mode === null) {
    try { mode = fs.statSync(filePath).mode & 0o777; } catch (e) { mode = 0o600; }
  }
  const tmp = filePath + '.tmp-' + process.pid + '-' + (seq++); // unique within dir -> never inherits a stale file's mode
  try { fs.rmSync(tmp, { force: true }); } catch (e) { /* ignore */ }
  fs.writeFileSync(tmp, data, { mode: mode });
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    // Windows: destination held open by Claude, or replace-existing not permitted.
    try {
      fs.writeFileSync(filePath, data, { mode: mode });
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* ignore */ }
    }
  }
  try { fs.chmodSync(filePath, mode); } catch (e) { /* best effort (e.g. Windows) */ }
}

// Recursively sort object keys so identical logical configs serialize to
// identical bytes (stable diffs, reproducible snapshots).
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).sort().forEach(function (k) { out[k] = sortKeys(value[k]); });
    return out;
  }
  return value;
}

// Deterministic JSON: recursively key-sorted, 2-space indented, trailing newline.
function writeJsonStable(filePath, obj, mode) {
  atomicWrite(filePath, JSON.stringify(sortKeys(obj), null, 2) + '\n', mode);
}

// Read a JSON config for read-modify-WRITE. A MISSING file is a legit empty
// config ({}); a file that EXISTS but doesn't parse is NOT emptiness — returning
// {} and writing it back would silently destroy the user's real config. So we
// throw, and the caller (usually inside txn.withRollback) aborts without writing.
function readJsonForWrite(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return {}; throw e; }
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(filePath + ' exists but is not valid JSON — refusing to overwrite it (fix or remove it first)'); }
}

module.exports = { atomicWrite: atomicWrite, sortKeys: sortKeys, writeJsonStable: writeJsonStable, readJsonForWrite: readJsonForWrite };
