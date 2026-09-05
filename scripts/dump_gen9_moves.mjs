import { Dex } from '@pkmn/dex';
const gen9 = Dex.forGen(9);
const out = {};
for (const move of gen9.moves.all()) {
  out[move.name] = {
    name: move.name, type: move.type, category: move.category,
    base_power: move.basePower, accuracy: move.accuracy === true ? null : move.accuracy,
    pp: move.pp, priority: move.priority, target: move.target,
    flags: move.flags, short_desc: move.shortDesc || move.desc || '',
  };
}
console.log(JSON.stringify(out));
