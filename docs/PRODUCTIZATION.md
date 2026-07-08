# keyflip — Productization plan

> Status: **plan.** How keyflip goes from an open-source CLI to a paid product **without breaking its
> brand promises** (local-first, zero-telemetry, zero-dependency). The licensing primitive ships as
> `src/license.js` (offline Ed25519 verification, no phone-home); everything else here is the
> business/infra layer around it.

## 1. Model: open-core + offline signed licenses

keyflip's differentiators are privacy and locality. A phone-home license server would betray that, so:

- **Open core, free forever:** single-machine account switching, providers, proxy, sessions, backup,
  migrate, foreign-session import, the base MCP surface. This stays MIT/open on npm — it's the funnel.
- **Paid tiers unlock advanced features** via an **offline, signed license** — a token
  `{ tier, email, expiry, issued }` signed with an **Ed25519** key (the same crypto the fleet already
  uses for origin auth). keyflip verifies the signature **locally** against an embedded public key.
  No network call, works air-gapped, nothing to leak. (`src/license.js`: `verify` / `activate` /
  `tier` / `requireTier`.)
- **Enforcement:** each paid command handler calls `license.requireTier(ctx, feature)` at the top;
  the same gate guards the corresponding MCP tools. Free users get a clear upgrade message, never a crash.

### Tiers (starting point — tune with data)

| Tier | Price (indicative) | Unlocks |
|---|---|---|
| **Free** | $0 (open source) | switch, providers, proxy, sessions, backup, migrate, foreign import, base MCP |
| **Pro** | ~$8–12/mo | fleet, orchestrator/jobs/fanout, cost intelligence, budgets, notify, autoswitch, router+cache |
| **Team** | ~$6–10/seat/mo | team pool (RBAC), policy engine, vault backend, swarm (own-fleet exec), audit export, SSO |
| **Enterprise** | custom | self-host license issuer, priority support, custom policy, procurement/invoicing |

Feature→tier map lives in `license.FEATURES` so it's one edit to re-slice.

## 2. Payment gateway

Recommendation for a solo/small vendor (esp. outside the US): a **Merchant of Record (MoR)** so global
sales tax / VAT / invoicing is handled for you.

- **Paddle** or **Lemon Squeezy** (MoR): they own the transaction, remit tax, provide a hosted
  checkout + customer portal + subscription webhooks. Least operational burden.
- **Stripe** (not MoR): more control + lower fees, but you handle tax registration/remittance
  (Stripe Tax helps). Choose only if you want full control and can manage compliance.
- **Gumroad**: simplest, highest fees — fine for a first paid launch / license-key sales.

**Fulfillment flow:** `payment succeeded` webhook → a tiny **license-issuer** service signs an Ed25519
license for `{tier, email, expiry}` and emails it / exposes it in the customer portal. Subscription
lifecycle (renew/cancel/refund) re-issues or shortens `expiry`. The issuer is the ONLY component that
holds the private key.

## 3. Components & phased roadmap

**Phase 1 — licensing primitive (in-repo, ships first):**
`src/license.js` (offline verify + tier gate) + `keyflip license status|activate` + MCP tools. Gate the
paid commands. *Deliverable: the product can distinguish free vs paid locally.* ✅ (built in Wave-3)

**Phase 2 — issuer + payment:**
- Pick MoR (Paddle/Lemon Squeezy). Configure products = tiers, monthly/annual.
- **license-issuer**: a serverless function (Cloudflare Workers / small Node) that (a) verifies the
  provider webhook signature, (b) signs a license with the private key (stored in the platform's secret
  store / KMS, never in git), (c) delivers it. Also a `/renew` + `/revoke` path.
- Private key management: generate offline; keep in the issuer's secret manager; publish only the
  public key (embedded in `license.js` at release, and on the website for verification transparency).

**Phase 3 — public website:**
- Static marketing site (Astro / Next static export) — hero, feature tour, pricing, docs, changelog.
- Pricing page → MoR hosted checkout. Docs from the existing README/SKILL (single source).
- Customer portal = the MoR's hosted portal (manage subscription, re-download license) → minimal custom UI.
- Host on Cloudflare Pages / Netlify / Vercel. Domain + TLS. Zero backend for the marketing site.

**Phase 4 — admin panel:**
- v1 = the MoR dashboard (customers, subscriptions, revenue) + the issuer's logs.
- v2 = a thin custom admin: reissue/revoke a license, look up a customer, toggle a feature flag,
  view aggregate (opt-in) metrics. Auth via the MoR or a simple admin SSO. Keep it minimal.

**Phase 5 — distribution & growth:**
- npm (free core), Homebrew tap, Scoop bucket, the existing install scripts.
- `keyflip upgrade` already self-updates; add a release channel.
- **Telemetry stays opt-in only** (brand promise). If added, it's an explicit `keyflip telemetry on`
  with a documented, minimal, non-secret payload — never default-on.
- Support: GitHub issues (free), email/priority (paid). Docs + FAQ on the site.

## 4. Brand-consistency guardrails (non-negotiable)

- **No phone-home** for license checks (offline signature verification only).
- **No secrets leave the machine** — licensing changes nothing here; creds stay in the OS store /
  encrypted files.
- **Free tier stays genuinely useful** (the core switch/manage workflow), so keyflip remains the
  obvious open tool; paid = scale/team/automation.
- **Zero runtime dependencies** preserved — `license.js` uses only `node:crypto`.

## 5. Open questions (decide before Phase 2)

- Perpetual-with-updates vs subscription? (Subscription fits the MoR model + ongoing cost of features.)
- Seat definition for Team (per-user vs per-machine).
- Grace period + offline expiry behavior (recommend: warn, then soft-degrade to free on hard expiry).
- Piracy stance: accept that a determined user can patch an open-source binary; optimize for honest
  customers + convenience, not DRM. (The value is the hosted issuer + updates + support, not lock-in.)
