// Read-only watcher for the concurrency dry-run test. Prints a line whenever a
// job or the agent changes, then a verdict. Usage: paste the exact WATCH line
// that queue-concurrency-test.mjs prints, e.g.
//   node watch-concurrency-test.mjs utAH98wCYH6URvr20muJ LEsmCYfsbMX5ymUtG0N8
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs'; import { homedir } from 'node:os';
const require = createRequire('/Users/sayeed/Ai projects/Motherlink-engage-agent/apps/poster-agent/package.json');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const db = getFirestore(initializeApp({ credential: cert(JSON.parse(readFileSync(homedir() + '/.config/motherlink-engage/admin.json', 'utf8'))) }));
const ids = process.argv.slice(2);
if (ids.length !== 2) { console.error('Give the two job ids printed by queue-concurrency-test.mjs (copy its WATCH line).'); process.exit(2); } const until = Date.now() + 20 * 60 * 1000;
let last = ''; let bothAt = null; let maxBoth = 0; const t0 = Date.now();
while (Date.now() < until) {
  const docs = await Promise.all(ids.map((id) => db.collection('jobs').doc(id).get()));
  const agent = (await db.doc('agents/agent').get()).data() || {};
  const st = docs.map((d) => `${d.id.slice(0, 6)}:${d.data()?.status}${d.data()?.stage ? '(' + d.data().stage + ')' : ''}`).join('  ');
  const run = (agent.running || []).length;
  const line = `${st} | agent running=${run}/${agent.slots ?? '?'} dryRun=${agent.dryRun}`;
  const posting = docs.filter((d) => d.data()?.status === 'posting').length;
  if (posting === 2) { bothAt ??= Date.now(); maxBoth = Math.max(maxBoth, Date.now() - bothAt); } else bothAt = null;
  if (line !== last) console.log(new Date().toISOString().slice(11, 19), line);
  last = line;
  if (docs.every((d) => ['completed', 'failed', 'cancelled', 'posted'].includes(d.data()?.status))) break;
  await new Promise((r) => setTimeout(r, 3000));
}
const final = await Promise.all(ids.map((id) => db.collection('jobs').doc(id).get()));
for (const d of final) { const x = d.data(); console.log('FINAL', d.id, x.status, '| error:', x.error ?? '-', '| trace steps:', (x.approachTrace || []).length); }
console.log('longest stretch with BOTH running at once:', Math.round(maxBoth / 1000) + 's');
process.exit(0);
