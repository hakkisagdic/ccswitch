# Multi-agent memory / config / sessions — spec (epics J1 + F)

> From a keyflip research pass (2026-07-06). Paths marked **NEEDS-VERIFICATION** were not
> confirmed on a real install and must be checked before shipping that tier. keyflip rules
> hold: zero-dep, **secrets never in git**, opt-in per tool.

## J1 — carry other agents' MEMORY + config across machines

Per-tool registry (home-level unless noted). keyflip's `agents` bundle carries the **memory /
instruction files** (markdown, no secrets); config files that hold secrets are opt-in + gitignored.

| Tool | Memory (instructions) | Config | Secrets (NEVER commit) | Confidence |
|---|---|---|---|---|
| **Cursor** | `~/.cursor/rules/` (+ project `.cursor/rules/`, legacy `.cursorrules`) | `~/.cursor/mcp.json` | `mcp.json` if it inlines keys (use `${env:VAR}`) | HIGH |
| **Gemini CLI** | `~/.gemini/GEMINI.md` | `~/.gemini/settings.json`, `*/mcp_config.json` | `~/.gemini/oauth_creds.json` | HIGH |
| **Copilot CLI** | `.github/copilot-instructions.md`, `AGENTS.md` (project-level) | `~/.copilot/config.json`, `mcp-config.json` | `~/.copilot/data.db` (token), `mcp-config.json` | HIGH (files) / MED (db) |
| **Codex CLI** | `~/.codex/AGENTS.md`, `~/.codex/memories/*.md` | `~/.codex/config.toml` | `~/.codex/auth.json` | MED (Codex deprecated) |
| **opencode** | NEEDS-VERIFICATION (instruction location) | `~/.config/opencode/opencode.json` | `~/.local/share/opencode/auth.json` | MED |
| **Aider** | `CONVENTIONS.md` (project, via `.aider.conf.yml read:`) | `.aider.conf.yml` | `.env` | MED |

**keyflip J1 v1 (SHIPPED):** the **home-level markdown memory** only — `~/.cursor/rules/`,
`~/.gemini/GEMINI.md`, `~/.codex/AGENTS.md` + `~/.codex/memories/` — existence-gated, opt-in via
`keyflip migrate export … --agents` (and `transfer`/`push`). Project-level files (`.cursorrules`,
`copilot-instructions.md`, `CONVENTIONS.md`) travel with their git repos, so they're out of scope.
Config files (secrets) are deferred (opt-in + secret-scan first — see below).

Surface: `src/agents.js` (`REGISTRY`, `collectAgentMemory`, `mergeAgentMemory`, `presentAgents`) →
`keyflip agents` (inspect, read-only), `--agents`/`--agents=cursor,gemini`/`--only-agents` bundle
filters, MCP `keyflip_agents` + `agents:true`/`agent_ids` on `keyflip_migrate_export`. Merge is
union (kept unless `--force`), guarded against path-traversal and non-markdown writes. Only `.md`
/`.mdc`/`.txt` are ever collected or written — auth/config JSON can never ride along.

**Secret safety:** before carrying any *config* file, scan for plaintext keys (`sk-`, `Bearer `,
`"token"`, `_API_KEY`) and refuse/warn; recommend `${env:VAR}` refs. gitignore: `oauth_creds.json`,
`auth.json`, `*.env`, `data.db`, any mcp config with inline keys.

**CONFIG-TIER SHIPPED (2026-07-07):** `src/secretscan.js` (reusable scanner/redactor) + `agents.js`
`CONFIG_REGISTRY` (Cursor `~/.cursor/mcp.json`, Gemini `~/.gemini/settings.json`, Codex
`~/.codex/config.toml`). `collectAgentConfig` redacts on the way out, `mergeAgentConfig` re-redacts
on the way in (defence in depth) + refuses unknown paths + symlink-guards. Behind opt-in
`--agent-config` / `--only-agent-config` and MCP `agent_config:true`. Known token shapes +
credential-key-name redaction; `${VAR}` refs and `*_TOKENS` limits preserved. Residual gap: a secret
under a benign key with no known prefix can slip — encrypt real transfers.

## F — read/normalize other tools' SESSION stores

**v1 SHIPPED (2026-07-07):** `src/foreign.js` — `keyflip foreign <file>` + MCP `keyflip_foreign_export`.
Detects + normalizes a session-log FILE into keyflip's unified conversation shape (the same
`transcript.parse` output), then renders it as markdown/HTML/json via the Claude Code exporter.
Supported now (zero-dep, tolerant): **message-event JSONL** (Claude Code, and Gemini-style
`transcript.jsonl`) via the tested `transcript.parse`; **Cursor SQLite** (`cursorDiskKV`) via a
**from-scratch zero-dep SQLite reader** `src/sqliteread.js` (header + table B-tree + record serial
types + overflow-page chains — verified against real sqlite3 fixtures), with a best-effort
bubble→message mapping (order from the composer header list, role from `type`); **generic JSON**
(opencode + others — largest array of `{role, text/content}` objects); **Aider**
`.aider.chat.history.md` via a best-effort markdown parser. The Cursor/JSON/Aider mappings are
NEEDS-VERIFICATION against a real install — the SQLite *reader* itself is fixture-verified.
Deferred: **Copilot** (YAML — needs a parser). Each parser is isolated behind `detect()`, so
adding a source later is one function + a fixture test.

Unified shape: `{ tool, sessionId, created_at, updated_at, resumable, resumeCommand, messages[], metadata }`.

| Tool | Session path | Format | Resumable | Feasibility |
|---|---|---|---|---|
| **Copilot** | `~/.copilot/session-state/<id>/` (workspace.yaml + checkpoints/index.md) | YAML+MD | ✅ `copilot --resume=<id>` | easiest |
| **Gemini** | `~/.gemini/antigravity-cli/brain/<UUID>/…/transcript.jsonl` (+ conversations/<UUID>.db) | JSONL | ✅ | easy |
| **Cursor** | `~/.cursor/chats/*store.db` (`cursorDiskKV`: `composerData:*`, `bubbleId:*`) | SQLite | ✅ `cursor agent --resume <id>` | medium |
| **opencode** | `~/.local/share/opencode/project/*/storage/` (`ses_*`) | JSON/JSONL (NEEDS-VERIFICATION) | ✅ `opencode --session <id>` | medium |
| **Aider** | `.aider.chat.history.md` per repo | Markdown | ⚠️ partial (no session ids) | hardest |

Normalization is per-tool (SQLite/YAML/JSONL parsers). Ship order: Copilot → Gemini → Cursor →
opencode → Aider. Reuse keyflip's `sessions`/`recall` once normalized into the unified shape.

### Verification checklist (run on a machine with these tools)
- opencode: instruction-file location + `storage/` message schema + `--session` resume.
- Copilot: `data.db` token extraction (or skip — carry only the memory md).
- Aider: whether any `--resume`/session-list exists.
- Cursor: `cursorDiskKV` bubble ordering for a faithful transcript.
