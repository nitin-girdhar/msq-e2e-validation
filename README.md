# MSQ Platforms — E2E Validation Harness

End-to-end validation "agents" that drive every UI tool in the platform through
the **real browser**, exercise every tab / dropdown / button (view, edit, create
forms), test **multiple users working the same record concurrently**, and — for
every UI action — **verify the backend agrees** by reading the source-of-truth
Postgres directly. Anything that breaks is captured as a severity-ranked finding
with a proposed fix in `results/SUMMARY.md`.

Every distinct role the platform ships is covered, from `read_only` all the way
up to `super_admin`, plus the department ladders (sales / hr / operations /
admin).

## Layout

```
msq-e2e-validation/
├─ roles.json           # every role → one representative login + secondary actors
├─ tools.config.mjs     # per-tool surface map: routes, expected nav, write tables
├─ localenv.mjs         # reads the platform root .env (app URLs, cookie domain, DB container)
├─ lib.mjs              # auth-state opener, page visit, finding recorder (path root)
├─ db.mjs               # backend verification — reads the live `platforms` DB
├─ crawl.mjs            # deep-crawl engine (tabs, dropdowns, buttons, forms)
├─ driver.mjs           # runs the crawler for a tool across every role
├─ conc.mjs             # per-actor API contexts, simultaneous fire, freshLogin + 429 backoff
├─ matrix.mjs           # run one action as every role; grade by rank OR live capability
├─ fixtures.mjs         # FK-aware purge, restore journal, leak detector, id extraction
├─ auth-setup.mjs       # logs in every role/actor, saves .auth/<key>.json
├─ auth-refresh.mjs     # re-logs only the stored sessions that stopped working
├─ restore.mjs          # replays restore journals (+ --purge-residue)
├─ selftest.mjs         # offline tests of the harness's own logic (no stack needed)
├─ report.mjs           # folds findings + run ledger → results/SUMMARY.md + summary.json
├─ run-all.mjs          # orchestrator — safe to leave running overnight
├─ suites/
│  ├─ core/             # auth-web + lookup-admin, branch switcher, account lifecycle
│  ├─ security/         # every gateway route × every login + anonymous; public edge
│  ├─ data/             # Postgres invariants (RLS, grants, weights, sync gaps)
│  ├─ lms/              # Leads/CRM, transfer, campaign types & rules, analytics scope
│  ├─ hr/               # Attendance & Leave, employees, reports
│  ├─ todo/             # Tasks
│  ├─ admin/            # admin-web + /sa console, Team contracts
│  ├─ platform/         # web push + notifications stream
│  ├─ tenant/           # cross-tenant isolation
│  ├─ capability/       # capability toggles
│  └─ concurrency/      # multi-user conflict scenarios
└─ results/             # findings-<tool>.json, <tool>-coverage.json, SUMMARY.md
```

`lib.mjs` lives at the root and resolves **all** paths (`.auth/`, `roles.json`,
`results/`) relative to itself, so suite scripts in `suites/<tool>/` only ever
`import … from '../../lib.mjs'` — no suite needs to know how deep it is nested.

## Running on this laptop

Everything — Postgres, the services, the six web apps and this harness — runs
locally. The harness reads the platform root `.env` (`../.env`, via
`localenv.mjs`) for the app URLs (`AUTH_URL`, `LMS_URL`, `HR_URL`, `TASK_URL`,
`ADMIN_WEB_URL`, `ADMIN_URL`), the gateway (`NEXT_PUBLIC_API_URL`), the cookie
domain and the DB container (`DB_CONTAINER_NAME`, `DB_NAME`, `POSTGRES_USER`),
so it always browses exactly what the stack was configured to serve. Pick ONE
of the two local shapes and start it from the platform root:

| | A. Full docker + proxy (current `.env`) | B. Native `pnpm` dev |
| --- | --- | --- |
| Start | `docker compose --profile sso-proxy up -d --build` | `make dev` (Postgres in docker + `pnpm turbo dev`) |
| URLs in `.env` | `AUTH_URL=http://app.localhost`, `LMS_URL=http://app.localhost/lms`, … | the commented block: `AUTH_URL=http://localhost:3000`, `LMS_URL=http://localhost:3001/lms`, … |
| `COOKIE_DOMAIN` | `app.localhost` | `localhost` |
| Proxy | Caddy on :80 (opt-in `sso-proxy` profile — without it `app.localhost` does not answer) | none |

