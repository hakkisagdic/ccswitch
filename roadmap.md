# keyflip Roadmap

> Status: **planning only.** Nothing in this file is implemented yet unless it
> already ships in the current release (v1.5.0). This document is the agreed
> backlog we will build from, in roughly the order below. Prices, star counts and
> product details are a **mid‑2026 snapshot** and drift — treat them as
> directional, re‑verify before building against any specific number.
>
> Companion docs: [README.md](README.md) · [README.tr.md](README.tr.md) ·
> [skills/keyflip/SKILL.md](skills/keyflip/SKILL.md). When any item here ships,
> update all three (EN + TR + skill) in lockstep.

---

## 0. North Star — what keyflip is becoming

keyflip today (v1.5.0) is a **multi‑account switcher for Claude** with provider
profiles, a command‑activated failover proxy, an MCP server, and local
Cowork/Chat/session tooling.

Where it is going: **the universal control plane for every AI coding surface,
subscription, and API key on one machine** — one place to *hold* every login,
*route* every request, *stretch* every quota, and *present* it all cleanly.
Everything stays **command‑activated — never an always‑on background daemon**
(this is a hard product rule, applied to the proxy, the router, and the bridge).

**The one idea underneath everything: account switching.** keyflip's whole reason
to exist is holding *many* accounts and switching between them. Generalized, that
becomes **quota rotation** — for any tool with a capped/free tier (Copilot 2k/mo,
Trae 5k/mo, Antigravity 20/day, Claude 5h/7d…), holding N accounts and rotating
them gives **N× effective quota**. Every surface, plan and tool in this doc is
judged by that lens: *what is the account unit, and can keyflip swap it?* (The
switchability taxonomy A–E lives in §E1.)

Four pillars everything below hangs off:

| Pillar | One line | Epic |
|---|---|---|
| **HOLD** | Hold *multiple* accounts per surface (IDE / CLI / chat / extension) and **switch/rotate** them — subscriptions *and* API keys — for N× quota. | **E1** |
| **ROUTE** | Switch at the *request* level: send each request across accounts/providers/models with rules, fallback, fusion — one key, one declared model, keyflip decides. | **E3** |
| **BRIDGE** | Turn a subscription into an API endpoint (Copilot/ChatGPT — the "copilot api" project), then rotate a *pool* of subscriptions behind one key. | **E2** |
| **PRESENT** | One central settings store + per‑surface run‑mode & rotation policy, a real TUI account switcher, and full MCP parity. | **E4, E5** |

Guiding constraints (carried from the whole project, non‑negotiable):

- No secrets in the repo. OAuth tokens / API keys live only in the OS credential
  store. **Never** pass a secret via argv — `--key-file`/stdin only.
- Command‑activated, not daemonized. Everything the user starts, the user stops.
- `~/.claude/projects` history and the live login are never mutated except through
  explicit commands.
- Never delete/unpublish/switch without explicit consent.
- Subscription⇄API bridging (E2) is a **ToS gray area** — see §5. Ship it as an
  opt‑in, clearly‑labeled, self‑hosted‑only capability; never a default.

---

## 1. Phase 0 — competitor‑adoption backlog (already scoped)

The 19 items from the router/switcher deep‑scan (claude‑code‑router 35k★,
claude‑relay‑service 12k★, clother, ccconfig, config‑switcher). Kept as the
near‑term backlog; several are prerequisites for the big epics (E3 especially).

