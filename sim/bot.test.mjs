// Bot decision tests (need pokemon-showdown installed): hand-built situations
// go through decide(); a full smart-vs-smart game checks every choice is legal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ps from 'pokemon-showdown';
import { decide, explain } from './bot.mjs';
import { validateTeam, normalizeTeam, Battle } from './server.mjs';
import { dex, scenario, choose, KINGAMBIT, GARCHOMP, SALAMENCE, INCINEROAR, AMOONGUSS, FLUTTER, LUCARIO, ROTOM, CORVIKNIGHT, FARIGIRAF, TORKOAL, STARAPTOR, PRIMARINA, SINISTCHA, GOLISOPOD } from './scenario.mjs';

const { Teams } = ps;

test('spread moves spare a partner that is not immune, and are used when it is', () => {
  // Kingambit takes double damage from Earthquake: either Garchomp picks another
  // move, or Kingambit Protects while it quakes (the classic doubles line).
  const [garchomp, kingambit] = choose(scenario({ own: [GARCHOMP, KINGAMBIT], foes: [INCINEROAR, AMOONGUSS] }));
  if (garchomp.startsWith('move 1')) assert.equal(kingambit, 'move 4', `Earthquake into an unprotected Kingambit: ${garchomp}, ${kingambit}`);
  // No Protect on the partner: never.
  const noProtect = { ...KINGAMBIT, moves: ['Kowtow Cleave', 'Sucker Punch', 'Iron Head', 'Swords Dance'] };
  const [garchomp2] = choose(scenario({ own: [GARCHOMP, noProtect], foes: [INCINEROAR, AMOONGUSS] }));
  assert.ok(!garchomp2.startsWith('move 1'), `Earthquake would hit Kingambit for double damage: ${garchomp2}`);
  // A Flying partner is immune: Earthquake is simply the best move.
  const [garchomp3] = choose(scenario({ own: [GARCHOMP, SALAMENCE], foes: [INCINEROAR, AMOONGUSS] }));
  assert.ok(garchomp3.startsWith('move 1'), `Salamence is immune, Earthquake hits both foes: ${garchomp3}`);
});

test('never attacks into a type- or ability-immune target', () => {
  const [lucario] = choose(scenario({ own: [LUCARIO, KINGAMBIT], foes: [FLUTTER, INCINEROAR] }));
  assert.ok(!['move 1 1', 'move 2 1'].includes(lucario), `Fighting move into a Ghost: ${lucario}`);
  const [garchomp] = choose(scenario({ own: [GARCHOMP, KINGAMBIT], foes: [ROTOM, CORVIKNIGHT] }));
  assert.ok(!garchomp.startsWith('move 1'), `Earthquake into Levitate + Flying: ${garchomp}`);
});

test('goes for the KO on the weakened foe', () => {
  // Either Kingambit hits the 25% Garchomp, or its partner's Earthquake does
  // (with Kingambit protecting from the quake) — both secure the KO.
  const [kingambit, garchomp] = choose(scenario({ own: [KINGAMBIT, GARCHOMP], foes: [{ ...GARCHOMP, hp: 25 }, AMOONGUSS] }));
  const hitsIt = /^move [123] 1/.test(kingambit) || /^move (1|[12] 1)/.test(garchomp);
  assert.ok(hitsIt, `expected the 25% Garchomp to be attacked: ${kingambit}, ${garchomp}`);
  if (garchomp === 'move 1') assert.equal(kingambit, 'move 4', 'Earthquake next to an unprotected Kingambit');
});

test('protects when a KO is coming and it cannot act first; not once the odds are gone', () => {
  const setup = (protectStreak) => scenario({
    own: [{ ...KINGAMBIT, hpFrac: 0.2, protectStreak }, INCINEROAR],
    foes: [GARCHOMP, ROTOM],
  });
  const [fresh] = choose(setup(0));
  assert.equal(fresh, 'move 4', `20% Kingambit facing two faster KOs should Protect: ${fresh}`);
  const [stale] = choose(setup(2));
  assert.ok(stale.startsWith('move 2'), `with 1/9 Protect odds Sucker Punch is the play: ${stale}`);
});

