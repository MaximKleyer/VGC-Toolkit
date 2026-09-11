// Dump mainline data for the Pokemon Regulation M-C added (2026-09-08) from the
// pokemon-showdown engine the sim/ sidecar already ships (no extra install).
//
//   node scripts/dump_mc_species.mjs > scripts/mc_species.json
//
// For each species (keyed by engine id): name, types, base stats, every
// ability (including the hidden one), weight, and its Gen 8 + Gen 9 learnset
// (own entries plus its pre-evolutions', the way Showdown's validator chains
// them; Champions keeps the Gen 8 TR moves SV dropped). Every move seen in
// those learnsets is dumped in moves.json's schema so add_mc_release.py can
// add the ones the Champions move pool lacks. `learners` lists, for a few
// moves whose availability changed in M-C, every roster species (toolkit id)
// whose mainline learnset has the move, so the release script can add Slash
// to the Pokemon that learn it.
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(new URL('../sim/package.json', import.meta.url));
const { Dex } = require('pokemon-showdown');
const dex = Dex.mod('gen9');
const toID = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const SPECIES = [
  'wigglytuff', 'persian', 'persianalola', 'farfetchd', 'farfetchdgalar', 'mrmime', 'mrmimegalar',
  'swalot', 'gogoat', 'cinderace', 'inteleon', 'thievul', 'toxtricity', 'toxtricitylowkey',
  'grapploct', 'perrserker', 'sirfetchd', 'pincurchin', 'indeedee', 'indeedeef', 'arboliva',
  'pawmot', 'squawkabilly', 'squawkabillyyellow', 'mabosstiff',
];
const LEARNER_MOVES = ['Slash', 'Milk Drink', 'Meteor Assault', 'Double Shock', 'Snipe Shot', 'Pound', 'Mirror Coat', 'Metal Burst'];

function mainlineLearnset(engineId) {
  const moves = new Set();
  let sp = dex.species.get(engineId);
  while (sp && sp.exists) {
    const data = dex.species.getLearnsetData(sp.id);
    for (const [move, sources] of Object.entries((data && data.learnset) || {})) {
      if (sources.some((s) => s.startsWith('9') || s.startsWith('8'))) moves.add(dex.moves.get(move).name);
    }
    // Cosmetic / battle-only formes share the base forme's learnset.
    if (!data?.learnset && sp.baseSpecies !== sp.name) { sp = dex.species.get(sp.baseSpecies); continue; }
    sp = sp.prevo ? dex.species.get(sp.prevo) : null;
  }
  return [...moves].sort();
}

const species = {};
const moves = {};
for (const engineId of SPECIES) {
  const sp = dex.species.get(engineId);
  if (!sp.exists) throw new Error(`unknown species ${engineId}`);
  const learnset = mainlineLearnset(engineId);
  species[engineId] = {
    engine_id: sp.id, name: sp.name, types: sp.types,
    base: { hp: sp.baseStats.hp, atk: sp.baseStats.atk, def: sp.baseStats.def,
            spa: sp.baseStats.spa, spd: sp.baseStats.spd, spe: sp.baseStats.spe },
    abilities: Object.values(sp.abilities), weight_kg: sp.weightkg, learnset,
  };
  for (const name of learnset) {
    if (moves[name]) continue;
    const m = dex.moves.get(name);
    moves[name] = {
      name: m.name, type: m.type, category: m.category, base_power: m.basePower,
      accuracy: m.accuracy === true ? null : m.accuracy, pp: m.pp, priority: m.priority,
      target: m.target, flags: m.flags, short_desc: m.shortDesc || m.desc || '',
    };
  }
}
for (const name of LEARNER_MOVES) {
  if (moves[name]) continue;
  const m = dex.moves.get(name);
  if (!m.exists) continue;
  moves[name] = {
    name: m.name, type: m.type, category: m.category, base_power: m.basePower,
    accuracy: m.accuracy === true ? null : m.accuracy, pp: m.pp, priority: m.priority,
    target: m.target, flags: m.flags, short_desc: m.shortDesc || m.desc || '',
  };
}

// Which roster species (toolkit ids, base forms only) learn each LEARNER_MOVES move.
const pokedex = JSON.parse(fs.readFileSync(new URL('../vgc_toolkit/data/pokedex.json', import.meta.url), 'utf8'));
const learners = Object.fromEntries(LEARNER_MOVES.map((m) => [m, []]));
const unresolved = [];
for (const [id, mon] of Object.entries(pokedex)) {
  if (mon.mega_of) continue;
  const candidates = [toID(mon.name), toID(id), toID(mon.name).replace(/^(.*?)(f|m)$/, '$1')];
  const sp = candidates.map((c) => dex.species.get(c)).find((s) => s.exists);
  if (!sp) { unresolved.push(id); continue; }
  const set = new Set(mainlineLearnset(sp.id));
  for (const m of LEARNER_MOVES) if (set.has(m)) learners[m].push(id);
}
for (const engineId of SPECIES) {
  const set = new Set(species[engineId].learnset);
  for (const m of LEARNER_MOVES) if (set.has(m)) learners[m].push(`engine:${engineId}`);
}

console.log(JSON.stringify({
  _note: 'Gen 8 + Gen 9 mainline data from the pokemon-showdown engine in sim/ (scripts/dump_mc_species.mjs) for the '
       + 'Regulation M-C additions of 2026-09-08. Consumed by scripts/add_mc_release.py; regenerate when the engine is updated.',
  species, moves, learners, unresolved,
}, null, 1));
