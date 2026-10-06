
# Cycle 6 re-validation (2026-10-06)

**What ran:** the full `run-all` pass against the **local** stack (docker + Caddy, `app.localhost`, schema 1.70.0, branch `stitch-redsign`), 87 stages, 2026-10-05 20:30 UTC to 2026-10-06 00:11 UTC. One new suite was built first: `suites/lms/meta-console-1-70-authz.mjs` (the 1.70 Meta console write routes, every role + tenant B: 70/70 refusals, 0 served).

**Environment incident before the run.** Docker (Rancher Desktop) was wedged (`timed out dialing Hyper-V socket`) and Postgres sat in crash recovery. Recovery was `wsl --shutdown`, kill the stuck Rancher process, relaunch. The msq containers and the bind-mounted data survived (no image rebuild); Postgres finished recovery cleanly. A `pg_dump` was taken first: `db_backups/pre_e2e_local_2026-10-06.dump`.

**Totals as generated:** 1 764 findings: 18 critical, 124 high, 520 medium, 1 086 low, 16 info. **These counts overstate the product defects.** After triage against code, logs and the DB (below): the 18 criticals reduce to **1 confirmed critical (leave double-consumption) + 3 data-health items that need confirmation**; the 124 highs collapse into **7 root causes**; the rest of the highs are harness drift or local-DB drift. `capability-matrix-ui.mjs` **crashed** (its page selector no longer exists), so the Capability Matrix UI is **UNTESTED** this cycle, not clean.

**Not changed:** no product code was modified in this cycle. Every fix below is a proposal with the code location; nothing is applied, and no image was rebuilt. Only the long-tail findings (medium/low) were not individually root-caused; they are listed in the generated sections below.

## Triage: what the findings really are