test('Fake Out only on the first turn out', () => {
  const [first] = choose(scenario({ own: [{ ...INCINEROAR, moveActions: 0 }, KINGAMBIT], foes: [FLUTTER, GARCHOMP] }));
  assert.ok(first.startsWith('move 1 '), `fresh Incineroar should Fake Out the Specs Flutter Mane: ${first}`);
  const [later] = choose(scenario({ own: [{ ...INCINEROAR, moveActions: 1 }, KINGAMBIT], foes: [FLUTTER, GARCHOMP] }));
  assert.ok(!later.startsWith('move 1'), `Fake Out fails after the first turn: ${later}`);
});

test('sets Trick Room when slower and never resets its own', () => {
  const [farigiraf] = choose(scenario({ own: [FARIGIRAF, TORKOAL], foes: [FLUTTER, GARCHOMP] }));
  assert.equal(farigiraf, 'move 1', `slow team vs fast foes should set Trick Room: ${farigiraf}`);
  const [underTR] = choose(scenario({ own: [FARIGIRAF, TORKOAL], foes: [FLUTTER, GARCHOMP], field: { pseudo: ['Trick Room'] } }));
  assert.ok(!underTR.startsWith('move 1'), `Trick Room is up and helping: ${underTR}`);
});

test('team preview picks four distinct members with two leads', () => {
  const s = scenario({
    own: [KINGAMBIT, INCINEROAR, GARCHOMP, AMOONGUSS, FARIGIRAF, LUCARIO],
    foes: [FLUTTER, ROTOM, CORVIKNIGHT, TORKOAL, SALAMENCE, AMOONGUSS].map((f) => ({ ...f, bench: true })),
    teamPreview: true,
  });
  const choice = decide(s.req, s.view, dex);
  assert.match(choice, /^team [1-6]{4}$/, choice);
  assert.equal(new Set(choice.slice(5)).size, 4, choice);
});

test('forced switch brings a benched, living replacement', () => {
  const s = scenario({
    own: [{ ...KINGAMBIT, hpFrac: 0 }, INCINEROAR, GARCHOMP, AMOONGUSS],
    foes: [FLUTTER, ROTOM],
    forceSwitch: [true, false],
  });
  const choice = decide(s.req, s.view, dex);
  assert.match(choice, /^switch [34], pass$/, choice);
});

// ---------------------------------------------------------------- full game
const meta = JSON.parse(fs.readFileSync(new URL('../vgc_toolkit/data/meta_sets.json', import.meta.url), 'utf8'));

/** Six ladder sets (distinct species and items, each legal on its own) starting
 *  from the n-th most used Pokémon, as a paste. */
function ladderPaste(offset, format) {
  const mons = Object.values(meta.pokemon).filter((m) => m.sets?.length).sort((a, b) => b.usage - a.usage);
  const items = new Set(); const species = new Set(); const out = [];
  for (let i = offset; i < mons.length && out.length < 6; i += 2) {
    const m = mons[i]; const s = m.sets[0];
    const sp = dex.species.get(m.name);
    if (!sp.exists) continue;
    if (species.has(sp.baseSpecies) || (s.item && items.has(s.item))) continue;
    const paste = [`${m.name}${s.item ? ` @ ${s.item}` : ''}`, `Ability: ${s.ability}`, 'Level: 50', `${s.alignment} Nature`,
      ...s.moves.map((mv) => `- ${mv}`), ''].join('\n');
    const set = Teams.import(paste);
    normalizeTeam(set, format);
    const problems = (validateTeam(format, set) || []).filter((x) => !/^You must bring/.test(x));
    if (problems.length) continue;
    species.add(sp.baseSpecies); if (s.item) items.add(s.item);
    out.push(paste);
  }
  return out.join('\n');
}

test('a full smart-vs-smart battle makes only legal choices', async () => {
  const format = 'gen9championsvgc2026regmb';
  const teams = [ladderPaste(0, format), ladderPaste(1, format)].map((paste) => Teams.import(paste));
  for (const team of teams) {
    assert.equal(team.length, 6);
    assert.deepEqual(normalizeTeam(team, format), []);
    assert.equal(validateTeam(format, team), null, `ladder team should be legal: ${JSON.stringify(validateTeam(format, team))}`);
  }
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const battle = new Battle({ format, p1: { name: 'A', team: teams[0] }, p2: { name: 'B', team: teams[1] }, bot: 'smart', seed: [7, 8, 9, 10] });
    let guard = 0;
    while (!battle.state.ended && guard++ < 150) {
      if (!battle.state.request) { await battle.nextEvent(3000); continue; }
      const choice = decide(battle.state.request, battle.state, battle.dex) || 'default';
      await battle.choose(choice);
    }
    try { battle.stream.destroy(); } catch { /* already ended */ }
    assert.equal(battle.state.ended, true, `battle did not end in ${guard} steps (turn ${battle.state.turn})`);
    assert.ok(battle.state.turn >= 3, `suspiciously short game: ${battle.state.turn} turns`);
    assert.deepEqual(battle.state.errors, [], 'p1 (smart) made an illegal choice');
    assert.deepEqual(warnings.filter((w) => w.includes('[bot]')), [], 'p2 (smart) fell back to default/random');
  } finally {
    console.warn = origWarn;
  }
});

