// Matchup Lab: bot-vs-bot self-play between your six and theirs.
//
// Real engine games (pokemon-showdown, champions mod) with bot.mjs playing
// both sides. The search dictates only the team-preview choice on your side
// ("team 1234": first two lead, next two in the back) and evaluates every
// legal lead + bring-four against the ways the opponent is likely to pick:
// the bot's own matchup-based pick, and picks sampled from the opponent's
// lead propensities (the Team Preview tab's lead_pct). Every KO and every
// point of damage is attributed from the omniscient stream, so the result
// carries a simulated matchup grid and the answers to each of their Pokemon
// as well as the win rates.
//
//   runLab({formatid, dex, p1:{name,team}, p2:{name,team}, oppLeadPct, budget}, onProgress)
//
// budget: "quick" | "standard" | "deep" (see BUDGETS). Successive halving:
// every config gets a few games, the best third gets more, the best few get
// the most, and the top configs are swept against each of their lead pairs.

import ps from 'pokemon-showdown';
import { newState, applyLine, syncOwnSide, parsePos, parseHP, speciesFromDetails } from './protocol.mjs';
import { decide } from './bot.mjs';

const { BattleStream, getPlayerStreams, Teams } = ps;

// A game takes a few hundredths of a second, so even "deep" finishes in
// about a minute for a 90-config team. r1: games per config in round 1;
// keep2/r2, keep3/r3: how many configs survive and how many more games each
// gets; sweepTop/sweepGames: the top configs against every lead pair of theirs;
// botShare: the share of games where the bot picks the opponent's four itself
// (the rest sample from their lead propensities). Rounds 1-3 play against
// their likely picks and decide the ranking; the sweep only feeds the
// "if they lead X" tables, since a uniform pass over every lead pair is a
// different opponent from the likely one.
export const BUDGETS = {
  quick:    { r1: 2, keep2: 24, r2: 3, keep3: 8,  r3: 8,  sweepTop: 2, sweepGames: 2, botShare: 0.25 },
  standard: { r1: 4, keep2: 30, r2: 5, keep3: 10, r3: 12, sweepTop: 3, sweepGames: 3, botShare: 0.25 },
  deep:     { r1: 8, keep2: 36, r2: 8, keep3: 12, r3: 30, sweepTop: 3, sweepGames: 4, botShare: 0.25 },
};
export const MAX_TURNS = 120;

// ---------------------------------------------------------------- helpers
export function combos(n, k) {
  const out = [];
  const rec = (start, acc) => {
    if (acc.length === k) { out.push(acc.slice()); return; }
    for (let i = start; i < n; i++) { acc.push(i); rec(i + 1, acc); acc.pop(); }
  };
  rec(0, []);
  return out;
}

