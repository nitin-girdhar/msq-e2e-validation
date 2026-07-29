// WhatsApp-to-lead integration.
//
// New surface: `lms.leads.whatsapp.send` capability, gateway routes
// GET /leads/:id/whatsapp/templates + POST /leads/:id/whatsapp (proxied to
// leads-service, which does its own authorization — this is NOT behind the
// gateway's withCommsSend guard, that one only fences the direct
// /communications/* relay routes).
//
// This suite proves:
//   1. UI — the WhatsApp button on a lead's Edit modal opens the send dialog
//      and the template list actually populates (or shows an honest empty
//      state), for a role that holds the capability.
//   2. API authorization — GET .../whatsapp/templates is allowed for a
//      capable role and denied for one that is not (read_only), so the
//      capability actually gates the endpoint rather than being decorative.
//
// Deliberately never fires the POST (the actual send): that call reaches a
// real WhatsApp Business API integration, which is exactly the class of
// side-effecting external action the crawler already treats as
// "inventory but never fire" for destructive/submit controls elsewhere in
// this harness.
//
//   node suites/lms/lms-whatsapp-send.mjs
import { openAs, record, APPS, roleMeta } from '../../lib.mjs';
import { actor, apiGet } from '../../conc.mjs';
import { dbReachable, scalar, lit } from '../../db.mjs';

const TOOL = 'lms';
const LMS = APPS['lms-web'];
const CAPABLE_ROLE = 'org_admin';
const DENIED_ROLE = 'read_only';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

// Sanity: the capability landed in the catalog (db_scripts/07 seed).
const capId = scalar(`SELECT id FROM iam.capabilities WHERE key='lms.leads.whatsapp.send' LIMIT 1`);
console.log(`iam.capabilities has lms.leads.whatsapp.send: ${!!capId}`);
if (!capId) {
  record(TOOL, {
    severity: 'high', role: CAPABLE_ROLE, tool: TOOL, page: 'iam.capabilities',
    scenario: 'Confirm the WhatsApp capability node was seeded',
    expected: "A row with key='lms.leads.whatsapp.send' exists",
    actual: 'No matching row — the capability exists in @platform/rbac code but was never seeded into the DB catalog.',
    evidence: 'SELECT id FROM iam.capabilities WHERE key=\'lms.leads.whatsapp.send\'',
    proposedSolution: 'Add the seed row in db_scripts/07_seed_lookup_data.sql and re-run the deploy — a key present in code but unseeded denies everyone (fail-closed).',
  });
}

// A lead with a phone number in the capable role's org, so canWhatsApp=true.
const org = roleMeta(CAPABLE_ROLE)?.org;
const leadId = scalar(
  `SELECT ml.id FROM lms.marketing_leads ml
   JOIN entity.organizations o ON o.id = ml.org_id
   WHERE o.name=${lit(org)} AND ml.phone IS NOT NULL AND length(ml.phone) >= 10 AND ml.is_deleted = false
   ORDER BY ml.created_at DESC LIMIT 1`
);
console.log(`lead with phone in "${org}": ${leadId ?? '(none found)'}`);

