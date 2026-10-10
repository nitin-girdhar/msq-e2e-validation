# Cycle 10 validation (2026-10-10, local stack recreated from the 08:46 IST image bundle, schema 1.81.0)

**What ran:** the full `run-all` pass, 96 stages, 04:30 to 09:04 UTC, against the **local** stack. Containers were recreated from `msq-deploy/artifacts/msq-images.tar` (every container verified on the loaded image id); the DB was already at 1.81.0 (3 tenants, 224 users). Preflight: 58/58, no drift. All 96 stages exited cleanly except the new suite below, which crashed on a bug in the suite itself (a non-existent `iam.users.tenant_id` column), was fixed and re-run in place: 17/17.

**Raw volume:** 1,618 findings (critical 2, high 89, medium 477, low 1,028, info 22). Collapsed by tool with the role name removed they are 218 distinct groups. **Most of the "high" count is one cause repeated per role** (75 of 89, see C10-2) and a further handful are harness drift, so the raw count overstates the product risk. The per-tool, per-role, per-page record is in the generated sections below and in `msq-e2e-validation/results/SUMMARY.md`.

How each item below is classified:
- **CONFIRMED**: I read the code path and observed the live behaviour.
- **HARNESS DRIFT**: the product behaves correctly and the suite's expectation is stale.
- **CARRIED**: already open from an earlier cycle.
- **NOT ROOT-CAUSED**: reported by the suites but not investigated in this pass. Listed, not dismissed.

## New suite: `suites/hr/face-match-punch-1-81.mjs` (schema 1.81.0 in-process face match)

17 passed, 0 failed.
- **Template isolation:** RLS enabled and forced on `hr.face_templates` with no policy; no privilege for `app_user`, `tenant_admin`, `hr_svc`, `analytics_svc`, `lms_svc`; every row is `enc:v1` ciphertext; no orphan pointer; no cross-tenant row.
- **Punch matrix as `rep1`, rule on:** `block` + not enrolled returns 422 `FACE_NOT_ENROLLED` and writes no row; `block` + undecryptable template fails open with `passed=NULL`, review `pending`; `flag` + not enrolled succeeds with review `pending`; neither `face/me` nor the check-in response contains ciphertext.
- State (rule row, org geo, template, punches) is restored afterwards.
- **Not covered:** the face-positive happy path and a below-threshold mismatch need a consented real photo (the `scripts/face-calibrate.ts` calibration is still pending).

## Confirmed product issues

### C10-1 [medium, CONFIRMED] Gateway drops `Cache-Control` / `ETag` on employee document and photo downloads
- **Where:** `msq-core/services/api-gateway/src/server.ts:1435` (`GET /hr/documents/:id/file`), `server.ts:715` (`GET /users/:id/photo`) and the documents export zip route. All call `proxyTo` without `forwardResponseHeaders`.
- **Control flow:** hr-service sets `Cache-Control: private, no-store` (`msq-hrms/services/hr-service/src/api/v1/documents/documents.router.ts:174-176` zip, `:221-224` file). `proxyTo` (`api-gateway/src/lib/proxy.ts:136-142`) forwards only `Content-Type`, `Content-Disposition` and the names in `options.forwardResponseHeaders`, so the header never reaches the browser. The avatar routes at `server.ts:694-700` do pass the list, which is why they are unaffected.
- **Evidence:** `hr-documents-vault` captured `nosniff | undefined` (second value is cache-control) and the zip headers with cache-control `undefined`; `attendance-face-enroll` captured `etag=undefined` on the photo. I did not re-curl by hand.
- **Impact:** identity documents and staff photos can be kept by a shared cache or the browser, and conditional photo requests never get a 304.
- **Fix:** pass `{ forwardResponseHeaders: ['cache-control', 'etag', 'x-content-type-options'] }` on those three routes, as `server.ts:694-700` does.

