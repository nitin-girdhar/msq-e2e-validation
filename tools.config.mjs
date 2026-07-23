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

  lookup: {
    label: 'Lookup Admin (lookup-admin)',
    app: 'lookup-admin',
    home: '/dashboard',
    // Lookup admin is a super/tenant/org-admin console; lower roles should be bounced.
    expectAccessMinRank: 980,
    routes: [
      { id: 'dashboard', label: 'Dashboard', path: '/dashboard' },
      { id: 'users', label: 'Users', path: '/dashboard/users' },
      // [table] is dynamic; the crawler expands it from the dashboard's lookup list.
      { id: 'lookups', label: 'Lookups', path: '/dashboard/lookups', dynamicChildOf: 'dashboard' },
    ],
    writeTables: ['entity.catalog_defaults', 'iam.users'],
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
      { id: 'api-clients', label: 'API Tokens', path: '/dashboard/api-clients' },
    ],
    // Expected nav visibility per role tier — from src/config/navigation.ts.
    // Used for authz drift detection; unlisted roles inherit by rank.
    expectedNav: {
      org_admin: ['leads', 'follow-ups', 'leads-history', 'assignments', 'analytics', 'users', 'api-clients'],
      org_sr_manager: ['leads', 'follow-ups', 'leads-history', 'assignments', 'users'],
      org_manager: ['leads', 'follow-ups', 'leads-history', 'assignments', 'users'],
      senior_sales_executive: ['leads', 'follow-ups', 'leads-history', 'assignments', 'users'],
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