The two `.env` settings must match the shape you start: a cookie domain that
does not cover the app host makes every login silently bounce back to
`/login`. `npm run preflight` prints the resolved topology and fails fast with
the exact fix for: Docker not responding (Rancher Desktop Hyper-V hang →
`wsl --shutdown`, relaunch), DB container not running, cookie domain / host
mismatch, proxy not up, gateway down, apps not serving their routes.

`E2E_MODE=ports` forces shape B's URLs without editing `.env` (the stack's
`COOKIE_DOMAIN` must still be `localhost`); `E2E_ORIGIN=<url>` forces one origin.

Laptop safeguards in `run-all.mjs`: the machine is kept awake for the duration
of the run (a helper holds `ES_SYSTEM_REQUIRED` and exits with the run; the
screen may still turn off — `E2E_ALLOW_SLEEP=1` disables it); a stage that
exceeds its timeout is killed **with its whole process tree** (`taskkill /T`),
so its Chromium windows do not pile up and starve later stages; every DB query
has a 60 s timeout (`MSQ_DB_TIMEOUT_MS`) so a hung Docker daemon fails a query
instead of freezing a stage. Plug the laptop in and keep Docker/Rancher running.

## Prerequisites

1. **Postgres** running as the stack's DB container (`DB_CONTAINER_NAME` from
   the platform `.env`, default `msq-db-server`), database `DB_NAME`
   (`platforms`) — read via `docker exec`, no local psql needed.
2. **The local stack**, in one of the two shapes above. All six web apps are
   compiled with a Next `basePath`:

   | app | shape A | shape B | tool |
   | --- | --- | --- | --- |
   | auth-web | `http://app.localhost/` | `http://localhost:3000/` | core / identity |
   | lms-web | `http://app.localhost/lms` | `http://localhost:3001/lms` | Leads / CRM |
   | hr-web | `http://app.localhost/hrms` | `http://localhost:3002/hrms` | HR |
   | todo-web | `http://app.localhost/todo` | `http://localhost:3003/todo` | Tasks |
   | admin-web | `http://app.localhost/admin` | `http://localhost:3004/admin` | Admin console |
   | lookup-admin | `http://app.localhost/sa` | `http://localhost:3005/sa` | Super-admin console |
   | gateway | `<auth>/api/*` rewrite + `http://localhost:4000` | same | API |

   Authenticated API calls go to `<auth-web URL>/api/...` so the session cookie
   is sent; the direct gateway URL is used only for the unauthenticated edge.
   Node on Windows cannot resolve `*.localhost` — `lib.mjs` maps it to
   127.0.0.1 in-process, so no hosts-file change is needed.
3. `pnpm install` in this folder, then `npx playwright install chromium` once.
4. The platform monorepo checked out next to this folder
   (`../msq-core/services/api-gateway/src/server.ts`, `../.env`) — the
   API-surface sweep parses the live route table, lib/db read the `.env`.

Environment overrides: `E2E_PLATFORM_ENV` (path to the platform `.env`),
`E2E_ORIGIN`, `E2E_MODE=ports`, `E2E_GATEWAY_DIRECT`, `E2E_GATEWAY_SRC`,
`E2E_SLOW_MS` (slow-endpoint threshold, default 8000), `E2E_RACE_ROUNDS`
(default 5), `E2E_ALLOW_SLEEP=1`, `MSQ_DB_CONTAINER`, `MSQ_DB_NAME`,
`MSQ_DB_USER`, `MSQ_DB_TIMEOUT_MS`.

## Running

### Overnight

```bash
npm run selftest   # seconds, no stack needed: the harness's own logic is sound
npm run preflight  # stack reachable, schema/roles/routes match the suites
npm run overnight  # = node run-all.mjs — the full pass, unattended
```

