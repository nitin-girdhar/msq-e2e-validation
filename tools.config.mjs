// Declarative surface map for every UI tool in the platform.
//
// This is the spine the deep-crawl suites walk: for each tool it lists the
// routes to visit, which roles are EXPECTED to have the tool at all, and the
// backend tables a write on that tool should land in (so a suite can verify
// "I clicked Save -> a row actually appeared"). Tabs, dropdowns and buttons are
// intentionally NOT enumerated here — the crawler discovers those live on each
// page so new UI is covered automatically without editing this file.
//
// `expectAccessRanks`: minimum global rank that should reach the tool's home.
//   Department-ladder users (hr_head, sales_manager, ...) are judged by the
//   product-specific rank they carry, so treat these as heuristics the crawler
//   reports against, not hard gates.

export const TOOLS = {
  core: {
    label: 'Auth / Identity (auth-web)',
    app: 'auth-web',
    home: '/login',
    routes: [
      { id: 'login', label: 'Login', path: '/login', public: true },
      { id: 'select-branch', label: 'Select Branch', path: '/select-branch' },
      { id: 'change-password', label: 'Change Password', path: '/change-password' },
    ],
    writeTables: [],
  },

  admin: {
    label: 'Admin console (admin-web)',
    app: 'admin-web',
    // NEW in msq-core since the last e2e pass (85c92ff "Admin panel for
    // HR/Tanent/Org Admin", eef7f50/940756d/1d44232/2891e7c "made admin ui"
    // across hrms/lms/todo). A separate Next app (port 3004, was NOT in
    // roles.json/tools.config until this update) that consolidates Team
    // (user management), API Tokens, Leave Admin and Attendance Admin behind
    // one console, gated in DashboardLayout at rank >= ANCHOR_RANK.ORG_ADMIN
    // (980) — below that the layout renders an in-place "Access restricted"
    // panel rather than redirecting, so the crawler must assert that panel's
    // text, not just a redirect/404, for sub-980 roles. Every dashboard card
    // is ALSO independently filtered by ADMIN_NAV capability (see
    // app/dashboard/page.tsx DESCRIPTIONS comment: this replaced a bug where
    // every tile incl. API Tokens showed regardless of capability and only
    // 403'd on click) — worth a dedicated capability-vs-tile-visibility check
    // alongside the existing X-04 tab-authz-consistency work.
    home: '/dashboard',
    expectAccessMinRank: 980,
    routes: [
      { id: 'dashboard', label: 'Dashboard', path: '/dashboard' },
      { id: 'team', label: 'Team', path: '/dashboard/team' },
      { id: 'api-tokens', label: 'API Tokens', path: '/dashboard/api-tokens' },
      { id: 'leave-admin', label: 'Leave Admin', path: '/dashboard/leave/admin' },
      { id: 'attendance-admin', label: 'Attendance Admin', path: '/dashboard/attendance/admin' },
    ],
    writeTables: ['iam.api_clients', 'hr.leave_policies', 'hr.attendance_rules', 'hr.attendance_geo_exceptions'],
  },

  lookup: {
    label: 'Lookup Admin (lookup-admin)',
    app: 'lookup-admin',
    // /dashboard redirects to /dashboard/m/platform — the module-grouped nav
    // (Platform/LMS/HRMS/Tasks/Capabilities) replaced the old single flat
    // dashboard card grid. See LookupTableDef.module in lookupTableConfig.ts.
    home: '/dashboard/m/platform',
    // Lookup admin is a super_admin-only console; lower roles should be bounced.
    expectAccessMinRank: 980,
    routes: [
      { id: 'dashboard', label: 'Dashboard', path: '/dashboard' },
      { id: 'module-platform', label: 'Platform module', path: '/dashboard/m/platform' },
      { id: 'module-lms', label: 'LMS module', path: '/dashboard/m/lms' },
      { id: 'module-hr', label: 'HRMS module', path: '/dashboard/m/hr' },
      { id: 'module-tasks', label: 'Tasks module', path: '/dashboard/m/tasks' },
      { id: 'module-capabilities', label: 'Capabilities module', path: '/dashboard/m/capabilities' },
      { id: 'capability-matrix', label: 'Capability Matrix', path: '/dashboard/capabilities/matrix' },
      { id: 'users', label: 'Users', path: '/dashboard/users' },
      // [table] is dynamic; the crawler expands it from each module pane's card
      // list. One dynamicChildOf entry per module — driver.mjs's expandRoutes
      // only walks a single parent per entry, and the 22 lookup tables are now
      // split across 5 panes instead of one flat dashboard grid.
      { id: 'lookups-platform', label: 'Lookups', path: '/dashboard/lookups', dynamicChildOf: 'module-platform' },
      { id: 'lookups-lms', label: 'Lookups', path: '/dashboard/lookups', dynamicChildOf: 'module-lms' },
      { id: 'lookups-hr', label: 'Lookups', path: '/dashboard/lookups', dynamicChildOf: 'module-hr' },
      { id: 'lookups-tasks', label: 'Lookups', path: '/dashboard/lookups', dynamicChildOf: 'module-tasks' },
      { id: 'lookups-capabilities', label: 'Lookups', path: '/dashboard/lookups', dynamicChildOf: 'module-capabilities' },
    ],
    writeTables: ['entity.catalog_defaults', 'iam.users', 'iam.role_capabilities'],
  },

  lms: {
    label: 'Leads / CRM (lms-web)',
    app: 'lms-web',
    home: '/dashboard/leads',
    routes: [
      { id: 'leads', label: 'Leads', path: '/dashboard/leads' },
      { id: 'my-leads', label: 'My Leads', path: '/dashboard/my-leads' },
      { id: 'follow-ups', label: 'Follow-ups', path: '/dashboard/follow-ups' },
      { id: 'leads-history', label: 'Leads History', path: '/dashboard/leads-history' },
      { id: 'assignments', label: 'Assignments', path: '/dashboard/assignments' },
      { id: 'analytics', label: 'Analytics', path: '/dashboard/analytics' },
      { id: 'team', label: 'Team', path: '/dashboard/team' },
      { id: 'users', label: 'Users', path: '/dashboard/users' },
      // 'api-clients' page/nav entry was REMOVED in msq-lms@8fc420c ("api clients
      // duplicate fix - moved to Admin panel") — the per-product LMS UI was a
      // duplicate of the identity-service-backed console. Management now lives
      // in msq-core admin-web at /dashboard/api-tokens (see core.routes below);
      // the /api-clients gateway API itself is unchanged and still covered by
      // suites/capability/apiclients-fresh-revoke.mjs. Do NOT re-add this route
      // here — it 404s now — without first confirming it wasn't re-introduced.
      { id: 'bulk-assign', label: 'Bulk Assign', path: '/dashboard/bulk-assign' },
    ],
    // Expected nav visibility per role tier — from src/config/navigation.ts.
    // Used for authz drift detection; unlisted roles inherit by rank.
    // 'bulk-assign' is gated by CAPABILITY.LMS_LEADS_ASSIGN_BULK; the service
    // (assignments.service.ts bulkAssignLeads) additionally hard-floors it at
    // actorRank >= LMS_RANKS.SSE, so it is assumed granted to the same roles as
    // 'assignments' below SSE-and-above — confirm the capability seed grants
    // match before trusting this list for authz-drift grading.
    expectedNav: {
      org_admin: ['leads', 'follow-ups', 'leads-history', 'assignments', 'bulk-assign', 'analytics', 'users'],
      org_sr_manager: ['leads', 'follow-ups', 'leads-history', 'assignments', 'bulk-assign', 'users'],
      org_manager: ['leads', 'follow-ups', 'leads-history', 'assignments', 'bulk-assign', 'users'],
      senior_sales_executive: ['leads', 'follow-ups', 'leads-history', 'assignments', 'bulk-assign', 'users'],
      sales_representative: ['leads', 'follow-ups', 'leads-history'],
      read_only: ['leads'],
    },
    writeTables: ['lms.marketing_leads', 'lms.lead_interactions', 'lms.lead_follow_ups'],
  },

  hr: {
    label: 'HR / Attendance & Leave (hr-web)',
    app: 'hr-web',
    home: '/attendance',
    routes: [
      { id: 'attendance', label: 'My Attendance', path: '/attendance' },
      { id: 'attendance-team', label: 'Team Attendance', path: '/attendance/team' },
      { id: 'attendance-admin', label: 'Attendance Admin', path: '/attendance/admin' },
      { id: 'leave', label: 'My Leave', path: '/leave' },
      { id: 'leave-approvals', label: 'Leave Approvals', path: '/leave/approvals' },
      { id: 'leave-admin', label: 'Leave Admin', path: '/leave/admin' },
    ],
    writeTables: ['hr.attendance_days', 'hr.attendance_regularizations', 'hr.leave_requests', 'hr.leave_policies', 'hr.shifts'],
  },

  todo: {
    label: 'Tasks / To-Do (todo-web)',
    app: 'todo-web',
    home: '/tasks',
    routes: [
      { id: 'tasks', label: 'My Tasks', path: '/tasks' },
      { id: 'tasks-team', label: 'Team Tasks', path: '/tasks/team' },
    ],
    writeTables: ['task.tasks', 'task.task_lists'],
  },
};

export const TOOL_KEYS = Object.keys(TOOLS);
