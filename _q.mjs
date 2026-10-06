import { q } from './db.mjs';
const sql = process.argv[2];
for (const r of q(sql)) console.log(r.join(' | '));