`run-all.mjs` archives the previous `results/` to `results/_archive/<stamp>/`,
replays any pending restore journal, logs everyone in, then runs every band
with a per-stage timeout (a hung suite is killed, logged and skipped). It
re-checks stored sessions between bands (`auth-refresh.mjs`) and restores
config at the end. In the morning read `results/SUMMARY.md` top-down:

1. **Run ledger** — any stage that crashed or timed out left its area UNTESTED.
2. **Triage — critical & high** — one line per finding.
3. Per-tool sections — expected / actual / evidence / **proposed fix** (the root
   cause pointer: file, function, and why).

Throwaway data is marked (`@e2e.local` users, `E2E-*` leads/tasks, `e2e_*`
campaign types) and purged by each suite; `npm run restore:purge` removes any
residue a killed run left behind.

### Manual

```bash
# 1. Log in every role once (writes .auth/<role>.json + .auth/rep2.json, rep3.json)
npm run auth

# 2a. Everything: auth → all deep crawls → concurrency → SUMMARY.md
npm run all

# 2b. …or a subset
node run-all.mjs --only=lms,hr --skip-auth

# 3. Individual stages
npm run crawl:lms      # deep-crawl Leads/CRM for every role
npm run conc:hr        # HR leave-approval race
npm run report         # regenerate results/SUMMARY.md from existing findings

# 3a. Newest additions (module-grouped lookup-admin nav, capability matrix,
#     WhatsApp-to-lead, split-shift attendance — see "Recently added coverage" below)
npm run admin:module-nav
npm run admin:capability-matrix-ui
npm run lms:whatsapp
npm run hr:split-shift
```

## Layers at a glance

| Layer | What it proves | Entry point |
| --- | --- | --- |
| **Preflight** | The product still matches what the suites assume (tables, columns, roles, routes). Fails fast on drift. | `npm run preflight` |
| **Breadth crawl** | Every role can open every route; all controls render and nothing throws. | `npm run crawl:*` |
| **Role matrix** | Real writes attempted as **all 19 roles**, graded allow/deny — catches privilege escalation *and* blocked-legit-user. | `npm run matrix:*` |
| **Cross-tenant** | Tenant B cannot see, read or modify tenant A's data. | `npm run tenant` |
| **Capability toggle** | Turning a grant off/on actually hides the tab/page **and** blocks the API. | `npm run capability` |
| **Concurrency** | Two users on one record behave safely. | `npm run conc:*` |
| **Visual** | Layout holds up on phone/tablet/laptop/desktop. | `npm run visual` |
| **Analysis** | Tab visibility matches route reachability. | `npm run analyze:tabs` |
| **API surface** | Every gateway route (parsed from source) × every login + anonymous: no unauthenticated access, no 5xx, no leaked internals, SA-only stays SA-only, tenant B cannot read tenant A by id. | `npm run security:sweep` |
| **Public edge** | API-key scope/binding/rotation, webhook key + HMAC, JWKS, headers, CORS. | `npm run security:edge` |
| **Data health** | Postgres invariants behind silent failures (RLS policies missing service logins, roles without `platform.write`, branches with no weighted assignee, cross-tenant rows, HR sync gaps). | `npm run data:health` |

### Role matrix (`matrix.mjs`)

The single most important addition: instead of testing a write as one hardcoded
role, `runRoleMatrix()` runs it as **every** role and grades the result against a
rank threshold, reporting the two failure directions separately because they are
different bugs:

- **over-permitted** — a role that should be rejected succeeded → privilege
  escalation (graded `high`, or `critical` for credential-issuing endpoints);
- **under-permitted** — a role that should be allowed got 403/404 → a broken
  feature for a legitimate user.

Grading uses an optional `verify()` that re-reads Postgres, so a `2xx` that
changed nothing is **not** counted as "allowed" — which is exactly how the
silent-drop bug in `PATCH /api/leads/:id` was caught.

## What each layer does

- **Deep crawl** (`crawl.mjs` via `driver.mjs`) — for each role × each route it
  visits the page, then discovers and exercises **every** control:
  - clicks every in-page **tab**;
  - opens every **dropdown / select** and enumerates its options;
  - classifies every **button** by intent and acts safely — *safe* controls
    (View, filters, sort, pagination) are clicked; *create/edit* controls are
    **opened** (form/modal must appear) then cancelled; *destructive* controls
    (Delete, Deactivate, Revoke) are **inventoried but never fired**; *submit*
    controls are never auto-fired (real writes go through the action/concurrency
    layer so business rules are exercised deliberately).
  - After each interaction it diffs console errors, page errors, 4xx/5xx
    requests, and scans for **leaked backend error banners** (a raw server error
    shown to the user is itself a defect).

