'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const appauth = require('../src/appauth');
const { tmpdir } = require('./helpers');

function setup() {
  const home = tmpdir();
  const appDataDir = path.join(home, 'Library', 'Application Support', 'Claude');
  fs.mkdirSync(appDataDir, { recursive: true });
  const cfg = path.join(appDataDir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ locale: 'en-US', 'oauth:tokenCache': 'TOKEN-A-V1', 'oauth:tokenCacheV2': 'TOKEN-A-V2', keep: 'me' }));
  const ctx = { home: home, platform: 'darwin', appDataDir: appDataDir, configDir: path.join(home, '.config', 'ccswitch'), now: function () { return '2026-01-01T00:00:00.000Z'; } };
  return { ctx: ctx, cfg: cfg };
}

test('snapshotToProfile captures the desktop app login tokens', function () {
  const s = setup();
  const r = appauth.snapshotToProfile(s.ctx, 'A');
  assert.strictEqual(r.ok, true);
  assert.ok(appauth.hasProfile(s.ctx, 'A'));
  const snap = JSON.parse(fs.readFileSync(appauth.profilePath(s.ctx, 'A'), 'utf8'));
  assert.strictEqual(snap['oauth:tokenCacheV2'], 'TOKEN-A-V2');
  assert.strictEqual(snap['oauth:tokenCache'], 'TOKEN-A-V1');
});

test('applyFromProfile restores tokens, preserves other keys, and backs up', function () {
  const s = setup();
  appauth.snapshotToProfile(s.ctx, 'A');
  // app is now logged in as B
  fs.writeFileSync(s.cfg, JSON.stringify({ locale: 'en-US', 'oauth:tokenCache': 'TOKEN-B-V1', 'oauth:tokenCacheV2': 'TOKEN-B-V2', keep: 'me', extra: 1 }));
  const r = appauth.applyFromProfile(s.ctx, 'A');
  assert.strictEqual(r.ok, true);
  const cfg = JSON.parse(fs.readFileSync(s.cfg, 'utf8'));
  assert.strictEqual(cfg['oauth:tokenCacheV2'], 'TOKEN-A-V2'); // restored A
  assert.strictEqual(cfg.extra, 1);                            // unrelated keys kept
  assert.strictEqual(cfg.keep, 'me');
  const bdir = path.join(s.ctx.configDir, 'backups');
  assert.ok(fs.readdirSync(bdir).some(function (n) { return n.indexOf('config-') === 0; }), 'config backup made');
});

test('applyFromProfile is not-ok when the profile has no saved desktop login', function () {
  const s = setup();
  assert.strictEqual(appauth.applyFromProfile(s.ctx, 'nope').ok, false);
});

test('snapshot/apply are no-ops without the desktop app (non-macOS)', function () {
  const s = setup();
  s.ctx.appDataDir = null;
  assert.strictEqual(appauth.snapshotToProfile(s.ctx, 'A').ok, false);
  assert.strictEqual(appauth.applyFromProfile(s.ctx, 'A').ok, false);
});

test('snapshotToProfile is not-ok when config.json has no token', function () {
  const s = setup();
  fs.writeFileSync(s.cfg, JSON.stringify({ locale: 'en-US' }));
  assert.strictEqual(appauth.snapshotToProfile(s.ctx, 'A').ok, false);
});
