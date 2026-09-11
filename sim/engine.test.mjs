// Engine-level checks (need pokemon-showdown installed): the provisional M-C
// format validates the confirmed additions, and the confirmed-ability patch
// really changes battle outcomes. Run with `npm test` in sim/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ps from 'pokemon-showdown';
import { patchChampionsData, resolveFormat, normalizeTeam, validateTeam, SYNTHETIC_FORMATS, Battle } from './server.mjs';

const { Dex, Teams, BattleStream, getPlayerStreams } = ps;

const MC_PASTE = `Rillaboom @ Miracle Seed
Ability: Grassy Surge
Level: 50
EVs: 32 HP / 32 Atk / 2 Def
Adamant Nature
- Fake Out
- Grassy Glide
- Wood Hammer
- Knock Off

Golisopod-Mega @ Golisopodite
Ability: Emergency Exit
Level: 50
EVs: 32 HP / 32 Atk / 2 SpD
Brave Nature
- First Impression
- Iron Head
- Close Combat
- Protect

Absol-Mega-Z @ Absolite Z
Ability: Sharpness
Level: 50
EVs: 4 HP / 32 Atk / 30 Spe
Jolly Nature
- Night Slash
- Sucker Punch
- Protect
- Swords Dance

Salamence-Mega @ Salamencite
Ability: Aerilate
Level: 50
EVs: 4 HP / 32 Atk / 30 Spe
Jolly Nature
- Double-Edge
- Dragon Claw
- Tailwind
- Protect

Baxcalibur-Mega @ Baxcaliburite
Ability: Thermal Exchange
Level: 50
EVs: 32 HP / 32 Atk / 2 SpD
Adamant Nature
- Glaive Rush
- Icicle Crash
- Ice Shard
- Protect

Lucario-Mega-Z @ Lucarionite Z
Ability: Aura Guard
Level: 50
EVs: 4 HP / 32 SpA / 30 Spe
Timid Nature
- Aura Sphere
- Flash Cannon
- Vacuum Wave
- Protect
`;

test('confirmed M-C abilities are patched into the champions mod', () => {
  patchChampionsData();
  const dex = Dex.mod('champions');
  assert.equal(dex.abilities.get('Aura Guard').exists, true);
  assert.equal(dex.species.get('Lucario-Mega-Z').abilities[0], 'Aura Guard');
  assert.equal(dex.species.get('Absol-Mega-Z').abilities[0], 'Sharpness');
  assert.equal(dex.species.get('Garchomp-Mega-Z').abilities[0], 'Levitate');
});

test('the provisional M-C format validates a team of the ten additions', () => {
  patchChampionsData();
  const fid = 'gen9championsvgc2026regmc';
  assert.ok(SYNTHETIC_FORMATS[fid]);
  assert.equal(resolveFormat(fid), 'gen9championsvgc2026regmb@@@!Obtainable');
  // The sidecar aliases the two stone spellings before import; mirror that here.
  const team = Teams.import(MC_PASTE.replace('Golisopodite', 'Golisopite').replace('Baxcaliburite', 'Baxcalibrite'));
  assert.equal(team.length, 6);
  assert.deepEqual(normalizeTeam(team, fid), []);
  assert.deepEqual(team.map((s) => s.species), ['Rillaboom', 'Golisopod', 'Absol', 'Salamence', 'Baxcalibur', 'Lucario']);
  assert.equal(validateTeam(fid, team), null, 'provisional M-C should accept the additions');
  assert.ok(validateTeam('gen9championsvgc2026regmb', team), 'plain M-B must still reject them');
});

const MC_RELEASE_PASTE = `Sirfetch'd @ Leek
Ability: Scrappy
Level: 50
EVs: 32 HP / 32 Atk / 2 SpD
Adamant Nature
- Meteor Assault
- Close Combat
- Brave Bird
- Protect

Pawmot @ Air Balloon
Ability: Iron Fist
Level: 50
EVs: 2 HP / 32 Atk / 32 Spe
Jolly Nature
- Double Shock
- Close Combat
- Revival Blessing
- Protect

Toxtricity @ Normal Gem
Ability: Punk Rock
Level: 50
EVs: 2 HP / 32 SpA / 32 Spe
Timid Nature
- Overdrive
- Boomburst
- Shift Gear
- Protect

Indeedee-F @ Psychic Seed
Ability: Psychic Surge
Level: 50
EVs: 32 HP / 32 SpD / 2 Spe
Calm Nature
- Follow Me
- Expanding Force
- Helping Hand
- Protect

Perrserker @ Rocky Helmet
Ability: Steely Spirit
Level: 50
EVs: 32 HP / 32 Atk / 2 Def
Adamant Nature
- Iron Head
- Slash
- Fake Out
- Protect

Gogoat @ Terrain Extender
Ability: Grass Pelt
Level: 50
EVs: 32 HP / 32 Atk / 2 SpD
Adamant Nature
- Horn Leech
- Milk Drink
- Bulk Up
- Protect
`;