- **Backend verification** (`db.mjs`) — suites that perform a write assert on
  real rows (`q`, `one`, `scalar`, `count`) so "the screen said OK" is backed by
  "the row actually changed / didn't".

### Cross-tenant isolation (`suites/tenant/`)

Every other suite runs inside one tenant, so it can only prove *role*
boundaries. This one logs in as a **second tenant** (MSquare Professionals,
`*@msq.ggn.in` — see `crossTenantActors` in `roles.json`) and attacks the first
(FitClass) four ways:

1. **List scoping** — every id returned by a list endpoint is looked up in the
   database and checked against the caller's tenant. A leak is proven by data,
   not inferred from row counts.
2. **IDOR read** — fetch tenant A's lead / task / leave request by its real id.
   Must 403/404 with no record in the body.
3. **IDOR write** — PATCH tenant A's record. Must fail **and** leave the row
   byte-identical (compared before/after in the DB). A "rejected" write that
   still mutated is the worst outcome, so the suite restores the row and grades
   it `critical`.
4. **Capability-override scoping** — revoking a capability for a role in tenant A
   must not change that role in tenant B, proving the tenant-scoped override is
   genuinely scoped.

All leaks are graded **critical**.

**Why the super_admin control matters.** The suite also asserts that
`super_admin` *can* still read across tenants. Without that probe, an API that
denied everything (or a suite that never logged in) would look like perfect
isolation. Preflight backs this up by failing if a tenant-B login is missing or
if both configured tenants resolve to the same tenant id — otherwise the
security check could return a false all-clear.

### Capability toggling (`capability.mjs` + `suites/capability/`)

Capabilities form a tree (`tool → page → tab → operation → scope`) in
`iam.capabilities`, granted per role in `iam.role_capabilities` and resolved by
`iam.fn_role_capability_matrix(tenant)` — where a **tenant-scoped row overrides
the platform default**, and page/tab nodes inherit their parent's grant.

Each case runs `baseline → revoke → observe → restore → re-observe`, comparing
**four independent views** of the same truth:

1. **resolver** — what `fn_role_capability_matrix` says;
2. **session** — `GET {gateway}/auth/me` capability list (identity-service
   re-resolves per call, so a change lands without re-login);
3. **frontend** — is the nav link / tab actually rendered after reload;
4. **backend** — does the guarded API still accept the call.

The disagreements are the findings:

| Disagreement | Meaning | Severity |
| --- | --- | --- |
| UI hides it, API still allows | capability is decorative; direct calls bypass it | high / critical |
| API denies it, UI still shows | user invited into a dead end | medium |
| resolver flips, session never does | cache not invalidating — revoking access does nothing | high |
| grant doesn't return after restore | strands real users | high |

**Safety.** This is the only suite that mutates authorization config, so it is
reversible by construction: it never edits platform-default rows, only inserts a
**tenant-scoped override** and deletes it to restore. Every override is journalled
to `results/capability-overrides.json` *before* the write, so a killed run is
recoverable from a cold process:

```bash
npm run capability:restore   # replays the journal and puts every grant back
```

A normal run also self-recovers any journal it finds before starting, so a stale
revoke is never mistaken for the product's baseline.

- **Tabs** — these products render tabs via the shared `PageTabs` component as
  `<nav aria-label><a href aria-current>` (anchors, *not* `role="tab"`). The
  crawler inventories them rather than clicking, because each tab is just a link
  to a route already crawled. The inventory is the valuable part: a tab only
  exists when its capability is granted, so `analyze:tabs` cross-checks "tab
  visible" against "route actually loads" and flags dead-end tabs — the recurring
  page-guard-vs-service-guard mismatch in this codebase.

