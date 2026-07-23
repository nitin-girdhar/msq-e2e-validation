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
