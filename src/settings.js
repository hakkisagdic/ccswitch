'use strict';
// Helpers for ~/.claude/settings.json — the file Claude Code hot-reloads. Used
// by provider switching (env block) and the shared-config-snippet feature.
const fs = require('fs');

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; }
}

// A "credential-shaped" env key we must never carry in a SHARED (non-secret)
// snippet: *_API_KEY, *_AUTH_TOKEN, anything with SECRET/TOKEN — but NOT plural
// *_TOKENS limits (MAX_OUTPUT_TOKENS etc.).
function isCredentialKey(k) {
  const s = String(k);
  if (/_TOKENS$/i.test(s)) return false;          // MAX_OUTPUT_TOKENS, ...
  return /(_API_KEY|_AUTH_TOKEN|SECRET|TOKEN|_KEY)$/i.test(s) || /SECRET|PASSWORD/i.test(s);
}

// Return a shallow copy of an env map with credential-shaped keys removed.
function stripCredentialEnv(env) {
  const out = {};
  Object.keys(env || {}).forEach(function (k) { if (!isCredentialKey(k)) out[k] = env[k]; });
  return out;
}

// Recursive merge: patch wins on scalars/arrays, objects merge. Setting a patch
// value to null DELETES that key (so a snippet can subtract).
function deepMerge(base, patch) {
  const out = Object.assign({}, base);
  Object.keys(patch || {}).forEach(function (k) {
    const pv = patch[k];
    if (pv === null) { delete out[k]; return; }
    if (pv && typeof pv === 'object' && !Array.isArray(pv) &&
        out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], pv);
    } else {
      out[k] = pv;
    }
  });
  return out;
}

module.exports = { read: read, isCredentialKey: isCredentialKey, stripCredentialEnv: stripCredentialEnv, deepMerge: deepMerge };
