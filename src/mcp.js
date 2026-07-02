'use strict';
// MCP (Model Context Protocol) server over stdio, so agents can operate keyflip
// themselves. Implements the spec's base protocol: JSON-RPC 2.0, newline-delimited
// messages, initialize/initialized lifecycle, ping, tools/list + tools/call with
// JSON Schema inputs, tool annotations (readOnlyHint/destructiveHint) and
// structuredContent results.
//
// Safety model for agents: mutating tools REQUIRE `confirm: true`, and the tool
// descriptions instruct the agent to ask the human first. Switching never closes
// the desktop app from under the user (swap-in-place semantics; Claude Code picks
// the new credential up on its next request).
const readline = require('readline');
const core = require('./core');
const profiles = require('./profiles');
const appauth = require('./appauth');
const usage = require('./usage');
const lock = require('./lock');
const logmod = require('./log');
const provider = require('./provider');
const sessions = require('./sessions');
const doctor = require('./doctor');
const backup = require('./backup');
const history = require('./history');
const proxy = require('./proxy');

// Mutating tools all gate on confirm:true — the agent must ask the user first.
function needConfirm(args) {
  if (!args || args.confirm !== true) throw new Error('confirmation required: ask the user first, then call again with confirm=true');
}
const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const RO_NET = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const MUT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const confirmProp = { confirm: { type: 'boolean', description: 'Must be true — set it only after the user has agreed.' } };

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

let VERSION = '0.0.0';
try { VERSION = require('../package.json').version; } catch (e) { /* ignore */ }

// ---- tool implementations ----------------------------------------------------

function accountsPayload(ctx, infos) {
  const appActive = ctx.appDataDir ? appauth.activeProfileName(ctx) : null;
  return core.listProfiles(ctx).map(function (e) {
    let cli = null;
    try { cli = !!ctx.store.getProfile(e.name); } catch (err) { cli = null; }
    const out = {
      name: e.name,
      email: e.email || null,
      cliCaptured: cli,
      appCaptured: appauth.hasProfile(ctx, e.name),
      activeCli: !!e.active,
      activeApp: e.name === appActive,
    };
    if (infos && infos[e.name]) {
      out.usage = infos[e.name].usage;
      out.usageStatus = infos[e.name].status;
      out.headroomPct = infos[e.name].headroom;
    }
    return out;
  });
}