test('the provisional M-C format validates the release Pokémon and items', () => {
  patchChampionsData();
  const fid = 'gen9championsvgc2026regmc';
  const team = Teams.import(MC_RELEASE_PASTE);
  assert.equal(team.length, 6);
  assert.deepEqual(normalizeTeam(team, fid), []);
  assert.deepEqual(team.map((s) => s.item), ['Leek', 'Air Balloon', 'Normal Gem', 'Psychic Seed', 'Rocky Helmet', 'Terrain Extender']);
  assert.equal(validateTeam(fid, team), null, 'provisional M-C should accept the release');
  assert.ok(validateTeam('gen9championsvgc2026regmb', team), 'plain M-B must still reject them');
  assert.equal(SYNTHETIC_FORMATS.gen9championsvgc2026regmcexp, undefined, 'the experimental format is gone');
});

test('the M-C move and ability changes are patched into the engine', () => {
  patchChampionsData();
  const dex = Dex.mod('champions');
  assert.equal(dex.moves.get('Slash').basePower, 80);
  assert.equal(dex.moves.get('Meteor Assault').basePower, 170);
  assert.equal(dex.moves.get('Snipe Shot').basePower, 85);
  assert.equal(dex.moves.get('Double Shock').flags.punch, 1);
  assert.equal(dex.moves.get('Wish').pp, 8);
  assert.equal(dex.moves.get('Strength Sap').pp, 8);
  assert.equal(dex.moves.get('Milk Drink').target, 'adjacentAllyOrSelf');
  assert.equal(dex.moves.get('Close Combat').basePower, 120, 'other moves untouched');
  assert.equal(dex.species.get('Golisopod-Mega').abilities[0], 'Tough Claws');
  assert.equal(dex.species.get('Baxcalibur-Mega').abilities[0], 'Thermal Exchange');
  assert.equal(dex.species.get('Salamence-Mega').abilities[0], 'Aerilate');
  assert.equal(typeof dex.abilities.get('Run Away').onTrapPokemon, 'function');
});

// Psychic Surge starts the terrain on entry and the Psychic Seed pops; Pawmot's
// Air Balloon makes it float over Garchomp's Earthquake (a doubles choice needs
// the target: "move 1 1").
test('Psychic Surge, a Seed and Air Balloon work in a real doubles battle', async () => {
  const p1 = Teams.import(`Indeedee-F @ Psychic Seed\nAbility: Psychic Surge\nLevel: 50\n- Follow Me\n- Protect\n\nPawmot @ Air Balloon\nAbility: Volt Absorb\nLevel: 50\n- Close Combat\n`);
  const p2 = Teams.import(`Kingambit @ Black Glasses\nAbility: Defiant\nLevel: 50\n- Protect\n\nGarchomp @ Life Orb\nAbility: Rough Skin\nLevel: 50\n- Earthquake\n`);
  const stream = new BattleStream();
  const streams = getPlayerStreams(stream);
  const spec = { formatid: 'gen9championsdoublescustomgame', seed: [4, 3, 2, 1] };
  streams.omniscient.write(`>start ${JSON.stringify(spec)}\n>player p1 ${JSON.stringify({ name: 'A', team: Teams.pack(p1) })}\n>player p2 ${JSON.stringify({ name: 'B', team: Teams.pack(p2) })}`);
  const seen = [];
  let done = false;
  const timer = setTimeout(() => { done = true; stream.destroy(); }, 15000);   // never hang the suite
  for await (const chunk of streams.omniscient) {
    for (const line of chunk.split('\n')) {
      seen.push(line);
      if (line.startsWith('|teampreview')) streams.omniscient.write('>p1 team 12\n>p2 team 12');
      if (line === '|turn|1') streams.omniscient.write('>p1 move 1, move 1 1\n>p2 move 1, move 1');
      if (line === '|turn|2' || line.startsWith('|win|') || line.startsWith('|error|')) done = true;
    }
    if (done) { stream.destroy(); break; }
  }
  clearTimeout(timer);
  assert.ok(!seen.some((l) => l.startsWith('|error|')), seen.filter((l) => l.startsWith('|error|')).join(' ; '));
  assert.ok(seen.includes('|turn|2'), `battle did not reach turn 2: ${seen.slice(-12).join(' ; ')}`);
  assert.ok(seen.some((l) => l.startsWith('|-fieldstart|move: Psychic Terrain')), 'Psychic Surge set the terrain');
  assert.ok(seen.some((l) => l.startsWith('|-enditem|p1a: Indeedee|Psychic Seed')), 'the Psychic Seed popped on the terrain');
  assert.ok(seen.some((l) => /\|-immune\|p1b: Pawmot/.test(l)), `Air Balloon floated over Earthquake: ${seen.filter((l) => /Pawmot/.test(l)).join(' ; ')}`);
});