test('Encore needs a last move and is not thrown into Armor Tail with Prankster', async () => {
  const { WHIMSICOTT } = await import('./scenario.mjs');
  const encoreValue = (sc) => {
    // Value the bot puts on Whimsicott's Encore (move 3) in this situation.
    const plans = explain(sc.req, sc.view, dex, 500);
    const act = plans.map((pl) => pl.actions[0]).find((x) => x && x.text.startsWith('move 3'));   // slot 0 = Whimsicott
    return act ? act.value : null;
  };
  // Fresh switch-in: nothing to Encore.
  const fresh = scenario({ own: [WHIMSICOTT, GARCHOMP], foes: [{ ...KINGAMBIT, moveActions: 0 }, FARIGIRAF] });
  assert.ok(!choose(fresh)[0].startsWith('move 3'), 'Encore into a fresh switch-in');
  // Farigiraf just set Trick Room, but its Armor Tail blocks the Prankster Encore.
  const blocked = scenario({ own: [WHIMSICOTT, GARCHOMP], foes: [{ ...FARIGIRAF, lastMove: 'Trick Room' }, KINGAMBIT], field: { pseudo: ['Trick Room'] } });
  assert.equal(encoreValue(blocked), 0, 'Prankster Encore into Armor Tail is worthless');
  assert.ok(!choose(blocked)[0].startsWith('move 3'));
  // Same situation without Armor Tail: Encore on the Trick Room user is a real option.
  const open = scenario({ own: [WHIMSICOTT, GARCHOMP], foes: [{ ...FARIGIRAF, ability: 'Cud Chew', lastMove: 'Trick Room' }, KINGAMBIT], field: { pseudo: ['Trick Room'] } });
  assert.ok(encoreValue(open) > 0.2, `Encore on a Trick Room user should be valued: ${encoreValue(open)}`);
});

test('pressure() answers the three questions from one side\'s point of view', async () => {
  const { pressure } = await import('./bot.mjs');
  const s = scenario({ own: [KINGAMBIT, GARCHOMP], foes: [INCINEROAR, AMOONGUSS], field: { pseudo: ['Trick Room'] } });
  const p = pressure(s.view, dex, 'p2');
  assert.equal(p.trickRoom, true);
  assert.equal(p.order.length, 4);
  // Under Trick Room the slowest acts first: the exact-speed Kingambit (70) before everyone.
  assert.equal(p.order[0].species, 'Kingambit');
  assert.ok(p.order.every((o, i) => i === 0 || o.speed >= p.order[i - 1].speed));
  const chompOnIncin = p.ours.find((o) => o.species === 'Garchomp').threats.find((t) => t.target === 'Incineroar');
  assert.equal(chompOnIncin.move, 'Earthquake');
  assert.ok(chompOnIncin.max > 80 && chompOnIncin.ko > 0, JSON.stringify(chompOnIncin));
  const incinOnGambit = p.theirs.find((f) => f.species === 'Incineroar').threats.find((t) => t.target === 'Kingambit');
  assert.equal(incinOnGambit.move, 'Flare Blitz');
  // Every damaging move is listed against each target, best one included, blocked ones flagged.
  const damaging = GARCHOMP.moves.filter((m) => dex.moves.get(m).category !== 'Status');
  assert.equal(chompOnIncin.moves.length, damaging.length, JSON.stringify(chompOnIncin.moves));
  assert.ok(chompOnIncin.moves.some((m) => m.move === 'Earthquake' && m.max === chompOnIncin.max));
  assert.ok(chompOnIncin.moves.every((m) => typeof m.blocked === 'boolean' && typeof m.min === 'number'));
  const incinOnChomp = p.theirs.find((f) => f.species === 'Incineroar').threats.find((t) => t.target === 'Garchomp');
  assert.ok(incinOnChomp.moves.length >= 2);
  // Team preview: their six ranked by danger, with our answers (2HKO or better).
  const pv = scenario({ own: [KINGAMBIT, GARCHOMP, INCINEROAR, AMOONGUSS], foes: [FARIGIRAF, GARCHOMP].map((f) => ({ ...f, bench: true })), teamPreview: true });
  const q = pressure(pv.view, dex, 'p2');
  assert.equal(q.preview.length, 2);
  assert.equal(q.preview[0].species, 'Garchomp');
  assert.ok(q.preview[0].answers.length >= 2);
});