const TOOLS = [
  {
    name: 'keyflip_status',
    title: 'Active Claude account',
    description: 'Which Claude account is active on each surface (Claude Code CLI and the desktop app). Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    run: async function (ctx) {
      const appName = ctx.appDataDir ? appauth.activeProfileName(ctx) : null;
      return {
        cli: core.currentEmail(ctx) ? { email: core.currentEmail(ctx) } : null,
        app: appName ? { name: appName, email: profiles.email(ctx.configDir, appName) || null } : null,
      };
    },
  },
  {
    name: 'keyflip_list',
    title: 'List saved Claude accounts',
    description: 'Saved Claude accounts with what is captured for each ([cli|app]) and which is active. Set include_usage=true to add each account\'s 5h/7d utilization and remaining headroom (network call, ~1s per account). Read-only.',
    inputSchema: {
      type: 'object',
      properties: { include_usage: { type: 'boolean', description: 'Also fetch per-account usage/quota.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    run: async function (ctx, args) {
      let infos = null;
      if (args && args.include_usage) {
        const list = core.listProfiles(ctx);
        const active = list.filter(function (e) { return e.active; })[0];
        infos = await usage.usageForProfiles(ctx, list.map(function (e) { return e.name; }),
          { liveFor: active ? active.name : null });
      }
      return { accounts: accountsPayload(ctx, infos) };
    },
  },
  {
    name: 'keyflip_switch',
    title: 'Switch Claude account',
    description: 'Switch the Claude Code CLI credential to a saved account (in place — the desktop app is NOT closed; a running Claude Code picks the new account up on its next request, so the user\'s current conversation continues on the new account). IMPORTANT: this changes which account is billed and rate-limited. Ask the user before calling, then set confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Account name (from keyflip_list).' },
        confirm: { type: 'boolean', description: 'Must be true — set it only after the user has agreed to the switch.' },
      },
      required: ['name', 'confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: async function (ctx, args) {
      if (args.confirm !== true) {
        throw new Error('confirmation required: ask the user first, then call again with confirm=true');
      }
      const name = core.resolveProfile(ctx, String(args.name));
      if (!name) throw new Error("no such account: '" + args.name + "' (use keyflip_list)");
      const em = profiles.email(ctx.configDir, name);
      if (em && em === core.currentEmail(ctx)) return { alreadyActive: { name: name, email: em } };
      const l = await lock.acquire(ctx.configDir);
      try {
        const did = core.performSwitch(ctx, name);
        logmod.log('mcp switch -> ' + name);
        return { switched: { name: name, email: em || null }, cliSwitched: did.cli,
          note: 'Desktop app not touched; a running Claude Code applies the new account on its next request.' };
      } finally { l.release(); }
    },
  },
  {
    name: 'keyflip_next',
    title: 'Rotate to another Claude account',
    description: 'Rotate the CLI credential to the next saved account, optionally by remaining quota (strategy "best" = most headroom, "next-available" = first not rate-limited). Same in-place semantics as keyflip_switch. Ask the user before calling, then set confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        strategy: { type: 'string', enum: ['best', 'next-available'], description: 'Optional quota-aware selection.' },
        confirm: { type: 'boolean', description: 'Must be true — set it only after the user has agreed.' },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    run: async function (ctx, args) {
      if (args.confirm !== true) {
        throw new Error('confirmation required: ask the user first, then call again with confirm=true');
      }
      const list = core.listProfiles(ctx);
      if (list.length < 2) throw new Error('need at least 2 saved accounts');
      let idx = -1;
      list.forEach(function (e, i) { if (e.active) idx = i; });
      const candidates = [];
      for (let k = 1; k <= list.length; k++) {
        const e = list[(idx + k) % list.length];
        if (!e.active) candidates.push(e);
      }
      let target = candidates[0];
      if (args.strategy) {
        const infos = await usage.usageForProfiles(ctx, candidates.map(function (e) { return e.name; }), {});
        target = usage.pickByStrategy(candidates, infos, args.strategy);
        if (!target) throw new Error("no account matches strategy '" + args.strategy + "'");
      }
      const l = await lock.acquire(ctx.configDir);
      try {
        const did = core.performSwitch(ctx, target.name);
        logmod.log('mcp next -> ' + target.name);
        return { switched: { name: target.name, email: target.email || null }, cliSwitched: did.cli };
      } finally { l.release(); }
    },
  },

  // ---- providers (third-party endpoints) ----
  {
    name: 'keyflip_providers', title: 'List provider endpoints',
    description: 'Saved third-party API endpoints (relays/gateways/Bedrock/OpenRouter) and which one Claude Code is currently routed through. Read-only; never returns keys.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO,
    run: async function (ctx) {
      const active = provider.readActive(ctx);
      return { providers: provider.list(ctx).map(function (n) { const m = provider.read(ctx, n); return { name: n, baseUrl: m && m.baseUrl, active: !!(active && active.name === n) }; }), active: active ? active.name : 'official' };
    },
  },
  {
    name: 'keyflip_provider_use', title: 'Route Claude Code to a provider',
    description: 'Point Claude Code at a saved provider endpoint (or "official" to return to the Anthropic subscription) by patching settings.json env — Claude hot-reloads, no restart. Ask the user first, then confirm=true.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Provider name, or "official".' }, confirm: confirmProp.confirm }, required: ['name', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      if (args.name === 'official' || args.name === 'off') { provider.useOfficial(ctx); return { provider: 'official' }; }
      if (!provider.exists(ctx, args.name)) throw new Error("no such provider: '" + args.name + "'");
      const r = provider.use(ctx, args.name); return { provider: args.name, baseUrl: r.baseUrl };
    },
  },
  {
    name: 'keyflip_provider_add', title: 'Save a provider endpoint',
    description: 'Save a third-party endpoint. NOTE: the API key is a secret and must NOT be passed through MCP — omit it here and tell the user to run `keyflip provider add <name> --base-url <url> --key-file -` (key on stdin). This tool stores only the non-secret metadata. Ask the user first, then confirm=true.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, base_url: { type: 'string' }, auth_scheme: { type: 'string', enum: ['bearer', 'api-key'] }, confirm: confirmProp.confirm }, required: ['name', 'base_url', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      provider.add(ctx, args.name, { baseUrl: args.base_url, authScheme: args.auth_scheme || 'bearer' });
      return { saved: args.name, note: 'No key stored. Run `keyflip provider add ' + args.name + ' --base-url ' + args.base_url + ' --key-file -` to add the key securely.' };
    },
  },
  {
    name: 'keyflip_test_provider', title: 'Test a provider endpoint',
    description: 'Fire one minimal real request to a provider to check auth + reachability. Read-only (no state change).',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false }, annotations: RO_NET,
    run: async function (ctx, args) { return { name: args.name, result: await doctor.testProvider(ctx, args.name) }; },
  },

  // ---- sessions ----
  {
    name: 'keyflip_sessions', title: 'Browse Claude Code conversations',
    description: 'List/search past Claude Code conversations across ALL accounts (transcripts in ~/.claude/projects). Read-only.',
    inputSchema: { type: 'object', properties: { search: { type: 'string' }, cwd: { type: 'string', description: 'Only sessions started in this directory.' }, limit: { type: 'integer' } }, additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) {
      const rows = sessions.list(ctx, { search: args && args.search, cwd: args && args.cwd, limit: (args && args.limit) || 40 });
      return { sessions: rows.map(function (r) { return { sessionId: r.sessionId, cwd: r.cwd, mtime: r.mtime, preview: r.preview }; }) };
    },
  },
  {
    name: 'keyflip_resume_command', title: 'Get a session resume command',
    description: 'Return the exact command to resume a past conversation in its original directory (does NOT run it). Read-only.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Session id or unique prefix.' } }, required: ['id'], additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) {
      const row = sessions.find(ctx, String(args.id)); if (!row) throw new Error('no such session: ' + args.id);
      const rc = sessions.resumeCommand(row); return { cwd: rc.cwd, command: rc.command + ' ' + rc.args.join(' ') };
    },
  },

  // ---- diagnostics / usage ----
  {
    name: 'keyflip_doctor', title: 'Diagnose config + connectivity',
    description: 'Health report: Claude config dir, login present, desktop app data, and each provider endpoint reachability. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO_NET,
    run: async function (ctx) { return await doctor.diagnose(ctx); },
  },
  {
    name: 'keyflip_usage_history', title: 'Usage trend + failover events',
    description: 'Recent per-account 5h/7d usage samples and autoswitch/failover events. Read-only.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false }, annotations: RO,
    run: async function (ctx, args) { const n = (args && args.limit) || 50; return { usage: history.readUsage(ctx, n), events: history.readEvents(ctx, n) }; },
  },

  // ---- backup ----
  {
    name: 'keyflip_backups', title: 'List backups',
    description: 'List keyflip metadata backups (newest first). Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO,
    run: async function (ctx) { return { backups: backup.list(ctx).map(function (b) { return { name: b.name, sizeBytes: b.sizeBytes, mtime: b.mtime }; }) }; },
  },
  {
    name: 'keyflip_backup_create', title: 'Create a backup',
    description: 'Snapshot keyflip metadata (no secrets). Ask the user first, then confirm=true.',
    inputSchema: { type: 'object', properties: confirmProp, required: ['confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); const r = backup.create(ctx); return { created: r.name, files: r.files }; },
  },
  {
    name: 'keyflip_backup_restore', title: 'Restore a backup',
    description: 'Restore a backup by name or 1-based index (takes a pre-restore safety backup first). Ask the user first, then confirm=true.',
    inputSchema: { type: 'object', properties: { which: { type: 'string' }, confirm: confirmProp.confirm }, required: ['which', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); return backup.restore(ctx, args.which); },
  },

  // ---- skills marketplace ----
  {
    name: 'keyflip_skills', title: 'List installed skills',
    description: 'Skills keyflip installed into ~/.claude/skills. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO,
    run: async function (ctx) { return { skills: require('./skillstore').list(ctx) }; },
  },
  {
    name: 'keyflip_skill_add', title: 'Install a skill',
    description: 'Install a skill from a GitHub repo (owner/repo[@ref][/subdir]), a local directory, or a .tar.gz/.zip. Installs code the agent will run — ask the user first, then confirm=true.',
    inputSchema: { type: 'object', properties: { source: { type: 'string' }, confirm: confirmProp.confirm }, required: ['source', 'confirm'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    run: async function (ctx, args) { needConfirm(args); return { installed: await require('./skillstore').add(ctx, String(args.source), {}) }; },
  },
  {
    name: 'keyflip_skill_remove', title: 'Remove an installed skill',
    description: 'Remove a keyflip-installed skill (never the user\'s own). Ask the user first, then confirm=true.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, confirm: confirmProp.confirm }, required: ['name', 'confirm'], additionalProperties: false }, annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); require('./skillstore').remove(ctx, args.name); return { removed: args.name }; },
  },

  // ---- failover proxy ----
  {
    name: 'keyflip_proxy_status', title: 'Failover proxy status',
    description: 'Is the local failover proxy running? On what port, wired? Per-account request/token totals. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO,
    run: async function (ctx) {
      const meta = proxy.readMeta(ctx);
      const running = !!(meta && meta.pid && (function () { try { process.kill(meta.pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } })());
      return { running: running, port: meta && meta.port, wired: !!(meta && meta.wired), stats: proxy.stats(ctx) };
    },
  },
  {
    name: 'keyflip_proxy_control', title: 'Start/stop the failover proxy',
    description: 'Start or stop the command-activated localhost failover proxy (routes each request to the active account, fails over on 429/5xx). action="start"|"stop"; wire=true also sets ANTHROPIC_BASE_URL. Starting spawns a background process — ask the user first, then confirm=true.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['start', 'stop'] }, wire: { type: 'boolean' }, port: { type: 'integer' }, confirm: confirmProp.confirm }, required: ['action', 'confirm'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    run: async function (ctx, args) {
      needConfirm(args);
      if (args.action === 'start') { const r = proxy.start(ctx, { wire: !!args.wire, port: args.port }); return { started: !r.already, url: r.url, wired: r.wired, port: r.port }; }
      return proxy.stop(ctx);
    },
  },
];

// ---- JSON-RPC / MCP plumbing ---------------------------------------------------

function toolDescriptor(t) {
  return { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations };
}

async function handle(ctx, msg) {
  // A message without an id is a NOTIFICATION — the spec forbids replying to it,
  // whatever its method. Process nothing that needs a response and stay silent.
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } };
  }
  const id = msg.id;
  if (id === undefined) return null;                 // notification → no response ever
  if (id === null) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'request id must not be null' } };

  const respond = function (result) { return { jsonrpc: '2.0', id: id, result: result }; };
  const rpcError = function (code, message) { return { jsonrpc: '2.0', id: id, error: { code: code, message: message } }; };

  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params && msg.params.protocolVersion;
      const version = SUPPORTED_VERSIONS.indexOf(requested) !== -1 ? requested : PROTOCOL_VERSION;
      return respond({
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'keyflip', title: 'Keyflip', version: VERSION },
        instructions: 'Manage the machine\'s saved Claude accounts. Use keyflip_status/keyflip_list to inspect; ' +
          'keyflip_switch/keyflip_next change the active account and REQUIRE confirm=true after asking the user. ' +
          'Switching is in-place: the desktop app is never closed, and a running Claude Code continues on the new account.',
      });
    }
    case 'ping':
      return respond({});
    case 'tools/list':
      return respond({ tools: TOOLS.map(toolDescriptor) });
    case 'tools/call': {
      const params = msg.params || {};
      const tool = TOOLS.filter(function (t) { return t.name === params.name; })[0];
      if (!tool) return rpcError(-32602, 'unknown tool: ' + params.name);
      try {
        const result = await tool.run(ctx, params.arguments || {});
        return respond({
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: false,
        });
      } catch (e) {
        return respond({ content: [{ type: 'text', text: (e && e.message) || String(e) }], isError: true });
      }
    }
    default:
      return rpcError(-32601, 'method not found: ' + msg.method);
  }
}

