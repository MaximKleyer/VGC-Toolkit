// Matchup Lab (lab.mjs): the config enumeration, the opponent sampler, the
// statistics, and one real self-play game plus a tiny full lab through the engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ps from 'pokemon-showdown';
import { combos, configsFor, makeOppSampler, wilson, plannedGames, rngFrom, playGame, runLab, BUDGETS } from './lab.mjs';
import { patchChampionsData, normalizeTeam, resolveFormat } from './server.mjs';
import { SALAMENCE, KINGAMBIT, INCINEROAR, GARCHOMP, PRIMARINA, SINISTCHA, WHIMSICOTT, ROTOM, STARAPTOR, LUCARIO } from './scenario.mjs';

const { Dex } = ps;
patchChampionsData();
const FORMAT = resolveFormat('gen9championsvgc2026regmc');
const dex = Dex.forFormat(FORMAT);
const team = (sets) => { const t = sets.map((s) => ({ ...s, level: 50 })); const p = normalizeTeam(t, FORMAT); assert.deepEqual(p, []); return t; };

test('combos and configs: four of six with at most one Mega, first two leading', () => {
  assert.equal(combos(6, 4).length, 15);
  assert.equal(combos(4, 2).length, 6);
  const six = team([SALAMENCE, KINGAMBIT, INCINEROAR, GARCHOMP, STARAPTOR, ROTOM]);   // two stones
  const cfgs = configsFor(six, dex);
  assert.ok(cfgs.every((c) => c.four.length === 4 && c.lead.length === 2 && c.back.length === 2));
  assert.ok(cfgs.every((c) => !(c.four.includes(0) && c.four.includes(4))), 'Salamence and Staraptor never share a four');
  assert.equal(cfgs.length, (15 - 6) * 6);   // 6 fours hold both stones
  assert.equal(cfgs[0].choice, 'team 1234');
  const keys = new Set(cfgs.map((c) => c.key));
  assert.equal(keys.size, cfgs.length);
});

test('opponent sampler follows lead propensities and the one-Mega rule', () => {
  const six = team([SALAMENCE, KINGAMBIT, INCINEROAR, GARCHOMP, STARAPTOR, ROTOM]);
  const rng = rngFrom(3);
  const sample = makeOppSampler(six, dex, [5, 60, 60, 5, 5, 5], rng);
  let both = 0, kgInc = 0;
  for (let k = 0; k < 300; k++) {
    const s = sample();
    const four = [...s.lead, ...s.back];
    assert.equal(new Set(four).size, 4);
    if (four.includes(0) && four.includes(4)) both += 1;
    if (s.lead.includes(1) && s.lead.includes(2)) kgInc += 1;
    assert.match(s.choice, /^team [1-6]{4}$/);
  }
  assert.equal(both, 0, 'never both stones');
  assert.ok(kgInc > 150, `Kingambit + Incineroar should lead most of the time, got ${kgInc}/300`);
  const forced = sample([3, 5]);
  assert.deepEqual(forced.lead, [3, 5]);
});

test('wilson interval and the planned game count', () => {
  const w = wilson(7, 10);
  assert.ok(w.lo < 0.7 && w.hi > 0.7 && w.lo > 0.35 && w.hi < 0.95);
  assert.deepEqual(wilson(0, 0), { rate: 0, lo: 0, hi: 1 });
  const q = BUDGETS.quick;
  assert.equal(plannedGames(90, 15, q), 90 * q.r1 + 24 * q.r2 + 8 * q.r3 + q.sweepTop * 15 * q.sweepGames);
});

