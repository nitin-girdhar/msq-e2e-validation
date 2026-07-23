# MSQ Platforms — E2E Test-Case Catalogue & Gap Analysis

_Companion to `openissues.md`. Reviews the existing `msq-e2e-validation/`
harness against the functional surface of all four product repos
(`msq-core` identity/lookup, `msq-lms`, `msq-hrms`, `msq-todo`) and lists the
E2E cases we should have — marking **[HAVE]**, **[WEAK]**, **[GAP]** for each._

---

## 1. What the harness already does well (keep as-is)

| Layer | Engine | Verdict |
|---|---|---|
| Deep crawl — every route × role, opens every tab/dropdown/button, opens (not submits) create/edit forms | `crawl.mjs` / `driver.mjs` | Strong breadth. |
| Role matrix — one write attempted as **all 19 roles**, graded allow/deny, **Postgres-verified** (a 2xx that changed nothing ≠ allowed) | `matrix.mjs` | Best-in-class. This is the spine. |
| Cross-tenant IDOR — list scoping, read, write, capability-override scoping, proven by row lookup | `suites/tenant/` | Airtight for leads/tasks/leave-requests. |
| Capability toggle — 4-way (resolver / session / UI / API) revoke→observe→restore, journalled & reversible | `capability.mjs` | Excellent. |
| Concurrency — lost-update, approval race, double-edit | `suites/concurrency/` | Good. |
| Visual/responsive — 5 viewports, measurable defects only | `suites/visual/` | Good. |
| Backend truth — direct `docker exec psql` reads | `db.mjs` | Correct premise. |

**The core architectural gap:** the crawler **opens forms but never submits**, and
real writes go through the **API layer** (`matrix.mjs` via `conc.mjs`), *not* through
the rendered dialog. So "open the edit dialog, change every field + notes, click
**Save**, confirm it persisted **and** re-renders correctly" is only actually
exercised in **one** place (`suites/admin/lookup-crud.mjs`, a single `lead_sources`
rename). Everything the user asked about — filling dialogs with all combinations and
verifying the round-trip through the real UI — is under-covered. That is the theme
of the gaps below.

---

## 2. Priority gaps (ordered)