// Process one parsed message (or a JSON-RPC batch array) and return the response
// to write, or null when there is nothing to send (all-notification batch, or a
// lone notification).
async function handleEnvelope(ctx, parsed) {
  if (Array.isArray(parsed)) {
    if (!parsed.length) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request (empty batch)' } };
    const responses = [];
    for (let i = 0; i < parsed.length; i++) {
      const r = await handle(ctx, parsed[i]);
      if (r) responses.push(r);
    }
    return responses.length ? responses : null;
  }
  return handle(ctx, parsed);
}

// Newline-delimited JSON-RPC over stdio (the MCP stdio transport). Requests are
// processed STRICTLY IN ORDER (promise queue): this server mutates machine state,
// so a client sending dependent calls back-to-back must never observe reordering
// (e.g. a `list` overtaking the `switch` before it).
function serve(ctx, io) {
  io = io || {};
  const input = io.input || process.stdin;
  const output = io.output || process.stdout;
  const rl = readline.createInterface({ input: input, terminal: false });
  let chain = Promise.resolve();
  // Safe write: a broken stdout must not throw into the queue and poison it.
  const send = function (obj) { try { output.write(JSON.stringify(obj) + '\n'); } catch (e) { /* peer gone */ } };

  rl.on('line', function (line) {
    line = line.trim();
    if (!line) return;
    let parsed;
    try { parsed = JSON.parse(line); }
    catch (e) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
    // Each step handles its own errors and the trailing .catch guarantees the
    // chain always resolves — one failing request can never silently stall the rest.
    chain = chain.then(function () {
      return Promise.resolve(handleEnvelope(ctx, parsed)).then(function (res) {
        if (res) send(res);
      }).catch(function (e) {
        const rid = (parsed && !Array.isArray(parsed) && parsed.id !== undefined) ? parsed.id : null;
        send({ jsonrpc: '2.0', id: rid, error: { code: -32603, message: (e && e.message) || 'internal error' } });
      });
    }).catch(function () { /* never leave the chain rejected */ });
  });
  return new Promise(function (resolve) { rl.on('close', function () { chain.then(resolve, resolve); }); });
}

module.exports = { serve: serve, handle: handle, TOOLS: TOOLS, PROTOCOL_VERSION: PROTOCOL_VERSION };