// Play turn 1 of a fixed-seed 1v1 and return the damage Lucario took.
async function kowtowIntoLucario(seed) {
  const p1 = Teams.import(`Lucario @ Lucarionite Z\nAbility: Inner Focus\nLevel: 50\nEVs: 32 HP / 32 Def\nBold Nature\n- Swords Dance\n- Protect\n`);
  const p2 = Teams.import(`Kingambit @ Black Glasses\nAbility: Defiant\nLevel: 50\nEVs: 32 Atk\nAdamant Nature\n- Kowtow Cleave\n`);
  const stream = new BattleStream();
  const streams = getPlayerStreams(stream);
  const spec = { formatid: 'gen9championscustomgame', seed };   // custom game: no legality checks
  streams.omniscient.write(`>start ${JSON.stringify(spec)}\n>player p1 ${JSON.stringify({ name: 'L', team: Teams.pack(p1) })}\n>player p2 ${JSON.stringify({ name: 'K', team: Teams.pack(p2) })}`);
  let damage = null; let species = null;
  for await (const chunk of streams.omniscient) {
    for (const line of chunk.split('\n')) {
      if (line.startsWith('|teampreview')) streams.omniscient.write('>p1 team 1\n>p2 team 1');
      if (line === '|turn|1') streams.omniscient.write('>p1 move 1 mega\n>p2 move 1');
      if (line.startsWith('|detailschange|p1a')) species = line.split('|')[3].split(',')[0];
      if (line.startsWith('|-damage|p1a: Lucario|')) {
        const [hp, max] = line.split('|')[3].split(' ')[0].split('/').map(Number);
        damage = max - hp;
      }
      if (line === '|turn|2' || line.startsWith('|win|')) { stream.destroy(); return { damage, species }; }
    }
  }
  return { damage, species };
}

test('Aura Guard halves a contact hit in a real battle', async () => {
  const seed = [11, 22, 33, 44];
  patchChampionsData();
  const guarded = await kowtowIntoLucario(seed);
  assert.equal(guarded.species, 'Lucario-Mega-Z');
  assert.ok(guarded.damage > 0);
  // Same seed, ability reverted -> roughly double the damage.
  const dex = Dex.mod('champions');
  dex.data.Pokedex.lucariomegaz.abilities = { 0: 'Adaptability' };
  dex.species.speciesCache?.clear?.();
  const plain = await kowtowIntoLucario(seed);
  patchChampionsData();
  assert.ok(plain.damage > guarded.damage * 1.8 && plain.damage < guarded.damage * 2.2,
    `expected ~2x: guarded=${guarded.damage} plain=${plain.damage}`);
});

test('Mega Floette normalises to the legal Floette-Eternal base forme', () => {
  const team = Teams.import(`Floette-Eternal-Mega @ Floettite
Ability: Fairy Aura
Level: 50
Timid Nature
- Protect
- Dazzling Gleam
- Moonblast
- Light of Ruin
`);
  assert.equal(team[0].species, 'Floette-Mega');
  assert.deepEqual(normalizeTeam(team, 'gen9championsvgc2026regmb'), []);
  assert.equal(team[0].species, 'Floette-Eternal');
  assert.equal(team[0].item, 'Floettite');
  const problems = (validateTeam('gen9championsvgc2026regmb', team) || []).filter((x) => !/^You must bring/.test(x));
  assert.deepEqual(problems, []);
});

test('ability overrides from the toolkit patch the engine (Mega Golisopod)', () => {
  patchChampionsData({ 'golisopod-mega': ['Battle Armor'], 'no-such-mon': ['Levitate'], 'baxcalibur-mega': ['Not An Ability'] });
  const dex = Dex.mod('champions');
  assert.equal(dex.species.get('Golisopod-Mega').abilities[0], 'Battle Armor');
  assert.equal(dex.species.get('Baxcalibur-Mega').abilities[0], 'Thermal Exchange', 'an ability the engine does not know leaves its data alone');
  assert.equal(dex.species.get('Golisopod').abilities[0], 'Emergency Exit', 'the base form is untouched');
  assert.equal(dex.species.get('Lucario-Mega-Z').abilities[0], 'Aura Guard', 'confirmed fixes still apply');
  patchChampionsData();   // back to the committed overrides file
});

