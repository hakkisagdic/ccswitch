'use strict';
// Versioned state + one-time migrations. Applied migration ids are recorded in
// <configDir>/.migrations.json; each migration is idempotent and self-guarded so
// a failure never bricks startup (it just retries next run).
const fs = require('fs');
const path = require('path');
const profiles = require('./profiles');
const { atomicWrite } = require('./fsutil');

const CURRENT_SCHEMA = 1;

const MIGRATIONS = [
  {
    id: '001-stamp-schema-version',
    run: function (ctx) {
      profiles.list(ctx.configDir).forEach(function (n) {
        const m = profiles.read(ctx.configDir, n);
        if (m && !m.schemaVersion) {
          m.schemaVersion = CURRENT_SCHEMA;
          profiles.write(ctx.configDir, m);
        }
      });
    },
  },
  {
    // The tool was renamed ccswitch -> keyflip. Adopt an existing ccswitch
    // install's data: move the old config dir's contents into the new one and,
    // on macOS, copy each profile's Keychain item from the old service prefix.
    // Idempotent: skips anything already present; the old dir is only removed
    // once it's empty. Claude's own live credential is never touched.
    id: '002-adopt-ccswitch-data',
    run: function (ctx) {
      const oldDir = path.join(path.dirname(ctx.configDir), 'ccswitch');
      if (oldDir === ctx.configDir || !fs.existsSync(oldDir)) return;

      // 1) Move files/dirs over (never overwrite something already migrated).
      fs.mkdirSync(ctx.configDir, { recursive: true });
      fs.readdirSync(oldDir).forEach(function (name) {
        if (name === '.lock' || name === '.migrations.json') return;
        const from = path.join(oldDir, name);
        const to = path.join(ctx.configDir, name);
        if (fs.existsSync(to)) return;
        try { fs.renameSync(from, to); }
        catch (e) { fs.cpSync(from, to, { recursive: true }); fs.rmSync(from, { recursive: true, force: true }); }
      });

      // 2) macOS: copy Keychain items 'ccswitch:<name>' -> 'keyflip:<name>'.
      if (ctx.platform === 'darwin' && ctx.store && ctx.store.type === 'keychain') {
        const KeychainStore = require('./stores/keychain');
        const kc = new KeychainStore({ account: ctx.account, runner: ctx.keychainRunner });
        profiles.list(ctx.configDir).forEach(function (name) {
          let existing = null;
          try { existing = ctx.store.getProfile(name); } catch (e) { existing = null; }
          if (existing) return; // already under the new prefix
          const blob = kc._read('ccswitch:' + name); // throws EKEYCHAIN if locked -> retried next run
          if (!blob) return;
          ctx.store.setProfile(name, blob);
          kc._delete('ccswitch:' + name);
        });
      }

      // 3) Drop the old dir if nothing is left in it.
      try {
        const left = fs.readdirSync(oldDir).filter(function (n) { return n !== '.lock' && n !== '.migrations.json'; });
        if (!left.length) fs.rmSync(oldDir, { recursive: true, force: true });
      } catch (e) { /* leave it */ }
    },
  },
];

function stampPath(ctx) { return path.join(ctx.configDir, '.migrations.json'); }

function readApplied(ctx) {
  try { return JSON.parse(fs.readFileSync(stampPath(ctx), 'utf8')).applied || []; }
  catch (e) { return []; }
}

// Returns the ids applied in this run. Never throws.
function runMigrations(ctx) {
  let applied;
  try { applied = readApplied(ctx); } catch (e) { applied = []; }
  const ranNow = [];
  for (let i = 0; i < MIGRATIONS.length; i++) {
    const m = MIGRATIONS[i];
    if (applied.indexOf(m.id) !== -1) continue;
    try {
      m.run(ctx);
      applied.push(m.id);
      ranNow.push(m.id);
    } catch (e) {
      break; // retry on the next run; never block startup
    }
  }
  if (ranNow.length) {
    try { atomicWrite(stampPath(ctx), JSON.stringify({ applied: applied }, null, 2), 0o600); }
    catch (e) { /* best effort */ }
  }
  return ranNow;
}

module.exports = { runMigrations: runMigrations, CURRENT_SCHEMA: CURRENT_SCHEMA, _MIGRATIONS: MIGRATIONS };