### C10-2 [low, CONFIRMED] Unknown paths with two or more segments return 400 "Invalid path parameter", not 404
- **Where:** gateway global hook `app.addHook('preValidation', rejectUnsafePathParams)` at `server.ts:68`, implemented in `lib/upstream-url.ts:26-31`.
- **Observed:** `POST`, `GET` and `DELETE /nonexistent/zzz` all return 400 `{"error":"Invalid path parameter"}` on the gateway directly and through `/api`; a single-segment unknown path (`POST /zzz`) returns 404. The routes `capability-toggle` was probing (`/meta/crm-event`, `/communications/send|email|whatsapp/text|whatsapp/template`) are genuinely not registered (only `/public/v1/communications/send` and `GET /communications/status` exist), so **no send route is reachable**. The 75 "route removed in 1.76.0 was re-opened" highs (5 routes x 15 logins) are this 400, not a regression of the wall.
- **Not identified:** which registered route a two-segment unknown path matches. Something yields a parameter containing `/`, which `UNSAFE_PARAM` rejects. Starting point: `app.printRoutes()` and look for a wildcard or catch-all.
- **Fix:** make unknown paths 404 (skip the hook when no route matched, or remove the stray wildcard). Until then `capability-toggle` should accept 404 or this 400 for removed routes.

### C10-3 [low, CONFIRMED; data-health's "critical" RLS-5 is overstated] `lms_svc` holds table privileges on `ext.meta_ad_accounts`
- **Where:** `db_scripts/07_grants.sql:796` revokes only from `app_user, tenant_admin`. The `ext` schema's default ACL gives `lms_svc` `arw` on new tables. Live: `has_table_privilege('lms_svc', 'ext.meta_ad_accounts', ...)` is true for SELECT, INSERT and UPDATE.
- **Why it is not a leak today:** the table has RLS enabled and forced with **no policy**; `SET ROLE lms_svc; SELECT count(*)` returns 0 while the table holds 8 rows. The columns are names, status and sync timestamps, with no tokens.
- **Risk:** defence in depth only. A policy added later for another reason would open it.
- **Fix:** add `lms_svc` to the revoke at `07_grants.sql:796` and scope the `ext` default privileges. **First confirm which database login `meta-conversion-api` uses**: `ad-accounts.service.ts`, `campaign-sync.service.ts` and `datasets.service.ts` read this table and I did not verify that.

## Harness drift (verified, not product defects)

| Finding(s) | Why it is drift |
|---|---|
| 4 highs "branch fence: Head-Office HR reads / PUTs Sector-69 colleague" (`hr-profile-360.mjs:321-322`) | The target is the manager actor, homed in Gurugram - Sector 69. Since Cycle 9 `auth-setup` logs `hr_admin` into Sector 69 and the account is mapped into all 28 Fitclass branches (`roles.json`), so the read is in-branch. The suite still assumes a Head-Office session. The wider mapping is the privilege widening already flagged in `roles.json` for confirmation. |
| `fitness_trainer` "Apply for casual leave (1 day)" 400 "contain no working days"; `tenant_admin` "Read the resolved day after recompute" (no row) | The run date, 2026-10-10, is a Saturday. |
| `sales_representative` "Create a private task" 403 "no access to the Tasks product in this organization" | Tasks is licensed for MSquare, not Fitclass (known). |
| 7 roles "/lms/dashboard/my-leads: blocked although the role holds lms.leads" | Every role lands on `/lms/dashboard/leads-history` with HTTP 200, so the route is redirected rather than blocked; the suite reads a redirect as a block. |

## Carried forward (already open, re-observed)

- React hydration error #418 on `/hrms` (as `hr_admin`) and `/sa/dashboard/m/capabilities` (as `super_admin`); containers run UTC, the browser IST.
- LMS auto-assign: 2 of 26 licensed branches with active reps have no weighted user (Delhi - Moti Nagar, Gurugram - Civil Lines).
- IAM-2: `root@root.com` is mapped to an org of another tenant (known fixture, homed in MSquare).
- CAP back-fill: roles holding a back-fill source capability but not its target key.