test('a mega set keeps a base-form ability until it Mega Evolves', () => {
  const team = Teams.import(`Staraptor-Mega @ Staraptite
Ability: Contrary
Level: 50
Jolly Nature
- Brave Bird
- Close Combat
- Tailwind
- Protect
`);
  assert.deepEqual(normalizeTeam(team, 'gen9championsvgc2026regmb'), []);
  assert.equal(team[0].species, 'Staraptor');
  assert.equal(team[0].ability, 'Intimidate', 'the mega ability is not the base form\'s: use its first ability');
  assert.equal(validateTeam('gen9championsvgc2026regmb', team).filter((x) => !/^You must bring/.test(x)).length, 0);
  const same = Teams.import(`Golisopod-Mega @ Golisopite
Ability: Emergency Exit
Level: 50
- Protect
`);
  normalizeTeam(same, 'gen9championsvgc2026regmc');
  assert.equal(same[0].ability, 'Emergency Exit', 'an ability the base form has is kept');
});

// Turn 1 of a fixed-seed 1v1 in which p1 Mega Evolves; the engine's own view of p1's active Pokémon afterwards.
async function megaTurnOne(paste, seed = [5, 6, 7, 8]) {
  const p1 = Teams.import(paste);
  normalizeTeam(p1, 'gen9championsvgc2026regmc');
  const p2 = Teams.import(`Amoonguss @ Rocky Helmet\nAbility: Regenerator\nLevel: 50\n- Protect\n`);
  const stream = new BattleStream();
  const streams = getPlayerStreams(stream);
  const spec = { formatid: 'gen9championscustomgame', seed };
  streams.omniscient.write(`>start ${JSON.stringify(spec)}\n>player p1 ${JSON.stringify({ name: 'A', team: Teams.pack(p1) })}\n>player p2 ${JSON.stringify({ name: 'B', team: Teams.pack(p2) })}`);
  for await (const chunk of streams.omniscient) {
    for (const line of chunk.split('\n')) {
      if (line.startsWith('|teampreview')) streams.omniscient.write('>p1 team 1\n>p2 team 1');
      if (line === '|turn|1') streams.omniscient.write('>p1 move 1 mega\n>p2 move 1');
      if (line === '|turn|2' || line.startsWith('|win|')) {
        const mon = stream.battle.p1.active[0];
        const out = { species: mon.species.name, ability: mon.ability, set: p1[0] };
        stream.destroy();
        return out;
      }
    }
  }
  return null;
}

test('Mega Golisopod fights with the toolkit-chosen ability once it has evolved', async () => {
  patchChampionsData({ 'golisopod-mega': ['Battle Armor'] });
  const r = await megaTurnOne(`Golisopod-Mega @ Golisopite\nAbility: Battle Armor\nLevel: 50\nBrave Nature\n- Iron Head\n- Protect\n`);
  assert.equal(r.set.ability, 'Emergency Exit', 'brought as the base form with its own ability');
  assert.equal(r.species, 'Golisopod-Mega');
  assert.equal(r.ability, 'battlearmor');
  patchChampionsData();
});

// The rule the Battle tab's replacement screen follows: with two slots emptied
// and one Pokémon left, the legal choice is "switch N, pass"; naming the same
// Pokémon twice is what used to produce "can only switch in once".
test('forced replacements with one Pokémon left are "switch N, pass"', async () => {
  const boom = (species) => ({ species, item: 'Sitrus Berry', ability: 'Inner Focus', level: 50, moves: ['Explosion'] });
  const wall = (species) => ({ species, item: 'Leftovers', ability: 'Thick Fat', level: 50, moves: ['Protect'] });
  const p1 = [boom('Glalie'), boom('Golem'), { species: 'Kingambit', item: 'Black Glasses', ability: 'Defiant', level: 50, moves: ['Iron Head'] }];
  const p2 = [wall('Snorlax'), wall('Blissey'), wall('Chansey'), wall('Wobbuffet')];
  const battle = new Battle({ format: 'gen9championsdoublescustomgame', p1: { name: 'A', team: p1 }, p2: { name: 'B', team: p2 }, bot: 'default', seed: [1, 2, 3, 4] });
  await battle.nextEvent(5000);
  if (battle.state.request?.teamPreview) await battle.choose('team 123');   // bring all three
  assert.ok(battle.state.request?.active, `expected a move request: ${JSON.stringify(battle.state.request)}`);
  await battle.choose('move 1, move 1');                      // both explode into a double Protect
  assert.deepEqual(battle.state.request?.forceSwitch, [true, true], JSON.stringify(battle.state.request));
  const twice = await battle.choose('switch 3, switch 3');
  assert.equal(twice.ok, false);
  assert.match(battle.state.errors.at(-1), /can only switch in once/);
  const pass = await battle.choose('switch 3, pass');
  assert.equal(pass.ok, true, battle.state.errors.join(' | '));
  assert.equal(battle.state.sides.p1.active[0]?.species, 'Kingambit');
  assert.equal(battle.state.sides.p1.active[1]?.fainted, true, 'the passed slot stays empty (its fainted occupant is shown greyed out)');
});