- **Visual / responsive** (`suites/visual/`) — renders each route at 5 viewports
  (360, 390, 820, 1366, 1920) and reports **measurable** defects only: document
  horizontal scroll, elements past the right edge, tap targets under 44×44,
  text under 12px, and overlapping interactive controls. A screenshot per
  viewport is saved to `results/screenshots/` as evidence. Deliberately
  objective — "looks unprofessional" is subjective, but a phone that scrolls
  sideways is a bug anyone will sign off.

- **Concurrency** (`suites/concurrency/`) — two authenticated actors hit the same
  record simultaneously:
  - `lms-lead-lost-update` — two editors PATCH the same lead field; detects
    silent last-writer-wins (no optimistic lock).
  - `hr-leave-approval-race` — two approvers approve the same request; expects
    exactly one winner, a clean 409/403 for the loser, no 500, no double-approve.
  - `todo-task-double-edit` — two editors change the same task; detects lost
    updates. Creates & soft-deletes its own throwaway task.

## Findings & severity

Every suite records findings via `record(tool, {...})` into
`results/findings-<tool>.json`. `report.mjs` aggregates them into
`results/SUMMARY.md`, grouped by tool and sorted by severity:

| severity | meaning |
| --- | --- |
| **critical** | data loss / auth bypass / cross-tenant leak |
| **high** | broken action, 500, page crash, double-write, privilege gap |
| **medium** | leaked backend error string, confusing/blocked UX, minor authz drift |
| **low** | cosmetic / non-blocking |
| **info** | observation or a blocked precondition (not a defect) |

Each finding carries: role(s), where, expected, actual, **proposed fix**, and
evidence.

## Roles covered (`roles.json`)

Global ladder: `read_only(0) · sales_representative(20) · senior_sales_executive(40)
· org_manager(60) · org_sr_manager(70) · hr_head(75, acts as HR-admin) ·
org_admin(980) · tenant_admin(990) · super_admin(1000)`.
Department ladders (FitClass CP / MSquare Gurgaon HQ): `sales_head, ops_head,
sales_manager, hr_manager, ops_manager, admin_manager, sales_senior_executive,
hr_executive, ops_executive, admin_executive`.
Secondary same-org actors `rep2`, `rep3` exist for concurrency tests.

> There is no global `hr_admin` user in the seed — HR-admin authority is carried
> by `hr_head` (rank 75).

## Recently added coverage

Four product changes landed together (lookup-admin's module-grouped nav +
generic FK dropdowns + a new Capabilities admin screen, WhatsApp-to-lead, and
split-shift attendance day classification). Each got a suite, plus one
existing suite and the tool's route map needed fixing because the nav change
moved lookup tables off the single flat dashboard they used to assume:

