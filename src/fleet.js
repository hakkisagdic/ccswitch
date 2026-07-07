'use strict';
// FLEET: manage every associated keyflip from one place. keyflip is not a daemon, so the fleet
// coordinates through a SHARED RENDEZVOUS folder (a Dropbox/iCloud/WebDAV-synced dir, or any
// path both machines can reach) — every file written there is encrypted with the fleet
// passphrase (via sync.encrypt), so the folder never holds plaintext. Each machine PUBLISHES a
// status (accounts + quota + chat state) and reads an INBOX of commands other machines queued
// for it (switch account, receive a distributed account). This lets machine A, in one screen,
// see B and C, flip B's account, and hand C's account to B.
const fs = require('fs');
const path = require('path');
const os = require('os');

function idPath(ctx) { return path.join(ctx.configDir, 'fleet.json'); }

// Stable per-machine identity (hostname + a random suffix), created once. Also holds the
// configured fleet name + rendezvous dir. The passphrase is NEVER stored (supplied per command).
function identity(ctx) {
  let id = {};
  try { id = JSON.parse(fs.readFileSync(idPath(ctx), 'utf8')) || {}; } catch (e) { id = {}; }
  if (!id.machineId) {
    const host = safeHost();
    const suffix = require('crypto').randomBytes(3).toString('hex');
    id.machineId = host + '-' + suffix;
    if (!id.name) id.name = host;
    try { const fsutil = require('./fsutil'); fsutil.atomicWrite(idPath(ctx), JSON.stringify(id, null, 2), 0o600); } catch (e) { /* best-effort */ }
  }
  return id;
}
function safeHost() { try { return String(os.hostname()).split('.')[0].replace(/[^A-Za-z0-9_-]/g, '') || 'machine'; } catch (e) { return 'machine'; } }

function setConfig(ctx, patch) {
  const id = identity(ctx);
  Object.keys(patch || {}).forEach(function (k) { if (patch[k] != null) id[k] = patch[k]; });
  require('./fsutil').atomicWrite(idPath(ctx), JSON.stringify(id, null, 2), 0o600);
  return id;
}

// A rendezvous bus over a directory (later swappable for WebDAV via sync's dav*). Everything is
// encrypted at rest with the fleet passphrase.
function bus(ctx, opts) {
  opts = opts || {};
  const id = identity(ctx);
  const dir = opts.dir || id.dir;
  if (!dir) throw new Error('no fleet rendezvous configured — run `keyflip fleet init --dir <shared-folder>`');
  if (!opts.passphrase) throw new Error('a fleet passphrase is required (--passphrase-file <f>)');
  const sync = require('./sync');
  return {
    dir: dir, machineId: id.machineId, name: id.name,
    write: function (name, obj) { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, name); fs.writeFileSync(f, sync.encrypt(JSON.stringify(obj), opts.passphrase), { mode: 0o600 }); try { fs.chmodSync(f, 0o600); } catch (e) { /* non-POSIX */ } },
    read: function (name) { let raw; try { raw = fs.readFileSync(path.join(dir, name), 'utf8'); } catch (e) { return null; } try { return JSON.parse(sync.decrypt(raw, opts.passphrase)); } catch (e) { return null; } },
    list: function (suffix) { let ents = []; try { ents = fs.readdirSync(dir); } catch (e) { return []; } return ents.filter(function (n) { return n.slice(-suffix.length) === suffix; }); },
    remove: function (name) { try { fs.rmSync(path.join(dir, name), { force: true }); } catch (e) { /* ignore */ } },
  };
}

function statusName(machineId) { return machineId + '.status.enc'; }
function inboxName(machineId) { return machineId + '.inbox.enc'; }

// Build this machine's status: accounts (+cached quota), the active account, and recent chat
// state (last message role -> replied/waiting). withSecrets also carries the account credentials
// (encrypted in the bus) so another machine can be handed one of them.
function buildStatus(ctx, opts) {
  opts = opts || {};
  const core = require('./core');
  const id = identity(ctx);
  let usageCache = {}; try { usageCache = JSON.parse(fs.readFileSync(path.join(ctx.configDir, '.usage-cache.json'), 'utf8')) || {}; } catch (e) { usageCache = {}; }
  const accounts = safe(function () {
    return core.listProfiles(ctx).map(function (p) {
      const u = usageCache[p.name] && usageCache[p.name].usage;
      return { name: p.name, email: p.email || null, active: !!p.active,
        fiveHourPct: (u && u.fiveHour && typeof u.fiveHour.pct === 'number') ? u.fiveHour.pct : null,
        sevenDayPct: (u && u.sevenDay && typeof u.sevenDay.pct === 'number') ? u.sevenDay.pct : null };
    });
  }, []);
  const chats = safe(function () { return recentChats(ctx, 12); }, []);
  const status = {
    machineId: id.machineId, name: id.name, at: ctx.now(),
    activeEmail: safe(function () { return core.currentEmail(ctx); }, null),
    accounts: accounts, chats: chats,
  };
  if (opts.withSecrets) {
    const creds = {};
    safe(function () { require('./transfer').buildExport(ctx).envelope.accounts.forEach(function (a) { creds[a.name] = { email: a.email, oauthAccount: a.oauthAccount, userID: a.userID, cliCredentials: a.cliCredentials }; }); }, null);
    status.creds = creds;
  }
  return status;
}
function safe(fn, d) { try { return fn(); } catch (e) { return d; } }

