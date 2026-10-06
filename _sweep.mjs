import { q, lit, scalar } from './db.mjs';
q(`UPDATE hr.comp_off_claims SET ledger_entry_id=NULL WHERE reason LIKE 'E2E-compoff-%'`);
q(`DELETE FROM hr.comp_off_claims WHERE reason LIKE 'E2E-compoff-%'`);
q(`UPDATE hr.leave_encashment_requests SET ledger_entry_id=NULL WHERE reason LIKE 'E2E-encash-%'`);
q(`DELETE FROM hr.leave_encashment_requests WHERE reason LIKE 'E2E-encash-%'`);
q(`DELETE FROM hr.leave_ledger WHERE note LIKE 'E2E-seed-%' OR note LIKE 'E2E-lower-%' OR note LIKE 'E2E-spend-%' OR note LIKE 'E2E-probe%'`);
q(`DELETE FROM hr.leave_ledger WHERE note IN ('Comp-off credit') AND created_at > now() - interval '3 hours' AND leave_request_id IS NULL AND id NOT IN (SELECT ledger_entry_id FROM hr.comp_off_claims WHERE ledger_entry_id IS NOT NULL)`);
for (const id of q(`SELECT id FROM hr.leave_requests WHERE reason LIKE 'E2E-apply2-%'`).map(r=>r[0])) { q(`DELETE FROM hr.leave_ledger WHERE leave_request_id=${lit(id)}`); q(`DELETE FROM hr.attendance_days WHERE leave_request_id=${lit(id)}`); q(`DELETE FROM hr.leave_request_approvals WHERE leave_request_id=${lit(id)}`); q(`DELETE FROM hr.leave_request_status_log WHERE request_id=${lit(id)}`); q(`DELETE FROM hr.leave_requests WHERE id=${lit(id)}`); }
q(`DELETE FROM hr.leave_policies WHERE sla_hours=37`);
console.log('policies left sla37:', scalar(`SELECT count(*) FROM hr.leave_policies WHERE sla_hours=37`), 'claims', scalar(`SELECT count(*) FROM hr.comp_off_claims WHERE reason LIKE 'E2E-%'`), 'capoverrides', scalar(`SELECT count(*) FROM iam.role_capabilities WHERE tenant_id='0b39b589-ea7d-446a-b660-350e1d84ebd9' AND is_granted=false AND capability_id IN (SELECT id FROM iam.capabilities WHERE key LIKE 'hr.leave.%')`));