## Reported but NOT root-caused this pass

| Area | Finding | Roles | Note |
|---|---|---|---|
| Visual | Disabled-state integrity (91), overlapping controls (88), tab-strip rendering (48) at narrow widths; iPad-portrait render findings across LMS, HR and ToDo | 4 to 8 | Bulk of the 477 mediums. Plausibly real layout issues; not looked at. |
| LMS | "create a follow-up on a lead" (8 roles), "log an interaction on an existing lead" (7), "create a new lead" (4), "create an API client/token" (4) | 4 to 8 | Permission-matrix grading; could be intended denials. |
| HR | "/hrms/team HTTP error on a normal page load" (7), "/hrms/dashboard HTTP error" (3); "create a public holiday", "create a leave policy", "change leave-year settings" (4 each) | 3 to 7 | Same family as the Cycle 9 ApplyLeavePanel 403s for non-managers. |
| HR (single role) | `fitness_trainer` remote_role geo-exception and punch labelling, empty regularization chain; `msq_rep1` payslip UI; `fitness_manager` reject encashment 403; `msq_org_admin` pending document not in review queue; `pre_sales_captain` and `assistant_fitness_manager` "Load /profile" (404 sub-calls) | 1 each | Likely fixture or date related; unverified. |
| Core | `PUT /tenant/branding` (rename a term) refused a permitted actor | 3 | |
| ToDo | list rename did not persist (2), board view shows fewer status columns (4), stale-browser overwrite (`first=undefined`, looks like a harness read error) | 1 to 4 | |
| Admin / lookup | Console says "Access restricted" although the login holds an admin node (2); some lookup tables unreadable for some roles; 18 catalog-drift items across Fitclass, MSquare and Novamin | | |

## What this cycle did not cover
- Face-positive match and below-threshold mismatch (need a consented real photo).
- Nothing was exercised against UAT or prod.
- No review of the 1,028 low findings.

# Cycle 8 re-validation (2026-10-09, after the Cycle 7 fixes, schema 1.78.0)

**What ran:** the full `run-all` pass (90 stages) against the **local** stack on **rebuilt images** (hr-service, leads-service, api-gateway, lms-web, admin-web, lookup-admin, then identity-service twice), after applying `one_time/apply_min_rest_hours.sql` (1.77.0) and `one_time/apply_departments_tenant_admin_write.sql` (1.78.0) to the local DB (backup: `db_backups/pre_cycle8_fixes_2026-10-09.dump`). One stage timed out (`admin-web-console`, a lone timeout) and passed on rerun in 924 s. Totals: **1 552 findings: 2 critical, 32 high, 475 medium, 1 027 low, 22 info** (Cycle 7: 1 595 / 2 / 61 / 480 / 1 029 / 23).

A new suite, `suites/regression/cycle7-fixes.mjs`, drives each Cycle 7 fix as the roles that hit it and grades it against the DB. It passed with **0 findings**.

## Status of the Cycle 7 items

