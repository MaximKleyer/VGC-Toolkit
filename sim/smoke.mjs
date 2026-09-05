// Bot-vs-bot smoke battle through the running sidecar + backend.
// Both servers must be up (uvicorn on 8000, `npm start` here on 8001).
//   node smoke.mjs [format] [bot]
const SIM = process.env.SIM_URL || 'http://127.0.0.1:8001';
const API = process.env.API_URL || 'http://127.0.0.1:8000';
const format = process.argv[2] || 'gen9championsvgc2026regmb';
const bot = process.argv[3] || 'greedy';

async function j(url, opts) {
  const r = await fetch(url, opts);
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(b).slice(0, 500)}`);
  return b;
}
const post = (u, b) => j(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

const health = await j(`${SIM}/sim/health`);
console.log('sidecar:', health);
const t1 = await j(`${API}/api/meta/random-team?regulation=M-B&seed=1`);
const t2 = await j(`${API}/api/meta/random-team?regulation=M-B&seed=2`);
console.log('p1:', t1.members.map((m) => m.name).join(', '));
console.log('p2:', t2.members.map((m) => m.name).join(', '));

let st = await post(`${SIM}/sim/battle`, {
  format, bot, p1: { name: 'Smoke', paste: t1.paste }, p2: { name: 'Bot', paste: t2.paste },
});
console.log(`battle ${st.id}: preview pick ${st.teamPreview?.pick}, opp preview: ${(st.sides.p2.preview || []).map((p) => p.species).join(', ')}`);

// The first move turn uses the exact strings the Battle tab builds
// ("move N T mega, move N T"); every later turn uses Showdown's default.
let explicitDone = false;
function explicitChoice(req) {
  let megaUsed = false;
  return req.active.map((a, i) => {
    const mon = req.side.pokemon[i];
    if (!a || mon.condition.endsWith(' fnt')) return 'pass';
    const idx = a.moves.findIndex((m) => !m.disabled);
    const m = a.moves[idx];
    const target = ['normal', 'any', 'adjacentFoe'].includes(m.target) ? ` ${1 + (i % 2)}` : '';
    const mega = a.canMegaEvo && !megaUsed ? (megaUsed = true, ' mega') : '';
    return `move ${idx + 1}${target}${mega}`;
  }).join(', ');
}

let guard = 0;
while (!st.ended && guard++ < 300) {
  if (!st.request) {
    await new Promise((r) => setTimeout(r, 150));
    st = await j(`${SIM}/sim/battle/${st.id}`);
    continue;
  }
  let choice = 'default';
  if (st.request.teamPreview) choice = 'team 1234';
  else if (st.request.active && !explicitDone) { choice = explicitChoice(st.request); explicitDone = true; console.log('explicit first turn:', choice); }
  try {
    st = await post(`${SIM}/sim/battle/${st.id}/choice`, { choice });
  } catch (e) {
    console.log('choice rejected:', e.message.slice(0, 300));
    st = await j(`${SIM}/sim/battle/${st.id}`);
    if (st.errors.length > 3) break;
  }
}
console.log(`ended=${st.ended} winner=${st.winner} turns=${st.turn} log lines=${st.log.length} errors=${st.errors.length}`);
if (st.errors.length) console.log('errors:', st.errors.slice(-5));
for (const s of ['p1', 'p2']) {
  console.log(s, st.sides[s].active.map((m) => (m ? `${m.species} ${m.hp}/${m.maxhp}${m.status ? ' ' + m.status : ''}${m.mega ? ' (mega)' : ''}` : '-')));
}
console.log('--- last log lines ---');
console.log(st.log.slice(-15).join('\n'));
process.exit(st.ended && !st.errors.length ? 0 : 1);
