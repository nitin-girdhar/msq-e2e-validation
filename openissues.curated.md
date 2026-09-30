---

# Cycle 5 re-validation (2026-09-30)

**What ran:**
- **Data:** a **fresh production copy**, restored 2026-09-29 and migrated 1.48.0 → 1.55.1 per `msq-deploy/DB_ROLLOUT_1.48.0_to_1.55.1.md`.
- **Code:** current images, including the 1.55.0 super-admin tenant switch.
- **Suites:** the full `run-all` pass, 60 stages.
  - The 3 crawls that hung on Docker's Hyper-V stalls overnight were re-run on their own and pass.
  - 14 suites whose actor or expectation was outdated were fixed and re-run in place with `rerun.mjs`.
- **Totals after re-verification:** 1 critical (data only), 26 high, 183 medium, 482 low.

## Status of every cycle-4 issue

| # | Issue | Cycle-5 status | Evidence |
|---|---|---|---|
| 1 | Denied switch-org filed in the other tenant's audit trail | ✅ **Fixed** (1.54.0 / 1.55.1) | switch-org suite: 0 cross-tenant rows; tenant B feed has 0 foreign performers |
| 3 | `/activities` 500 + no tenant predicate | ✅ **Fixed** (1.54.0) | API sweep: no 5xx on `/activities`; each feed holds only its own tenant's users |
| 2 | Lead transfer: 500s, branch pin, race | ❌ **Open** | 6 highs (re-transfer / missing id / other-tenant / other-branch → 500; tenant_admin cross-branch 500); transfer race loser 5xx 5/5 |
| 4 | Regularizations created without approvers | ❌ **Open** | fitness_trainer's own regularization: `chain=[]` |
| 4b | Resolved approver lacks `hr.leave.approve` | ⚠️ **Latent, not re-exercised** | This cycle's employee (fitness_trainer) reports to a fitness_manager who *does* hold approve. The defect is untouched in code, and reps' manager (senior_sales_executive) still lacks it. |
| 4c | HR admin actions pinned to the session branch; recompute no-op | ❌ **Open** | hr_admin approve/reject → 404, geo-exception → 400 "User not found in this org", recompute 2xx with no row, split-shift punches read → 0 events |
| 5 | Department create/update 500 | ❌ **Open, wider** | Now **super_admin too** (500): since 1.55.0 super_admin runs as the `tenant_admin` PG role, which lacks the INSERT/UPDATE grant and write policy |
| 6 | Malformed `:id` → 500 | ❌ **Open** | `GET /hr/attendance/regularizations/not-a-uuid` → 500 |
| 7 | Leads grid shows Edit to read_only | ❌ **Open** | read_only Edit → Save → 403 |
| 8 | Apply leave shown to read_only | ❌ **Open** | read_only sees Apply leave |
| 9 | Follow-up date required without `lms.followups.create` | ❌ **Open, wider** | Now also **Fitclass tenant_admin** (its follow-up grants were removed in prod); MSquare tenant_admin still 403 |
| 10 | New-user modal pre-fills an inactive branch | ⚠️ **Latent** | Not reproduced because "Fitclass - Head Office" was re-activated in prod; the code is unchanged, so it returns as soon as any admin's home branch is deactivated |
| 11 | Token revoked at birth after a password reset | ⚠️ **Not reproduced** | Timing-dependent (same-second reset + login); code unchanged |
| 12 | super_admin cross-tenant grid / 404 | ✅ **Superseded** by the 1.55.0 tenant switch (super_admin is fenced to the session tenant; the branch picker lists every tenant **by design**) | data IAM-2 (root's stray cross-tenant mapping) is still critical in data-health: remove it |
| 13 | Lead FK trigger ignores `campaign_type_id` | ❌ **Open** | No code change (not exercised by a suite) |
| 14 | Tablet overflow | ❌ **Open** | 48 overflow findings |
| 15 | Gateway drops ETag | ❌ **Open** | photo GET: `etag=undefined` |
| 16 | React #418 hydration (`toLocaleString`) | ❌ **Open** | api-tokens (super_admin, tenant_admin, **hr_admin**), SA HRMS pane, SA leave-request-statuses |
| 17 | `/tenants/:id/modules` edge guard | ❌ **Open** | tenant_admin / org_admin PUT → 422 (past the edge) |
| 18 | `200 []` for a foreign lead's sub-resources | ❌ **Open** (low) | 5 findings, no data leaked |

## New in cycle 5

| Sev | Finding | Detail |
|---|---|---|
| **Confirm** | **Fitclass `hr_admin` re-ranked 75 → 980** (org_admin level) in prod, and `hr-admin@fitclass.in` is mapped into all 28 Fitclass branches | At 980 it passes every `rank ≥ ORG_ADMIN` gate. The UI round trip shows **hr_admin creating a user (201)**. MSquare and the platform default keep 75. If unintended, restore 75 in the Capability/User Roles screen. |
| Low | Leave approval race: two simultaneous approvals by the same approver both return **200** | Only **one** approval row is written and the request advances once (no double approval), but the losing tab should get 409 "already decided" instead of a silent success. `leave.repository.ts approveLeave`: return `ConflictError` when the level is no longer pending. |

## Production config changes discovered by this cycle (not defects)
- Fitclass `sales_representative` now holds **0 HR capabilities** (it had 13). Reps can no longer check in, enroll a face or apply for leave. The harness now uses `fitness_trainer` as the HR employee (`roles.json hrEmployee`).
- Fitclass `tenant_admin` lost `lms.followups.*`, which is what makes it hit #9.
- The Fitclass HR admin account is now `hr-admin@fitclass.in`; `hr-head@fitclass.in` is gone.
- "Fitclass - Head Office" is active again.

## Harness changes this cycle
- **Actors and expectations:**
  - HR suites act as `HR_EMPLOYEE` / `HR_APPROVER` from `roles.json` (capability-picked), so the leave approval race is now actually exercised.
  - switch-org accepts super_admin's cross-tenant picker (1.55.0 design).
  - capability-matrix-ui switches a **fresh** super_admin session into the target tenant, because the SA console follows the session since the tenant cookie was retired.
- **`run-all.mjs` hung-stage handling:** a timed-out stage is abandoned 60 s after its tree is killed. A hung `docker exec` had kept one stage alive 537 min past its limit.
- **Still to fix in the harness:**
  - `hr-admin-matrix` request bodies are outdated (holidays / leave settings / adjustments answer 422/400 to every role);
  - the leave-overlap step must check that its base request succeeded (it graded a 201 as a defect when the base had failed).

---

# Verified issues — cycle 4 (2026-09-29)

**Scope of this cycle:** the local stack with every current change applied, including the
uncommitted Partner API v2 work, the new HR detail routes and the WFH summary view. The
local DB was migrated 1.51.1 → 1.53.0 first; see *Environment* at the end.

**Who was tested:** 12 tenant-A roles (`read_only` rank 0 → `super_admin` rank 1000) plus 3
tenant-B logins (MSquare Professionals). Tenant B's `read_only` role is deactivated, so it has
no login.

**What was tested:** 6 UI tools, 241 gateway routes, and real writes both through the
browser and through the API.

**How findings were verified:** every critical/high finding a suite raised was re-checked by
hand against the code and the live stack. Only confirmed defects are listed below. Findings
that turned out to be harness grading, stale expectations or tenant configuration are
listed separately in *Triaged — not product defects*, so they are not chased.

## Summary

| # | Sev | Tool | Issue | Who is affected | Where |
|---|---|---|---|---|---|
| 1 | ✅ **Fixed 1.54.0** (was High) | Identity / Audit | A denied switch-org is written into the **target tenant's** audit trail. Tenant B admins see tenant A user ids (11 rows), and anyone can write into another tenant's log. | every tenant | `identity-service/src/api/v1/auth/auth.service.ts:307-315` |
| 2 | **High** | LMS | Lead transfer: 500 on every refusal; broken for any actor whose session branch ≠ the lead's branch; no row lock (double-transfer race). | tenant_admin, multi-branch managers, super_admin, any holder of `lms.leads.transfer` | `msq-lms/.../leads/leads.repository.ts:828-965`, `leads.service.ts:195-205` |
| 3 | ✅ **Fixed 1.54.0** (was High) | LMS / Audit | `GET /activities` → 500 "permission denied for schema audit" for every non-tenant-admin; query has no tenant predicate. | org_admin in both tenants (the Activity screen) | `db_scripts/07_grants.sql:530,267-270`, `packages/audit-log/src/index.ts:84-93` |
| 4 | **High** | HR | Every regularization is created with **no approver rows**. Multi-level approval is silently ignored and the detail modal's chain is always empty. | every employee requesting a regularization | `msq-hrms/.../attendance/attendance.repository.ts:1451,1472` |
| 4b | **High** | HR | The **reporting-line approver cannot approve**: a senior sales executive resolved as L1 approver sees the request in the team queue but `approve` → 403. The request stalls at L1 until someone overrides. | every requester whose manager lacks `hr.leave.approve` (e.g. rep1 → Chirag) | `msq-hrms/.../leave/leave.router.ts:56` vs `leave.repository.ts:476-478`; same shape `attendance.router.ts:77` |
| 4c | **High** | HR | HR admin actions are **pinned to the session branch**. A tenant-wide HR admin approving, granting a geo-exception or recomputing attendance for an employee of another branch gets 404 / 400 "User not found in this org", and **recompute reports success while writing nothing**. | hr_admin and tenant_admin (both homed in an *inactive* branch), any multi-branch HR admin | `leave.repository.ts:467`, `attendance.repository.ts:787,792`, geo-exceptions service |
| 5 | **High** | HR | Create/update department → 500 for tenant_admin (no INSERT/UPDATE grant or write policy for the `tenant_admin` PG role). | tenant_admin | `db_scripts/07_grants.sql:862-863`, `08_rls.sql:1710-1714` |
| 6 | **Medium** | All services | A malformed `:id` → **500** on `/leads/:id*` (all sub-routes), `/hr/leave/requests/:id` and `/hr/attendance/regularizations/:id`. | any caller | `leads.router.ts:29-54`, `leave.router.ts:52`, `attendance.router.ts:72`, `lib/errors.ts translatePgError` |
| 7 | **Medium** | LMS UI | The Leads grid shows **Edit** to roles without `lms.leads.edit*`; Save → 403. | read_only | `msq-lms/packages/lms-web/src/components/LeadsTable.tsx:100`, `leads/FollowUpGrid.tsx:84` |
| 8 | **Medium** | HR UI | The Leave page shows **Apply leave** to roles without `hr.leave.request.create`; submit fails. | read_only | `msq-hrms/packages/hr-web/src/components/leave/LeaveDashboardShell.tsx:98` |
| 9 | **Medium** | LMS UI | Lead editor requires a Follow-up date for follow-up stages even when the user lacks `lms.followups.create`, so Save → 403 "You do not have permission to create follow-ups". | tenant B tenant_admin, and any role with edit but not follow-ups | `LeadEditModal.tsx:74,98`; gate `leads.controller.ts:111-113` |
| 10 | **Medium** | Admin UI | New-user modal pre-fills the actor's **inactive** home branch → 400 "Branch not found in this tenant". | Fitclass tenant_admin (home = inactive "Fitclass - Head Office") | `team-web/.../CreateUserModal.tsx:~82`, `ui/.../UserForm/branchOptions.ts:39-41`, `users.repository.ts:767-778` |
| 11 | **Medium** | Identity | A login in the same second as a password reset / revoke-all gets a token that is **already revoked** (200 login, then 401 everywhere). | any user after an admin reset | `packages/db/src/blocklist.ts:70-95`, `users.service.ts:1221-1225` |
| 12 | **Medium** | LMS / IAM | super_admin (homed in tenant B, also mapped into a tenant A branch) sees tenant A leads in the grid; Edit → Save → 404 "Lead not found". | super_admin | data: `iam.user_org_mapping` (root@root.com → Gurugram - Sector 69); code: `leads.repository.ts:93 listLeads` vs `leads.service.ts:127 updateLead` |
| 13 | **Medium** | DB invariant | `lms.check_lead_fk_org_scope()` does not check `campaign_type_id`'s tenant, and its trigger doesn't fire on that column. A lead can carry another tenant's campaign type, which the RLS type fence then evaluates. | data integrity | `db_scripts/04_functions_triggers.sql:605-665` |
| 14 | **Medium** | UI (shell) | Tablet (820 px) horizontal overflow of 51 px on 10 pages (LMS leads/assignments, HR attendance/leave, Tasks). | every role on tablet | `msq-core/packages/ui/src/shell/AppNavbar.tsx:107`, `UserMenu.tsx:157-161` |
| 15 | Low-Med | Gateway | The proxy drops `ETag` / `Cache-Control` and never forwards `If-None-Match`, so avatars are never cached (the 304 path is dead). | all | `msq-core/services/api-gateway/src/lib/proxy.ts proxyTo (~71-121)` |
| 16 | Low-Med | Admin UI | React #418 hydration mismatch on API Tokens: `toLocaleString()` renders in server TZ (UTC) vs browser (IST). The same pattern appears in 5 lookup-admin grids. | any non-UTC user | `admin-web/components/api-tokens/ApiTokensTable.tsx:74` |
| 17 | Low | SA console | `GET/PUT /tenants/:id/modules` use `withAuth` (not `withSuperAdmin`), and body validation runs before the rank check → a non-SA gets 422 with the schema. An unknown tenant id → 500. | tenant/org admins (information only; writes are refused) | `api-gateway/src/server.ts:565,569`, `admin-service tenant-modules.router.ts` |
| 18 | Low | LMS | A lead sub-resource for a lead the caller can't see answers `200 []` instead of 404. No data leaks (RLS filters), but it's inconsistent with `GET /leads/:id`. | tenant B (probing), multi-branch viewers | `leads.repository.ts:191,226,239,254` |
| 19 | Low | Identity | An inactive role in `org_assignments` is reported as "Role not found in this tenant". | admins | `users.service.ts:173`, `users.repository.ts:751-763` |
| 20 | Low | UI (shell) | Tap targets under 44 px (hamburger 40, close/notifications/home 36, nav items 40 high), and 9–11 px text (grid headers, leave balance cards, sidebar labels). | phone/tablet users | `shell/HamburgerButton.tsx:11`, `MobileSidebar.tsx:117`, `styles/ag-grid.css:18-20`, `hr-web/.../leave/BalanceCards.tsx` |

**Verified correct in this cycle** (the suites passed after verification):
- **Partner API v2** (leads list/find, branch fencing, scope separation, out-of-reach `branch_id` → 400, no DTO leakage): the 1.53.0 security fix holds.
- **HR detail routes:** owner-only is enforced for 10 non-owner actors across both tenants.
- **WFH monthly summary:** the fixed view is installed, and the report equals the view.
- **Cross-tenant isolation:** no tenant-A row reached any tenant-B login on any of 241 routes. The five "critical" sweep hits were empty `200 []` answers (item 18).
- **Capability toggles:** revoking a grant hides the UI and blocks the API.
- **Concurrency (multi-user on the same record):**
  - lead lost-update (API): 204 / **409**;
  - same lead saved from two browsers (org_admin + org_manager): 204 / **409**, stale editor warned;
  - task double-edit (tenant B): **409** / 200.

  Optimistic locking works on leads and tasks. **Lead transfer race:** see #2. **Leave approval race:** not exercisable, because the only resolved L1 approver cannot approve (#4b).
- **UI round trip:** lead edit, leave apply, task quick-add and Team → New user, each performed as every role and verified in Postgres. Outcomes per role are in Part A.

---

## 1. Denied switch-org leaks into the other tenant's audit trail — ✅ Fixed in 1.54.0

> **Fixed 2026-09-29.** `auth.service.ts switchOrg` now files denials under `payload.org_id`. `one_time/apply_rehome_org_switch_denied.sql` moved 42 rows locally (22 cross-tenant). Verified: a new cross-tenant denial is filed in the caller's tenant, and tenant B's feed shows 0 foreign performers (switch-org suite, new check).

**Repro.** A Fitclass user calls `POST /auth/switch-org {org_id: <MSquare branch>}`. The server answers 403, as it should. Then `GET /api/activities` as MSquare's tenant_admin returns `org_switch_denied` rows whose `performed_by` is the Fitclass user's uuid, with `meta.new_value.requested_org_id`. There were 31 such rows locally, 11 of them cross-tenant.

**Control flow.**
1. gateway `POST /auth/switch-org`
2. `identity-service auth.controller switchOrg`
3. `auth.service.ts switchOrg()`
4. `repo.getUserById(sub, target.org_id)` → null
5. `logActivity({ org_id: org_id ?? payload.org_id, … })` writes the row with the **requested** org
6. `audit.activities` RLS (`tenant_isolation_policy`) scopes by the row's `org_id`, so the row belongs to the victim tenant.

**Root cause.** `auth.service.ts:307-315` uses the untrusted, requested `org_id` as the row's owner. This violates "never trust client-supplied identity/scope". It also lets any user inject rows into any tenant's audit log. A nonexistent id fails the FK, and because the call is `void logActivity(...)`, that denial is silently lost.

**Fix.**
```ts
// auth.service.ts switchOrg — both org_switch_denied sites
void logActivity({
  action_type: 'org_switch_denied',
  performed_by: payload.sub,
  org_id: payload.org_id,                                   // the caller's own, verified org
  new_value: all_branches ? { all_branches: true } : { requested_org_id: target.org_id },
});
```
Backfill in a `one_time` script:
```sql
UPDATE audit.activities a SET org_id = u.org_id FROM iam.users u
 WHERE a.action_type='org_switch_denied' AND u.id=a.performed_by AND a.org_id<>u.org_id;
```

## 2. Lead transfer: 500s, branch pin, race — High

**Repro** (all 500, from `docker logs msq-leads-service-1`, "Unhandled error"):

| Case | Result |
|---|---|
| Re-transfer an already transferred lead | 500 `Error: Lead not found or already inactive` |
| Non-existent id | 500, same |
| Target branch in another tenant | 500 `Error: Target org not found or not in the same tenant` |
| tenant_admin, lead outside its current branch | 500 |
| org_manager (session on another of its 4 branches) | 500 |
| super_admin | 500 |
| id = `null` | 500 (22P02) |

Two simultaneous transfers × 5 rounds gave `500/201`, `201/500` and `201/409`×3. The 409 came only from the incidental phone/email unique index. A lead with neither could be copied twice.

**Control flow.**
1. gateway `server.ts:301 POST /leads/:id/transfer`
2. `leads.router.ts:37` (capability `lms.leads.transfer`, body validated, **params not validated**)
3. `leads.controller.ts:209-217`
4. `leads.service.ts:195-205` (only checks `ctx.org_id !== targetOrgId`)
5. `leads.repository.ts:828 transferLead` under `withServiceTx`.

**Root causes.**
- `leads.repository.ts:847,861,866` throw plain `Error`. `server.ts` error handling maps only AppError, Zod and `translatePgError`, so every refusal becomes 500.
- `:836-845` reads the source `AND org_id = ${ctx.org_id}` (and `:934` the link row, `:964` the closing UPDATE), which pins the lead to the caller's *current* branch. `updateLead` and `deleteLead` already solve this with `resolveLeadOrgId` + `leadWriteCtx` (`leads.service.ts:135-137,237-239`).
- The source SELECT has no `FOR UPDATE`. The closing UPDATE doesn't re-check `is_active` or verify a row was updated. There is no unique index on `lead_links(source_lead_id) WHERE link_type='transfer'`.

**Fix.**
```ts
// leads.service.ts transferLead
const leadOrgId = await resolveLeadOrgId(ctx, leadId);      // tenant-fenced; null -> 404
if (!leadOrgId) throw new NotFoundError('Lead not found');
const txCtx = await leadWriteCtx(ctx, leadOrgId);            // 403 if the branch isn't covered
if (leadOrgId === targetOrgId) throw new BadRequestError('Cannot transfer a lead to the same branch');
return repo.transferLead(txCtx, leadId, leadOrgId, targetOrgId, notes);
```
```ts
// leads.repository.ts transferLead(ctx, id, leadOrgId, targetOrgId, notes)
-  AND org_id = ${ctx.org_id}::uuid AND NOT is_deleted AND is_active = true
+  AND org_id = ${leadOrgId}::uuid AND NOT is_deleted
+  FOR UPDATE
-if (!sourceRows[0]) throw new Error('Lead not found or already inactive');
+if (!sourceRows[0]) throw new NotFoundError('Lead not found');
+if (!sourceRows[0].is_active) throw new ConflictError('Lead has already been transferred');
-if (!targetOrgRows[0]) throw new Error('Target org not found or not in the same tenant');
+if (!targetOrgRows[0]) throw new NotFoundError('Target branch not found');
 // link row + closing UPDATE: ctx.org_id -> leadOrgId; add AND is_active; 0 rows -> ConflictError
```
```sql
CREATE UNIQUE INDEX IF NOT EXISTS uix_lead_links_transfer_source ON lms.lead_links(source_lead_id) WHERE link_type='transfer';
```

## 3. `GET /activities` 500 + no tenant predicate — ✅ Fixed in 1.54.0

> **Fixed 2026-09-29.** `07_grants.sql` grants `lms_svc` USAGE on `audit` + SELECT on `audit.activities`; `listActivities` has a session-tenant predicate; the rank gate is replaced by `lms.history.view.org`. Verified: org_admin and msq_org_admin → 200; every feed (super_admin included) contains only its own tenant's users; rep → 403.

**Repro.** org_admin and msq_org_admin get 500, tenant_admin gets 200, and a rep gets 403 (rank gate). The log shows `PostgresError: permission denied for schema audit`, query `SELECT … FROM audit.activities ORDER BY created_at DESC LIMIT 100`.

**Control flow.**
1. gateway `server.ts:743`
2. leads-service `activities.controller.ts:9` (rank gate)
3. `@platform/audit-log listActivities` (`index.ts:84-93`)
4. `withRoleTx`: leads-service runs as `lms_svc` (`DB_PRODUCT_SCOPED_LOGIN=true`, NOINHERIT), so no `SET ROLE app_user`.

**Root cause.** `07_grants.sql:530` grants lms_svc USAGE on `public, iam, entity, geo, comms, lms, marketing, ext`, but not `audit`. `:267-270` grant `audit.activities` SELECT only to `app_user` and `tenant_admin`. The RLS side is already right (the auto-naming loop adds lms_svc to `org_isolation_policy`). The query itself has no tenant/org predicate, and super_admin runs it on `serviceDrizzle`, so it reads the latest 100 activities across **all** tenants. The controller gates on rank, against the platform rule that capabilities are the boundary.

**Fix.**
```sql
-- 07_grants.sql (+ one_time script + 09_schema_version row)
GRANT USAGE ON SCHEMA audit TO lms_svc;
GRANT SELECT ON TABLE audit.activities TO lms_svc;
```
```ts
// listActivities: defence in depth
WHERE org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = ${ctx.tenant_id}::uuid)
```
Replace `rank < LMS_RANKS.ADMIN` with a capability check.

## 4. Regularizations are created without approvers — High

**Repro.** `hr.attendance_regularization_approvals` has **0 rows in the whole DB**, while leave requests do get chains. For example, rep1's leave has L1 Chirag and L2 Anup; rep1's regularization detail returns `approval_chain: []`.

**Control flow.**
1. hr-web Request regularization
2. `POST /hr/attendance/regularizations`
3. `attendance.repository.ts:1451 createRegularization` inside `withRoleTx` (the **requester's** RLS)
4. `resolveApprovers` (`:1472`) reads `iam.user_org_mapping` to decide who is "active in org" and for the admin fallback, but under the requester's RLS it sees only the requester's own mapping
5. every manager is skipped and the fallback finds nobody
6. `[]`.

Simulated in psql as `hr_svc` with rep1's GUCs: `reporting_lines` shows 18 rows, `users` shows 23, `user_org_mapping` shows **1** (only rep1). Leave is unaffected because `applyLeave` resolves under `serviceTxWithContext` (`leave.repository.ts:256`).

**Impact.** Approval falls back to the single-level `canApprove` branch (`attendance.repository.ts:~1796`). So `regularization_approval_levels` > 1 is ignored, the next approver is never notified, and the modal chain is always empty.

**Fix.**
```ts
// attendance.repository.ts createRegularization
const approvers = await withServiceTx((stx) =>
  resolveApprovers(stx, ctx.org_id, ctx.tenant_id, ctx.user_id, levels, new Date(data.work_date)));
```
Or wrap the create in `serviceTxWithContext` exactly as `applyLeave` does. Backfill approver rows for pending regularizations.

## 4b. The resolved approver cannot approve — High

**Repro.** rep1 (sales_representative, Sector 69) applies for leave. `hr.leave_request_approvals` records L1 = chiragbhardwaj463 (senior_sales_executive, rep1's reporting-line manager) and L2 = anuppundir0011. Chirag's `GET /leave/requests/team` returns 200 and lists it. Chirag's `POST /leave/requests/:id/approve` returns **403** "You do not have permission to approve leave". His live capabilities are `hr.leave, hr.leave.view, hr.leave.view.own, hr.leave.request.create, hr.leave.request.cancel`, with no `hr.leave.approve`.

**Control flow.**
1. `POST /hr/leave/requests/:id/approve`
2. `leave.router.ts:56` `requireCapability(HR_LEAVE_APPROVE)` → **403 here**
3. *(never reached)* `leave.service approveLeave` → `leave.repository.ts:476` `isAssignedApprover = pending.approver_id === ctx.user_id` would have allowed him.

Approver resolution (`resolveApprovers`, reporting lines) never consults capabilities, so it assigns levels to people the route will refuse. `attendance.router.ts:77` (regularization approve, `HR_ATTENDANCE_REGULARIZATION_APPROVE`) has the same shape. Related: `leave.repository.ts:467` returns 404 when the approver's **session branch** ≠ the request's branch (the same branch-pin pattern as #2), so a tenant-wide HR admin working in another branch cannot override without switching.

**Fix.** Make the two layers agree. Either:
- (a) the route admits the assigned approver: move the capability check into the service as `if (!isAssignedApprover && !has(HR_LEAVE_APPROVE)) throw Forbidden`; or
- (b) `resolveApprovers` only assigns users holding `hr.leave.approve` in that branch and walks up the reporting line otherwise. (b) keeps "capabilities are the boundary".

Backfill: re-resolve pending levels assigned to non-approvers.

## 4c. HR admin actions pinned to the session branch; recompute silently no-ops — High

**Repro.** `hr-head@fitclass.in` (hr_admin: holds `hr.leave.approve`, `geo_exceptions.manage`, `shifts.manage`) and `admin@fitclass.in` (tenant_admin) are both homed in **"Fitclass - Head Office", which is inactive**, so every session they start sits in a branch with no employees. For rep1 (Sector 69):

| Action | Result |
|---|---|
| hr_admin approve leave | 404 "Leave request not found" |
| hr_admin grant geo-exception | 400 "User not found in this org" |
| tenant_admin `POST /hr/attendance/recompute {user_id}` | **2xx, but no `hr.attendance_days` row is written** |

**Root cause.** Each path scopes the target by `ctx.org_id`, the caller's current branch, instead of resolving the target's branch and checking that the caller covers it:
- `leave.repository.ts:467` `if (req.org_id !== ctx.org_id) throw new NotFoundError(...)`;
- `attendance.repository.ts:787` `WHERE ep.org_id = ${ctx.org_id} … AND ep.user_id = …` (zero employees → nothing to do → success) and `:792` rules read by `ctx.org_id`;
- the geo-exception create validates the user against `ctx.org_id`.

This is the same pattern as the LMS transfer (#2). LMS `updateLead` already fixed it with `resolveLeadOrgId` + `leadWriteCtx`.

**Fix.** Add an HR equivalent of `leadWriteCtx`. Resolve the subject's branch within the caller's tenant, require that branch to be in the caller's coverage (tenant-wide capability or mapping), then run under that branch. When `user_id` is given and resolves to nothing, recompute must return 404, never success. **Data:** move both admins' home to an active branch.

## 5. Department create/update 500 for tenant_admin — High

**Repro.** tenant_admin holds `hr.employees.taxonomy.manage`. `POST /hr/employees/departments` returns 500, and the log shows `permission denied for table departments`. hr_admin, org_manager and super_admin succeed.

**Control flow.**
1. `employees.router.ts:24`
2. `employees.service.ts:54`
3. `employees.repository.ts:217 createDepartment` → `withRoleTx`
4. `packages/db/src/transaction.ts:50-52` runs `SET LOCAL ROLE tenant_admin`
5. INSERT is refused.

**Root cause.** `07_grants.sql:862-863` gives `tenant_admin` only SELECT on `iam.departments`. `08_rls.sql:1710` declares the tenant_admin policy `FOR SELECT`, and the write policy (`:1714`) is `TO app_user`. Compare `hr.designations`, which grants tenant_admin writes with a `FOR ALL` policy. `updateDepartment` (`:229`) fails the same way.

**Fix.**
```sql
GRANT INSERT, UPDATE ON iam.departments TO tenant_admin;
CREATE POLICY tenant_admin_write_policy ON iam.departments AS PERMISSIVE FOR ALL TO tenant_admin
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
```
Map SQLSTATE 42501 to 403 in `translatePgError`.

## 6. Malformed `:id` → 500 — Medium

**Repro.** `GET /leads/not-a-uuid` and `/leads/null/{timeline,interactions,assignment-history,follow-ups}`, `POST /leads/null/transfer`, `GET /hr/leave/requests/not-a-uuid`, `GET /hr/attendance/regularizations/not-a-uuid` all return 500. The log shows `invalid input syntax for type uuid` (22P02).

**Root cause.** No `/…/:id` route passes `validate({ params })`, although both services' `validate.middleware.ts` support it (`campaign-types.router.ts:81` uses it). `translatePgError` has no `22P02` case.

**Fix.**
```ts
const idParams = validate({ params: z.object({ id: z.string().uuid() }) });
app.get('/leave/requests/:id', { preHandler: [...gate, idParams, requireCapability(CAPABILITY.HR_LEAVE_VIEW)] }, ctrl.getMine);
// same for every /leads/:id*, /attendance/regularizations/:id, follow-up ids
// translatePgError backstop:
case '22P02': return new BadRequestError('Invalid identifier');
```

## 7. Leads grid shows Edit to roles that can't edit — Medium

**Repro.** Log in as `read_only` and open Leads. The row Edit button is visible and the editor opens. Save → `PATCH /api/leads/:id` → 403 "Insufficient permissions to edit leads", with no row change (verified in DB).

**Root cause.** `LeadsTable.tsx:100` `actionsCellRenderer` (and `FollowUpGrid.tsx:84`) render Edit unconditionally. The server gate is `checkEditLeadAccess(request.auth)` (`leads.controller.ts:94`). `@lms/authz` exports the same predicate, and `actor` (with capabilities) is already passed to `LeadsTable`.

**Fix.**
```tsx
import { checkEditLeadAccess } from '@lms/authz';
const canEdit = checkEditLeadAccess(actor);
// actionsCellRenderer
{canEdit && (<button type="button" title="Edit" onClick={() => ctx.onEdit(lead)} …/>)}
```

## 8. Leave page shows Apply leave to roles that can't apply — Medium

**Repro.** Log in as `read_only` and open `/hrms/leave`. The page renders (by design: `app/leave/page.tsx`, "no better place to go"), and **Apply leave** is shown. Submit stays disabled or the server refuses.

**Root cause.** `LeaveDashboardShell.tsx:98` renders the button unconditionally, while `LeaveTabs.tsx:27` already uses `canApplyLeave(actor) && isOnHomeBranch(actor)`.

**Fix.**
```tsx
const canApply = canApplyLeave(actor) && isOnHomeBranch(actor);
actions={canApply ? <Button variant="primary" onClick={…}>Apply leave</Button> : undefined}
```

## 9. Follow-up date required without follow-up permission — Medium

**Repro.** As `msq_tenant_admin`, whose tenant grants `lms.leads.edit*` but no `lms.followups.*`, pick a follow-up stage. The editor shows a mandatory Follow-up Due field. Save → 403 "You do not have permission to create follow-ups".

**Root cause.** `LeadEditModal.tsx:74` shows, and `:98` requires, the follow-up field for follow-up stages. The editor never checks `LMS_FOLLOWUPS_CREATE`. The PATCH then needs it (`leads.controller.ts:111-113`).

**Fix.** Gate the field and the follow-up stages on the capability.
```tsx
const mayFollowUp = can(actor, CAPABILITY.LMS_FOLLOWUPS_CREATE);
const fuVisible = mayFollowUp && followUpSet.has(selectedStatus);
// and drop follow-up stages from statusOptions (or show "needs follow-up permission") when !mayFollowUp
```

## 10. New-user modal pre-fills an inactive branch — Medium

**Repro.** Fitclass tenant_admin (`admin@fitclass.in`) is homed in "Fitclass - Head Office", which has `is_active=false`. Team → New user → fill in → Create user → `400 {"error":"Branch not found in this tenant: 27a7e2a1-…"}`. The same body with an active branch → 201.

**Control flow.**
1. `CreateUserModal.tsx:~82-84` seeds `seedBranch = actor.org_id`
2. `useUserAssignments.ts:63-67` pre-fills the first row and `home_org_id`
3. `branchOptions.ts:39-41` re-injects the actor's org even though it is absent from the active list
4. `users.repository.ts:767-778 getOrgsInTenant` (`is_active AND NOT is_deleted`) rejects it with a "not found" message.

**Fix.** Seed only from an active branch, and don't re-inject an inactive actor org.
```ts
const actorBranchActive = orgs.some((o) => o.id === actor.org_id);
const seedBranch = actorBranchActive ? { org_id: actor.org_id, org_name: actor.org_name }
  : branchOptions[0] ? { org_id: branchOptions[0].id, org_name: branchOptions[0].name } : { org_id: '', org_name: '' };
```
Server: return "Branch is inactive: <name>". Data: move the tenant_admin's home to an active branch.

## 11. Token revoked at birth after a password reset — Medium

**Repro.** Reset a user's password (`POST /users/:id/reset-password`) and log in within the same second. Login returns 200 with a cookie, then `/auth/me` returns 401 "Session has been revoked", and change-password returns 401. With more than 1 s in between, everything works.

**Root cause.** `revokeAllUserSessions` (`users.service.ts:1221-1225`) writes a user-wide blocklist row with `revoked_at = NOW()` at microsecond precision. `isTokenRevoked` (`packages/db/src/blocklist.ts:70-95`) compares `revoked_at > iat`, and JWT `iat` is whole seconds. So a token minted in the same second counts as issued "before" the revoke.

**Fix.** Add a millisecond-precision claim (`iat_ms`) in `signJwt` and compare against it. Alternatively, compare `revoked_at >= to_timestamp(iat + 1)` for user-wide revokes.

## 12. super_admin cross-tenant mapping: grid shows leads it can't save — Medium

**Repro.** `root@root.com` is homed in MSquare (session there) and also has an active `user_org_mapping` into Fitclass "Gurugram - Sector 69". The Leads grid lists Sector 69 leads; Edit → Save → 404 "Lead not found".

**Root cause.**
- **Data:** a cross-tenant mapping (data-health IAM-2). The platform does not rely on it, since super_admin reaches other tenants through switch-org.
- **Code:** `listLeads` at `view_scope: 'all'` honours `org_ids` across tenants for super_admin. `updateLead` → `resolveLeadOrgId` is deliberately tenant-pinned (`leads.service.ts:127-137`), so read and write scopes disagree.

**Fix.**
1. Deactivate the mapping.
2. Add a constraint trigger on `iam.user_org_mapping`: org tenant = user's home tenant.
3. Scope the `all` list to the session tenant, so super_admin switch-orgs into a tenant to act on its leads.

## 13. Lead FK scope trigger ignores `campaign_type_id` — Medium

**Root cause.** `lms.check_lead_fk_org_scope()` (`04_functions_triggers.sql:605-661`) validates `org_id`, `campaign_id`, `assigned_user_id` and geo ids against the lead's tenant, but not `campaign_type_id`. The trigger (`:662-665`) is `UPDATE OF org_id, campaign_id, assigned_user_id, city_id, state_id, country_id`. This cycle's first UI-fixture bug created such rows unhindered.

**Fix.** Add `campaign_type_id` to the trigger's column list, and assert `marketing.campaign_types.tenant_id = (org's tenant)`.

## 14. Tablet overflow (51 px) — Medium

**Repro.** At 820×1180, 10 pages scroll sideways: `/lms/dashboard/leads` and `/assignments`, `/hrms/attendance` (+ team, admin), `/hrms/leave` (+ approvals, admin), `/todo/tasks` and `/tasks/team`. The user-menu pill ends at 871 px.

**Root cause.** `AppNavbar.tsx:107`: the filter slot, scope slot and switchers render from `sm:`, while the sidebar only collapses at `lg:`. `UserMenu.tsx:157-161` shows the name from `sm` (max-w 140 px).

**Fix.** Move that row to `md:` / `lg:`, or let it wrap or shrink.

## 15–20. Low

- **15. ETag dropped by the gateway.** In `api-gateway/src/lib/proxy.ts proxyTo`, forward `If-None-Match` upstream, and copy `etag`, `cache-control` and `last-modified` back to the client.
- **16. Hydration mismatch.** `ApiTokensTable.tsx:74` calls `new Date(t.last_used_at).toLocaleString()`. The same pattern appears in `MetaAdAccountsClient.tsx:11`, `CampaignMappingGrid.tsx:24`, `MetaMappingsGrid.tsx:44`, `MetaLeadInboxClient.tsx:22` and `StagedLeadsGrid.tsx:62`. Use a shared formatter with an explicit locale and timezone. Intermittent #418s on five other super_admin pages were **not** reproduced; retest with a dev build.
- **17. `/tenants/:id/modules`.** Use `withSuperAdmin` at the gateway, move admin-service's rank check before `validate`, and return 404 for an unknown tenant.
- **18. Empty `200 []` for invisible leads.** Sub-resource services should resolve the parent lead first and 404.
- **19. Inactive role message.** Report it as inactive rather than "not found in this tenant".
- **20. Tap targets and text size.** Raise icon buttons to ≥ 44 px (`HamburgerButton.tsx:11`, `MobileSidebar.tsx:117`, the navbar icons). Raise the smallest type step to 12 px (`ag-grid.css:18-20` header 11 px, `BalanceCards.tsx` 9 px, sidebar labels 11 px).

---

## UI write round trip — outcome per role (browser → API → Postgres)

Each cell is the result of performing the write **in the UI** as that role, with the row
checked in Postgres.

- **allowed (✓):** 2xx and the row was written.
- **denied / error (✗):** the control was shown but the server refused (a UI-gating defect when the role lacks the capability).
- **hidden:** the control is not offered, or the page redirects. This is correct when the role lacks the capability; the suite flags it if the role holds the capability.
- **no-op:** the form offered no leave type (no active policy for that branch; tenant config).

| Role (tenant) | Leads: Edit (stage+note) | Leave: Apply | Tasks: Quick-add | Team: New user |
|---|---|---|---|---|
| super_admin | allowed 204 ✓ | no-op | allowed 201 ✓ | allowed 201 ✓ |
| tenant_admin (A) | allowed 204 ✓ | hidden | allowed 201 ✓ | **error 400 ✗ (#10)** |
| org_admin (A) | allowed 204 ✓ | hidden | hidden | allowed 201 ✓ |
| hr_admin (A) | hidden | hidden | hidden | hidden |
| fitness_manager (A) | hidden | allowed 201 ✓ | hidden | hidden |
| org_manager (A) | allowed 204 ✓ | allowed 201 ✓ | hidden | allowed 201 ✓ |
| pre_sales_captain (A) | allowed 204 ✓ | no-op | hidden | hidden |
| assistant_fitness_manager (A) | hidden | no-op | hidden | hidden |
| senior_sales_executive (A) | allowed 204 ✓ | allowed 201 ✓ | hidden | hidden |
| fitness_trainer (A) | hidden | allowed 201 ✓ | hidden | hidden |
| sales_representative (A) | allowed 204 ✓ | allowed 201 ✓ | hidden | hidden |
| read_only (A) | **denied 403 ✗ (#7)** | **shown, cannot submit ✗ (#8)** | hidden | hidden |
| msq_tenant_admin (B) | **denied 403 ✗ (#9)** | no-op | allowed 201 ✓ | allowed 201 ✓ |
| msq_org_admin (B) | hidden | no-op | allowed 201 ✓ | allowed 201 ✓ |
| msq_rep1 (B) | allowed 204 ✓ | no-op | allowed 201 ✓ | hidden |

Every "hidden" was checked against the role's live capabilities; none hid a control from a
role that holds the capability. Fitclass enables Tasks for tenant_admin only (deliberate),
which is why the Fitclass column is mostly hidden.

## Data / configuration findings (not code defects; need an owner)

| Item | What | Action |
|---|---|---|
| CAP-1 | MSquare has 7 tenant-created roles with **zero** capability grants: cto, video_editor, senior_video_editor, cameraman, content_manager, photo_editor, intern (9 active users). They get no product access, and any `withRoleTx` write returns a bare 500 (PG 25006). | Grant `platform` + `platform.write` + intended products in MSquare's Capability Matrix. **Product gap:** `admin-service user-roles.service.ts:62` creates roles with no seed grants. Seed `platform.write`, map 25006 → 403, and warn in the matrix for a role with no grants. |
| LMS-1 | 9 active LMS branches have no weighted assignee. **Gurugram - Civil Lines** (MSquare) received 4 leads in the last 30 days that went unassigned. | Set weights in Team → Lead weights. Make auto-assign alert, not just warn-log. |
| RLS-2 | `iam.role_capabilities_bak_20260819` (2087 rows, every tenant's grants) has RLS off and SELECT granted to app/service roles. | Run the existing `db_scripts/one_time/drop_role_capabilities_bak_20260819.sql` (local/UAT/prod). |
| CAP-2 | 207 child grants sit under a denied parent (e.g. every Fitclass `tasks.*` under a denied `tasks`), so the matrix UI shows them ticked. | Clean up, or grey children out under a denied parent. |
| Lead hard-delete | Impossible, even for `root_service`. The AFTER DELETE audit trigger inserts a `marketing_leads_history` row referencing the deleted lead, and that FK is `RESTRICT`. | Decide the erasure path (anonymise, or make the history FK `ON DELETE SET NULL`). |
| HR-1 | Active users without an `hr.employee_profiles` row (msq.in staff, branch admins). | Backfill. |
| Inactive home branch | Fitclass tenant_admin (`admin@fitclass.in`) and hr_admin (`hr-head@fitclass.in`) are homed in **"Fitclass - Head Office" (is_active=false)**. Every session starts in a branch with no employees, which triggers #10 and #4c. | Re-home both to an active branch, and block deactivating a branch that is still someone's home. |

## Triaged — not product defects

These were raised by suites and **cleared** on verification. The harness was corrected in
this cycle.

| Raised as | Actually | Harness change |
|---|---|---|
| 5 × critical "tenant-B login reads tenant-A lead timeline / interactions / assignment-history / follow-ups / leave balances" | Empty `200 []`. RLS filters every row, and no tenant-A data was returned (checked on leads that have rows). Kept as Low #18. | The sweep now grades critical only when the body carries tenant-A ids or data. |
| POST /users under-permitted for hr_admin, fitness_manager, pre_sales_captain, AFM, SSE | Those roles lack `admin.team.manage`; the 403 is correct. | The matrix grades by capability. |
| assistant_fitness_manager over-permitted on `/hr/attendance/team` | AFM holds `hr.attendance.view.team`, scoped to its reporting subtree. | Graded by capability. |
| org_admin 403 on leave approve, geo-exceptions, shifts, detail views, HR reports | Fitclass grants org_admin **no** HR capabilities (tenant config). | HR suites use hr_admin / tenant_admin / org_manager. |
| org_manager "Apply leave hidden", "lead list shows previous branch" | Login had picked the first (alphabetical) branch, and apply is home-branch-only by design. `lms.leads.view.tenant` makes the default list tenant-wide. | auth-setup picks the `· Default` branch; switch-org asserts narrowing only without `view.tenant`. |
| face-enroll: 4 × "422/400 refusal" highs | The server was correct; the suite read `error.code` instead of `details.code`. | Fixed, and the suite now restores the branch attendance rule it used to leave behind. |
| rep "create private task" 403, org_admin "create list" 403 | Fitclass enables `tasks` for tenant_admin only (deliberate override). | — |
| org_admin cannot mint API keys | `platform.api_tokens` not granted to org_admin in Fitclass. | public-edge / public-api-v2 fall back to tenant_admin single-branch keys. |
| capability-matrix-ui, bulk-assign, split-shift crashes | UI moved the tenant selector to the navbar; `lms.lead_activity_log` was renamed to `lead_assignment_log`; wrong HR actor. | Fixed. |
| Capabilities pane "only 3 cards" | 3 is correct since lms/hr/task-roles were removed (5933410). | Expectation updated. |
| JWKS empty | This environment signs HS256 only (no `JWT_PUBLIC_KEY`). | Graded info when RS256 is not configured. |
| Visual "disabled-state integrity" (50 medium) | AG Grid pager `div.ag-paging-button`: not an authorization control. | Treat as low. |
| `/api/users/:id/photo` 404 for root | Production-refresh DB references a blob not present locally. | Info. |

## Environment — what was changed to run this cycle (local only)

- **Local DB 1.51.1 → 1.53.0.** Ran `pg_dump` to `db_backups/pre_152_local_2026-09-29.dump`, then `one_time/apply_missed_punch_status.sql`, `apply_schema.ps1` and `09_schema_version.sql`. Without this, hr-service's monthly summary would have failed on `missed_punch_count`.
- **Rancher Desktop.** Docker hung ("timed out dialing Hyper-V socket"). Fixed with `wsl --shutdown` and a relaunch; Postgres crash-recovered cleanly.
- **Port 80.** k3s's bundled Traefik LoadBalancer held :80 ahead of Caddy, so `app.localhost` answered 404. Patched `kube-system/traefik` to `ClusterIP`. Revert with `kubectl -n kube-system patch svc traefik -p '{"spec":{"type":"LoadBalancer"}}'`.
- **Harness logins.** Local only: every `roles.json` login was reset to the dev password, because a production refresh had restored real hashes. `readonly.fitclass@e2e-fixture.test` was created through the Team API.
- **Residue.** Harness leads, users, leave, regularizations and tasks were purged. Plain `DELETE`s had been soft-deleting through `soft_delete_row()`; the harness now deletes as `root_service`. E2E leads can only be soft-deleted (see *Lead hard-delete*). A branch attendance rule left by an earlier face-enroll run was removed.
