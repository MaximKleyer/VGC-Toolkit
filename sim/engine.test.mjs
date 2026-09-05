// Engine-level checks (need pokemon-showdown installed): the provisional M-C
// format validates the confirmed additions, and the confirmed-ability patch
// really changes battle outcomes. Run with `npm test` in sim/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ps from 'pokemon-showdown';
import { patchChampionsData, resolveFormat, normalizeTeam, validateTeam, SYNTHETIC_FORMATS } from './server.mjs';

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
