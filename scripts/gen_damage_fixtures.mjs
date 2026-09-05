// Generate reference damage fixtures with @smogon/calc, using stat/type
// overrides from the toolkit's own pokedex so both engines see identical
// inputs and we verify pure MECHANICS, not data.
import { calculate, Generations, Pokemon, Move, Field } from '@smogon/calc';
import { readFileSync, writeFileSync } from 'fs';

const gen = Generations.get(9);
const dex = JSON.parse(readFileSync('/home/claude/vgc-toolkit/vgc_toolkit/data/pokedex.json'));
const movedb = JSON.parse(readFileSync('/home/claude/vgc-toolkit/vgc_toolkit/data/moves.json'));

function mon(id, opts = {}) {
  const m = dex[id];
  const evs = {};
  for (const [k, v] of Object.entries(opts.sp || {})) evs[k] = v * 8;
  return new Pokemon(gen, 'Arcanine', {   // placeholder species, fully overridden
    level: 50,
    overrides: { baseStats: m.base, types: m.types },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    evs,
    nature: opts.nature || 'Serious',
    ability: opts.ability || 'Pressure',  // neutral unless specified
    item: opts.item,
    status: opts.status || '',
    boosts: opts.boosts || {},
    curHP: opts.curHPFraction !== undefined ? undefined : undefined,
  });
}

function mv(name, opts = {}) {
  const md = movedb[name];
  // Real move name so name-keyed mechanics (Body Press, Psyshock, Foul Play,
  // spread targeting) fire; overrides pin OUR data values for the numbers.
  return new Move(gen, name, {
    overrides: { basePower: md.base_power, type: md.type, category: md.category,
                 target: md.target, flags: md.flags || {} },
    isCrit: opts.crit || false,
  });
}

const cases = [];
function run(label, aId, aOpts, dId, dOpts, moveName, mOpts = {}, fOpts = {}) {
  const a = mon(aId, aOpts), d = mon(dId, dOpts);
  const f = new Field({
    gameType: 'Doubles',
    weather: fOpts.weather,
    terrain: fOpts.terrain,
    defenderSide: { isReflect: !!fOpts.reflect, isLightScreen: !!fOpts.lightScreen,
                    isFriendGuard: !!fOpts.friendGuard },
    attackerSide: { isHelpingHand: !!fOpts.helpingHand },
  });
  const r = calculate(gen, a, d, mv(moveName, mOpts), f);
  const rolls = Array.isArray(r.damage) ? r.damage : [r.damage];
  cases.push({ label, attacker: aId, attacker_opts: aOpts, defender: dId,
               defender_opts: dOpts, move: moveName, move_opts: mOpts,
               field: fOpts, expected_rolls: rolls });
}

// Real Champions matchups — mechanics coverage matrix
run('basic STAB special', 'charizard-mega-y', {sp:{spa:32}, nature:'Modest'},
    'kingambit', {sp:{hp:32}}, 'Heat Wave');
run('spread + sun', 'charizard-mega-y', {sp:{spa:32}, nature:'Modest'},
    'kingambit', {sp:{hp:32}}, 'Heat Wave', {spread:true}, {weather:'Sun'});
run('rain boosted water', 'politoed', {sp:{spa:32}, nature:'Modest'},
    'charizard-mega-y', {sp:{hp:4}}, 'Surf', {spread:true}, {weather:'Rain'});
run('physical + burn', 'kingambit', {sp:{atk:32}, nature:'Adamant', status:'brn'},
    'skarmory-mega', {sp:{hp:32, def:16}}, 'Kowtow Cleave');
run('crit ignores screens', 'kingambit', {sp:{atk:32}}, 'amoonguss' in dex ? 'clefable' : 'clefable',
    {sp:{hp:32}}, 'Iron Head', {crit:true}, {reflect:true});
run('reflect halves physical', 'kingambit', {sp:{atk:32}},
    'clefable', {sp:{hp:32}}, 'Iron Head', {}, {reflect:true});
run('adaptability stab', 'beedrill-mega', {sp:{atk:32}, nature:'Jolly', ability:'Adaptability'},
    'gardevoir', {sp:{hp:4}}, 'Poison Jab');
run('huge power', 'starmie-mega', {sp:{atk:32}, ability:'Huge Power'},
    'kingambit', {sp:{hp:32}}, 'Waterfall');
run('multiscale full hp', 'dragapult', {sp:{spa:32}, nature:'Timid'},
    'dragonite-mega', {sp:{hp:32}, ability:'Multiscale'}, 'Shadow Ball');
run('type boost item', 'golurk-mega', {sp:{atk:32}, nature:'Adamant', item:'Soft Sand'},
    'kingambit', {sp:{hp:32}}, 'Earthquake', {spread:true});
run('resist berry', 'charizard-mega-y', {sp:{spa:32}, nature:'Modest'},
    'kingambit', {sp:{hp:32}, item:'Occa Berry'}, 'Heat Wave');
run('stat stages', 'kingambit', {sp:{atk:32}, boosts:{atk:2}},
    'clefable', {sp:{hp:32}, boosts:{def:1}}, 'Iron Head');
run('body press', 'skarmory-mega', {sp:{def:32}, nature:'Impish'},
    'kingambit', {sp:{hp:32}}, 'Body Press');
run('psyshock hits def', 'gardevoir', {sp:{spa:32}, nature:'Modest'},
    'primarina', {sp:{hp:32, spd:32}, nature:'Calm'}, 'Psyshock');
run('foul play', 'sableye', {sp:{}}, 'kingambit', {sp:{hp:32, atk:32}, nature:'Adamant'},
    'Foul Play');
run('thick fat halves', 'charizard-mega-y', {sp:{spa:32}, nature:'Modest'},
    'venusaur-mega', {sp:{hp:32}, ability:'Thick Fat'}, 'Heat Wave');
run('snow def boost', 'kingambit', {sp:{atk:32}, nature:'Adamant'},
    'froslass-mega', {sp:{hp:32}}, 'Iron Head', {}, {weather:'Snow'});
run('friend guard + filter', 'dragapult', {sp:{spa:32}},
    'tyranitar-mega', {sp:{hp:32}, ability:'Filter'}, 'Draco Meteor', {}, {friendGuard:true});

writeFileSync('/home/claude/vgc-toolkit/tests/fixtures_damage.json', JSON.stringify(cases, null, 1));
console.log(cases.length, 'fixtures written');
for (const c of cases) console.log(' ', c.label, '->', c.expected_rolls[0], '-', c.expected_rolls[15]);
