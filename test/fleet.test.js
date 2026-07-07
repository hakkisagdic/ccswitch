'use strict';
// FLEET: multi-machine control plane over an encrypted shared rendezvous dir. Two machines are
// two makeCtx contexts (separate config dirs, separate credential stores) sharing one fleet dir
// + passphrase — exactly the real topology, just local.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fleet = require('../src/fleet');
const profiles = require('../src/profiles');
const { makeCtx } = require('./helpers');

const PASS = 'fleet-secret-passphrase';
function sharedDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kf-fleet-')); }
function machine(name, dir) {
  const ctx = makeCtx();
  ctx.claudeDir = path.join(ctx.home, '.claude');
  fs.mkdirSync(path.join(ctx.claudeDir, 'projects'), { recursive: true });
  fleet.setConfig(ctx, { name: name, dir: dir });
  return ctx;
}
function seedAccount(ctx, name, email, blob) {
  ctx.store.setProfile(name, blob);
  profiles.write(ctx.configDir, { name: name, email: email, oauthAccount: { organizationUuid: 'org-' + name }, userID: 'u' + name, savedAt: ctx.now() });
}
function busOf(ctx, dir) { return fleet.bus(ctx, { dir: dir, passphrase: PASS }); }

test('identity is stable + persisted per machine', function () {
  const ctx = makeCtx();
  const a = fleet.identity(ctx);
  assert.ok(a.machineId && a.name);
  assert.strictEqual(fleet.identity(ctx).machineId, a.machineId, 'same id on re-read');
});

test('publish + readFleet: each machine sees the others', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir), B = machine('beta', dir);
  seedAccount(A, 'work', 'a@x.com', '{"token":"AAA"}');
  seedAccount(B, 'home', 'b@x.com', '{"token":"BBB"}');
  fleet.publish(A, busOf(A, dir), {});
  fleet.publish(B, busOf(B, dir), {});
  const seenByA = fleet.readFleet(A, busOf(A, dir));
  assert.strictEqual(seenByA.length, 2);
  assert.deepStrictEqual(seenByA.map(function (s) { return s.name; }).sort(), ['alpha', 'beta']);
  assert.ok(seenByA.find(function (s) { return s.name === 'beta'; }).accounts.some(function (a) { return a.name === 'home'; }));
});

test('rendezvous files are ENCRYPTED (wrong passphrase cannot read)', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir);
  seedAccount(A, 'work', 'a@x.com', '{"token":"SECRET-AAA"}');
  fleet.publish(A, busOf(A, dir), { withSecrets: true });
  const raw = fs.readFileSync(path.join(dir, fleet.statusName(fleet.identity(A).machineId)), 'utf8');
  assert.strictEqual(raw.indexOf('SECRET-AAA'), -1, 'the credential is not on disk in cleartext');
  const wrong = fleet.bus(A, { dir: dir, passphrase: 'WRONG' });
  assert.deepStrictEqual(fleet.readFleet(A, wrong), [], 'a wrong passphrase decrypts nothing');
});

test('remote switch: A queues a switch for B; B drains + applies it', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir), B = machine('beta', dir);
  seedAccount(B, 'home', 'b@x.com', '{"claudeAiOauth":{"accessToken":"BBB"}}');
  seedAccount(B, 'work', 'bw@x.com', '{"claudeAiOauth":{"accessToken":"BW"}}');
  const bId = fleet.identity(B).machineId;
  fleet.queue(A, busOf(A, dir), bId, { type: 'switch', payload: { account: 'work' } });
  // B processes its inbox
  const cmds = fleet.readInbox(B, busOf(B, dir));
  assert.strictEqual(cmds.length, 1);
  const res = fleet.applyCommand(B, cmds[0], { allowSwitch: true });
  assert.ok(res.ok && /switched to work/.test(res.detail));
  const skipped = fleet.applyCommand(B, cmds[0], {}); // no consent
  assert.ok(!skipped.ok && /consent/.test(skipped.detail));
});