// ── 1. UI: open a lead, open the WhatsApp dialog, read the template list ───
if (leadId) {
  const { browser, page, log } = await openAs(CAPABLE_ROLE);
  try {
    await page.goto(`${LMS}/dashboard/leads`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const editBtn = page.locator('button[title="Edit"]').first();
    const hasEdit = await editBtn.count().catch(() => 0);
    if (!hasEdit) {
      console.log('  no Edit button found on the leads grid — skipping UI check');
    } else {
      await editBtn.click();
      await page.waitForTimeout(1200);

      const waBtn = page.getByRole('button', { name: /send a whatsapp message/i });
      const waVisible = await waBtn.isVisible().catch(() => false);
      const waDisabled = waVisible ? await waBtn.isDisabled().catch(() => true) : null;
      console.log(`  WhatsApp button visible=${waVisible} disabled=${waDisabled}`);

      if (waVisible && !waDisabled) {
        const [templatesResp] = await Promise.all([
          page.waitForResponse((r) => /\/api\/leads\/.+\/whatsapp\/templates/.test(r.url()), { timeout: 8000 }).catch(() => null),
          waBtn.click(),
        ]);
        await page.waitForTimeout(600);
        const dialog = page.locator('[role="dialog"]').last();
        const dialogOpened = await dialog.isVisible().catch(() => false);
        const dialogText = await dialog.innerText().catch(() => '');
        const showsTemplatesOrEmptyState = /template|no message templates/i.test(dialogText);
        console.log(`  templates fetch=${templatesResp ? templatesResp.status() : 'none'} dialogOpened=${dialogOpened} showsTemplatesOrEmptyState=${showsTemplatesOrEmptyState}`);

        if (!dialogOpened || !showsTemplatesOrEmptyState) {
          record(TOOL, {
            severity: 'medium', role: CAPABLE_ROLE, tool: TOOL, page: 'Leads > Edit modal > WhatsApp',
            scenario: 'Open the WhatsApp send dialog for a lead with a phone number',
            expected: 'The dialog opens and shows either the template list or an honest "no templates configured" message',
            actual: `dialogOpened=${dialogOpened}; body snippet: "${dialogText.slice(0, 200)}"`,
            evidence: `templates fetch status=${templatesResp ? templatesResp.status() : 'none'}; badRequests=${JSON.stringify(log.badRequests.slice(-4))}`,
            proposedSolution: 'Check WhatsAppSendModal renders its loading/empty/error states and leadsApi.whatsappTemplates() resolves.',
          });
        } else {
          console.log('  OK: WhatsApp dialog opened and rendered a legible state');
        }
        // Close WITHOUT sending — this suite never fires the actual send.
        await page.keyboard.press('Escape').catch(() => {});
      } else if (waVisible && waDisabled) {
        console.log('  WhatsApp button disabled (lead has no usable phone per the UI check) — acceptable, skipping send-dialog check');
      } else {
        record(TOOL, {
          severity: 'medium', role: CAPABLE_ROLE, tool: TOOL, page: 'Leads > Edit modal',
          scenario: 'Locate the WhatsApp action on a lead with a phone number',
          expected: 'A "WhatsApp" button is present on the Edit modal',
          actual: 'No WhatsApp button found in the Edit modal.',
          evidence: `lead=${leadId}`,
          proposedSolution: 'Confirm LeadEditModal renders the WhatsApp action and canWhatsApp resolves true for this lead.',
        });
      }
    }
  } finally {
    await browser.close();
  }
} else {
  console.log('  no lead with a phone number found — skipping UI check (nothing to open)');
}

// ── 2. API authorization: capable role allowed, denied role rejected ───────
if (leadId) {
  const templatesUrl = `${LMS}/api/leads/${leadId}/whatsapp/templates`;

  const capableActor = await actor(CAPABLE_ROLE);
  const deniedActor = await actor(DENIED_ROLE);
  try {
    const allowed = await apiGet(capableActor, templatesUrl);
    const denied = await apiGet(deniedActor, templatesUrl);
    console.log(`  ${CAPABLE_ROLE} -> ${allowed.status} | ${DENIED_ROLE} -> ${denied.status}`);

    if (allowed.status < 200 || allowed.status >= 300) {
      record(TOOL, {
        severity: 'high', role: CAPABLE_ROLE, tool: TOOL, page: `GET ${templatesUrl}`,
        scenario: `${CAPABLE_ROLE} (holds lms.leads.whatsapp.send by default) requests WhatsApp templates for a lead in their own org`,
        expected: 'HTTP 2xx',
        actual: `HTTP ${allowed.status}`,
        evidence: JSON.stringify(allowed.body).slice(0, 300),
        proposedSolution: 'Confirm org_admin holds lms.leads.whatsapp.send by default (db_scripts/07 seed) and the lead is within the actor\'s edit scope.',
      });
    }
    if (denied.status >= 200 && denied.status < 300) {
      record(TOOL, {
        severity: 'high', role: DENIED_ROLE, tool: TOOL, page: `GET ${templatesUrl}`,
        scenario: `${DENIED_ROLE} (should NOT hold lms.leads.whatsapp.send) requests WhatsApp templates`,
        expected: 'HTTP 403 — read_only should never reach a send-capable endpoint',
        actual: `HTTP ${denied.status} — the endpoint served the request.`,
        evidence: JSON.stringify(denied.body).slice(0, 300),
        proposedSolution: "Enforce lms.leads.whatsapp.send server-side in leads-service's whatsapp router/controller — comment in server.ts says this route relies on leads-service's own authorization, not the gateway's withCommsSend guard, so a gap here is enforced nowhere.",
      });
    }
  } finally {
    await capableActor.close();
    await deniedActor.close();
  }
} else {
  console.log('  skipping API authorization check — no lead id resolved');
}

console.log('\ndone.');
