import { q } from './db.mjs';
import { purgeE2eUsers } from './fixtures.mjs';
const ids = "SELECT id FROM iam.users WHERE email LIKE '%@e2e.local'";
q(`DELETE FROM iam.password_reset_tokens WHERE user_id IN (${ids})`);
q(`DELETE FROM iam.token_blocklist WHERE user_id IN (${ids})`);
console.log(JSON.stringify(purgeE2eUsers()));