| Item | Cycle 7 | Now | Evidence |
|---|---|---|---|
| N1 payroll malformed month | High | **FIXED** | publish / lock / unlock x `2020-13`, `abc`, `2020-3-1`, `2020-00` as `hr_admin`, Fitclass `tenant_admin`, MSquare `org_admin`: all 422 (was 500) |
| N2 remove emergency contact | High | **FIXED** | `msq_rep1` and `tenant_admin`: 204 and `is_deleted` in the DB |
| R3 `tenant_admin` cannot write `iam.departments` | High | **FIXED** | `tenant_admin`, `super_admin`, `msq_tenant_admin` create (201) and rename a department |
| R2 class-22 errors give 500 | High | **FIXED** (image was stale) | all four services already carried the translator; rebuilt images no longer 500 |
| N3 campaign summary tenant-wide | High | **FIXED** (product decision, see below) | `org_admin` sees 1 branch; `tenant_admin` (holds `lms.analytics.org.view`) sees 11 |
| N5 `PUT /tenants/:id/modules` | Low | **FIXED** | `tenant_admin`, `org_admin`: 403 at the gateway for an invalid and a valid body |
| N7 reset attempts spend the login budget | Low | **FIXED** | 8 failed resets, then login answers 401, not 429 |
| N4 hydration #418 | Medium | **PARTLY FIXED** | `LocalDateTime` now on API Tokens, Branding and 5 Meta screens. React #418 still shows on `/hrms/attendance` for `sales_representative` (see "Open") |
| N6 `tenant_admin` edit lead 403 | High | **FIXED in code, not exercised** | `LeadEditModal` no longer offers follow-up stages (or sends follow-up fields) without `lms.followups.create`; no suite drives it as `tenant_admin` yet |
| R7 data drift | High | **OPEN (data)** | below |

**Decision to confirm (N3).** Campaign summary is now limited to the caller's own branch unless they hold `lms.analytics.org.view` (the dashboard's rule). `org_manager` currently gets 0 rows. If branch managers should see tenant-wide campaign totals, grant them `lms.analytics.org.view` instead of widening the query.

## New defects found this cycle

### C8-1. My `iam.departments` change dropped the service-login roles: HIGH (found by data-health RLS-1, fixed)

- **Control flow:** `apply_departments_tenant_admin_write.sql` did `DROP POLICY ... tenant_isolation_policy; CREATE POLICY ... TO tenant_admin`. The closing widening block of `08_rls.sql` is what adds the NOINHERIT service logins, and a one-shot does not run it, so the owning service would read zero rows with no error.
- **Fix (applied):** `ALTER POLICY tenant_isolation_policy ON iam.departments TO tenant_admin, tenant_dash_svc` in the one-shot (same role list as every other tenant policy) and on the local DB.

### C8-2. Two reset links live after back-to-back requests, and the per-user cap is not enforced: HIGH then MEDIUM (fixed)

- **Where:** `identity-service/src/api/v1/auth/auth.repository.ts createResetToken`, `auth.service.ts requestPasswordReset`.
- **Control flow:** the controller answers before the token write runs, so overlapping requests all pass `countRecentResetRequests` and each retires nothing and inserts a token (2 unused, then 4 rows against a cap of 3).
- **Fix (applied, rebuilt):** `createResetToken` takes `pg_advisory_xact_lock(hashtextextended(user_id, 0))`, re-checks the cap inside the lock, and returns `false` (no email) at the cap. Verified: 2 live tokens no longer occur; the cap re-check held on the rebuilt image (`auth-recovery` rerun: 0 findings).

### C8-3. `DELETE /api-clients/:id` with a malformed id returns 500: MEDIUM (fixed)

- **Control flow:** `identity-service api-clients.router.ts` had no params schema on `PATCH/DELETE/rotate :id`, so a non-uuid reached Postgres as `22P02` and surfaced as a bare 500 (identity-service has no `translatePgError`).
- **Fix (applied, rebuilt):** `validate({ params: z.object({ id: z.string().uuid() }) })` on all three routes (422).

## Open, carried forward

- **R7 data items (all local data; need an owner):** `IAM-2` (`root@root.com` mapped to both tenants, confirm intent then exempt `super_admin`), `RLS-5` (`ext.meta_ad_accounts` grants to `lms_svc` / `analytics_svc`, confirm or `REVOKE`), `LMS-1` / `LMS-5` / `W1` (9 licensed branches and 2 branches with active reps have no weighted assignee, set weights in `lms.lead_assignment_weights`), `CAP-5` (re-run the back-fill pinned to effective holders). The three `iam.*_bak_*` tables now have RLS on (RLS-2 closed).
- **Hydration #418 on `/hrms/attendance`** (`sales_representative`): not root-caused. `MyMonthCalendar.tsx:65` falls back to `new Date().toLocaleDateString('en-CA')` for `today` (server and browser zones differ near midnight); the same pattern is in `TeamRosterShell.tsx:24`, `PunchLog.tsx:44`. The other fixed-locale `en-IN` / `timeZone: 'UTC'` sites are deterministic.
- **Highs that are harness drift, not product defects:** `attendance monthly summary report` x5 (the suite looks for a stale capability key), `Create a private task` 403 (Tasks is licensed for MSquare, not Fitclass), the HR people-UI and payslip-modal selectors after the Stitch redesign, `Recompute a day` 409 (Oct 2026 payroll is locked by an earlier suite), `A stale browser silently overwrote...` (first save response not captured, unverified).