test('one self-play game records picks, KOs and damage from the omniscient stream', async () => {
  const p1 = { name: 'You', team: team([SALAMENCE, KINGAMBIT, INCINEROAR, GARCHOMP]) };
  const p2 = { name: 'Them', team: team([PRIMARINA, SINISTCHA, WHIMSICOTT, ROTOM]) };
  const g = await playGame({ formatid: FORMAT, dex, p1, p2, p1Choice: 'team 1234', p2Choice: 'team 3412', seed: [1, 2, 3, 4] });
  assert.deepEqual(g.errors, []);
  assert.ok(['p1', 'p2'].includes(g.winner), `winner ${g.winner}`);
  assert.ok(g.turns >= 1);
  assert.deepEqual(g.sides.p1.lead, [0, 1]);
  assert.deepEqual(g.sides.p2.lead, [2, 3]);
  assert.equal(g.sides.p1.four.length, 4);
  const loser = g.winner === 'p1' ? 'p2' : 'p1';
  assert.equal(g.sides[loser].mons.filter((m) => m.fainted).length, 4, 'the loser lost all four');
  const kos = g.sides[g.winner].mons.reduce((s, m) => s + m.kos.length, 0);
  assert.ok(kos >= 1 && kos <= 4, `winner scored ${kos} KOs`);
  const dealt = g.sides.p1.mons.reduce((s, m) => s + Object.values(m.dealt).reduce((a, b) => a + b, 0), 0);
  assert.ok(dealt > 0);
  for (const side of ['p1', 'p2']) for (const m of g.sides[side].mons) assert.ok(m.brought, `${side} brought all four`);
});

test('a tiny lab ranks configs and builds the grid, the answers and their leads', async () => {
  const p1 = { name: 'You', team: team([SALAMENCE, KINGAMBIT, INCINEROAR, LUCARIO]) };
  const p2 = { name: 'Them', team: team([PRIMARINA, SINISTCHA, WHIMSICOTT, ROTOM]) };
  const budget = { r1: 1, keep2: 3, r2: 1, keep3: 1, r3: 1, sweepTop: 1, sweepGames: 1, botShare: 0.5 };
  const seen = [];
  const res = await runLab({ formatid: FORMAT, dex, p1, p2, budget, seed: 11, oppLeadPct: [40, 30, 20, 10] }, (p) => seen.push(p));
  assert.equal(seen.length, plannedGames(6, 6, budget));
  assert.equal(res.games + res.dropped, seen.length);
  assert.ok(res.configs.length >= 1 && res.configs.length <= 6);
  assert.ok(res.configs[0].games >= 3, 'the winner got the extra games');
  assert.ok(res.configs.every((c, i, a) => i === 0 || a[i - 1].lo >= c.lo));
  assert.equal(res.fours.length, 1);
  assert.equal(res.matchup.length, 4);
  assert.equal(res.matchup[0].length, 4);
  assert.equal(res.mine.length, 4);
  assert.equal(res.theirs.length, 4);
  assert.ok(res.theirs.every((f) => f.broughtGames === res.games), 'four of four always come');
  assert.equal(res.uniformGames, 6, 'round 1 is one game per config');
  assert.ok(res.mine.every((m) => m.broughtGames + m.benchGames === res.uniformGames), 'brought + benched = round-1 games');
  assert.ok(res.mine.every((m) => m.gamesAll === res.games), 'four of four always come on your side too');
  assert.ok(res.oppLeads.every((l) => l.lo <= l.theirWinRate && l.theirWinRate <= l.hi));
  assert.ok(res.oppLeads.length >= 1 && res.oppLeads.every((l) => l.names.length === 2));
  assert.ok(res.configs[0].vsLeads.length >= 1);
  // The ranking never counts sweep games; the swept config reports them separately.
  assert.equal(res.sweepGames, 6);
  const swept = res.configs.find((c) => c.anyLead);
  assert.ok(swept && swept.anyLead.games === 6 && swept.games === 3, JSON.stringify({ g: swept?.games, a: swept?.anyLead }));
  assert.equal(res.overall.games, res.games - res.sweepGames);
  assert.ok(res.configs[0].vsLeads.every((v, i, a) => i === 0 || a[i - 1].likelihood >= v.likelihood), 'most likely lead first');
  assert.ok(Math.abs(res.oppLeads.reduce((s, l) => s + l.likelihood, 0) - 1) < 1e-9 || res.oppLeads.length < 6);
  assert.equal(res.names.mine[0], 'Salamence');
});
