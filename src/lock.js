'use strict';
// Cross-process advisory lock so two ccswitch invocations can't interleave a
// switch (e.g. double-fired alias, the launcher app racing a terminal). The lock
// is <configDir>/.lock created with O_EXCL and holding {pid, at}; stale locks
// (dead pid or older than staleMs) are reclaimed.
const fs = require('fs');
const path = require('path');

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; } // EPERM = alive but not ours
}

function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Acquire the mutation lock. Resolves to { release() }. Throws Error with
// code 'ELOCKED' if another live ccswitch holds it past timeoutMs.
async function acquire(configDir, opts) {
  opts = opts || {};
  const file = path.join(configDir, '.lock');
  const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : 10000;
  const staleMs = opts.staleMs !== undefined ? opts.staleMs : 60000;
  const start = Date.now();
  fs.mkdirSync(configDir, { recursive: true });
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      return {
        release: function () { try { fs.rmSync(file, { force: true }); } catch (e) { /* ignore */ } },
      };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      let info = null;
      try { info = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e2) { /* unreadable = stale */ }
      const stale = !info || (Date.now() - (info.at || 0) > staleMs) || (info.pid && !pidAlive(info.pid));
      if (stale) {
        try { fs.rmSync(file, { force: true }); } catch (e2) { /* raced */ }
        continue;
      }
      if (Date.now() - start >= timeoutMs) {
        const err = new Error('another ccswitch is running (lock held by pid ' + (info && info.pid) + ') — try again in a moment');
        err.code = 'ELOCKED';
        throw err;
      }
      await delay(120);
    }
  }
}

module.exports = { acquire: acquire, _pidAlive: pidAlive };
