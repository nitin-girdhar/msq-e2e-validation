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
├─ lib.mjs              # auth-state opener, page visit, finding recorder (path root)
├─ db.mjs               # backend verification — reads the live `platforms` DB
├─ crawl.mjs            # deep-crawl engine (tabs, dropdowns, buttons, forms)
├─ driver.mjs           # runs the crawler for a tool across every role
├─ conc.mjs             # concurrency helpers (per-actor API context, simultaneous fire)
├─ auth-setup.mjs       # logs in every role/actor, saves .auth/<key>.json
├─ report.mjs           # folds findings → results/SUMMARY.md + summary.json
├─ run-all.mjs          # orchestrator (auth → crawl → concurrency → report)
├─ suites/
│  ├─ core/             # auth-web + lookup-admin (identity) — deep crawl + legacy probes
│  ├─ lms/              # Leads/CRM
│  ├─ hr/               # Attendance & Leave
│  ├─ todo/             # Tasks
│  └─ concurrency/      # multi-user conflict scenarios
└─ results/             # findings-<tool>.json, <tool>-coverage.json, SUMMARY.md
```

`lib.mjs` lives at the root and resolves **all** paths (`.auth/`, `roles.json`,
`results/`) relative to itself, so suite scripts in `suites/<tool>/` only ever
`import … from '../../lib.mjs'` — no suite needs to know how deep it is nested.

## Prerequisites

1. **Postgres** running as container `msq-db-server`, database `platforms`
   (the harness reads it via `docker exec` — no local psql needed).
2. **All web apps up** on their dev ports:
   | app | port | tool |
   | --- | --- | --- |
   | auth-web | 3000 | core / identity |
   | lms-web | 3001 | Leads / CRM |
   | hr-web | 3002 | HR |
   | todo-web | 3003 | Tasks |
   | lookup-admin | 3005 | Lookup admin |

   From the repo root: `make dev` (or `pnpm turbo dev`) brings up Postgres + all
   services + web apps.
3. `pnpm install` in this folder, then `npx playwright install chromium` once.

Override DB access with env vars if needed: `MSQ_DB_CONTAINER`, `MSQ_DB_NAME`,
`MSQ_DB_USER`.

## Running

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

## Notes

- Legacy per-scenario probes (the "level 1" setup) were moved into `suites/<tool>/`
  unchanged except their import path; they still run and remain useful for
  targeted reproduction. The deep-crawl + concurrency + reporting layer is the
  "level 2" enhancement.
- The crawler never fires destructive or submit controls, so a full `npm run all`
  is safe to run against the seeded dev database. The concurrency suites make
  bounded, self-cleaning writes.