test('account distribution C->B, orchestrated from A', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir), B = machine('beta', dir), C = machine('gamma', dir);
  seedAccount(C, 'clientX', 'x@corp.com', '{"claudeAiOauth":{"accessToken":"CX-CRED"}}');
  // C publishes WITH secrets so its credentials are available to the fleet (encrypted)
  fleet.publish(C, busOf(C, dir), { withSecrets: true });
  // A reads C's published account and queues a save-account into B's inbox
  const cStatus = fleet.readFleet(A, busOf(A, dir)).find(function (s) { return s.name === 'gamma'; });
  const account = fleet.accountFrom(cStatus, 'clientX');
  assert.ok(account && account.cliCredentials.indexOf('CX-CRED') !== -1);
  fleet.queue(A, busOf(A, dir), fleet.identity(B).machineId, { type: 'save-account', payload: { account: account } });
  // B drains + saves it
  const cmd = fleet.readInbox(B, busOf(B, dir))[0];
  const res = fleet.applyCommand(B, cmd, { allowSave: true });
  assert.ok(res.ok, res.detail);
  assert.strictEqual(B.store.getProfile('clientX'), '{"claudeAiOauth":{"accessToken":"CX-CRED"}}', 'B now holds C\'s account');
});

test('chat-status: a session whose last message is the assistant is "replied"', function () {
  const dir = sharedDir();
  const A = machine('alpha', dir);
  const pdir = path.join(A.claudeDir, 'projects', '-p'); fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, 'sReplied.jsonl'),
    '{"type":"user","cwd":"/p","message":{"role":"user","content":"do X"}}\n' +
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n');
  fs.writeFileSync(path.join(pdir, 'sWaiting.jsonl'),
    '{"type":"user","cwd":"/p","message":{"role":"user","content":"are you there?"}}\n');
  const st = fleet.buildStatus(A, {});
  const replied = st.chats.find(function (c) { return c.sessionId === 'sReplied'; });
  const waiting = st.chats.find(function (c) { return c.sessionId === 'sWaiting'; });
  assert.strictEqual(replied.replied, true);
  assert.strictEqual(waiting.replied, false);
});

test('newReplies flags a chat that got a reply since the last snapshot', function () {
  const ctx = makeCtx();
  const s1 = [{ machineId: 'm1', name: 'beta', chats: [{ sessionId: 's', mtime: '2026-07-07T10:00:00Z', lastRole: 'user', replied: false, lastText: 'q' }] }];
  const first = fleet.newReplies(ctx, s1);
  assert.strictEqual(first.newReplies.length, 0);
  fleet.saveSeen(ctx, first.snapshot);
  const s2 = [{ machineId: 'm1', name: 'beta', chats: [{ sessionId: 's', mtime: '2026-07-07T10:05:00Z', lastRole: 'assistant', replied: true, lastText: 'answer' }] }];
  const second = fleet.newReplies(ctx, s2);
  assert.strictEqual(second.newReplies.length, 1);
  assert.strictEqual(second.newReplies[0].machine, 'beta');
});

test('fleet.json does not pollute the account list (RESERVED)', function () {
  const ctx = makeCtx();
  profiles.write(ctx.configDir, { name: 'real', email: 'r@x.com', oauthAccount: {}, savedAt: ctx.now() });
  ctx.store.setProfile('real', '{"token":"x"}');
  fleet.setConfig(ctx, { name: 'thismachine', dir: '/tmp/x' });
  fleet.saveSeen(ctx, { k: 'v' });
  const names = require('../src/core').listProfiles(ctx).map(function (p) { return p.name; });
  assert.ok(names.indexOf('fleet') === -1 && names.indexOf('fleet-seen') === -1, 'fleet.json/fleet-seen.json are not accounts');
  assert.ok(names.indexOf('real') !== -1);
});