| # | Root cause | Verified how | Real severity | Findings it explains |
|---|---|---|---|---|
| R1 | Leave approval has no row lock, so approvals double-consume | code read + the race finding (2 ledger rows, 200/200) | **Critical** (data integrity) | 2 critical/high (bulk+single, two approvers) |
| R2 | `translatePgError` ignores Postgres class-22 data errors, giving a bare 500 | code read; service logs show `invalid input syntax for type uuid`, `date/time field value out of range`, `invalid byte sequence`; deployed `dist/lib/errors.js` has no `22P02` | **High** (client-triggered 500) | about 75 highs (malformed id / month 13 / 2031-02-30 / NUL byte / year beyond INT) across HR, LMS, Tasks |
| R3 | `iam.departments`: `tenant_admin` has SELECT only | `information_schema.role_table_grants`; service log `permission denied for table departments` | **High** (feature broken for super_admin + tenant_admin) | 5 highs (create department) |
| R4 | Push subscription endpoint accepts any URL | `routes/push.ts` schema is `z.string().url()` only; the suite stored `http://169.254.169.254/...` | **High** (SSRF: the server POSTs to a user-chosen URL) | 3 highs |
| R5 | `GET /meta/integration` has no capability/rank check; writes are rank-gated | `integration.controller.ts` | **Medium** (not critical: no secrets returned, tenant-scoped; `tenant_admin` legitimately owns this route) | the 18 criticals were a **wrong harness assumption** ("super-admin only") |
| R6 | Lead transfer still throws a plain `Error` | `leads.repository.ts:962` | **High** (cycle-4 issue #2, unchanged) | 5 highs |
| R7 | Local DB lags the schema scripts (one-time applies not run) | `data-health` + catalog queries | **High locally; N/A once applied** | CAP-1/3/5, RLS-2/4/5, GRANT-1, LMS-1/5, IAM-2, XT-2 |

Everything else in the high list is harness drift after the Stitch redesign or an accepted product decision (section "Harness drift"), or is **not root-caused** (section "Open, not root-caused").

## R1. Leave approval double consumption: CRITICAL

- **Role/where:** `fitness_manager`, `POST /hr/leave/requests/:id/approve` racing `POST /hr/leave/bulk-decision` (also two approvers). Result: `http 200/200` and **2 `consumption` rows** in `hr.leave_ledger`, so the employee's balance is debited twice.
- **Control flow:** gateway `/hr/leave/requests/:id/approve` -> hr-service `leave.service.ts approveLeave` (line 93) -> `leave.repository.ts approveLeave` (line 525), one `serviceTxWithContext`.
  1. `loadRequestForAction` (line 448) does a plain `SELECT` with **no `FOR UPDATE`**.
  2. Both transactions see `status_name = 'pending'` and the same pending approval row.
  3. `UPDATE hr.leave_request_approvals SET action='approved' WHERE id = :pending` has **no `AND action='pending'`**, so the second tx, after waiting for the first to commit, still matches and updates.
  4. Both reach the final level and run `INSERT INTO hr.leave_ledger ... 'consumption'` (line 576); both also write the attendance rows.
- **Why it slips through:** `assertNotAlreadyApproved` reads the pre-commit snapshot, so it cannot see the other tx. `bulkDecideLeave` calls the same `approveLeave` per id in separate transactions, so it inherits the race. `decideCompOffClaim` / `decideEncashment` already lock (`FOR UPDATE`, lines 1389 / 1624); leave is the odd one out.
- **Fix (proposed):**

```ts
// leave.repository.ts loadRequestForAction: lock the request row for mutating callers
WHERE lr.id = ${id} AND NOT lr.is_deleted
FOR UPDATE OF lr

// approveLeave: make the approval update conditional and check it hit a row
UPDATE hr.leave_request_approvals SET action='approved', ...
 WHERE id = ${pending.id} AND action = 'pending' RETURNING id
// no row returned -> throw new ConflictError('Request was already decided')
```

  Backstop in `db_scripts` (new schema version): `CREATE UNIQUE INDEX uix_leave_ledger_consumption ON hr.leave_ledger(leave_request_id) WHERE entry_type='consumption';`. Apply the same lock to the reject / cancel / request-info paths (lines 608, 663, 702, 1474).
- **Existing damage:** before any UAT/prod rollout, run `SELECT leave_request_id, count(*) FROM hr.leave_ledger WHERE entry_type='consumption' GROUP BY 1 HAVING count(*)>1;` and reverse the extras. (Locally these are e2e fixtures.)

## R2. Class-22 Postgres errors surface as 500: HIGH

- **Where:** `translatePgError` in `src/lib/errors.ts` of hr-service, leads-service, meta-conversion-api and tasks-service (the same function, copied four times). It maps only `23505 23P01` (to 409) and `23503 23514` (to 400).
- **Control flow:** route -> controller -> repository -> drizzle raises `DrizzleQueryError` with the pg error on `.cause` -> `setErrorHandler` -> not `AppError`, not `ZodError`, `translatePgError` returns `null` -> `500 Internal server error`.
- **Triggers seen:** `22P02` (non-uuid id in a path/query), `22008` / `22007` (month 13, `2031-02-30`), `22003` (year beyond INT), `22021` (NUL byte in a name or file name).
- **Fix (proposed), one place per service, ideally deduplicated into a shared package:**

```ts
case '22P02': case '22007': case '22008': case '22003': case '22021': case '22P05':
  return new BadRequestError('One of the supplied values is not valid');
```

  Per-route `params: { id: uuid }` validation is still the right primary fix (a 404/422 naming the field); the translator is the backstop so no future route can 500 this way.

## R3. `iam.departments` write denied for the `tenant_admin` DB role: HIGH

- **Where:** `db_scripts/07_grants.sql:948-949`: `GRANT SELECT ... TO app_user, tenant_admin;` but `GRANT INSERT, UPDATE ... TO app_user, hr_svc;`.
- **Control flow:** `POST /hr/employees/departments` -> hr-service permission check passes -> the write runs on the pool for rank >= tenant_admin, which logs in as `tenant_admin` -> `permission denied for table departments` -> R2's gap turns it into a bare 500. super_admin and tenant_admin cannot create departments.
- **Fix (proposed):** `GRANT INSERT, UPDATE ON iam.departments TO tenant_admin;` in `07_grants.sql` plus the one-time apply script; confirm the table's RLS has a `tenant_admin` policy with `WITH CHECK`.

## R4. Web-push endpoint SSRF: HIGH

- **Where:** `msq-lms/services/notifications-service/src/routes/push.ts`, `subscriptionSchema.endpoint: z.string().url().max(2000)`.
- **Control flow:** any authenticated user (seen as `sales_representative`) POSTs a subscription -> stored (HTTP 201) -> the push sender later POSTs to that URL from inside the network. Cloud metadata (`169.254.169.254`), loopback and internal service names were all accepted.
- **Fix (proposed):** require `https:` and a host allow-list (`fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`) in `subscriptionSchema.refine`, and re-check the host at send time (DNS rebinding), refusing private and link-local ranges.

## R5. `GET /meta/integration` readable by every tenant user: MEDIUM (re-graded from 18 critical)

- **Where:** gateway `server.ts:859` is `withAuth`; `integration.controller.ts getIntegration` has no rank/capability check. `createIntegration` / `updateIntegration` check `ctx.rank < RANKS.TENANT_ADMIN`.
- **Impact:** any logged-in user of the tenant, including `read_only`, reads the pixel id, field mappings and the webhook path (which embeds the integration id). Secrets (`app_secret`, `verify_token`, `access_token`) are **not** returned. Tenant isolation holds (`ctx.tenant_id` comes from the token). The 18 criticals compared against a super-admin-only rule that does not apply to this tenant-level route.
- **Fix (proposed):** gate all three verbs on a capability added through the Capability Matrix, not on a rank number; this also removes a rank-based check that conflicts with the project rule that new access control is capability-based.
- **Harness fix:** drop `/meta/integration` from `META_READS` in `meta-routing-and-weights.mjs`; add an explicit capability test for it.

## R6. Lead transfer errors are 500s: HIGH (still open, cycle-4 #2)

`leads.repository.ts:962` `throw new Error('Lead not found or already inactive')` gives a bare 500 for re-transfer, unknown id, other-tenant and other-branch targets (5 findings). A `FOR UPDATE` exists at line 782 for the earlier read, but this closing step is unchanged. Fix: throw `ConflictError` / `NotFoundError`, re-check `is_active` and the affected row count in the closing `UPDATE`, and add `CREATE UNIQUE INDEX uix_lead_links_transfer_source ON lms.lead_links(source_lead_id) WHERE link_type='transfer'` (full diff in `open_issues/openissues-cycle5.curated.md`, section 2).

## R7. Local database drift (apply the one-time scripts)

| Check | Evidence | Fix |
|---|---|---|
| CAP-3 (high) | `lms.leads.bulk.update` and `lms.followups.bulk.reschedule` are **missing from `iam.capabilities`**, while `leads.controller.ts assertBulkAllowed` requires them, so **bulk update/reschedule is denied to every non-super-admin locally** | apply `reference_data/02_capabilities.sql` + the matching `one_time/apply_*capabilit*.sql` |
| CAP-5 (high) | 12 role/tenant pairs hold `lms.leads.assign.bulk` but not the 1.56-1.68 targets | same back-fill, pinned to effective holders per tenant |
| CAP-1 (high) | 7 Fitclass roles (cameraman, cto, intern ...) resolve without `platform.write`, so their writes 500 | grant `platform` + `platform.write` in the Capability Matrix |
| RLS-4 (high) | `ext.meta_page_health` and `ext.meta_pull_run_history` policies miss the NOINHERIT service logins, so the owning service reads **zero rows with no error** | re-run the widening DO block at the end of `08_rls.sql` |
| GRANT-1 (high) | `ext.lead_stage_capi_event_map` lacks the `lms_svc` grant | add to `07_grants.sql` |
| RLS-2 (high) | `iam.role_capabilities_bak_20260819` has RLS disabled | drop the leftover backup table |
| LMS-1/5 (high) | 8 licensed branches have no weighted assignee (3 with active reps), so auto-assign returns null | set weights in `lms.lead_assignment_weights` |
| IAM-2 (critical, **confirm**) | `root@root.com` mapped to an org of another tenant | delete the stray mapping; add the `o.tenant_id` assertion in `addOrgMapping` / `getUserOrgs` |
| XT-2 (critical, **confirm**) | one `ext.meta_page_form_org_map` row references an org of another tenant | repair the row; assert the referenced org's tenant in the page-map writers |
| RLS-5 (critical, **confirm**) | `lms_svc` holds SELECT on deny-all `ext.meta_ad_accounts` | `REVOKE` per `07_grants.sql` 1.68.0; first check whether 1.69 intentionally granted it |

The three "confirm" rows come straight from `data-health` SQL and were not traced further; treat them as critical until someone confirms intent.

## Harness drift (not product defects; treat as info)

| Finding | Why it is the harness | Action |
|---|---|---|
| `attendance monthly summary report` x5 (tenant_admin, hr_admin, fitness_manager) | the route is gated by `hr.reports.attendance.view`, which those roles do hold (DB checked); the suite looked for a stale key `hr.attendance.admin.reports.view` | update `hr-attendance-role-matrix.mjs` |
| todo `UI pass crashed` x4 | `#new-task-title` still exists; the suite waits for `[role="dialog"]` and the redesigned `Modal` no longer matches | update the selector in `tasks-v2.mjs:579` |
| `Open the Capability Matrix` + suite crash | `#matrix-role` no longer exists in the lookup-admin app | rewrite `capability-matrix-ui.mjs` for the new matrix page |
| `auth-recovery` / `auth-screens` aborted, `change-password ... Invalid token` | the redesigned "Set new password" button stays `disabled` until the form validates; the throwaway user's token was rejected | update the form-fill steps; recheck change-password with a fresh login |
| `Create a private task` 403 (sales_representative) | Tasks is licensed for MSquare, not Fitclass (accepted decision) | use an MSquare actor |
| `A stale browser silently overwrote...` | `first=undefined`: the first UI save response was never captured, so this is unverified, **not** an overwrite proof | recheck after the selector fix; optimistic locking was proven by the API-level suites |
| the 18 `/meta/integration` criticals | see R5 | change the expectation |

## Open, not root-caused

- **React #418 hydration** on API Tokens, Branding, `/profile` and Meta Ad Accounts (known cycle-4 #16): `toLocale*String()` renders in the server time zone; 13 files still use it. Also `GET /api/users/:id/photo?v=0` returns **404** for every user without a photo, on every redesigned page: handle the no-photo case in the avatar component instead of requesting the image.
- **Edit lead as `tenant_admin` / `msq_tenant_admin` gives 403** `You do not have permission to create follow-ups`: the server rule (`leads.controller.ts` lines 160-162) is intentional, but the edit form apparently sends `follow_up_scheduled_at` for users who lack `lms.followups.create`. Needs a UI check: omit or hide the follow-up field when the capability is missing.
- **`Restore 'lms.leads.assign.bulk'`** (org_admin): after removing the override the session reports the capability but the UI hides the control (cache / navigation state). The restore journal is empty, so the DB itself is clean.
- **`PUT /tenants/:id/modules` reaches admin-service for non-super-admins** (low): the controller refuses with `Super admin only`, so a valid body is rejected; the gateway route should still carry `withSuperAdmin` like its neighbours (defence in depth).

## What this cycle did not cover

- Meta console actions that call the real Meta API or import leads (Sync, Pull, Apply, Validate, Archive of a real campaign): blocked by design; only authorization and invalid-input handling were exercised.
- Capability Matrix UI (suite crashed, see above).
- Anything on UAT or production: this was a local run only.