| # | Area | Gap | Severity of missing coverage |
|---|---|---|---|
| G1 | **Attendance geofence bypass** — **✅ IMPLEMENTED** `suites/hr/attendance-geofence-guard.mjs` | Fires check-in from **outside** the geofence, with no geo, no photo, WFH-no-bypass, double-punch — proving the **server** rejects each (422/409) and writes no row; plus a UI assertion the submit stays disabled outside the fence. **All 7 cases pass** — enforcement is solid. | **Critical** — the "HTML-hack to enable check-in" scenario. Now covered. |
| G2 | **UI edit-form round-trip matrix** | Dialogs are opened but never filled+saved+verified through the UI (except one lookup field). | High |
| G3 | **User management** — **✅ IMPLEMENTED** `suites/admin/user-management.mjs` | Create-user authority matrix (19 roles) + admin lifecycle (name/manager/password/org) verified against `iam.users`. **Caught a live bug on first run** — see note below. | High |
| G4 | **Per-tenant HR config isolation** — **✅ IMPLEMENTED** `suites/tenant/cross-tenant-hr-config.mjs` | Tenant-B admins list holidays/policies/shifts/calendars (every returned id checked against the DB for tenant ownership) and IDOR-PATCH tenant-A config by id; plus a leave_types tenant-split probe. **Passes** — IDOR write 404s, leave_types cleanly split 8/8/0, no leaks. | High |
| G5 | **Leave lifecycle depth** — **✅ IMPLEMENTED** `suites/hr/leave-lifecycle.mjs` | apply → approve (**ledger debit verified**) → cancel (**credit-back verified**) → reject-with-comment (no debit) → overlap 409 → self-approval 403. **All pass.** | High |
| G6 | **Regularization lifecycle depth** — **✅ IMPLEMENTED** `suites/hr/regularization-lifecycle.mjs` | submit → reject (comment stored, day not flipped) → reject-without-comment 422 → WFH approve (**day resolves to `wfh`**) → self-approval 403. Records an info finding that the product exposes **no cancel/withdraw/edit** endpoint for a pending regularization. **All pass.** | Medium |
| G7 | **Attendance button enable/disable UI-state assertions** | No assertion that the button is disabled outside-fence / no-geo / already-punched, enabled inside. | Medium |
| G8 | **Photo / face / WFH punch rules** — **✅ IMPLEMENTED** (folded into G1's `attendance-geofence-guard.mjs`) | `require_photo` (PHOTO_REQUIRED), `require_geo` (GEO_REQUIRED), `allow_wfh_checkin` bypass, double check-in 409 — all now asserted and passing. | Medium |
| G9 | **Tab-strip responsiveness (phone/tablet/laptop)** — **✅ CODE ADDED** in `visual.mjs` (not yet executed) | The existing audit measured generic overflow but never the in-page **tab bar** specifically, so "the Follow-ups tab looks odd on mobile" slipped through. New check: per viewport, is the tab strip clipped, overflowing with no scroll affordance, or wrapping into an unaligned multi-row block. | Medium |
| G10 | **Disabled-state integrity (clean UI, genuinely disabled)** — **✅ CODE ADDED** in `visual.mjs` (not yet executed) | Verifies a control that *looks* disabled (faded / cursor:not-allowed / `.disabled` / `aria-disabled`) is *actually* inert (`disabled` / `pointer-events:none` / `inert`), not merely styled or backend-guarded — catches "html hide/show but still clickable / tamperable". | Medium |

> ### 🔴 New bug found by `user-management.mjs` (first run) — create-user 500 for admin roles
> `POST /users` returns **HTTP 500 `Internal server error`** for **every role from rank 40 up to `org_admin` (980)** — `senior_sales_executive`, all managers, dept heads, `hr_head`, `org_admin`. `super_admin` (1000) and `tenant_admin` (990) succeed (201) with the **identical payload**, and ranks < 40 correctly get 403. So it is not an authorization denial — it is a server error that blocks user creation for the entire admin middle tier.
> **Likely cause:** the create runs in `withRoleTx` on the RLS `app_user` pool; the `iam.users` `set_org_id()` BEFORE-INSERT trigger + `users_org_write` WITH-CHECK policy read `app.current_org_id`. `super_admin` uses BYPASSRLS and `tenant_admin` its own role, so only the `app_user` path trips. Reproduced directly: the trigger raises `org_id is NULL and app.current_org_id GUC is not set`.
> **Next step (product side):** confirm `withRoleTx` sets `app.current_org_id`/`app.current_tenant_id` GUCs before the insert for regular admin roles, and that the raw DB error is mapped to a clean 4xx (this is Issue #3's class). Graded **high** by the matrix (legitimate admins blocked from a core feature).

---

## 3. Test-case catalogue

Legend: **[HAVE]** implemented · **[WEAK]** partial/happy-path only · **[GAP]** missing.
Each case names the expectation and, where relevant, the backend table/error to verify.

### 3.1 Identity / Auth / Users  (`msq-core`, auth-web, lookup-admin)

| ID | Case | Status | Verify |
|---|---|---|---|
| ID-01 | Valid login (email + phone), logout invalidates session, open-redirect blocked, cross-SSO | **[HAVE]** | `suites/core/core-0*` |
| ID-02 | Lookup-admin reachable only ≥ org_admin; lower roles bounced | **[HAVE]** | `tools.config` + crawl |
| ID-03 | Edit a lookup value → Save → row changed in `entity.catalog_defaults`/`lms.lead_sources` **and** UI re-renders after reload; then restored | **[HAVE]** (one field) | `lookup-crud.mjs` |
| **ID-04** | **Create a new user** via UI → row in `iam.users`, correct org/tenant/role, welcome/activation path; duplicate-email rejected cleanly (not 500) | **[GAP]** | `iam.users`, `iam.user_roles` |
| **ID-05** | **Edit user name** → Save → `iam.users.full_name` changed → re-renders in grid | **[GAP]** | `iam.users` |
| **ID-06** | **Change / reset password** → old password fails login, new one works; password policy enforced; reset by admin vs self-change both covered | **[GAP]** | login round-trip |
| **ID-07** | **Change reporting manager** → `iam.users`/hierarchy row updated → new manager sees the user in their team, old one no longer does | **[GAP]** | hierarchy tables |
| **ID-08** | **Change user's org / branch** → user's data scope moves with them; they lose access to old-org records, gain new-org | **[GAP]** | org scope re-check |
| **ID-09** | User-management writes graded across **all 19 roles** (only admins may create/edit/reset; escalation = high) | **[GAP]** | `runRoleMatrix` |
| ID-10 | Unified role hierarchy: every seeded role resolves to expected rank; capability matrix per role | **[HAVE]** | `roles.json`, capability suite |

### 3.2 LMS / Leads  (`msq-lms`)

| ID | Case | Status | Verify |
|---|---|---|---|
| LMS-01 | Every role's lead create/interaction/follow-up graded allow/deny, Postgres-verified | **[HAVE]** | `lms-crud-matrix.mjs` |
| LMS-02 | Nav visibility per role matches `navigation.ts`; analytics/team/api-clients redirect for ungranted roles | **[HAVE]** | crawl + `expectedNav` |
| LMS-03 | Concurrent edit of one lead → optimistic-lock 409, no silent clobber | **[HAVE]** | concurrency suite |
| **LMS-04** | **Open a lead's Edit dialog, change every field** (status, owner, source, stage, value) **+ add a note/interaction** → Save → all fields persisted in `lms.marketing_leads`/`lead_interactions` → re-open dialog shows new values | **[WEAK]** (API-level only) | full field round-trip |
| **LMS-05** | Reassign / transfer lead through the UI → owner changes, old owner loses it from My-Leads, new owner gains it | **[WEAK]** | `lms.marketing_leads.owner_id` |
| **LMS-06** | Invalid field combinations rejected in-dialog (validation shown, no raw 500 banner) | **[GAP]** | negative UI |
| LMS-07 | Cross-tenant IDOR on a lead (read + write) rejected, row byte-identical | **[HAVE]** | tenant suite |

### 3.3 HR — Attendance  (`msq-hrms`)

| ID | Case | Status | Verify |
|---|---|---|---|
| HR-A-01 | Check-in **inside** geofence with photo → 2xx, row in `hr.attendance_events`, Check-out button appears after reload | **[HAVE]** | `hr-attendance-punch.mjs` |
| **HR-A-02** | **Geofence bypass — server enforcement.** POST check-in with coords **outside** `geofence_radius_meters` → **422 `OUTSIDE_GEOFENCE`**, no row written. (Fire API directly to simulate the force-enabled/HTML-hacked button.) | **[GAP]** | `attendance.repository.ts:280` throws — assert it |
| **HR-A-03** | **`GEO_REQUIRED`** — check-in with `require_geo` on and no coords → 422, no row | **[GAP]** | `:261` |
| **HR-A-04** | **`PHOTO_REQUIRED`** — check-in with `require_photo` on and no photo → 422, no row | **[GAP]** | `:297` |
| **HR-A-05** | **WFH bypass rule** — with `allow_wfh_checkin=false`, a `is_wfh` check-in from outside fence is **rejected**; with it `true`, allowed | **[GAP]** | `wfhBypass` at `:266` |
| **HR-A-06** | **Double check-in** — second open check-in same day → **409 `ALREADY_CHECKED_IN`**; check-out with no open check-in → 409 `NO_OPEN_CHECK_IN` | **[GAP]** | `:349`, `:354` |
| HR-A-07 | Check-out → day resolves, `day_status`/hours computed, persists across reload | **[WEAK]** | punch suite covers in-only |
| **HR-A-08** | **UI button-state** — Check-in button **disabled** when outside fence / geo unresolved / already punched; **enabled** inside fence with photo captured | **[GAP]** | assert `isDisabled()` per state |
| HR-A-09 | Team/admin attendance views gated: `canViewTeamAttendance` (≥ mgr), `canManageAttendance` (≥ hr_head); dept-scoped roles denied other depts | **[HAVE]** | `hr-admin-matrix.mjs` |
| **HR-A-10** | **Attendance rules (geofence config) per tenant** — updating radius/require_photo in tenant A does not change tenant B's effective rules | **[GAP]** | `hr.attendance_rules`, tenant-scoped read |

### 3.4 HR — Regularization / WFH  (`msq-hrms`)

| ID | Case | Status | Verify |
|---|---|---|---|
| HR-R-01 | Submit regularization for an unmarked day → row in `hr.attendance_regularizations`, appears in "My regularizations" | **[HAVE]** | `hr-regularization.mjs` |
| HR-R-02 | Admin/manager sees it in pending queue and **approves** → day flips, leaves queue | **[HAVE]** | same |
| **HR-R-03** | **Reject** with comment → status `rejected`, comment stored, day not flipped | **[GAP]** | `rejectRegularization` |
| **HR-R-04** | **Cancel by requester** while pending → withdrawn, gone from approver queue | **[GAP]** | |
| **HR-R-05** | **Send-back / edit-pending** flow (requester amends and resubmits) | **[GAP]** | |
| **HR-R-06** | **WFH → regularization linkage** — a WFH day that needs regularization surfaces the request path; approve credits the day as WFH | **[GAP]** | `is_wfh` on resolved day |
| HR-R-07 | Approver-authority matrix across 19 roles (only ≥ mgr in-scope may approve; escalation = high) | **[WEAK]** | fold into `runRoleMatrix` |

### 3.5 HR — Leave  (`msq-hrms`)

| ID | Case | Status | Verify |
|---|---|---|---|
| HR-L-01 | Apply for leave → row in `hr.leave_requests` | **[HAVE]** | `hr-leave-apply.mjs` |
| HR-L-02 | Two approvers race one request → exactly one winner, clean 409/403 for loser, single approval row | **[HAVE]** | concurrency suite |
| HR-L-03 | Leave-admin matrix: policies, holidays, leave-year settings, balance adjustments, shifts across 19 roles | **[HAVE]** | `hr-admin-matrix.mjs` |
| **HR-L-04** | **Approve** leave → balance **decrements** in the ledger; **Reject** with comment → balance untouched, comment stored | **[WEAK]** | `hr.leave_balances`/ledger |
| **HR-L-05** | **Cancel / revoke** an already-approved leave → balance **credited back**, status `cancelled` | **[GAP]** | ledger reversal |
| **HR-L-06** | **Multi-level approval** (`approval_levels > 1`) — request not final until all levels approve; each level's authority checked | **[GAP]** | `leave_policies.approval_levels` |
| **HR-L-07** | **Send-back** to requester and resubmit | **[GAP]** | |
| **HR-L-08** | **Business-rule negatives** — overlapping leave rejected; below `min_notice_days` rejected; over-balance rejected; half-day only when `allow_half_day` — each a clean 4xx, not 500 | **[GAP]** | policy fields |
| **HR-L-09** | **Leave types & holiday calendar per tenant** — tenant A's leave types/holidays not visible or usable by tenant B (config isolation) | **[GAP]** | tenant-scoped catalog |

### 3.6 Tasks / To-Do  (`msq-todo`)

| ID | Case | Status | Verify |
|---|---|---|---|
| TD-01 | Task lifecycle (create → assign → status → soft-delete) | **[HAVE]** | `todo-lifecycle.mjs` |
| TD-02 | Task-visibility matrix (who sees whose tasks), team 403 boundary | **[HAVE]** | `task-visibility-matrix.mjs` |
| TD-03 | Concurrent double-edit → lost-update detection | **[HAVE]** | concurrency suite |
| **TD-04** | **Edit dialog round-trip** — change assignee, due date, rank, notes through the dialog → Save → all persisted → re-render (several existing "record-bug" probes suggest known dialog issues here) | **[WEAK]** | `task.tasks` |

### 3.7 Responsive & UI-quality (every route × phone / tablet / laptop / desktop)

Engine: `visual.mjs` (via `suites/visual/responsive-audit.mjs`). Runs each route at
**5 device modes** — phone 390, small phone 360, **tablet 820**, **laptop 1366**,
desktop 1920 — and reports only *measurable* defects, with a screenshot per
viewport as evidence. Run one representative role per privilege band (the DOM
shape is the same; only data/nav differ), e.g. `org_admin,sales_representative,read_only`.

| ID | Case | Status | Detail |
|---|---|---|---|
| UI-R-01 | Document never scrolls sideways; no element spills past the right edge | **[HAVE]** | body-overflow + overflowing-element scan |
| UI-R-02 | Tap targets ≥ 44×44, body text ≥ 12px, no overlapping controls (phone/tablet) | **[HAVE]** | a11y/geometry scans |
| **UI-R-03** | **Tab strip stays usable on every viewport** — no tab clipped off the edge, no overflow without a scroll affordance, no ugly multi-row wrap on mobile. *Motivating bug: "the Follow-ups tab looks very odd in mobile view."* | **[CODE ADDED]** | new `tabStrip` measurement in `visual.mjs`; flagged per viewport, `⚠ TABS` in the runner log |
| **UI-R-04** | **Disabled-state integrity** — a control that looks disabled is genuinely inert, not just styled/backend-guarded. *Motivating requirement: "UI is clean & attractive — not only html hide/show, backend, also disabled."* | **[CODE ADDED]** | new `fakeDisabled` measurement; `⚠ FAKE-DISABLED` in the runner log |
| UI-R-05 | Screenshot per route × viewport saved for human review of "attractiveness" (the subjective layer objective checks can't grade) | **[HAVE]** | `results/screenshots/` |

> **How UI-R-03 / UI-R-04 were added (code only, not executed per request).** Both
> are new in-page measurements folded into the existing `measure()` so they run at
> all 5 viewports with zero extra passes: `tabStrip` inspects the shared `PageTabs`
> `<nav aria-label><a>` bar (tab count, row count, container overflow, scrollable-X,
> clipped tabs); `fakeDisabled` finds interactive controls that *look* disabled
> (`.disabled` / `aria-disabled` / `cursor:not-allowed` / opacity<0.55) yet are not
> inert (`disabled` / `pointer-events:none` / `inert` / `fieldset[disabled]`).
> Findings carry the screenshot path and a concrete fix. To run when ready:
> `npm run visual` (or `node suites/visual/responsive-audit.mjs org_admin`).

### 3.8 Cross-tenant & Capability / Roles (cross-cutting)

| ID | Case | Status |
|---|---|---|
| X-01 | Tenant B cannot list/read/write tenant A's leads, tasks, leave requests (IDOR ×4) | **[HAVE]** |
| **X-02** | Tenant B cannot see tenant A's **leave types, holidays, attendance rules, leave policies, shifts, users** (G4) | **[GAP]** |
| X-03 | Capability revoke hides nav/tab **and** blocks API (4-way); restore reverses | **[HAVE]** (found the `lms.apiclients` UI-only hole) |
| **X-04** | **Capability→role reachability map** — assert, per role, the exact set of tabs/operations it *should* access, and that each granted tab actually loads (no dead-end tabs) and each ungranted one 403s at the API | **[WEAK]** | `tab-authz-consistency.mjs` inventories but doesn't assert an expected map |

---

## 4. Recommended changes to the harness

Concrete, in priority order. Each is a new suite (or engine addition) that fits the
existing `record()` / `runRoleMatrix()` / `db.mjs` conventions.

1. **`suites/hr/attendance-geofence-guard.mjs`** — the headline gap (G1/HR-A-02…06).
   Drive the API directly via `conc.mjs` with the real session so it *is* the
   "button force-enabled" case. Assert `422 OUTSIDE_GEOFENCE` / `GEO_REQUIRED` /
   `PHOTO_REQUIRED` / `409 ALREADY_CHECKED_IN`, and `count(hr.attendance_events)`
   unchanged on each rejection. Also add a UI-state block that asserts the Check-in
   button `isDisabled()` when geolocation is set outside the fence (Playwright can
   set `geolocation` per context — see `hr-attendance-punch.mjs`).

2. **Generalise the crawler into a fill-and-save pass** — `crawl.mjs` currently
   classifies `submit` and refuses to fire it. Add an opt-in `formMatrix.mjs` that,
   for a given route + dialog, fills every input (valid combination + a notes field),
   clicks Save, then verifies via `db.mjs` that the row changed and via reload that
   the UI re-renders. Wire it for LMS lead-edit (LMS-04), Todo task-edit (TD-04),
   and HR shift/policy dialogs. This closes G2 across tools with one engine.

3. **`suites/admin/user-management.mjs`** (G3/ID-04…09) — through lookup-admin UI:
   create a throwaway user, edit name, reset password (then prove old fails / new
   logs in), change manager, change org; verify each in `iam.users`/`iam.user_roles`
   and re-render; run the create/edit/reset actions through `runRoleMatrix` so
   escalation is graded. Self-cleaning (soft-delete the throwaway user).

4. **Extend `suites/tenant/cross-tenant-isolation.mjs`** (G4/X-02) — add HR config
   objects to the IDOR sweep: leave types, holidays, attendance rules, leave
   policies, shifts, and the user directory. Same four attacks; grade any leak
   critical. Include the super_admin cross-tenant *positive* control.

5. **`suites/hr/leave-lifecycle.mjs`** (G5) — apply → approve (assert ledger
   decrement) → cancel (assert credit-back) → reject-with-comment; multi-level
   approval when `approval_levels>1`; business-rule negatives (overlap, min-notice,
   over-balance, half-day) each asserting a clean 4xx, not 500.

6. **`suites/hr/regularization-lifecycle.mjs`** (G6) — extend the existing submit+
   approve into reject / cancel-by-requester / send-back / edit-pending, plus the
   WFH→regularization linkage.

7. **Add an expected capability→tab map** to `tab-authz-consistency.mjs` (X-04) —
   turn the current inventory into an assertion: per role, the rendered tab set must
   equal the expected set, every visible tab's route must load (no dead-ends), and
   every hidden tab's API must 403.

8. **Harness hygiene (from `openissues.md` Part D):** refresh matrix payloads that
   drift into 409/422 from stale rows; add a per-suite pre-clean so re-runs don't
   false-positive. Add `DATABASE_URL_TENANT` to `scripts/setup-env.js` generation
   (still emits without it, though `.env.example` now carries it).
   _Done since first draft: `assertDbEnv()` fails loud at boot and is wired into
   all three product `server.ts` (Issue #1 durability); `.env.example` carries the
   var._

> **Status note (post bug-fix pass by another agent):** Issue #1 is hardened and
> Issue #2 (`lms.apiclients` UI-only) is **fixed** — the identity-service controller
> now enforces `hasCapability(CAPABILITY.LMS_APICLIENTS_*)` on every op. The
> capability toggle suite (X-03) therefore now asserts **API 403 after revoke** and
> serves as the regression guard for that fix — keep it in the decisive path.
> Issues #3 (raw DB 500 → clean 4xx) and #4 (super_admin org-bound follow-ups)
> remain **open**; cases LMS-06 and HR-L-08 cover them.

---

## 5. Suggested run wiring

Add the new suites to `run-all.mjs` in the write/matrix band, and to
`run-decisive.mjs` for the fast path. Ordering: geofence-guard and user-management
alongside the existing matrices; the extended tenant sweep in the tenant band; the
two lifecycle suites in the HR band. The geofence-guard suite is cheap and
high-value — it belongs in the smoke/decisive path.
