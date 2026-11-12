// Stand-in for db.js in the tests: no MariaDB needed. ssh_settings is kept in memory, or in the JSON file
// named by STUB_DB_FILE so a test can restart the server and check that settings persist.
const fs = require('fs');
const F = process.env.STUB_DB_FILE;
let mem = {};
const load = () => { if (F) { try { return JSON.parse(fs.readFileSync(F, 'utf8')); } catch (e) { return {}; } } return mem; };
const save = (o) => { if (F) fs.writeFileSync(F, JSON.stringify(o)); else mem = o; };
async function run(sql, params) {
  sql = String(sql);
  if (/^\s*SELECT/i.test(sql) && /FROM ssh_settings/i.test(sql)) return [Object.entries(load()).map(([k, v]) => ({ k, v })), []];
  if (/INSERT INTO ssh_settings/i.test(sql)) { const o = load(); o[params[0]] = params[1]; save(o); return [{}, []]; }
  if (/DELETE FROM ssh_settings WHERE k IN/i.test(sql)) { const o = load(); ['auth_hash', 'allow_on', 'allow_cidrs'].forEach((k) => delete o[k]); save(o); return [{}, []]; }
  if (/DELETE FROM ssh_settings/i.test(sql)) { const o = load(); delete o[params[0]]; save(o); return [{}, []]; }
  if (/COUNT\(\*\)/i.test(sql)) return [[{ n: 1 }], []];
  return [[], []];
}
module.exports = { pool: { query: run, execute: run }, init: async () => {} };