// Recent sessions with last-message role (assistant = a reply arrived; user = waiting on Claude).
function recentChats(ctx, limit) {
  const sessions = require('./sessions');
  const transcript = require('./transcript');
  return sessions.list(ctx, { limit: limit }).map(function (r) {
    let lastRole = null, lastText = null;
    try { const msgs = transcript.parse(fs.readFileSync(r.file, 'utf8')).messages; const last = msgs[msgs.length - 1]; if (last) { lastRole = last.role; lastText = String(last.text || '').replace(/\s+/g, ' ').slice(0, 80); } } catch (e) { /* ignore */ }
    return { sessionId: r.sessionId, cwd: r.cwd || null, mtime: r.mtime, lastRole: lastRole, lastText: lastText, replied: lastRole === 'assistant' };
  });
}

// ---- publish / read the fleet ----
function publish(ctx, b, opts) {
  const status = buildStatus(ctx, opts || {});
  b.write(statusName(b.machineId), status);
  return status;
}
function readFleet(ctx, b) {
  return b.list('.status.enc').map(function (n) { return b.read(n); }).filter(Boolean);
}

// ---- command queue (per-machine inbox) ----
function queue(ctx, b, targetMachineId, command) {
  const cmd = Object.assign({ id: require('crypto').randomBytes(4).toString('hex'), from: b.machineId, at: ctx.now() }, command);
  const inbox = b.read(inboxName(targetMachineId)) || [];
  inbox.push(cmd);
  b.write(inboxName(targetMachineId), inbox);
  return cmd;
}
function readInbox(ctx, b) { return b.read(inboxName(b.machineId)) || []; }
function clearInbox(ctx, b) { b.remove(inboxName(b.machineId)); }

// Apply a single inbound command. Mutations are gated: opts.allowSwitch / opts.allowSave must be
// true (the caller confirms with the user first). Returns { ok, applied, detail }.
function applyCommand(ctx, cmd, opts) {
  opts = opts || {};
  if (!cmd || !cmd.type) return { ok: false, detail: 'malformed command' };
  if (cmd.type === 'note') return { ok: true, applied: 'note', detail: (cmd.payload && cmd.payload.text) || '' };
  if (cmd.type === 'save-account') {
    if (!opts.allowSave) return { ok: false, applied: 'save-account', detail: 'skipped (needs consent)' };
    const a = cmd.payload && cmd.payload.account;
    if (!a || !a.name || !a.cliCredentials) return { ok: false, detail: 'no account payload' };
    try {
      const transfer = require('./transfer');
      const r = transfer.applyImport(ctx, { format: transfer.FORMAT, version: transfer.VERSION, accounts: [a] }, { force: !!opts.force });
      return { ok: true, applied: 'save-account', detail: (r.imported[0] ? 'saved ' + r.imported[0] : 'kept existing ' + a.name) };
    } catch (e) { return { ok: false, applied: 'save-account', detail: (e && e.message) || 'error' }; }
  }
  if (cmd.type === 'switch') {
    if (!opts.allowSwitch) return { ok: false, applied: 'switch', detail: 'skipped (needs consent)' };
    const name = cmd.payload && cmd.payload.account;
    const core = require('./core');
    const resolved = core.resolveProfile(ctx, name);
    if (!resolved) return { ok: false, applied: 'switch', detail: "no such account: '" + name + "'" };
    try { core.performSwitch(ctx, resolved); return { ok: true, applied: 'switch', detail: 'switched to ' + resolved }; }
    catch (e) { return { ok: false, applied: 'switch', detail: (e && e.message) || 'error' }; }
  }
  return { ok: false, detail: 'unknown command type: ' + cmd.type };
}

// Pull one account's full credential from a machine's published status (needs it published
// --with-secrets) → an account object suitable for a save-account command.
function accountFrom(status, accountName) {
  const c = status && status.creds && status.creds[accountName];
  if (!c || !c.cliCredentials) return null;
  return { name: accountName, email: c.email || '', oauthAccount: c.oauthAccount || {}, userID: c.userID || '', cliCredentials: c.cliCredentials };
}

// Diff the fleet's chats against the last-seen snapshot to spot NEW replies since last check.
function seenPath(ctx) { return path.join(ctx.configDir, 'fleet-seen.json'); }
function newReplies(ctx, statuses) {
  let seen = {}; try { seen = JSON.parse(fs.readFileSync(seenPath(ctx), 'utf8')) || {}; } catch (e) { seen = {}; }
  const fresh = {};
  const out = [];
  statuses.forEach(function (s) {
    (s.chats || []).forEach(function (c) {
      const key = s.machineId + '/' + c.sessionId;
      fresh[key] = c.mtime + '|' + (c.lastRole || '');
      const prev = seen[key];
      if (c.replied && prev && prev !== fresh[key] && prev.split('|')[0] !== c.mtime) out.push({ machine: s.name, sessionId: c.sessionId, cwd: c.cwd, lastText: c.lastText });
    });
  });
  return { newReplies: out, snapshot: fresh };
}
function saveSeen(ctx, snapshot) { try { require('./fsutil').atomicWrite(seenPath(ctx), JSON.stringify(snapshot), 0o600); } catch (e) { /* ignore */ } }

module.exports = {
  identity: identity, setConfig: setConfig, bus: bus,
  buildStatus: buildStatus, publish: publish, readFleet: readFleet,
  queue: queue, readInbox: readInbox, clearInbox: clearInbox, applyCommand: applyCommand,
  accountFrom: accountFrom, newReplies: newReplies, saveSeen: saveSeen,
  statusName: statusName, inboxName: inboxName,
};