test('Mega Evolves on the first turn it can, including into a Fairy attacker it outspeeds', () => {
  // Mega Staraptor is Fighting/Flying: Moonblast becomes super effective, but the
  // stat gain is permanent and it moves first, so the one-turn evaluator's bonus
  // for a Mega Evolution must win here.
  const chomp = { ...GARCHOMP, moves: ['Rock Slide', 'Earthquake', 'Dragon Claw', 'Protect'] };
  const [, neutral] = choose(scenario({ own: [chomp, STARAPTOR], foes: [FARIGIRAF, GOLISOPOD], canMega: [1], turn: 1 }));
  assert.ok(/ mega$/.test(neutral), `expected Staraptor to Mega Evolve on a neutral field: ${neutral}`);
  const [, fairy] = choose(scenario({ own: [chomp, STARAPTOR], foes: [PRIMARINA, SINISTCHA], canMega: [1], turn: 1 }));
  assert.ok(/ mega$/.test(fairy), `expected Staraptor to Mega Evolve facing Primarina: ${fairy}`);
  // Contrary turns Close Combat's drops into boosts: the mega happily clicks it.
  const [cc] = choose(scenario({ own: [STARAPTOR, KINGAMBIT], foes: [INCINEROAR, AMOONGUSS], canMega: [0], turn: 1 }));
  assert.ok(/ mega$/.test(cc), `expected Mega Staraptor into Incineroar: ${cc}`);
});

test('does not Mega Evolve into a KO it would otherwise survive', () => {
  // Under Trick Room Primarina moves first: Moonblast KOs a Fighting-type mega
  // that a Normal-type base Staraptor survives. The mega bonus is scaled by
  // survival like everything else, so the bot keeps the base form this turn.
  const [staraptor] = choose(scenario({ own: [STARAPTOR, KINGAMBIT], foes: [PRIMARINA, SINISTCHA], field: { pseudo: ['Trick Room'] }, canMega: [0], turn: 3 }));
  assert.ok(!/ mega/.test(staraptor), `Mega Evolving here walks into a Moonblast KO: ${staraptor}`);
});

test('team preview always brings a Mega Stone holder, and only one of two', () => {
  const foes = [FLUTTER, ROTOM, CORVIKNIGHT, TORKOAL, GARCHOMP, AMOONGUSS].map((f) => ({ ...f, bench: true }));
  // Two holders (slots 5 and 6): exactly one comes, chosen by matchup.
  const two = scenario({ own: [KINGAMBIT, INCINEROAR, AMOONGUSS, FARIGIRAF, STARAPTOR, SALAMENCE], foes, teamPreview: true });
  const picks = decide(two.req, two.view, dex).slice(5);
  assert.equal(['5', '6'].filter((k) => picks.includes(k)).length, 1, `expected exactly one of Staraptor / Salamence in ${picks}`);
  // A lone holder comes whatever it scores.
  const one = scenario({ own: [KINGAMBIT, INCINEROAR, AMOONGUSS, FARIGIRAF, LUCARIO, SALAMENCE], foes, teamPreview: true });
  assert.ok(decide(one.req, one.view, dex).slice(5).includes('6'), 'the only Mega Stone holder must be brought');
  const oneFirst = scenario({ own: [STARAPTOR, KINGAMBIT, INCINEROAR, AMOONGUSS, FARIGIRAF, LUCARIO], foes, teamPreview: true });
  assert.ok(decide(oneFirst.req, oneFirst.view, dex).slice(5).includes('1'), 'the only Mega Stone holder must be brought');
});
