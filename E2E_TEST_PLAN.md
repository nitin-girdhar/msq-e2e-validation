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
| **ID-11** | Lookup-admin left nav groups every table by module (Platform/LMS/HRMS/Tasks/Capabilities); every module pane's cards open a working table page | **[HAVE]** | `lookup-module-nav.mjs` |
| **ID-12** | Generic FK dropdown chaining (Country -> State -> City on Organizations' Create form, and a plain global-scope fk like Tenant) populates and gates on its `dependsOn` field | **[HAVE]** | `lookup-module-nav.mjs` |
| **ID-13** | Capability Matrix screen (`/dashboard/capabilities/matrix`) writes a real tenant-scoped `iam.role_capabilities` override via `PUT /roles/:id/capabilities`, verified against the resolver **and** a live user's session, not just the UI | **[HAVE]** | `capability-matrix-ui.mjs` |

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
| **LMS-08** | WhatsApp-to-lead: send dialog opens and its template list resolves for a capable role; `GET .../whatsapp/templates` is gated by `lms.leads.whatsapp.send` (allowed for `org_admin`, denied for `read_only`). The actual send (external API call) is deliberately never fired. | **[HAVE]** | `lms-whatsapp-send.mjs` |

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
| **HR-A-11** | **Split-shift day classification** — `worked_minutes` sums paired check-in/check-out sessions (not `last_out - first_in`, so the inter-segment gap is unpaid); an off-window punch is accepted but flagged (`is_off_segment` / `has_off_window_punch`); `GET /hr/attendance/events` (no gateway route existed for it before this change) returns every punch of the day | **[HAVE]** | `attendance-split-shift.mjs`, `docs/ATTENDANCE_DAY_CLASSIFICATION.md` |

### 3.4 HR — Regularization / WFH  (`msq-hrms`)

| ID | Case | Status | Verify |
|---|---|---|---|
| CONC-UI | Leave approval race with rep1's real L1 approver (two tabs) — currently blocked: that approver lacks hr.leave.approve (openissues #4b). | `concurrency/hr-leave-approval-race.mjs` |
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

## 4b. New functionality since 2026-07-29 (this pass)

The product repos (`msq-hrms`, `msq-lms`, `msq-core`; `msq-todo` had only minor
fixes) shipped a batch of new features between the harness's last commit
(2026-07-29) and this pass (2026-08-09). This section catalogues what shipped,
what was **[GAP]** (zero coverage, now closed by a new suite this pass), and
one real piece of **harness drift** this pass fixed along the way.

### Harness drift fixed

| Area | Drift | Fix |
|---|---|---|
| `tools.config.mjs` (LMS) | `api-clients` page/nav entry pointed at `/dashboard/api-clients`, which **msq-lms@8fc420c removed** (moved to the new admin-web console). The crawler was silently 404ing on a dead route and grading it as a product defect. | Route + `expectedNav` entries removed; added `bulk-assign` (the page that replaced it in the nav) instead. |
| `roles.json` / `tools.config.mjs` | The new consolidated **admin-web** console (Team / API Tokens / Leave Admin / Attendance Admin, port 3004, `msq-core@543a91e`) was never registered — the harness had no idea this app existed. | Added `apps['admin-web']`, a new `TOOLS.admin` entry (routes, `expectAccessMinRank: 980`), and `suites/admin/deep-crawl-admin.mjs`. |
| `suites/capability/apiclients-fresh-revoke.mjs`, `capability-toggle.mjs` | **Worse than dead route drift — a silently no-op'd regression guard.** Both tested the capability key `lms.apiclients`, which the same "moved to Admin panel" refactor **deleted outright** (zero references left in `msq-core`/`msq-lms`); the endpoint is now gated by `platform.api_tokens.view`/`.manage`. `apiclients-fresh-revoke.mjs`'s baseline check (`grantedBefore` falsy) made it self-abort every run — exit 0, zero findings, indistinguishable from a pass while testing nothing. This was the harness's only regression guard for Issue #2 (fresh-capability-resolve on credential endpoints). | Re-pointed both to `platform.api_tokens.view` / admin-web's `/dashboard/api-tokens`; added cases for the two new-this-pass capabilities (`hr.attendance.admin.geo_exceptions.view`, `lms.leads.assign.bulk`) that had no capability-matrix coverage at all. See §4c. |

### New surfaces, now covered

| ID | Case | Status | Verify |
|---|---|---|---|
| **HR-A-12** | **Per-employee geofence exceptions** (`hr.attendance_geo_exceptions`) — capability-gated CRUD (`HR_ATTENDANCE_ADMIN_GEO_EXCEPTIONS_VIEW`/`_MANAGE`), and the `remote_role` vs `wfh` labelling rule: a `remote_role` punch bypasses the fence but must NOT be recorded `is_wfh=true` (a field visit is not a WFH day) | **[HAVE]** | `suites/hr/geo-exceptions.mjs` |
| **HR-A-13** | Ending a geo-exception (`PATCH is_active=false`) re-engages fence enforcement immediately | **[HAVE]** | same |
| **HR-R-08** | **Configurable regularization backdate window** (`hr.attendance_rules.regularization_max_backdate_days`) — future date always rejected (not configurable), a date older than the window rejected naming the earliest acceptable date, tenant-wide default write (`scope: 'tenant'`) requires `tenant_admin`/`super_admin` even though an org's own `org_admin` holds the write capability | **[HAVE]** | `suites/hr/regularization-window.mjs` |
| **HR-L-10** | **Leave-request / regularization "detail" modal** (`GET /leave/requests/:id`, `GET /attendance/regularizations/:id`) — full multi-level `approval_chain` + derived `pending_with`; own-scope IDOR check: even the assigned APPROVER gets 404 fetching someone else's request via this route (separate from their team/approvals list) | **[HAVE]** | `suites/hr/request-detail-approval-chain.mjs` |
| — | `resolve-approvers.ts` role-name-vs-capability gap ([[hr-leave-approver-capability-gap]] in prior session notes) — **fixed** 2026-08-09, `hasCapability(tenantId, roleName, CAPABILITY.HR_LEAVE)` now gates the fallback-admin candidate list | **[FIXED]**, indirectly regression-guarded (non-empty `approval_chain`) | `request-detail-approval-chain.mjs`; a dedicated "role literally named org_admin without HR_LEAVE" case is still a good future addition |
| **LMS-09** | **Bulk lead assignment** (`POST /assignments/bulk`) — three independent guards: actor rank ≥ SSE, target rank ≤ SSE (stricter than single-assign), all leads + assignee share one org; activity-log action_type (`assignment_created` vs `_reassigned`) verified per lead | **[HAVE]** | `suites/lms/bulk-assign.mjs` |
| **LMS-10** | **Public partner API — lead report** (`GET {gateway}/public/v1/lead-report`, API-key auth, `lead-report:read` scope) — no-key/garbage-key/wrong-scope all rejected correctly; happy path via both `Authorization` header and the documented `?key=` query fallback | **[HAVE]** (single-org key path only) | `suites/lms/public-report-api.mjs` |
| **LMS-11** | **Public partner API — single lead read** (`GET {gateway}/public/v1/leads/:id`) — an out-of-scope (wrong-org) lead returns **404, not 403**, with the identical shape as a genuinely nonexistent id (no enumeration oracle); `org_id` stripped from the response | **[HAVE]** | `suites/lms/public-read-api.mjs` |
| **LMS-12** | **Admin console reachability** — Team / API Tokens / Leave Admin / Attendance Admin under the new admin-web app, rank-gated at `ANCHOR_RANK.ORG_ADMIN` (980) with an in-place "Access restricted" panel (not a redirect) below that, and each dashboard tile independently filtered by its own capability (fixed a prior bug where every tile incl. API Tokens showed regardless of capability) | **[HAVE]** (crawl only) | `suites/admin/deep-crawl-admin.mjs` |
| **X-05** | admin-web tile-visibility-vs-capability consistency (does every VISIBLE tile's route actually load, does every HIDDEN one 403 at the API) — same shape as X-04 but for the new console | **[GAP]** | fold into a future `tab-authz-consistency.mjs` extension |
| **LMS-13** | Meta-lead source relabelling (`959d85c`) and "CAPI trigger only fires when lead is actually from Meta" (`ebefae1`) — no e2e coverage; these are webhook/background-job paths the harness does not currently drive | **[GAP]** | needs a webhook-simulation suite, out of scope for this pass |

## 4c. Capability-matrix coverage audit (asked explicitly this pass)

`capability-toggle.mjs`'s `CASES` array is a small **hand-curated** list, not
derived from the capability catalog — extending it is a manual step every time
a capability is added or a guarded feature moves. Status as of this pass:

| Capability | Guards | Coverage before this pass | Coverage now |
|---|---|---|---|
| `platform.api_tokens.view`/`.manage` | admin-web API Tokens tile + `GET/POST/PATCH/DELETE {gateway}/api-clients` | **Broken** — suite tested the deleted `lms.apiclients` key, self-aborted silently (see §4b harness-drift table) | **[HAVE]** — re-pointed in both `capability-toggle.mjs` and `apiclients-fresh-revoke.mjs` |
| `hr.attendance.admin.geo_exceptions.view`/`.manage` | admin-web/hr-web Geo Exceptions tab, `GET/POST/PATCH .../geo-exceptions` | **[GAP]** (capability didn't exist before this pass) | UI/session case added to `capability-toggle.mjs` (`.view` only — `.manage`'s write-path denial is covered directly in `geo-exceptions.mjs` case 1) |
| `lms.leads.assign.bulk` | LMS nav "Bulk Assign" + `POST /assignments/bulk` | **[GAP]** | UI/session case added; the API-side 403 is covered by `bulk-assign.mjs`, not the toggle suite (`probe()` is GET-only, see the case's comment) |
| `hr.leave.admin` / `hr.attendance.admin` on **admin-web** specifically (vs. the pre-existing hr-web cases, same capability keys, different app) | admin-web Leave/Attendance Admin tiles | **[GAP]** — only the hr-web copy of these screens was ever toggle-tested | **[GAP]**, unchanged — the existing `hr.leave.admin.policies`/`hr.attendance.admin.shifts` cases still point at hr-web; add admin-web-pointed twins if the two consoles are expected to diverge in what they show |
| `platform.write` (admin-web Team tile) | Team tile nav visibility only — the underlying user-mgmt endpoints gate on **rank alone**, not a capability (see the code comment in `admin-web/src/config/navigation.ts`) | **[GAP]** | **[GAP]** — arguably not worth a toggle case since revoking `platform.write` cannot be proven against an API 403 (there isn't one); a UI-only nav-visibility assertion would be the most this capability can prove |
| Every other capability in `packages/rbac/src/capabilities.ts` not listed above (~most of the catalog — LMS/HR/Tasks page + operation nodes) | various | **[GAP]**, pre-existing | **[GAP]**, pre-existing — `capability-matrix-ui.mjs` proves the UI round-trip for one example (`admin.lookups.manage`); the resolver/session/UI/API 4-way check in `capability-toggle.mjs` only runs for the ~8 capabilities listed as `CASES` |

**Bottom line:** capability matrix coverage is not, and was not before this
pass, exhaustive over the capability catalog — it is a curated sample proving
the 4-way-consistency *mechanism* works, plus whichever capabilities someone
has explicitly added a case for. This pass (a) fixed the one case that had
silently gone dead, and (b) added cases for the two brand-new capabilities.
Capabilities belonging to screens this pass did not touch are exactly as
covered (or not) as they were on 2026-07-29.

## 4d. Coverage pass 2026-09-28 (single origin, Meta console, campaign types, transfer, team edit)

Between 2026-08-09 and 2026-09-28 the product shipped ~40 commits (PWA + single
origin, branch switcher, bulk/branch transfer, campaign types + ordered rules,
Meta lead fetch screens, Team edit/HR sync, canonical emails, attendance
reports). When this pass started, **150 of the gateway's 241 routes** were not
referenced by any suite, and the harness itself could no longer reach the apps.

### Harness drift fixed (a run before this would have been ~all false positives)

| Area | Drift | Fix |
|---|---|---|
| `roles.json` / `lib.mjs` | Apps moved to ONE origin behind Caddy with a compiled Next `basePath` (`/lms /hrms /todo /admin /sa`); the session cookie is host-only on `app.localhost`. Every `localhost:300x` URL 404'd and every `cfg.gateway` (`:4000`) call carried no cookie → 401. | `lib.mjs` derives apps from `origin + prefixes` (override `E2E_ORIGIN`); authenticated API calls go through `${origin}/api` (auth-web rewrite); `gatewayDirect` only for the unauthenticated edge. |
| Node DNS | Node on Windows does not resolve `*.localhost` (Chromium does) → `ENOTFOUND` for every API/actor call. | In-process `dns.lookup` shim in `lib.mjs` (no hosts-file edit needed). |
| Scraped hrefs | Next renders links WITH the basePath; `APP + href` produced `/sa/sa/...`. | `absUrl()` / `appPath()`; used in `driver.mjs`, `lookup-crud`, `lookup-module-nav`, `tab-authz-consistency`. |
| `crawl.mjs` | Buttons classified `other` ARE clicked. The new SA screens' **Sync / Pull / Apply / Remap / Retry / Ignore / Re-run** buttons would have fired real Meta Graph calls and re-assigned/ignored real leads on production-refresh data. The BranchSwitcher chip (labelled with the branch name) could call switch-org, which revokes the stored session. | New `sideEffect` class (inventoried, never fired); `title="Branch: …"` treated as a session control. |
| Login rate limit | `/auth/login` + `/auth/switch-org` share 10/min per IP; the harness is one IP and logs in ~20 accounts → 429 reported as "stuck-on-login". | `auth-setup.mjs` waits out `Retry-After`; `conc.freshLogin()` / `with429Retry()`. |
| User cleanup | Creating a user now writes `iam.user_org_mapping` + `hr.employee_profiles` (`ON DELETE RESTRICT`), so the bare `DELETE FROM iam.users` failed silently and leaked accounts. | FK-aware `fixtures.purgeById()` / `purgeE2eUsers()`. |
| `public-read-api` / `public-report-api` | Revoked the API key AFTER closing the actor → every run leaked a live key. | Revoke before close. |
| `core-07-lookup-admin-authz` | Expected a redirect; since c2fba5e non-SA get an in-place "Access restricted"; and `super_admin` is now in roles.json (would self-report a bypass). | Accepts the panel; super_admin is the positive control; new console pages added. |
| `run-all.mjs` | Findings accumulated across runs; no per-stage timeout; a crashed suite looked clean. | Archives previous results, per-stage timeout, `results/run-ledger.json` rendered at the top of SUMMARY.md, restore at start/end, `auth-refresh` between bands. |

### New coverage

| ID | Case | Suite |
|---|---|---|
| SEC-01 | Every gateway route (parsed from `server.ts`, incl. loop-registered lookup slugs) × every login + tenant B + anonymous: anon → 401 on every method; no 5xx; no leaked stack/SQL; `{success,data}` envelope; SA-only routes 403 below super_admin; tenant-A object routes denied to tenant B; slow (>8 s) GETs | `security/api-surface-sweep.mjs` |
| SEC-02 | Partner API scope per route, single-branch key binding, `/public/v1/users` has no credential fields, key **rotation** kills the old key, intake/Meta webhook key + forged HMAC, Meta verify-token echo, JWKS has no private params, security headers, CORS does not reflect a foreign origin | `security/public-edge.mjs` |
| ID-10 | Branch switcher: my-orgs == data coverage (and never another tenant), `can_view_all` only tenant-wide, switch → `/auth/me` + lead list follow, **old token revoked**, unmapped / other-tenant / all-branches refusals, refusal keeps the session | `core/switch-org.mjs` |
| ID-11 | Throwaway account: canonical-email login, change-password wrong/weak/ok, other sessions die on change (pwd_iat), old password dead, logout revokes | `core/account-session-lifecycle.mjs` |
| ID-12 | Team contracts: lowercase email + case-dup 409, escalation via `org_assignments.role_id`, cross-tenant branch/role, **edit keeps manager**, PATCH 200 `hr_profile_synced` + `hr.employee_profiles` follows, API-level email edit, reset-password on a higher rank (throwaway victim), `?tenant_id=` SA-only, role catalog ceiling, manager candidates / weights never cross tenants, weights validation | `admin/team-user-contracts.mjs` |
| LMS-14 | Branch transfer: capability matrix, source closed out + copy + link, timeline/history on a transferred lead, refusals are 4xx (same branch, re-transfer, missing, other tenant, other branch, tenant B caller), tenant_admin from a non-current branch, follow-up write ⊄ read | `lms/lead-transfer.mjs` |
| LMS-15 | Two simultaneous transfers of one lead → exactly one copy | `concurrency/lms-lead-transfer-race.mjs` |
| LMS-16 | Campaign types + ordered rules: view/manage matrix, CRUD in `marketing.*`, default/in-use deletes, first-match-wins, reorder flips the winner (order restored exactly), tenant B isolation incl. rule-test matching, `?tenant_id=` SA-only | `lms/campaign-types-rules.mjs` |
| LMS-17 | Every analytics/report endpoint × role: all org/user ids inside the caller's covered branches / tenant; report-send gate | `lms/analytics-scope.mjs` |
| HR-E-01 | Employees/departments/designations matrices, profile + balance + ledger IDOR (rep → peer, tenant B → A), attendance reports json/csv/xlsx content + bad month + tenant scoping, face-review gate, `/hr/me`/`modules`/`today-state` never 5xx | `hr/hr-employees-reports.mjs` |
| TODO-10 | Private task/list: owner comment + status history recorded; rep2 and tenant B cannot read/comment/see history/rename/delete | `todo/task-comments-lists.mjs` |
| SA-01 | Every new /sa screen renders for SA; SA actions refused at the edge for tenant/org admins; tenant-modules phantom tenant; **Tasks module off → task API 403, on → restored** (journalled); catalog drift surfaced | `admin/sa-console.mjs` |
| PLAT-01 | Push subscribe ignores a smuggled `user_id`; another user cannot unsubscribe my device; SSE stream handshake per role | `platform/push-and-stream.mjs` |
| DATA-01 | Postgres invariants: RLS policies missing service logins, org/tenant tables without RLS, roles without `platform.write`, dead grants under denied parents, branches with no weighted assignee, pools ≠ 100, orphaned lead owners, cross-tenant campaign types / mappings / managers, email canonical/dups, HR profile sync gaps, stuck Meta inbox, harness residue | `data/data-health.mjs` |

### Suspected defects found by reading the code (the run confirms or clears them)

| Where | Suspicion | Probed by |
|---|---|---|
| `msq-lms leads.repository.ts` `transferLead` | `throw new Error('Lead not found or already inactive')` / `('Target org not found or not in the same tenant')` are not AppErrors → **500** for re-transfer, wrong branch, cross-tenant target | LMS-14 |
| same | Source read without `FOR UPDATE`; closing UPDATE does not re-check `is_active` → **double transfer** under concurrency | LMS-15 |
| same | Source lookup pinned to `ctx.org_id` → tenant_admin cannot transfer a lead from a non-current branch (500) | LMS-14 |
| `identity-service auth.repository.ts` `getUserOrgs` | Mapped orgs are not filtered by tenant → a stray cross-tenant mapping would appear in the branch picker | ID-10, DATA-01 IAM-2 |
| `users.service updateUser` | Email is read-only in the Team modal only; the API still accepts `email` | ID-12 (low, confirm intent) |
| `admin-service tenant-modules.service put` | Four separate service transactions (not atomic) and no tenant-existence check | SA-01 |

### Still not covered

- Meta webhook **happy path** (signed payload → inbox → lead): needs the app secret; only the rejection paths are covered.
- Lead-pull run apply/remap and assignment re-run **as super_admin**: deliberately not fired (external Graph calls / mass re-assignment). Needs a sandboxed tenant with a stubbed Graph.
- WhatsApp / email **sends**: gating only, never fired.
- Speech-to-text inputs (browser mic permission).
- `read_only` role: still no active user in the restored data.

## 4e. Coverage pass 2026-09-29 (UI write round trip, read_only, Partner API v2, HR detail routes)

### Harness drift fixed

| Area | Drift | Fix |
|---|---|---|
| `read_only` | No real read_only user in the production-refresh data → rank 0 never tested. | `provision-readonly.mjs` (first stage of `run-all`, before preflight) creates `readonly.fitclass@e2e-fixture.test` **through the Team API** as tenant_admin. `@e2e-fixture.test`, not `@e2e.local`, so residue purges leave it alone. Tenant B has its read_only role deactivated (tenant config) → no tenant-B read_only login. |
| Harness passwords | A production refresh of the local DB restores real hashes → 11/17 logins "stuck-on-login". | `provision-readonly.mjs` re-aligns every `roles.json` login to the dev password (local DB only) and clears lockouts, each run. |
| Leave suites | Hardcoded `casual`; the refreshed data has only an active `sick` policy, and org_admin has no `hr.leave.adjust` in FitClass → every leave suite reported "apply failed". | `fixtures.leaveTypeFor(email)` (a type with an active policy for the user's branch) and `fixtures.seedLeaveBalance()` (precondition ledger row, deleted by note). Used by leave-lifecycle, request-detail-*, hr-admin-matrix, hr-leave-approval-race. |
| `fixtures.purgeById` | Selecting `id` from a child without one (`hr.employee_profiles`, `lms.lead_assignment_weights`) threw into the catch and **skipped that child's DELETE** → throwaway users leaked as soft-deleted rows. | Recurse only into children that have an `id` column. |
| Fixture leads | Seeded as super_admin, who is homed in tenant B → leads got tenant B's campaign type, and RLS hid them. | Seed with the tenant_admin of the actor's own tenant; set the campaign type the owner's department works; place it in the actor's LIVE session branch (`/auth/me`). |
| Cleanup DELETEs | `public.soft_delete_row()` (BEFORE DELETE on ~25 tables) turns any DELETE into `is_deleted=true` and reports success → every purge left residue. | `db.q()` runs DELETE statements as `root_service`, the trigger's hard-delete path (FK cascades still fire). Leads still cannot be hard-deleted (audit history FK RESTRICT) → soft-deleted `E2E*` leads are the floor; LMS-4 ignores deleted rows. |
| auth-setup | Clicked the FIRST (alphabetical) branch on /select-branch → multi-branch users (org_manager: 4) ran off their home branch, where hr-web correctly hides Apply leave. | Picks the `· Default` (is_home) branch. |
| Actors / grading | Many suites hardcoded org_admin as the HR actor (Fitclass grants it no HR capability) and graded by rank. | HR suites use hr_admin / tenant_admin / org_manager; user-management, hr-admin-matrix grade by capability; switch-org, face-enroll, capability-matrix-ui (navbar tenant cookie), bulk-assign (`lead_assignment_log`), lookup-module-nav (3 cards), the api-surface sweep (critical only when tenant-A data is returned) corrected; concurrency suites use fixtures and actors that can actually race. |
| Partial re-runs | Re-running one suite appended its findings next to the stale ones. | `rerun.mjs <suite…>` drops the stage's findings + action shards (by run-ledger window), re-runs, updates the ledger. |

### New coverage

| ID | Case | Suite |
|---|---|---|
| UI-01 | As every login (read_only → super_admin + tenant B): Leads Edit (stage/outcome/follow-up/note → Save), Leave Apply, Tasks quick-add, Team New user — performed **in the browser**, the write request captured, the row checked in Postgres, graded by the session's live capability (hidden-for-holder, dead-end control, silent no-op, escalation). | `ui/ui-write-roundtrip.mjs` |
| UI-02 | Two browsers save different stages + notes on one lead at the same instant: no 5xx, no lost note, stale writer warned. | same, S5 |
| SEC-03 | Partner API v2 (schema 1.53.0): leads:list / leads:find scope separation; multi-branch, single-branch, tenant-wide and tenant-B keys fenced (every returned id resolved in the DB); out-of-reach branch_id → 400; malformed filters 4xx; phone normalisation / matched_on / not_found; DTO has no raw_webhook_data / metadata / tags / outcome_comment. | `security/public-api-v2.mjs` |
| HR-D-01 | New gateway detail routes `GET /hr/leave/requests/:id`, `/hr/attendance/regularizations/:id`: owner 200; peer, managers, admins, super_admin, tenant B → 404; anonymous 401; malformed id not 500; 403 only flagged when it differs from a random id's answer. | `hr/request-detail-idor.mjs` |
| HR-R-01 | `vw_attendance_monthly_summary.wfh_count`: installed view is the fixed one, equals a recount from events, report API == view, report access graded by `hr.attendance.admin.reports.view`. | `hr/monthly-summary-wfh.mjs` |

---

## 5. Suggested run wiring

Add the new suites to `run-all.mjs` in the write/matrix band, and to
`run-decisive.mjs` for the fast path. Ordering: geofence-guard and user-management
alongside the existing matrices; the extended tenant sweep in the tenant band; the
two lifecycle suites in the HR band. The geofence-guard suite is cheap and
high-value — it belongs in the smoke/decisive path.

> **Done this pass:** the seven §4b suites (`geo-exceptions.mjs`,
> `regularization-window.mjs`, `request-detail-approval-chain.mjs`,
> `bulk-assign.mjs`, `public-report-api.mjs`, `public-read-api.mjs`) are wired
> into both `run-all.mjs` (write/matrix band) and `run-decisive.mjs` (all
> API-driven, no web app needed — same reasoning as the existing entries
> there); `deep-crawl-admin.mjs` is wired into `run-all.mjs`'s breadth band
> only (crawls need the web app up, like the other `deep-crawl-*`).
> **Not yet run** — this was a code-only authoring pass (per request, "I will
> be executing those in next session"). First run should go through
> `preflight.mjs` first in case the new `admin-web` app isn't up on port 3004
> in the target environment yet.
