// Run the Matchup Lab from the command line (no servers needed):
//   node lab.cli.mjs my.txt their.txt [quick|standard|deep] [seed]
// Pastes are toolkit pastes (SP on the EVs line). Prints the certified lead,
// the four to bring, the simulated matchup grid and the answers to each of
// their Pokemon, with the win rates behind them.
import fs from 'node:fs';
import ps from 'pokemon-showdown';
import { patchChampionsData, normalizeTeam, resolveFormat } from './server.mjs';
import { runLab, BUDGETS } from './lab.mjs';

const { Dex, Teams } = ps;
const [, , mineFile, theirsFile, budget = 'quick', seedArg] = process.argv;
if (!mineFile || !theirsFile) { console.error('usage: node lab.cli.mjs my.txt their.txt [quick|standard|deep] [seed]'); process.exit(2); }
if (!BUDGETS[budget]) { console.error(`unknown budget "${budget}"`); process.exit(2); }
const formatid = process.env.LAB_FORMAT || 'gen9championsvgc2026regmc';

patchChampionsData();
const dex = Dex.forFormat(resolveFormat(formatid));
const load = (f) => {
  const team = Teams.import(fs.readFileSync(f, 'utf8')) || [];
  const problems = normalizeTeam(team, formatid);
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  return team;
};
const p1 = { name: 'You', team: load(mineFile) };
const p2 = { name: 'Them', team: load(theirsFile) };
const pct = (x) => `${Math.round(x * 100)}%`;
let lastLine = 0;
const t0 = Date.now();
const res = await runLab({ formatid: resolveFormat(formatid), dex, p1, p2, budget, seed: seedArg ? Number(seedArg) : undefined }, ({ done, total, phase, seconds }) => {
  if (Date.now() - lastLine > 2000 || done === total) {
    lastLine = Date.now();
    process.stderr.write(`\r${phase}: ${done}/${total} games, ${seconds.toFixed(0)}s (${(seconds / done).toFixed(2)} s/game)   `);
  }
});
process.stderr.write('\n');
console.log(`${res.games} games in ${res.seconds}s (${res.dropped} dropped), overall ${pct(res.overall.winRate)} [${pct(res.overall.lo)}-${pct(res.overall.hi)}]`);
console.log('\n== best lead + back');
for (const c of res.configs.slice(0, 6)) console.log(`  ${c.leadNames.join(' + ')} | back ${c.backNames.join(', ')} | ${pct(c.winRate)} [${pct(c.lo)}-${pct(c.hi)}] over ${c.games} vs their likely picks${c.anyLead ? ` | ${pct(c.anyLead.winRate)} over ${c.anyLead.games} when every lead of theirs is equally likely` : ''}`);
const top = res.configs[0];
if (top && top.vsLeads.length) { console.log(`  if they lead (most likely first), with ${top.leadNames.join(' + ')}:`); for (const v of top.vsLeads) console.log(`     ${v.names.join(' + ')} (${pct(v.likelihood)} likely): ${pct(v.winRate)} (${v.games})`); }
console.log('\n== fours');
for (const f of res.fours) console.log(`  ${f.names.join(', ')} | bench ${f.benchNames.join(', ')} | ${pct(f.winRate)} over ${f.games} | best lead ${f.best.leadNames.join(' + ')}`);
console.log(`\n== your Pokemon (win rates from the ${res.uniformGames} round-1 games, where every lead and four played equally; KO rates from all games)`);
for (const m of res.mine) console.log(`  ${m.name.padEnd(14)} brought ${m.broughtGames} (${m.winRateBrought == null ? '-' : pct(m.winRateBrought)}) benched ${m.benchGames} (${m.winRateBenched == null ? '-' : pct(m.winRateBenched)}) KOs/game ${m.kosPerGame.toFixed(2)} faints ${pct(m.faintRate)} scores best against ${m.bestInto.map((b) => b.name).join(', ')} | suffers most against ${m.worstInto.map((b) => b.name).join(', ')}`);
console.log('\n== their Pokemon (threat order)');
for (const f of res.theirs) console.log(`  ${f.name.padEnd(14)} brought ${f.broughtGames} (they win ${f.theirWinRateBrought == null ? '-' : pct(f.theirWinRateBrought)}) KOs/game ${f.kosPerGame.toFixed(2)} faints ${pct(f.faintRate)} | answers ${f.answers.map((a) => `${a.name} (${pct(a.koRate)} KO, KOd ${pct(a.koedRate)})`).join(', ')}`);
console.log('\n== their best leads against you');
for (const l of res.oppLeads) console.log(`  ${l.names.join(' + ')}: they win ${pct(l.theirWinRate)} [${pct(l.lo)}-${pct(l.hi)}] over ${l.games}`);
console.log(`\ntotal ${((Date.now() - t0) / 1000).toFixed(0)}s`);