### Phase 0a — quick wins (low effort)
| # | Item | Feeds |
|---|---|---|
| 2 | Honor `Retry-After` + exponential backoff before failing over on 429 | E3 |
| 3 | Authoritative‑reset‑only 429 triage (don't fail over on billing/org‑disabled 429s) | E3 |
| 9 | Priority + LRU deterministic account ordering (`priority` field) | E3 |
| 10 | Route‑decision debug headers / `--verbose` (`x-keyflip-account`, `-route-reason`) | E3 |
| 14 | `keyflip test --all` parallel provider health check | — |
| 15 | `keyflip provider fork <src> <new>` duplicate a provider config | — |

### Phase 0b — provider ecosystem (the biggest gap vs competitors)
| # | Item | Feeds |
|---|---|---|
| 1 | **Built‑in preset catalog** (`src/catalog.json`): Z.AI/GLM, Kimi, MiniMax, DeepSeek, Qwen, OpenRouter, Ollama/LM Studio… base_url + tier models, so `keyflip provider add <id>` needs only the key | E1, E3 |
| 17 | Interactive provider picker (numbered, category‑grouped) — argument‑less `provider add` | E5 |
| 16 | `keyflip test`/`provider models` → query `/v1/models`, suggest a default model | — |

### Phase 0c — smart‑router substrate (→ folds into E3)
| # | Item |
|---|---|
| 4 | Declarative `proxy-routes.json` with mtime hot‑reload |
| 5 | Rule‑based routing engine + no‑dep token estimator |
| 6 | Fallback modes: `off` / `retry` / `model-chain` (incl. model degradation) |
| 7 | Per‑provider + per‑route body/header rewrites (transformers) |
| 8 | Sticky same‑conversation‑same‑account routing (`user_id` key + TTL map) |
| 19 | Custom router script hook (`CUSTOM_ROUTER_PATH`) |

### Phase 0d — reliability, cost & tier awareness
| # | Item |
|---|---|
| 11 | Per‑error‑type cooldown TTLs + `keyflip cooldown` / `reset` readout |
| 12 | Model‑eligibility filtering by subscription tier (Free≠Opus) before selecting an account |
| 13 | Fine‑grained cost accounting (cache tiers + 200k + fast‑mode multiplier) |
| 18 | Self‑updating model‑pricing table (LiteLLM prices, SHA‑256 verified, bundled fallback) |

---

## 2. The big epics

### E1 — Universal surface support (HOLD every credential)

**Goal:** do for *every* AI coding surface what keyflip already does for Claude —
**hold multiple accounts and switch between them.** Not a feature list of other
tools; the whole point is the switch. The same primitives (capture, switch, list,
doctor, backup, run‑isolated) generalized over a **surface registry**.

**Why this is the core value — quota rotation (the universal keyflip play).**
Every one of these surfaces has a *capped* tier: Copilot Free 2k completions/mo,
Trae Free 5k/mo, Antigravity 20 req/day, Kiro 50 credits/mo, Cursor/Windsurf free
tiers, Claude 5h/7d windows. Hold **N accounts** of the same tool and rotate them,
and the effective quota is **N×**. That is exactly the Claude play — generalized to
Copilot, Cursor, Trae, Gemini CLI, everything. So each catalog entry is judged by
one question: **what is the account unit, and can keyflip swap it?**

**Switchability taxonomy** (drives which adapters are cheap vs hard):

| Class | Credential shape | Switch = | Examples | keyflip effort |
|---|---|---|---|---|
| **A — file/token swap** | readable JSON/YAML/token file | capture N, restore one | Codex `auth.json`, Gemini `settings.json`, Copilot CLI `config.json`, opencode `auth.json`, Aider yaml/env, Cursor SQLite session | **low** (does this already) |
| **B — OS keychain** | macOS Keychain / libsecret / DPAPI | swap keychain item | Claude Code, Zed, Goose, Copilot‑CLI (default) | **medium** (already solved for Claude on macOS) |
| **C — cloud session/cookie** | server‑side session + cookie/token | swap cookie/token, re‑auth fragile | Claude desktop, chat apps, some IDEs | **high** (fragile — like today's Chat) |
| **D — bundled, vendor‑account switch** | one vendor login, keys bundled server‑side | switch the *vendor account* → resets its free quota | Trae (ByteDance), Qoder, Antigravity, Kiro | **the account is the vendor login** — rotate it for N× free quota |
| **E — BYO key (not an account)** | provider API key | this is a **provider profile**, already shipped | Cline, Aider, Continue, any BYOK tool | **done** (use `provider`) |

**Surface adapter model** (`src/surfaces/<id>.js`), each declaring:
```
{ id, kind: 'cli'|'ide'|'desktop'|'chat'|'extension',
  switchClass: 'A'|'B'|'C'|'D'|'E',
  accountUnit: 'github'|'google'|'bytedance'|'vendor'|'apikey'|...,
  credStore: 'keychain'|'file'|'sqlite'|'dpapi'|'oauth-token'|'cookie',
  path(ctx), read(ctx), swap(ctx, account), hotReload: bool, notes }
```

Work items (all framed as *switch multiple accounts of X*):
- **E1.1** Surface registry + adapter interface; migrate existing Claude Code +
  Claude‑desktop logic onto it (no behavior change). They become Class B/C rows.
- **E1.2** Class‑A CLI adapters (highest ROI, lowest effort — pure file swap):
  **Codex**, **Gemini CLI**, **Copilot CLI**, **opencode**, **Aider**, **Crush**,
  **Plandex**, **OpenHands**. Each = "hold & rotate multiple logins of this CLI."
- **E1.3** Class‑B (keychain) adapters: **Zed**, **Goose**, **Amazon Q** (AWS SSO
  cache). Reuse the Claude‑macOS keychain code.
- **E1.4** Class‑D vendor‑account rotation for the bundled IDEs (**Trae, Qoder,
  Antigravity, Kiro, Copilot**): the switch swaps the editor's stored login so a
  fresh account = a fresh free‑tier bucket. Scope read‑only first; verify a
  round‑trip before writing another app's store.
- **E1.5** `keyflip surfaces` — list every detected surface, which account each is
  on, remaining quota per account (so you can see when to rotate), health.
- **E1.6** Cross‑surface switch: `keyflip use <account> --surfaces codex,gemini`
  moves several surfaces to one identity at once; `keyflip next --surface trae`
  rotates just that surface to its next‑freshest account.
- **E1.7** Generalize `run` isolation (today `CLAUDE_CONFIG_DIR`) to per‑surface
  env‑var isolation, so one terminal can be pinned to one account of one surface
  while everything else stays put.

**Reality check:** Class C/D touch OS‑specific stores (Keychain, DPAPI, libsecret)
or cloud sessions. Staged approach as with Claude: switch where the format is open,
mark the rest "detected but manual," never write another app's secret store without
a verified round‑trip. Class D also raises ToS questions per vendor (multi‑account
free‑tier farming may violate a tool's terms) — surface that, same as §5.

---

### E2 — Subscription ⇄ API‑key bridge ("keyflip serve" / the *copilot api* project)

**Goal (the "very big" feature):** expose a **single local API key** from keyflip;
requests to it get **fulfilled out of a subscription's quota** — e.g. a GitHub
Copilot, ChatGPT, or Claude Max plan — instead of a metered API key. keyflip hands
out an OpenAI/Anthropic‑compatible endpoint; behind it, it spends whichever
*subscription* has headroom.

**Precedent (proves it's feasible):** [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api)
turns a GitHub Copilot subscription into an OpenAI **and** Anthropic‑compatible
server ("usable with Claude Code"): GitHub OAuth device‑flow token persisted to
`~/.local/share/copilot-api/github_token`, a short‑lived Copilot token
auto‑refreshed before expiry, endpoints `/v1/chat/completions` + `/v1/messages`
+ `/v1/models`, Individual/Business/Enterprise plans, and a **`GET /usage`**
quota endpoint. [caozhiyuan/copilot-api](https://github.com/caozhiyuan/copilot-api)
adds `/v1/responses` + third‑party providers. This is exactly the shape of the
user's "copilot api" project — E2 brings that capability *inside* keyflip.

> **⚠️ Load‑bearing compliance finding (verified mid‑2026):** the bridge target
> matters. **Copilot** bridges work by reverse‑engineering GitHub's internal
> endpoint — a gray area, "not GitHub‑supported," with account‑suspension risk on
> abuse, but functional. **Claude Pro/Max is different: Anthropic actively
> BLOCKS third‑party‑harness use of subscription OAuth as of 2026‑04‑04**
> (OpenClaw/OpenCode/NanoClaw were cut off; it's an enforced ToS violation, not
> just a gray area). **So E2 does NOT build a Claude‑subscription backend** — for
> Claude, keyflip uses only real API keys / Bedrock / Vertex. ChatGPT bridging
> sits between (exists, ToS‑risky, less aggressively enforced than Anthropic).

Architecture (reuses the E3/proxy machinery — command‑activated, localhost‑only):
- **E2.1 Bridge core:** `keyflip serve --wire` starts a local OpenAI/Anthropic‑
  compatible endpoint (same detached‑process + `/__keyflip_ping` identity model as
  the proxy). Emits a local key; nothing leaves 127.0.0.1 unless explicitly bound.
- **E2.2 Copilot backend (primary):** translate the emitted API contract ⇄ the
  Copilot backend, using the Copilot token captured by the E1 Copilot adapter;
  poll its `/usage` so keyflip's usage history and breaker treat it like any
  account. This is the flagship E2 backend.
- **E2.3 Other backends — scoped by compliance:** ChatGPT (Codex backend, ToS‑risky
  opt‑in); **NOT Claude subscription (blocked — see finding above)**; plus the
  *reverse* — front a real API key behind the local endpoint so a tool that only
  speaks one dialect can reach any provider (fully compliant, ship freely).
- **E2.4 Pool bridging:** combine E2 with E3 so one emitted key round‑robins /
  fails over across *several* eligible subscriptions (Copilot + ChatGPT) + API
  keys, each spent to its cap — "all memberships behind one API key."
- **E2.5 Accounting & guardrails:** per‑subscription token/quota accounting, a
  hard stop before a plan's cap, and clear ToS labeling (§5).

**Risk:** the item most in tension with provider ToS (§5). Ship opt‑in,
self‑host‑only, off by default, with a printed warning naming the specific
provider's stance on first `serve`.

---

### E3 — Embedded model router + fusion (9router / OpenFugu / OpenRouter‑Fusion class)

**Goal:** the user declares **one API key and one model** to their tool; keyflip
does all model management behind it — tiered fallback, rule routing, and
optionally *fusion/orchestration* across many models. Command‑activated, no daemon.

This is the natural growth of the existing failover proxy (`src/proxy.js`) plus
Phase‑0c. Build it as escalating **router modes**, cheapest/simplest first:

- **E3.0 Substrate** = Phase‑0c (routes.json + hot‑reload + rule engine + token
  estimator + transformers + sticky + custom hook). Everything below rides on it.
- **E3.1 Tiered fallback (9router‑style).** Ordered tiers: Tier‑1 subscription
  (Claude Max / Copilot via E2) → Tier‑2 cheap (GLM/MiniMax/DeepSeek) → Tier‑3
  free/local (Ollama, free provider keys). On limit/failure, drop a tier. Mirrors
  [decolua/9router](https://github.com/decolua/9router)'s model. *(Note: 9router
  advertises "RTK −40% tokens" — it already uses the user's own RTK compressor;
  keyflip's router can integrate RTK the same way as an optional pre‑pass.)*
- **E3.2 Rule routing.** Route by request shape: long‑context → a big‑context
  model, cheap/short → a small model, code vs prose, tool‑use, etc. (Phase‑0 #5.)
- **E3.3 Fusion mode (OpenRouter‑Fusion‑style).** Optional: fan the prompt to a
  **panel** of models in parallel, a judge synthesizes (consensus / contradictions
  / blind spots) into one answer. ~4–5× cost — strictly opt‑in per route, for
  high‑stakes prompts. Ref: [OpenRouter Fusion](https://openrouter.ai/docs/guides/features/plugins/fusion).
- **E3.4 Orchestrator mode (Fugu / OpenFugu‑style).** The most advanced: a
  coordinator decides **up front** which models to call and in what order, then
  combines — closer to [Sakana Fugu](https://sakana.ai/fugu) /
  [OpenFugu](https://github.com/trotsky1997/OpenFugu) than to Fusion's
  parallel‑then‑synthesize. Longer‑horizon; likely pluggable (bring‑your‑own
  orchestrator via the E3.0 custom hook) rather than a trained model we ship.
- **E3.5 `keyflip route`** front‑end: `keyflip route start --mode tier|rule|fusion|orchestrate`,
  `keyflip route explain` (dry‑run a request and print the decision), plus the
  debug headers from Phase‑0 #10.

**Distinction to keep straight** (informs which mode to reach for):
Fusion = ask several **in parallel**, then synthesize. Fugu = decide **up front**,
call in sequence, then combine. Tiered = one at a time, fall down the ladder on
failure. keyflip should offer all three under one `--mode` flag.

---

### E4 — Centralized settings & run‑mode manager

**Goal:** one place for every decision, including **how each surface comes up** —
in‑app, service mode, or command‑activated — so the scattered flags become a
single, inspectable configuration.

- **E4.1 One settings store:** `<configDir>/keyflip.config.json` (schema‑versioned,
  the same corruption‑safe read/write as everything else — `readJsonForWrite`,
  atomic + rollback). Absorbs today's scattered options (proxy defaults, breaker
  TTLs, autoswitch threshold, provider prefs, sync target…).
- **E4.2 Run‑mode per capability:** for the proxy, router (E3), and bridge (E2),
  declare a `runMode`: `command` (default — start/stop by hand), `wired`
  (auto‑wire the active tool when started), or `service` (opt‑in, user‑managed
  background start — still never a hidden daemon; the user installs it knowingly,
  e.g. a launchd/systemd unit keyflip can *generate* but not silently enable).
- **E4.3 Per‑surface policy:** which account each surface defaults to, whether a
  switch also restarts that surface, hot‑reload vs restart behavior (E1 metadata).
- **E4.4 `keyflip config`:** get/set/edit/validate/reset, `--json` for scripts,
  and a TUI editor (E5). Import/export a profile (no secrets) — reuses `share`.
- **E4.5 Precedence + doctor:** documented precedence (env > flag > config >
  default) and `keyflip doctor` validates the config and every declared run‑mode.

---

### E5 — TUI layer (present every screen properly)

**Goal:** all interactive screens (menu, account list, usage dashboard, provider
picker, route explainer, config editor) rendered through a proper terminal UI —
much nicer than today's line printing — **without breaking the zero‑dependency
rule**.

Recommendation (see §3.7): build a **small self‑contained ANSI/TUI helper module**
(`src/tui/`) on Node stdlib — alternate screen buffer (`\x1b[?1049h`), raw‑mode key
handling via `readline`, a tiny box/table/list/live‑update toolkit — rather than
adopting a heavy dependency (blessed is effectively unmaintained; Ink pulls in
React + a large tree). This keeps keyflip installable as a single dependency‑free
package while delivering a big visual upgrade. Reuse the existing `src/style.js`
color helper.

- **E5.1** ANSI core: alt‑screen, cursor, raw keys, resize (`SIGWINCH`), Windows
  terminal quirks, graceful fallback to plain mode when not a TTY / `NO_COLOR`.
- **E5.2** Widgets: selectable list/menu, table, key‑value panel, progress/spinner,
  live‑refresh region (`log-update`‑style, home‑grown).
- **E5.3** Screens: main menu (`menu.js` upgrade), `list --usage` dashboard,
  provider/catalog picker (Phase‑0 #17), `route explain`, `config` editor (E4.4).
- **E5.4** Everything degrades: every TUI screen has a `--json` / plain‑text twin
  so scripts and MCP are unaffected.

---

## 3. Reference catalogs

Comprehensive lists of the surfaces, plans, tools and extensions keyflip aims to
cover. **Snapshot, mid‑2026 — verify before building.** Items marked ⚠️ are ones I
could not fully verify and should be re‑checked.

### 3.1 AI IDEs / editors

Last column = **the account‑switching angle** (switch class from E1 + what rotating
multiple accounts buys). That is why each tool is here — not its feature set.

| Product | Vendor | Auth model | Free/capped tier | **keyflip account‑switch angle** |
|---|---|---|---|---|
| **Cursor** | Anysphere | Cursor login **or** BYO key | Free tier; Pro $20 | **A** — swap `~/.cursor/` session (SQLite, plaintext); rotate logins → N× free/fast‑request quota |
| **Windsurf → Devin Desktop** | Cognition | Account login (no BYO key) | Free tier | **C ⚠️** — cred path undocumented; rotate accounts for free credits (verify first). Rebranded 2026‑06‑02 |
| **Google Antigravity** | Google | Google account | **20 req/day** (cut from 250) | **D** — swap Google login → **N× the 20/day**; highest‑value rotation target |
| **AWS Kiro** | Amazon | GitHub/Google/AWS ID | 50 credits/mo | **D** — rotate login → N× 50 cr/mo |
| **Qoder** | Alibaba | Email/Google/GitHub; BYOK (Community) | Community free | **D** (or **E** if Community BYOK) — rotate accounts → N× free; BYOK path = provider profile |
| **Trae** | ByteDance | ByteDance account (bundled keys) | **Free 5k completions/mo** | **D** — swap ByteDance login → **N× 5k**; ⚠️ heavy telemetry + multi‑acct ToS |
| **Zed** | Zed Industries | BYO key **or** Claude Code (ACP) | Free; Pro $10 | **B/E** — OS‑keychain swap; mostly BYOK → provider profile |
| **GitHub Copilot** (VS Code/JetBrains) | GitHub/MS | GitHub login | Free 2k completions/mo | **D+B** — swap GitHub login → N× free/plan credits; **also E2 bridge** |
| **JetBrains AI + Junie** | JetBrains | JetBrains account; local/BYOK | AI Free 3 cr | **C** — swap JetBrains login → N× credits; BYOK path too |
| **Replit (Agent)** | Replit | Replit account | credit‑based | **C**, lower priority |
| **Cline / Kilo Code / Void / PearAI / Aide** | various OSS | **BYO key** | Free (BYO) | **E** — the "account" is the API key → already **provider profiles** (shipped) |
| ~~**Roo Code**~~ | RooCodeInc | — | — | **dropped** — shut down 2026‑05‑15 (→ Cline/Kilo) |
| ~~**Continue.dev**~~ | acq. Cursor | BYO/hosted | — | **reference only** — winding down (cloud data deleted 2026‑07‑15) |
| **Augment / Tabnine / Cody** | resp. | Account / SSO | mostly **no free tier** | **C**, lower priority — paid‑only ⇒ little rotation value |
| **Amazon Q Developer** | Amazon | AWS Builder ID | Free / Pro $19 | **B** — swap AWS SSO cache (`~/.aws/sso/cache/`) |
| **Bolt.new / v0 / Lovable** | resp. | Account (credits) | Free credits | **C/D** — rotate for free credits; web surface, low priority |

### 3.2 AI CLIs / terminal agents  *(credential paths matter for E1)*

| Tool | Vendor | Install | Auth | **Credential location** | Plans |
|---|---|---|---|---|---|
| **Claude Code** ✅ | Anthropic | `npm i -g @anthropic-ai/claude-code` | Claude.ai OAuth (Pro/Max/Team/Ent) **or** API key | **macOS Keychain** svc `Claude Code-credentials`; Linux/Win `~/.claude/.credentials.json` (0600); honors `CLAUDE_CONFIG_DIR` | Pro ~$17–20 / Max $100 / Max20 $200 / Console API |
| **Codex CLI** ✅ | OpenAI | `npm i -g @openai/codex` / brew / curl | ChatGPT OAuth (Plus/Pro/Business/Edu/Ent) **or** API key | **`~/.codex/auth.json`** (plaintext by default); `cli_auth_credentials_store=keyring` opts into OS store; `$CODEX_HOME` overrides | Included in ChatGPT paid plans, or API rates |
| **Gemini CLI** ✅ | Google | `npm i -g @google/gemini-cli` | OAuth browser login **or** `GEMINI_API_KEY` | **`~/.gemini/settings.json`**; key via env or `~/.env` | Free tier (→ "Antigravity CLI" after 2026‑06‑18 ⚠️) / API |
| **GitHub Copilot CLI** ✅ | GitHub | `npm i -g @github/copilot` | OAuth device flow | **`~/.copilot/config.json`** (keychain default, plaintext fallback); `COPILOT_HOME` overrides | Copilot plans (see 3.1) |
| **opencode** ✅ | SST | `npm i -g opencode-ai` / brew | `opencode auth login`; BYO keys | **`~/.local/share/opencode/auth.json`** (dedicated encrypted store) | Free (BYO) |
| **Aider** ✅ | open source | `pip`/`uv` | Provider API keys (env) | **plaintext `.aider.conf.yml`** (home/repo) or env vars — no encrypted store ⚠️ | Free (BYO) |
| **Amazon Q CLI** ✅ | Amazon | brew/download; `q login` | AWS Builder ID / IAM Identity Center | **`~/.aws/sso/cache/`** (tokens), `~/.aws/config` | Free / Pro (IAM IC SSO) |
| **Crush** ✅ | Charm | brew/go | BYO keys or `crush login` OAuth2 | **`~/.config/crush/crush.json`** (`CRUSH_GLOBAL_CONFIG` overrides) | Free (BYO) |
| **Goose** ✅ | Block | binary | BYO keys / OAuth | OS keychain **or** `~/.config/goose/secrets.yaml`; config `~/.config/goose/config.yaml` | Free (Apache‑2.0; Linux Foundation) |
| **Warp** ✅ | Warp | app | Warp account + BYO keys | `~/.warp/` (macOS `settings.toml`); Linux `~/.config/warp-terminal/` | Free 75cr / Build $20 / Max $200 / Business $50 |
| **OpenHands** ✅ | OpenHands | pip/docker | BYO keys + GitHub OAuth | **`~/.openhands/`** (`OH_PERSISTENCE_DIR`), FileSecretsStore | Free/OSS (self‑host) |
| **Plandex** ✅ | Plandex | binary | BYO keys | **`~/.plandex/`**; cloud service sunset 2026 | Free/OSS |
| **Codebuff** ✅ | CodebuffAI | npm | GitHub OAuth | `~/.codebuff/` ⚠️ (unverified) | Free (FreeBuff) + paid ⚠️ |

✅ = verified this pass. ⚠️ = re‑verify path/plan before building an adapter.
**Account‑switch angle (why these are here):** almost every CLI stores a plaintext
JSON/YAML token under `~/.config/<tool>` or `~/.<tool>` → **Class A**, a trivial
file swap, so keyflip can *hold and rotate multiple logins per CLI* exactly like it
does for Claude Code — N accounts = N× quota / rate‑limit headroom. Only Claude Code
(Keychain), Zed/Goose (OS keychain), Copilot CLI (keychain‑default) are **Class B**
(OS‑store handling, already solved for Claude on macOS). BYO‑key CLIs (Aider, Cline)
are **Class E** → provider profiles, already shipped.

### 3.3 Consumer chat / assistant apps  *(subscription surfaces; some are E2 bridge targets)*

| App | Vendor | Tiers (rough $/mo) |
|---|---|---|
| **ChatGPT** | OpenAI | Free / Plus $20 / Pro $200 (20× quota, Sora) / Team / Enterprise |
| **Claude.ai** | Anthropic | Free / Pro $20 / Max 5× $100 / Max 20× $200 / Team / Enterprise |
| **Gemini app** | Google | Free / AI Pro $19.99 / AI Ultra $250 |
| **Microsoft Copilot** | Microsoft | Free / Copilot Pro $20 / M365 Copilot (business) |
| **Perplexity** | Perplexity | Free / Pro $20 / Max $200 / Edu $4.99 |
| **Grok** | xAI | Free / SuperGrok $30 / Heavy $300 |
| **Mistral Le Chat** | Mistral | Free (mostly API/enterprise; thin consumer tier ⚠️) |
| **DeepSeek** | DeepSeek | Free chat only (+5M free API tokens; no paid consumer tier) |

**Account‑switch angle:** these are all **Class C** — the login is a server‑side
session + cookie (the exact surface keyflip's existing Chat/desktop switching
already touches for Claude.ai). Rotating multiple chat accounts → more message
quota (ChatGPT 160/3h, Claude 5h/7d windows, etc.). Same play, but Class C is the
**fragile** tier: cookies expire, re‑auth may be interactive, and ⚠️ several of
these (esp. Claude.ai) forbid automated multi‑account use — see §5. Ship read/switch
where a captured cookie round‑trips; never scrape or bypass a login wall.

### 3.4 Providers & token plans (API)

| Provider | Model families | Notes |
|---|---|---|
| **Anthropic API** | Claude Opus / Sonnet / Haiku | per‑MTok in/out; cache tiers; 200k tier |
| **OpenAI API** | GPT‑5.x, o‑series | usage‑based |
| **Google Gemini API** | Gemini (AI Studio + Vertex) | free tier + paid |
| **xAI Grok API** | Grok | usage‑based |
| **Mistral / DeepSeek / Groq / Together / Fireworks** | open + own | cheap/fast tiers — good E3 Tier‑2 |
| **OpenRouter** | 300+ models aggregated | **credit/prepaid**; Auto Router + **Fusion** (E3.3) |
| **Amazon Bedrock / Azure OpenAI** | multi | cloud‑billed; Claude Code supports natively |
| **China: Z.AI/GLM, Moonshot/Kimi, MiniMax, Qwen, Volcengine** | own | very cheap — prime E3 Tier‑2/catalog (Phase‑0 #1) |
| **Local: Ollama / LM Studio / llama.cpp** | open weights | free — E3 Tier‑3 |

> **Verified cheap Tier‑2 anchors (mid‑2026, per‑1M in/out — re‑verify, volatile):**
> DeepSeek V4 Flash **$0.14/$0.28** (cache‑hit input ~$0.003), Mistral Small 4
> **$0.15/$0.60**, Groq Llama‑3.1‑8B **$0.05/$0.08**, Together Llama‑3.3‑70B
> **~$1.04** flat. Near‑universal levers: **batch −50%**, **cached‑input −50%**.
> Frontier refs: GPT‑5.5 $5/$30, Claude Fable 5 $10/$50, Claude Opus $5/$25.
> **OpenRouter passes provider price through with no markup** (revenue = ~5.5%
> credit top‑up fee; BYOK = first ~1M req/mo free then 5%). These figures should
> feed Phase‑0 #18's self‑updating pricing table, not be hard‑coded.

> **Verified base URLs for the Phase‑0 #1 catalog (OpenAI/Anthropic‑compatible):**
> Anthropic `https://api.anthropic.com/v1` · OpenAI `https://api.openai.com/v1` ·
> Gemini `https://ai.google.dev` · xAI `https://api.x.ai/v1` · **GLM/Zhipu**
> `https://open.bigmodel.cn` (CN) / Z.AI (intl) · **Kimi/Moonshot**
> `https://api.moonshot.ai` · **MiniMax** `https://api.minimax.io` (intl) /
> `api.minimaxi.com` (CN) · **Qwen/Alibaba** `https://dashscope.aliyuncs.com`
> (CN) / `dashscope-intl.aliyuncs.com` · **Ollama** `http://localhost:11434/v1`
> · **LM Studio** `http://localhost:1234/v1` · **llama.cpp**
> `http://localhost:8080/v1`. ⚠️ China per‑model prices vary — resolve via a
> gateway or the provider directly.

### 3.5 Routers / gateways / fusion (prior art for E3)

| Project | What it is | Lesson for keyflip |
|---|---|---|
| **[9router](https://github.com/decolua/9router)** (19k★, JS) | 3‑tier fallback sub→cheap(GLM ~$0.6)→free(Kiro/Vertex); real‑time cross‑account quota; **RTK losslessly filters git‑diff/grep/ls/tree output** before send (−20–40% input) | E3.1 model; **RTK pre‑pass on tool output** |
| **[OmniRoute](https://github.com/diegosouzapw/OmniRoute)** / n9router | 9router forks, 231+ providers, TS rewrite of CLIProxyAPI | breadth of provider coverage |
| **claude‑code‑router** (musistudio) | routes.json + rule engine + **20+ transformers** normalizing provider dialects (field maps, tool‑call formats, streaming events) | E3.0 substrate + **E3.7 transformer pattern** |
| **LiteLLM proxy** | 140+ providers; **cooldown + order‑based deployment retry** (failed deployment pauses, retried at order+1) | E2 endpoint shape; **retry/cooldown logic (#11)**; pricing (#18) |
| **RouteLLM** (lmsys) | learned router: **95% GPT‑4 quality at 14% strong‑model calls** (~75% cost cut) — but needs training data | E3.2 idea; ⚠️ high setup cost |
| **OpenRouter Auto / [Fusion](https://openrouter.ai/docs/guides/features/plugins/fusion)** | parallel panel + judge synthesis (~4–5×) | **E3.3** |
| **[Sakana Fugu](https://sakana.ai/fugu)** / **[OpenFugu](https://github.com/trotsky1997/OpenFugu)** | orchestrator that decides up‑front which models to call in sequence | **E3.4** |
| **Portkey** (Apache‑2.0, 1600+ models) | **semantic (embedding) cache −30–50%**, 50+ guardrails, MCP gateway | **semantic cache** idea; observability + headers (#10) |

### 3.6 Subscription → API bridges (prior art for E2)

| Project | Bridges | Notes |
|---|---|---|
| **[ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api)** | Copilot → OpenAI **+ Anthropic** | GitHub OAuth device‑flow → token at `~/.local/share/copilot-api/github_token`; Copilot token auto‑refreshed; `/v1/chat/completions`+`/v1/messages`+`/v1/models`; **`GET /usage`** quota — closest emsal to "copilot api" ✅ |
| **[caozhiyuan/copilot-api](https://github.com/caozhiyuan/copilot-api)** | Copilot / Codex / 3rd‑party → OpenAI+Anthropic | adds `/v1/responses`; day/week/month usage dashboard; Node ≥22.13 |
| **yuchanns/copilot-openai-api** | Copilot chat/embeddings → OpenAI (FastAPI) | Python reference |
| **Copilot API Gateway** (VS Code ext) | Copilot → OpenAI/Anthropic/Gemini local HTTP | in‑editor variant |
| ChatGPT reverse proxies (raine/claude-code-proxy etc.) | ChatGPT/Kimi subscription → Anthropic‑compat | ToS‑risky; reference only |
| ~~Claude Pro/Max reverse proxies~~ | ~~subscription → API~~ | **❌ blocked & enforced by Anthropic since 2026‑04‑04 — do NOT build (§5)** |

### 3.7 TUI options (for E5)

| Option | Deps | Maintained (2026) | Fit | Verdict |
|---|---|---|---|---|
| **Raw ANSI + `node:readline` raw mode + alt‑screen** (home‑grown) | **0** | stdlib | single‑pane menus/tables/dashboards/progress | ✅ **recommended** — keeps zero‑dep promise |
| ansi‑escapes + log‑update (+readline) | **0 hard deps**, ~5–10 KB | active (log‑update updated ~weekly) | same, less hand‑rolling | ✅ acceptable fallback if hand‑rolling ANSI is too much |
| ~~blessed~~ → **neo‑blessed** | ~1 dep, ~50 KB | blessed **unmaintained**; neo‑blessed active | full‑screen widgets + mouse | ✗ only if we ever need mouse widgets |
| Ink (React for CLIs) | React + large tree | active | stateful multi‑screen | ✗ breaks zero‑dep |
| terminal‑kit | medium | active | curses‑like | ✗ dep weight |
| @clack/prompts / enquirer | small | active | prompts only, not full‑screen | maybe for one‑off prompts |

**Decision:** home‑grown `src/tui/` on stdlib (§E5), reusing `src/style.js`.
**Keyboard‑only by design — so mouse is a non‑issue.** keyflip's UI is menus,
lists and dashboards driven by arrow keys / Enter / hotkeys; we deliberately do
**not** want mouse. That sidesteps Node's Windows‑tty mouse limitation entirely
(one less thing to handle) and means we never need a mouse‑capable lib like
neo‑blessed. Real gotchas that remain: `process.stdout.on('resize')` lags a bit on
Windows, and always fall back to plain mode when `!process.stdout.isTTY` or
`NO_COLOR`.

---

## 4. Suggested sequencing

Rough milestone mapping (subject to change):

| Milestone | Content |
|---|---|
| **v1.6** | Phase 0a + 0b (quick wins + **provider catalog** #1/#17/#16) |
| **v1.7** | Phase 0c + 0d → **E3.0–E3.2** (routes.json, rule router, tiered fallback) |
| **v1.8** | **E1.1–E1.4** (surface registry + core CLI adapters) |
| **v1.9** | **E2.1–E2.3** (bridge core + Copilot/ChatGPT/Claude backends) |
| **v2.0** | **E4** (central settings + run‑mode) + **E5** (TUI) — the "one control plane" release |
| **later** | E3.3 fusion, E3.4 orchestrator, E2.4 pool bridging, more E1 IDE adapters |

Prereq order that matters: Phase‑0c (#4/#5) → E3 → E2.4; E1 Copilot adapter → E2.2;
E4 settings store should land before E5 so the TUI edits a real config.

---

## 5. Compliance & safety rails

- **E2 (subscription bridging) has provider‑specific ToS status — not one blanket
  rule:**
  - **Claude Pro/Max → prohibited & actively enforced.** Anthropic blocks
    third‑party‑harness use of subscription OAuth as of **2026‑04‑04** (OpenClaw /
    OpenCode / NanoClaw were cut off). keyflip will **not** build a Claude
    subscription backend; Claude routes only through real API keys / Bedrock /
    Vertex.
  - **GitHub Copilot → gray area, functional.** Reverse‑engineers an internal
    endpoint; "not GitHub‑supported"; account‑suspension risk on abuse. Shipped
    opt‑in with a warning.
  - **ChatGPT → gray area, less aggressively enforced than Anthropic.** Opt‑in,
    warned.
  keyflip ships E2 **opt‑in, off by default, self‑host/localhost‑only**, prints a
  one‑time warning **naming the specific provider's stance**, and never markets it
  as a way to resell or evade limits. Personal‑use convenience; the user owns the
  compliance decision.
- **Secrets:** every new capability inherits the existing rules — OS credential
  store only, never argv, `--key-file`/stdin, no secret through MCP, nothing in
  the repo, nothing in logs.
- **Command‑activated:** proxy, router (E3), and bridge (E2) are all started/stopped
  explicitly. E4's "service" run‑mode only ever *generates* a unit file the user
  installs knowingly — keyflip never enables a hidden background daemon.
- **No destructive defaults:** switching, deleting, logging out, unpublishing —
  all require explicit consent, always.
- **Docs stay in lockstep:** any shipped item updates README.md + README.tr.md +
  SKILL.md + MCP setup text together.