// Deterministic PRNG so a lab can be replayed (mulberry32).
export function rngFrom(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedFor = (base, g) => [(base + 31 * g) & 0xffff, (base * 7 + 13 * g) & 0xffff, (base * 3 + 101 * g) & 0xffff, (g + 1) & 0xffff];

function weightedPick(items, rng) {
  const total = items.reduce((s, it) => s + it.p, 0);
  let x = rng() * total;
  for (const it of items) { x -= it.p; if (x <= 0) return it; }
  return items[items.length - 1];
}

// Wilson 95% interval for a win rate.
export function wilson(wins, games) {
  if (!games) return { rate: 0, lo: 0, hi: 1 };
  const z = 1.96, p = wins / games, n = games;
  const d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return { rate: p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

export function isMegaSet(dex, set) {
  const it = dex.items.get(set.item || '');
  return !!(it.exists && it.megaStone);
}

const choiceOf = (lead, back) => 'team ' + [...lead, ...back].map((i) => i + 1).join('');
const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

// Every legal "team abcd" for your side: four of the six with at most one
// Mega Stone holder (only one Pokemon Mega Evolves per game), the first two leading.
export function configsFor(team, dex) {
  const megas = team.map((s) => isMegaSet(dex, s));
  const out = [];
  for (const four of combos(team.length, Math.min(4, team.length))) {
    if (four.filter((i) => megas[i]).length > 1) continue;
    for (const [a, b] of combos(four.length, 2)) {
      const lead = [four[a], four[b]];
      const back = four.filter((i) => !lead.includes(i));
      out.push({ four, lead, back, choice: choiceOf(lead, back), key: choiceOf(lead, back) });
    }
  }
  return out;
}

// The opponent's picks: lead pair ∝ w_i * w_j from their lead propensities
// (uniform when unknown), the back two ∝ sqrt(w), at most one Mega Stone
// holder in the four. `forceLead` pins the lead pair (used by the sweep).
export function makeOppSampler(team, dex, leadPct, rng) {
  const n = team.length;
  const megas = team.map((s) => isMegaSet(dex, s));
  const known = Array.isArray(leadPct) && leadPct.length === n && leadPct.some((x) => x > 0);
  const w = known ? leadPct.map((x) => Math.max(Number(x) || 0, 1)) : team.map(() => 1);
  const leadPairs = combos(n, 2).filter(([i, j]) => !(megas[i] && megas[j]));
  return (forceLead = null) => {
    const lead = forceLead || (() => { const p = weightedPick(leadPairs.map(([i, j]) => ({ i, j, p: w[i] * w[j] })), rng); return [p.i, p.j]; })();
    let megaIn = lead.some((i) => megas[i]);
    const back = [];
    let pool = [...Array(n).keys()].filter((i) => !lead.includes(i));
    while (back.length < Math.min(2, n - 2) && pool.length) {
      const cands = pool.filter((i) => !(megaIn && megas[i]));
      const from = cands.length ? cands : pool;
      const c = weightedPick(from.map((i) => ({ i, p: Math.sqrt(w[i]) })), rng).i;
      back.push(c); if (megas[c]) megaIn = true;
      pool = pool.filter((i) => i !== c);
    }
    return { lead, back, choice: choiceOf(lead, back) };
  };
}
export const oppLeadPairs = (team, dex) => {
  const megas = team.map((s) => isMegaSet(dex, s));
  return combos(team.length, 2).filter(([i, j]) => !(megas[i] && megas[j]));
};

// ---------------------------------------------------------------- one game
const sideStats = (n) => ({
  four: null, lead: null,
  mons: Array.from({ length: n }, () => ({ brought: false, switchIns: 0, moves: 0, fainted: false, koedBy: null, kos: [], dealt: {}, taken: 0 })),
});

/**
 * Play one game. `formatid` is the engine's format id (resolveFormat() applied);
 * p1Choice / p2Choice are team-preview strings ("team 1234"), null lets the bot pick. Resolves to {winner:'p1'|'p2'|null, turns, sides, errors}.
 */
export function playGame({ formatid, dex, p1, p2, p1Choice = null, p2Choice = null, seed = null, timeoutMs = 60000 }) {
  return new Promise((resolve) => {
    const stream = new BattleStream();
    const streams = getPlayerStreams(stream);
    const names = { p1: p1.name || 'You', p2: p2.name || 'Them' };
    const teams = { p1: p1.team, p2: p2.team };
    const dictated = { p1: p1Choice, p2: p2Choice };
    const mk = () => newState({ id: 'lab', format: formatid, bot: 'smart', p1Name: names.p1, p2Name: names.p2 });
    const views = { p1: mk(), p2: mk() };
    const sheet = (team) => team.map((s) => ({ species: s.species, item: s.item || '', ability: s.ability || '', moves: s.moves || [] }));
    for (const v of Object.values(views)) { v.sides.p1.sheet = sheet(p1.team); v.sides.p2.sheet = sheet(p2.team); }
    // Base species -> team index (a Mega changes its species mid-game).
    const key = (name) => { const sp = dex.species.get(name); return (sp.exists ? sp.baseSpecies : String(name)).toLowerCase(); };
    const roster = { p1: new Map(), p2: new Map() };
    for (const side of ['p1', 'p2']) teams[side].forEach((s, i) => roster[side].set(key(s.species), i));
    const G = { winner: null, turns: 0, sides: { p1: sideStats(p1.team.length), p2: sideStats(p2.team.length) }, errors: [], choices: { ...dictated } };
    const pos = { p1: [], p2: [] };   // field slot -> team index
    const hp = { p1: [], p2: [] };    // field slot -> {hp, maxhp}
    let lastMove = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { stream.destroy(); } catch { /* already closed */ }
      resolve(G);
    };
    const timer = setTimeout(() => { G.errors.push('timeout'); finish(); }, timeoutMs);
    const write = (cmd) => { if (process.env.LAB_DEBUG) console.log('  >>', cmd.slice(0, 80)); try { stream.write(cmd); } catch (e) { G.errors.push(e.message); finish(); } };
    const monAt = (p) => { const i = pos[p.side][p.slot]; return i == null ? null : G.sides[p.side].mons[i]; };

    const onOmni = (line) => {
      const parts = line.split('|'); const cmd = parts[1];
      switch (cmd) {
        case 'switch': case 'drag': case 'replace': {
          const p = parsePos(parts[2]); if (!p) break;
          const i = roster[p.side].get(key(speciesFromDetails(parts[3])));
          pos[p.side][p.slot] = i ?? null;
          hp[p.side][p.slot] = parseHP(parts[4]);
          if (i != null) { const m = G.sides[p.side].mons[i]; m.brought = true; m.switchIns += 1; }
          break;
        }
        case 'turn': {
          G.turns = Number(parts[2]) || G.turns;
          if (G.turns > MAX_TURNS) { G.errors.push('turn limit'); finish(); }
          break;
        }
        case 'move': {
          const p = parsePos(parts[2]);
          lastMove = p ? { side: p.side, idx: pos[p.side][p.slot] ?? null } : null;
          const m = p && monAt(p); if (m) m.moves += 1;
          break;
        }
        case '-damage': case '-heal': case '-sethp': {
          const p = parsePos(parts[2]); if (!p) break;
          const before = hp[p.side][p.slot];
          const after = parseHP(parts[3]);
          if (after.fainted) after.maxhp = before?.maxhp || 100;
          hp[p.side][p.slot] = after;
          if (cmd !== '-damage' || !before) break;
          const victimIdx = pos[p.side][p.slot];
          const victim = monAt(p); if (victim == null) break;
          const dealt = Math.max(0, before.hp - after.hp) / (before.maxhp || 100);
          victim.taken += dealt;
          const tags = parts.slice(4);
          const from = tags.find((x) => x.startsWith('[from]'));
          let attacker = null;
          if (!from) {
            if (lastMove && lastMove.idx != null && lastMove.side !== p.side) attacker = lastMove;
          } else {
            // Rough Skin, Rocky Helmet, ...: credited to the [of] Pokemon when it is a foe.
            const of = tags.find((x) => x.startsWith('[of]'));
            const op = of && parsePos(of.slice(4).trim());
            if (op && op.side !== p.side && pos[op.side][op.slot] != null) attacker = { side: op.side, idx: pos[op.side][op.slot] };
          }
          if (attacker) {
            const a = G.sides[attacker.side].mons[attacker.idx];
            a.dealt[victimIdx] = (a.dealt[victimIdx] || 0) + dealt;
            if (after.hp === 0 && !victim.fainted) { a.kos.push(victimIdx); victim.koedBy = attacker.idx; victim.fainted = true; }
          }
          break;
        }
        case 'faint': { const p = parsePos(parts[2]); const m = p && monAt(p); if (m) m.fainted = true; break; }
        case 'win': G.winner = parts[2] === names.p1 ? 'p1' : parts[2] === names.p2 ? 'p2' : null; finish(); break;
        case 'tie': G.winner = null; finish(); break;
        case 'error': G.errors.push(line.slice(7, 200)); break;
        default: break;
      }
    };

    const onPlayer = (side, line) => {
      if (line.startsWith('|request|')) {
        const req = JSON.parse(line.slice(9) || 'null');
        if (!req) return;
        if (process.env.LAB_DEBUG) console.log(`  [${side}] request preview=${!!req.teamPreview} wait=${!!req.wait} n=${req.side?.pokemon?.length} active=${req.side?.pokemon?.filter((p) => p.active).length}`);
        syncOwnSide(views[side], req.side);
        if (req.wait) return;
        let choice = null;
        if (req.teamPreview) {
          choice = dictated[side];
        } else if (!G.sides[side].four) {
          // The first request after team preview lists the four that were brought, leads first.
          const idx = (p) => roster[side].get(key(speciesFromDetails(p.details)));
          G.sides[side].four = req.side.pokemon.map(idx).filter((i) => i != null);
          G.sides[side].lead = req.side.pokemon.filter((p) => p.active).map(idx).filter((i) => i != null);
          // "Brought" means in the four, whether or not it ever reached the field.
          for (const i of G.sides[side].four) G.sides[side].mons[i].brought = true;
        }
        if (!choice) {
          try { choice = decide(req, views[side], dex) || 'default'; } catch (e) { G.errors.push(`${side} bot: ${e.message}`); choice = 'default'; }
        }
        write(`>${side} ${choice}`);
        return;
      }
      if (line.startsWith('|error|')) {
        if (process.env.LAB_DEBUG) console.log(`  [${side}] ${line.slice(0, 120)}`);
        // An illegal choice: the engine keeps waiting, so answer with its default.
        if (!/Can't do anything|already/.test(line)) write(`>${side} default`);
        return;
      }
      applyLine(views[side], line);
    };

    const pump = async (s, who) => {
      try {
        for await (const chunk of s) {
          for (const line of String(chunk).split('\n')) {
            if (done) return;
            if (!line) continue;
            if (who === 'omni') onOmni(line); else onPlayer(who, line);
          }
        }
      } catch (e) {
        if (!done) { G.errors.push(`${who} stream: ${e.message}`); finish(); }
      }
    };
    void pump(streams.omniscient, 'omni');
    void pump(streams.p1, 'p1');
    void pump(streams.p2, 'p2');
    const spec = { formatid };
    if (seed) spec.seed = seed;
    write(`>start ${JSON.stringify(spec)}`);
    write(`>player p1 ${JSON.stringify({ name: names.p1, team: Teams.pack(p1.team) })}`);
    write(`>player p2 ${JSON.stringify({ name: names.p2, team: Teams.pack(p2.team) })}`);
  });
}

// ---------------------------------------------------------------- the search
export function plannedGames(nConfigs, nOppLeads, B) {
  return nConfigs * B.r1 + Math.min(nConfigs, B.keep2) * B.r2 + Math.min(nConfigs, B.keep3) * B.r3
    + Math.min(nConfigs, B.sweepTop) * nOppLeads * B.sweepGames;
}

/**
 * Run the whole lab. Resolves to the results object (null when stopped).
 * onProgress({done, total, phase, seconds}) after every game.
 */
export async function runLab(spec, onProgress = () => {}) {
  const { formatid, dex, p1, p2, oppLeadPct = null, shouldStop = () => false } = spec;
  const B = (spec.budget && typeof spec.budget === 'object') ? spec.budget : (BUDGETS[spec.budget] || BUDGETS.standard);
  const seed = Number.isFinite(spec.seed) ? spec.seed & 0xffff : (Date.now() & 0xffff);
  const rng = rngFrom(seed);
  const configs = configsFor(p1.team, dex);
  const sampleOpp = makeOppSampler(p2.team, dex, oppLeadPct, rng);
  const leadPairs = oppLeadPairs(p2.team, dex);
  const total = plannedGames(configs.length, leadPairs.length, B);
  const t0 = Date.now();
  const games = [];
  let done = 0, g = 0, phase = 'round 1';
  const play = async (cfg, oppCfg) => {
    const res = await playGame({ formatid, dex, p1, p2, p1Choice: cfg.choice, p2Choice: oppCfg ? oppCfg.choice : null, seed: seedFor(seed, g++) });
    res.cfg = cfg; res.oppCfg = oppCfg; res.phase = phase;
    games.push(res); done += 1;
    onProgress({ done, total, phase, seconds: (Date.now() - t0) / 1000 });
    return res;
  };
  const stat = (cfg) => {
    const gs = games.filter((x) => x.cfg === cfg);
    const wins = gs.filter((x) => x.winner === 'p1').length;
    return { games: gs.length, wins, score: (wins + 1) / (gs.length + 2) };
  };
  let pool = configs;
  const rounds = [[configs.length, B.r1], [B.keep2, B.r2], [B.keep3, B.r3]];
  for (let r = 0; r < rounds.length; r++) {
    const [keep, reps] = rounds[r];
    phase = `round ${r + 1}`;
    pool = [...pool].sort((a, b) => stat(b).score - stat(a).score).slice(0, keep);
    for (let k = 0; k < reps; k++) {
      for (const cfg of pool) {
        if (shouldStop()) return null;
        await play(cfg, rng() < B.botShare ? null : sampleOpp());
      }
    }
  }
  // Sweep: the top configs against each of their possible lead pairs.
  phase = 'sweep';
  const top = [...pool].sort((a, b) => stat(b).score - stat(a).score).slice(0, B.sweepTop);
  for (const cfg of top) {
    for (const lead of leadPairs) {
      for (let k = 0; k < B.sweepGames; k++) {
        if (shouldStop()) return null;
        await play(cfg, sampleOpp(lead));
      }
    }
  }
  return summarize({ games, configs, p1, p2, dex, seed, budget: typeof spec.budget === 'string' ? spec.budget : 'custom', seconds: (Date.now() - t0) / 1000, formatid, oppLeadPct });
}

// ---------------------------------------------------------------- aggregation
export function summarize({ games, configs, p1, p2, dex, seed, budget, seconds, formatid, oppLeadPct = null }) {
  const n1 = p1.team.length, n2 = p2.team.length;
  const name1 = p1.team.map((s) => s.species), name2 = p2.team.map((s) => s.species);
  const played = games.filter((x) => x.winner !== null && !x.errors.some((e) => /timeout|turn limit|stream/.test(e)));
  // Round 1 plays every lead + four the same number of times. Later rounds
  // pile games onto the best ones, so "win rate when X is brought" over all
  // games would mostly measure whether X sits in the best sets. Per-Pokemon
  // win rates (brought / benched / lead) therefore use round 1 only; KO and
  // damage rates, which are per game brought, use everything.
  const uniform = played.filter((x) => x.phase === 'round 1');
  // The sweep plays the top configs against every lead pair of theirs equally,
  // a different opponent from the likely one the other rounds sample. It feeds
  // the "if they lead X" tables and the per-Pokemon grid, never the ranking.
  const main = played.filter((x) => x.phase !== 'sweep');
  const nameList = (side, idx) => idx.map((i) => (side === 'p1' ? name1 : name2)[i]);
  // How likely each lead pair of theirs is, from the same propensities the sampler used.
  const pairs2 = oppLeadPairs(p2.team, dex);
  const known = Array.isArray(oppLeadPct) && oppLeadPct.length === n2 && oppLeadPct.some((x) => x > 0);
  const w2 = known ? oppLeadPct.map((x) => Math.max(Number(x) || 0, 1)) : p2.team.map(() => 1);
  const pairTotal = pairs2.reduce((s, [i, j]) => s + w2[i] * w2[j], 0) || 1;
  const likelihood = (lead) => (w2[lead[0]] * w2[lead[1]]) / pairTotal;

  // Configs (lead + back), fours, lead pairs.
  const byCfg = new Map();
  for (const x of played) {
    const c = byCfg.get(x.cfg.key) || { ...x.cfg, games: 0, wins: 0, turns: 0, sweepGames: 0, sweepWins: 0, vsLeads: new Map() };
    const win = x.winner === 'p1' ? 1 : 0;
    if (x.phase === 'sweep') { c.sweepGames += 1; c.sweepWins += win; } else { c.games += 1; c.wins += win; c.turns += x.turns; }
    const ol = x.sides.p2.lead;
    if (ol && ol.length === 2) {
      const k = pairKey(ol[0], ol[1]);
      const v = c.vsLeads.get(k) || { lead: [Math.min(...ol), Math.max(...ol)], games: 0, wins: 0 };
      v.games += 1; v.wins += win; c.vsLeads.set(k, v);
    }
    byCfg.set(x.cfg.key, c);
  }
  const cfgRows = [...byCfg.values()].filter((c) => c.games > 0).map((c) => {
    const w = wilson(c.wins, c.games);
    const s = c.sweepGames ? wilson(c.sweepWins, c.sweepGames) : null;
    return {
      key: c.key, four: c.four, lead: c.lead, back: c.back,
      leadNames: nameList('p1', c.lead), backNames: nameList('p1', c.back), benchNames: nameList('p1', [...Array(n1).keys()].filter((i) => !c.four.includes(i))),
      games: c.games, wins: c.wins, winRate: w.rate, lo: w.lo, hi: w.hi, avgTurns: c.games ? c.turns / c.games : 0,
      // The same lead + back when every lead pair of theirs is equally likely (sweep games only).
      anyLead: s && { games: c.sweepGames, wins: c.sweepWins, winRate: s.rate, lo: s.lo, hi: s.hi },
      vsLeads: [...c.vsLeads.values()]
        .map((v) => ({ ...v, names: nameList('p2', v.lead), winRate: v.games ? v.wins / v.games : 0, likelihood: likelihood(v.lead) }))
        .sort((a, b) => (b.likelihood - a.likelihood) || (b.games - a.games)),
    };
  });
  // Rank by the lower confidence bound first, then the rate: a 70% on 40 games beats a 100% on 2.
  const rank = (a, b) => (b.lo - a.lo) || (b.winRate - a.winRate) || (b.games - a.games);
  cfgRows.sort(rank);

  const group = (keyOf, label) => {
    const m = new Map();
    for (const c of cfgRows) {
      const k = keyOf(c);
      const g0 = m.get(k) || { key: k, games: 0, wins: 0, best: null, ...label(c) };
      g0.games += c.games; g0.wins += c.wins;
      if (!g0.best || rank(c, g0.best) < 0) g0.best = c;
      m.set(k, g0);
    }
    return [...m.values()].map((g0) => { const w = wilson(g0.wins, g0.games); return { ...g0, winRate: w.rate, lo: w.lo, hi: w.hi, best: g0.best && { key: g0.best.key, lead: g0.best.lead, leadNames: g0.best.leadNames, back: g0.best.back, backNames: g0.best.backNames, winRate: g0.best.winRate, games: g0.best.games } }; }).sort(rank);
  };
  const fours = group((c) => c.four.join(','), (c) => ({ four: c.four, names: nameList('p1', c.four), benchNames: c.benchNames }));
  const leads = group((c) => pairKey(c.lead[0], c.lead[1]), (c) => ({ lead: c.lead, names: nameList('p1', c.lead) }));

  // Matchup grid and per-Pokemon stats.
  const grid = Array.from({ length: n1 }, () => Array.from({ length: n2 }, () => ({ games: 0, kos: 0, koed: 0, dealt: 0, taken: 0 })));
  const mine = Array.from({ length: n1 }, (_, i) => ({ idx: i, name: name1[i], broughtGames: 0, broughtWins: 0, benchGames: 0, benchWins: 0, leadGames: 0, leadWins: 0, gamesAll: 0, kos: 0, fainted: 0, dealt: 0, taken: 0 }));
  const theirs = Array.from({ length: n2 }, (_, j) => ({ idx: j, name: name2[j], broughtGames: 0, broughtWins: 0, leadGames: 0, leadWins: 0, kos: 0, fainted: 0, dealt: 0 }));
  const oppLeadMap = new Map();
  for (const x of uniform) {
    const win = x.winner === 'p1';
    const S1 = x.sides.p1;
    for (let i = 0; i < n1; i++) {
      if (S1.mons[i].brought) { mine[i].broughtGames += 1; mine[i].broughtWins += win ? 1 : 0; } else { mine[i].benchGames += 1; mine[i].benchWins += win ? 1 : 0; }
      if (S1.lead && S1.lead.includes(i)) { mine[i].leadGames += 1; mine[i].leadWins += win ? 1 : 0; }
    }
  }
  for (const x of played) {
    const win = x.winner === 'p1';
    const S1 = x.sides.p1, S2 = x.sides.p2;
    for (let i = 0; i < n1; i++) {
      const m = S1.mons[i];
      if (m.brought) mine[i].gamesAll += 1;
      mine[i].kos += m.kos.length; mine[i].fainted += m.fainted ? 1 : 0; mine[i].taken += m.taken;
      for (const [j, d] of Object.entries(m.dealt)) mine[i].dealt += d, grid[i][j].dealt += d;
      for (const j of m.kos) grid[i][j].kos += 1;
      for (let j = 0; j < n2; j++) if (m.brought && S2.mons[j].brought) grid[i][j].games += 1;
    }
    for (let j = 0; j < n2; j++) {
      const f = S2.mons[j];
      if (f.brought) { theirs[j].broughtGames += 1; theirs[j].broughtWins += win ? 0 : 1; }
      if (S2.lead && S2.lead.includes(j)) { theirs[j].leadGames += 1; theirs[j].leadWins += win ? 0 : 1; }
      theirs[j].kos += f.kos.length; theirs[j].fainted += f.fainted ? 1 : 0; theirs[j].dealt += Object.values(f.dealt).reduce((s, d) => s + d, 0);
      for (const i of f.kos) grid[i][j].koed += 1;
      for (const [i, d] of Object.entries(f.dealt)) grid[i][j].taken += d;
    }
    if (S2.lead && S2.lead.length === 2) {
      const k = pairKey(S2.lead[0], S2.lead[1]);
      const v = oppLeadMap.get(k) || { lead: [Math.min(...S2.lead), Math.max(...S2.lead)], names: nameList('p2', [Math.min(...S2.lead), Math.max(...S2.lead)]), games: 0, theirWins: 0, likelihood: likelihood([Math.min(...S2.lead), Math.max(...S2.lead)]) };
      v.games += 1; v.theirWins += win ? 0 : 1; oppLeadMap.set(k, v);
    }
  }
  const cell = (c) => ({
    games: c.games,
    koRate: c.games ? c.kos / c.games : 0, koedRate: c.games ? c.koed / c.games : 0,
    dealt: c.games ? c.dealt / c.games : 0, taken: c.games ? c.taken / c.games : 0,
    edge: c.games ? (c.kos - c.koed) / c.games + (c.dealt - c.taken) * 0.25 : 0,
  });
  const matchup = grid.map((row) => row.map(cell));
  const mineRows = mine.map((m) => ({
    ...m,
    winRateBrought: m.broughtGames ? m.broughtWins / m.broughtGames : null,
    winRateBenched: m.benchGames ? m.benchWins / m.benchGames : null,
    winRateLead: m.leadGames ? m.leadWins / m.leadGames : null,
    kosPerGame: m.gamesAll ? m.kos / m.gamesAll : 0,
    faintRate: m.gamesAll ? m.fainted / m.gamesAll : 0,
    dealtPerGame: m.gamesAll ? m.dealt / m.gamesAll : 0,
    takenPerGame: m.gamesAll ? m.taken / m.gamesAll : 0,
    bestInto: matchup[m.idx].map((c, j) => ({ idx: j, name: name2[j], ...c })).filter((c) => c.games >= 3).sort((a, b) => b.edge - a.edge).slice(0, 3),
    worstInto: matchup[m.idx].map((c, j) => ({ idx: j, name: name2[j], ...c })).filter((c) => c.games >= 3).sort((a, b) => a.edge - b.edge).slice(0, 3),
  }));
  const theirRows = theirs.map((f) => {
    const col = matchup.map((row, i) => ({ idx: i, name: name1[i], ...row[f.idx] })).filter((c) => c.games >= 3);
    return {
      ...f,
      theirWinRateBrought: f.broughtGames ? f.broughtWins / f.broughtGames : null,
      theirWinRateLead: f.leadGames ? f.leadWins / f.leadGames : null,
      kosPerGame: f.broughtGames ? f.kos / f.broughtGames : 0,
      faintRate: f.broughtGames ? f.fainted / f.broughtGames : 0,
      dealtPerGame: f.broughtGames ? f.dealt / f.broughtGames : 0,
      threat: f.broughtGames ? f.kos / f.broughtGames + (f.broughtWins / f.broughtGames) : 0,
      answers: [...col].sort((a, b) => b.edge - a.edge).slice(0, 3),
      preys: [...col].sort((a, b) => a.edge - b.edge).slice(0, 2),
    };
  }).sort((a, b) => b.threat - a.threat);
  const oppLeads = [...oppLeadMap.values()]
    .map((v) => { const w = wilson(v.theirWins, v.games); return { ...v, theirWinRate: w.rate, lo: w.lo, hi: w.hi }; })
    .sort((a, b) => (b.lo - a.lo) || (b.theirWinRate - a.theirWinRate) || (b.games - a.games));

  const wins = main.filter((x) => x.winner === 'p1').length;
  const overall = wilson(wins, main.length);
  return {
    formatid, budget, seed, seconds: Math.round(seconds), games: played.length, dropped: games.length - played.length,
    uniformGames: uniform.length, sweepGames: played.length - main.length,
    overall: { games: main.length, wins, winRate: overall.rate, lo: overall.lo, hi: overall.hi },
    names: { mine: name1, theirs: name2 },
    configs: cfgRows.slice(0, 12),
    fours: fours.slice(0, 6),
    leads: leads.slice(0, 6),
    matchup, mine: mineRows, theirs: theirRows, oppLeads,
  };
}