| Suite | Proves |
| --- | --- |
| `suites/admin/lookup-module-nav.mjs` (`npm run admin:module-nav`) | The left rail groups tables by module (Platform/LMS/HRMS/Tasks/Capabilities), every module pane's cards actually open, and the generic FK chain on Organizations' Create form (Country -> State -> City, plus the plain Tenant fk) populates and disables correctly — the behavior that replaced the old hardcoded `GeoCascadeSelect`. |
| `suites/admin/capability-matrix-ui.mjs` (`npm run admin:capability-matrix-ui`) | The new `/dashboard/capabilities/matrix` screen writes a real `iam.role_capabilities` override through its `PUT /roles/:id/capabilities` endpoint — UI, DB, resolver, and a live user's session are all checked to agree, the same four-way doctrine as `capability.mjs`, but exercising the admin UI's own round trip instead of a direct SQL write. Runs in the `capability` band (mutates authz config; reversible by construction — see that suite's header). |
| `suites/lms/lms-whatsapp-send.mjs` (`npm run lms:whatsapp`) | The WhatsApp send dialog opens on a lead with a phone number and its template list resolves; `GET /leads/:id/whatsapp/templates` is capability-gated (`lms.leads.whatsapp.send`) — allowed for `org_admin`, denied for `read_only`. Never fires the actual send (a real external API call), consistent with the crawler's "inventory, don't fire" rule for side-effecting controls elsewhere in this harness. |
| `suites/hr/attendance-split-shift.mjs` (`npm run hr:split-shift`) | `worked_minutes` sums paired check-in/check-out sessions instead of spanning first-in to last-out (a split-shift employee is no longer paid for the multi-hour gap between segments), an off-window punch is accepted-but-flagged (`is_off_segment` / `has_off_window_punch`), and `GET /hr/attendance/events` — which had **no gateway route at all** until this change — is actually reachable. See `docs/ATTENDANCE_DAY_CLASSIFICATION.md` for the full manual test plan this suite automates a slice of. |

`suites/admin/lookup-crud.mjs` and `tools.config.mjs`'s `lookup` tool entry
were also updated: they used to assume every lookup table was linked from one
`/dashboard` page, which stopped being true once tables moved into per-module
panes at `/dashboard/m/[module]` — both now discover tables by walking every
module link first.

## Coverage pass 2026-09-28

The full table (case IDs, suspected defects from code reading, and what is
still not covered) is in `E2E_TEST_PLAN.md` §4d. Suites added:

| Suite | Proves |
| --- | --- |
| `security/api-surface-sweep.mjs` | Every gateway route swept per login + anonymous (see Layers). |
| `security/public-edge.mjs` | Partner API scopes, branch binding, key rotation, webhooks, JWKS, CORS. |
| `core/switch-org.mjs` | Branch switcher: picker == coverage, switch follows, old token revoked, refusals. Fresh logins only. |
| `core/account-session-lifecycle.mjs` | Throwaway account: canonical-email login, change-password, pwd_iat invalidation, logout revocation. |
| `admin/team-user-contracts.mjs` | Lowercase emails, role_id escalation, cross-tenant branch/role, edit keeps manager, HR profile sync, reset-password rank gate, `?tenant_id=` SA-only. |
| `admin/sa-console.mjs` | New /sa screens render; SA actions refused at the edge; tenant-module entitlement off/on (journalled); catalog drift. |
| `lms/lead-transfer.mjs` | Branch transfer matrix, close-out, 4xx-not-500 refusals, tenant_admin cross-branch, follow-up write ⊄ read. |
| `lms/campaign-types-rules.mjs` | Types/rules gates, CRUD, first-match-wins + reorder (restored exactly), tenant isolation. |
| `lms/analytics-scope.mjs` | Every report row inside the caller's branches/tenant. |
| `hr/hr-employees-reports.mjs` | Employees matrices, profile/balance/ledger IDOR, attendance report formats + scope. |
| `todo/task-comments-lists.mjs` | Private task/list guards for comments, history, rename, delete. |
| `platform/push-and-stream.mjs` | Push subscription identity from session only; SSE handshake per role. |
| `concurrency/lms-lead-transfer-race.mjs` | Two simultaneous transfers → one copy. |
| `data/data-health.mjs` | Postgres invariants (see Layers). |

**Safety changes that matter for unattended runs:** the crawler has a
`sideEffect` class (Sync / Pull / Apply / Remap / Retry / Ignore / Re-run /
Transfer / Rotate …) that is inventoried and **never clicked**, and treats the
BranchSwitcher as a session control. Anything that re-mints or kills a session
(switch-org, change-password, logout) runs on `conc.freshLogin()` sessions or
throwaway users — never on `.auth/` state. `matrix.mjs` can grade by the
role's live capabilities (`capability: 'lms.leads.transfer'`) instead of rank,
and records any 5xx as its own finding.

## Coverage pass 2026-09-29

See `E2E_TEST_PLAN.md` §4e. In short: `provision-readonly.mjs` now runs first
(creates the read_only login through the Team API and re-aligns harness
passwords after a production refresh), and three suites were added —
`ui/ui-write-roundtrip.mjs` (real writes through the browser as every role,
verified in Postgres, graded by live capability, plus a two-browser same-lead
race), `security/public-api-v2.mjs` (lead list/find and branch fencing) and
`hr/request-detail-idor.mjs` / `hr/monthly-summary-wfh.mjs`.

`E2E_ACTORS=role1,role2 node suites/ui/ui-write-roundtrip.mjs [lms,hr,todo,admin,concurrency]`
narrows the UI round trip for a quick check.

After fixing a suite, re-run just it in place — `node rerun.mjs suites/x.mjs [...]`
replaces that stage's findings/actions from the last pass — then
`node report.mjs && node gen-openissues.mjs`. `gen-openissues.mjs` prepends the
hand-verified `openissues.curated.md` (root cause, control flow, fix per defect) and a
page × role coverage matrix built from the crawl, and writes `../openissues.md`.

## Coverage pass 2026-10-06 (schema 1.59–1.70, HR parity H10–H12, Stitch redesign)

Authored without a live stack (Docker/Postgres were down) — **none of these has
been run yet**; expect a shake-out run to fix selectors and guessed response
shapes. Full wiring is in `run-all.mjs`; sixteen HR suites that were authored
earlier but never wired (payroll, swap desk, planner, documents vault, comp-off,
encashment, announcements/assets, people, profile-360, punch hub, attendance UI
flows/role matrix, leave-apply-v2) are now in the HR band, as are
`core/branding`, `core/auth-recovery` and `todo/tasks-v2`.

| Suite | Proves |
| --- | --- |
| `hr/hr-taxonomy-holidays.mjs` | Departments/designations/holiday calendars/leave-policy PATCH + create authz (by live capability), cross-tenant/branch IDOR, mass-assignment, 4xx-not-5xx validation, 409 duplicates, simultaneous-create race. |
| `hr/hr-self-routes-dossier.mjs` | `/me/activity` privacy, `me/shift`, `today-summary` counts-only, regularization cancel IDOR + state machine, `reports/detail` csv/xlsx + CSV-injection, documents dossier ZIP, shift / shift-assignment PATCH. |
| `todo/task-soft-delete.mjs` | Task + list soft delete (service tx bypasses RLS, so service checks are the only guard): creator/admin only, cross-branch/tenant refused, deleted rows invisible everywhere, races, UI archive flow. |
| `core/branding-ownership.mjs` | SA vs tenant vs user field ownership, malformed terms/menu rejected, tenant-B write isolation, personal `font_size` per login. |
| `core/auth-screens.mjs` | `/select-branch` and `/no-access` agree with the API, fail safe, hostile `callbackUrl` blocked. |
| `visual/text-size-scaling.mjs` | 4-step text size scales rendered text in every app, no px-pinned text, persisted size renders server-side. |
| `admin/admin-web-console.mjs` | Console gating per login, Team tenant isolation/scope, API Tokens UI + API, leave/attendance admin shells. |
| `tenant/cross-tenant-new-modules.mjs` | Tenant B vs tenant A on every new HR/LMS/Tasks table: UUID leak scan plus before/after row snapshots on ~35 writes. |
| `lms/meta-routing-and-weights.mjs` | Read-only: Meta routing decisions, weights, rule-engine precedence, console inventory (buttons never clicked). |
| `lms/meta-console-1-70-authz.mjs` | Meta console 1.70 write routes (campaign archive / PATCH, run selection / discard, page-health validate): every non-super-admin login + tenant B must be refused; super_admin only gets nil ids and must see a 4xx; DB state unchanged. Never reaches the Meta Graph API. |
| `platform/push-flag-and-stream.mjs` | `WEB_PUSH_ENABLED` per environment, SSRF on push endpoints, stream handshake/logout hardening. |
| `data/data-health.mjs` (extended) | 33 new tables (RLS enabled/forced, service logins named, grants), new capabilities + back-fill pins, HR/Tasks integrity, weights, Meta routing. |
| `security/api-surface-sweep.mjs` (extended) | Parser self-check + new-route-family guard; new HR `:id` routes exercised. |
| `visual/responsive-audit.mjs` (extended) | Todo, lookup-admin branding and auth-web screens added (`--no-extras` skips). |

Also fixed: `capability/apiclients-fresh-revoke.mjs` used the renamed capability
key `platform.api_tokens.view` (now `admin.api_tokens.view`).

## Notes

- Legacy per-scenario probes (the "level 1" setup) were moved into `suites/<tool>/`
  unchanged except their import path; they still run and remain useful for
  targeted reproduction. The deep-crawl + concurrency + reporting layer is the
  "level 2" enhancement.
- The crawler never fires destructive or submit controls, so a full `npm run all`
  is safe to run against the seeded dev database. The concurrency suites make
  bounded, self-cleaning writes.
