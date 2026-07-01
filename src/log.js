'use strict';
// Lightweight action log for postmortems. Key events (switch/add/clean/errors)
// are appended to <configDir>/logs/ccswitch.log — the directory is only created
// on the first record, so read-only runs leave no artifacts. --debug additionally
// echoes records to stderr. Never logs secrets.
const fs = require('fs');
const path = require('path');

const state = { dir: null, debug: false, ready: false };

function init(configDir, debug) {
  state.dir = configDir ? path.join(configDir, 'logs') : null;
  state.debug = !!debug;
}

function log(msg) {
  if (state.debug) { try { process.stderr.write('[debug] ' + msg + '\n'); } catch (e) { /* ignore */ } }
  if (!state.dir) return;
  try {
    if (!state.ready) { fs.mkdirSync(state.dir, { recursive: true }); state.ready = true; }
    fs.appendFileSync(path.join(state.dir, 'ccswitch.log'), new Date().toISOString() + ' ' + msg + '\n', { mode: 0o600 });
  } catch (e) { /* logging must never break the tool */ }
}

function debugEnabled() { return state.debug; }

module.exports = { init: init, log: log, debugEnabled: debugEnabled };