## Roles, tools and coverage

21 logins from `read_only` (fixture) up to `super_admin` on both tenants (Fitclass ladder and MSquare), across auth-web, admin-web, lookup-admin (SA), lms-web, hr-web and todo-web. Every tab, dropdown and button was opened by the deep crawls; real writes, capability on/off (via the Capability Matrix) and two-user races ran in the role-matrix, capability and concurrency bands. Per-page and per-tab results are in Parts A0 and A below, generated from `results/`.

---

# Cycle 7 re-validation (2026-10-09)

**What ran:** three full `run-all` passes against the **local** stack (docker + Caddy, `app.localhost`), then targeted reruns. The final pass ran against the **rebuilt images carrying the latest repo changes (schema 1.76.0)**. 87 stages, **all clean** after reruns (the HR and Tasks crawls each timed out once and passed on rerun in 1688 s and 460 s). Totals: **1 595 findings: 2 critical, 61 high, 480 medium, 1 029 low, 23 info**. Cycle 6 had 18 critical / 124 high. Most of the remaining highs are harness drift or the open items below, not new product defects.

**Environment.** Docker (Rancher) hit the Hyper-V socket stall about a dozen times during passes 1-2 and fully hung once; the owner restarted Rancher and rebuilt the images. A stall during a stage crashes it or silently skips its DB checks, so every stall-hit stage was rerun in place (`rerun.mjs`).

**Roles and tenants exercised.** 21 logins: `read_only` (fixture) up to `super_admin`; the Fitclass ladder (`tenant_admin`, `org_admin`, `hr_admin`, `org_manager`, `fitness_manager`, `assistant_fitness_manager`, `pre_sales_captain`, `senior_sales_executive`, `fitness_trainer`, `sales_representative`) and the MSquare tenant (`tenant_admin`, `org_admin`, `cto`, `content_manager`, `editor`, `sd_1`, plus a `sales_representative` fixture). Capability on/off was driven through the Capability Matrix UI and by tenant-scoped overrides (journalled and restored).

**Product code changed in this cycle:** none. All edits are in `msq-e2e-validation` and are listed under "Harness corrected this cycle". Every fix below is a proposal.

## Status of the Cycle 6 items (verified live on the rebuilt stack)

| Item | Cycle 6 | Now | How verified |
|---|---|---|---|
| R1 leave approval double consumption | Critical | **FIXED** | `uix_leave_ledger_consumption` exists; 0 requests with more than one consumption row; both race suites report nothing at medium or above |
| R2 class-22 Postgres errors -> 500 | High | **OPEN** | `POST /hr/payroll/admin/abc/lock` -> 500 (see N1, a variant R2's fix would not cover) |
| R3 `tenant_admin` cannot INSERT `iam.departments` | High | **OPEN** | grants on `iam.departments` for `tenant_admin` are `SELECT` only; `POST /hr/employees/departments` -> 500 for `tenant_admin` and `super_admin` |
| R4 web-push endpoint SSRF | High | **FIXED** | `169.254.169.254`, `localhost`, `10.0.0.5` all rejected with 422 |
| R5 `GET /meta/integration` open to every role | Medium | **FIXED** | `read_only` now gets 403; the 18 harness criticals are gone |
| R6 lead transfer plain `Error` -> 500 | High | **FIXED** | the throw is gone from `leads.repository.ts`; no high or critical transfer findings |
| R7 local DB drift | High | **PARTLY FIXED** | CAP-3 fixed (`lms.leads.bulk.update` and `lms.followups.bulk.reschedule` now exist). Open: RLS-2, LMS-1/5, CAP-5, IAM-2, RLS-5 (table below) |

## New defects found this cycle

### N1. Payroll publish / lock / unlock with a malformed month returns 500: HIGH

- **Role/where:** any caller holding `hr.reports.payroll.manage` (seen as MSquare `org_admin`). `POST /hr/payroll/admin/:month/{publish,lock,unlock}` with `2020-13`, `abc`, `2020-3-1` -> HTTP 500 `Internal server error` (9 findings).
- **Control flow:** gateway `server.ts:1385-1395` -> hr-service `payroll.router.ts:86-100`. The preHandler is `[authenticate, manage]` with **no `validate({ params })`** -> `monthParam(request)` -> `payroll.repository.ts` (`publish` ~151, `setLock` ~163) -> `monthStart()` in `lib/payroll/payroll.ts:36-39`, which does `throw new Error('Invalid month: ...')`. A plain `Error` is neither an `AppError` nor a Postgres error, so the error handler (and R2's `translatePgError`) returns a bare 500. The GET routes are protected: they run `validate({ query: payrollMonthQuerySchema })`.
- **Fix (proposed):** (1) `monthStart` throws `BadRequestError('Month must be YYYY-MM')`; (2) add the same month schema as `validate({ params })` on the three POST routes so the 400 happens before any repository work.

### N2. Removing an emergency contact returns 500 for every employee: HIGH

- **Role/where:** any employee. `DELETE /hr/profile/me/contacts/:id`, the "Remove contact" button in the profile UI, and deleting an already-removed contact.
- **Control flow:** `profile.repository.ts removeOwnContact` (line 206) runs `withRoleTx`, then `UPDATE hr.emergency_contacts SET is_deleted = TRUE, is_active = FALSE ... WHERE id AND user_id AND NOT is_deleted`. The table's only `app_user` policy, `self_policy` (`db_scripts/08_rls.sql:1474-1476`), has `WITH CHECK (user_id = ... AND NOT is_deleted)`. The UPDATE produces a row with `is_deleted = TRUE`, which **fails its own WITH CHECK**; Postgres raises `new row violates row-level security policy for table "emergency_contacts"` (confirmed in the hr-service log) and it surfaces as a bare 500. Contacts can be added and listed but never removed.
- **Fix (proposed):** run the soft delete in a service transaction with the caller's `user_id` predicate (the repo's rule for soft delete under RLS), or drop `AND NOT is_deleted` from the `WITH CHECK` only. Audit other `self_policy ... NOT is_deleted` tables that soft-delete through `withRoleTx`.

### N3. Campaign summary returns other branches' rows to branch-scoped roles: HIGH (confirm intent)

- **Role/where:** `org_admin` and `org_manager`. `GET /analytics/dashboard/campaigns` returns rows for 9-10 branches the caller does not cover.
- **Control flow:** `analytics.controller.ts getCampaignSummary` (line 32) passes only `org_id, user_id` -> `analytics.repository.ts getTenantCampaignSummary` (line 92) hard-codes `role: 'tenant_admin'` in `withRoleTx` and selects `FROM marketing.vw_tenant_campaign_summary WHERE tenant_id = ...`. There is no branch filter and the transaction runs with tenant-wide RLS, so the answer is tenant-wide for every role that passes the capability check. The neighbouring `getPipelineByStage` scopes to `org_id`.
- **Impact:** inside one tenant only (no cross-tenant leak). A branch manager sees other branches' campaign performance.
- **Fix (proposed):** resolve `getCoveredOrgIds(ctx)` (as the lead-write paths do) and filter the view by it, or run the query in the caller's own role. If tenant-wide totals are intended for these roles, put them behind a dedicated capability instead of `lms.analytics.view`. Confirm with product first.

### N4. Hydration mismatch (React #418) on API Tokens, Branding and other admin screens: MEDIUM (was "not root-caused")

- **Role/where:** reproduced with Playwright as `tenant_admin` on `/admin/dashboard/api-tokens`: one page error "Minified React error #418" on load.
- **Control flow:** `components/api-tokens/ApiTokensTable.tsx:178,209` and `components/branding/BrandingSettings.tsx:166` render `new Date(x).toLocaleString()` inside client components that are also server-rendered. The server formats in its own locale and time zone (UTC, en-US); the browser re-renders in the user's, the text differs, and React discards the server HTML for that subtree (console error, flicker).
- **Fix (proposed):** one shared `<LocalDateTime iso=... />` in `@platform/ui-kit` that renders a fixed-locale string on the server and swaps to the user's locale in a `useEffect`, or a `<time suppressHydrationWarning>`. Replace the remaining `toLocale*String()` call sites.

### N5. `PUT /tenants/:id/modules` reaches the service for non-super-admins: LOW (defence in depth)

- **Where:** gateway `server.ts:588-595` registers the route with `withAuth` (its neighbours use `withSuperAdmin`). admin-service `tenant-modules.router.ts` runs `validate({ params, body })` **before** the controller's `rank < SUPER_ADMIN` check (`tenant-modules.controller.ts:9,16`). A `tenant_admin` with an invalid body gets 422 and with a valid body 403 from the controller. No escalation, but the edge guard is missing.
- **Fix (proposed):** `{ ...withSuperAdmin }` on both routes; keep the controller check.

### N6. Editing a lead as `tenant_admin` is refused with 403: HIGH (capability / UI mismatch)

- **Role/where:** `tenant_admin` (Fitclass and MSquare), Leads -> Edit lead, change stage and add a note -> 403 `You do not have permission to create follow-ups`; nothing is saved.
- **Control flow:** the edit form sends the follow-up fields with the stage change; `leads.controller.ts` lines 40, 50 and 160 call `need(CAPABILITY.LMS_FOLLOWUPS_CREATE)`. `iam.fn_role_capability_matrix` shows **every `lms.followups.*` capability is false for `tenant_admin`** while `lms.leads.edit` is true, so the user may open and submit a form the server then rejects as a whole.
- **Fix (proposed):** grant `lms.followups.*` to `tenant_admin` in the Capability Matrix, or make the form hide the follow-up controls when the session lacks `lms.followups.create`, and split the save so a lead edit without a follow-up never needs that capability.

### N7. Failed password-reset attempts lock the same IP out of login: LOW

- **Role/where:** anonymous. A handful of failed `POST /auth/reset-password` calls from one IP, then `POST /auth/login` from that IP returns 429.
- **Control flow:** `api-gateway/src/server.ts:101` registers `/auth/reset-password` with `preHandler: [loginRateLimit]`, the same limiter instance (10 requests per 60 s per IP, in-memory, `lib/rate-limit.ts`) that guards login and switch-org. Reset attempts spend the login budget.
- **Impact:** low. Anyone behind a shared NAT can lock colleagues out of login for a minute by hammering reset with bad tokens.
- **Fix (proposed):** give reset its own `createRateLimiter` instance (and key it by token prefix plus IP), leaving the login bucket separate.

## R7 (carried forward, still open)

| Check | Evidence now | Fix |
|---|---|---|
| RLS-2 (high) | 3 backup tables without RLS: `iam.role_capabilities_bak_20260819`, `iam.role_capabilities_bak_20261008`, `iam.capabilities_bak_20261008` (the last two come from the 1.76.0 capability-walls migration) | drop after the retention window, or enable RLS |
| LMS-1 / LMS-5 / W1 (high) | 9 licensed branches without a weighted assignee; 2 of 26 branches with active reps have no weighted user, so auto-assign returns null | set weights in `lms.lead_assignment_weights` |
| CAP-5 (high) | 2 role/tenant pairs hold a back-fill source capability but not its 1.56-1.68 target | re-run the back-fill pinned to effective holders |
| IAM-2 (critical, **confirm**) | `root@root.com` is mapped to orgs of both tenants. For a platform `super_admin` this is probably intended; the check should exempt `super_admin` | confirm intent, then exempt it in `data-health` or delete the mapping |
| RLS-5 (critical, **confirm**) | `ext.meta_ad_accounts` is documented root_service-only (`07_grants.sql:786-789`) but live grants include `lms_svc` SELECT/INSERT/UPDATE and `analytics_svc` SELECT. Row access is still denied (RLS on, no policy), so this is defence in depth | confirm whether 1.69.0 intended the grants; if not, `REVOKE` |

## Harness corrected this cycle (not product defects)

| Finding | Cause | Change |
|---|---|---|
| preflight: 4 missing logins | `roles.json` listed `@msquareprofessionals.in` users; the DB has `@msq.in` | updated; added `msq_editor`, `msq_content_manager`, `msq_cto`, `msq_sd1`; `msq_rep1` is now a `sales_representative` fixture created by `provision-readonly.mjs` |
| Payroll, payslip and announcement suites showed "employee can manage payroll" | `msq_rep1` had been the MSquare HR admin account, which holds `hr.reports.payroll.manage` | fixture user above; every suite using `msq_rep1` was rerun |
| `tasks-v2`, `task-soft-delete` crashed | stale emails; branch name `KSH` (the MSquare branch is `Kinshasa`); `[role="dialog"]` matched the permanent nav drawer first | emails, branch, and a selector that requires `#new-task-title` |
| `capability-matrix-ui` crashed | `#matrix-role` was removed by the Capability Matrix redesign (department and role chips, tools -> modules -> operations drilldown, Review & Save) | rewritten; **now passes: UI, DB, resolver and live session agree** |
| `capability.mjs roleId()` | picked the inactive tenant copy of a role, so overrides never reached users (false "PATCH succeeded without tasks.edit") | now filters `is_active` |
| `auth-screens` aborted | the request interceptor matched `evil.example` inside our own query string and aborted the test's own navigation | match on host; the hostile `callbackUrl` is correctly rejected by `resolveCallback` |
| `branding` (3 findings) | expected the old `brand/<tenant>/` key and exactly four slots | now `<tenant>/branding/<slot>/...` and the current 13 slots |
| `leave-apply-v2` | token layout `leave/<org>/<user>/` (now `<tenant>/<org>/<user>/leave/`); the fixture pool lost a request to a 409 overlap | new layout; pool retries and logs refusals |
| `cross-tenant-new-modules` | counted an id the caller itself sent as a "leak" | ignore ids present in the request |
| **Branding ownership** (2 highs) | **the ownership split changed on purpose**: `platform-validation/src/branding.ts` gives Super Admin names, words, menu labels and regional formats, and the tenant admin only the theme (`tenantBrandingUpdateSchema` is `.strict()`); the suite still encodes the old split | NOT yet rewritten: update O2/O4 in `branding-ownership.mjs` |
| `Create a private task` 403 | Tasks is licensed for MSquare, not Fitclass | accepted decision; use an MSquare actor |
| lead-transfer matrix mediums | `POST /leads/:id/transfer` is now a branch transfer (`target_org_id`, creates a copy); the matrix step tested the removed reassign-to-user contract | step retired (covered by `lead-transfer.mjs`) |
| `auth-recovery` aborted (3 passes) | the test typed `pw('again')` into both fields, and `pw()` embeds `Date.now()`, so the passwords differed and the form correctly kept its button disabled | one constant for both fields; **suite now passes** |

---

# Carried forward from Cycle 6 (detail for R1-R7)

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
