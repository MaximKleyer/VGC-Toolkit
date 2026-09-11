// Practice bot for the Showdown sidecar ("smart" mode).
//
// A one-turn look-ahead evaluator built on the engine's own data (Dex) and a
// compact Gen 9 damage estimate. It is deliberately *fair*: it only uses what a
// player sees under Open Team Sheets — the foe's species / items / abilities /
// moves, HP percentages, visible boosts and statuses, weather / terrain / side
// conditions and the turn history (Protect streaks, moves attempted). Its own
// side it knows exactly (the engine's request), like any player.
//
// Per move request it enumerates every legal action for each of its slots
// (move x target, Mega Evolution, switches), scores single actions (expected
// damage as a fraction of the target's HP, a KO premium, secondary effects,
// hand-written values for status moves) and then scores every PAIR of actions
// jointly: overkill on a shared target, spread moves hitting its own partner,
// Helping Hand / Follow Me / Fake Out synergy, and the damage it expects to
// take back this turn from the foes still standing (Protect, Wide Guard and
// redirection reduce that; KOs and flinches deny it). Consecutive Protect odds
// (1, 1/3, 1/9, ...) are part of that model, for its own Protect and the foe's.
import { toID, speciesFromDetails } from './protocol.mjs';

const LEVEL = 50;
const KO_BONUS = 0.45;        // premium for removing a foe, on top of the HP fraction
const OWN_KO_COST = 0.5;      // extra cost of losing one of ours
const INCOMING_WEIGHT = 0.85; // how much expected damage taken counts against a plan
const TEMPO_PROTECT = 0.08;   // a protecting Pokémon does nothing else this turn
const TEMPO_SWITCH = 0.25;
// A Mega Evolution's stat gain lasts the whole battle; a one-turn evaluator only
// sees this turn's damage. 0.3 is the smallest value at which Mega Staraptor still
// evolves into a Psychic user (Farigiraf) while a Trick-Room Moonblast KO stays refused.
const MEGA_BONUS = 0.3;
const SECOND_MEGA_PENALTY = 0.5; // team preview: a second Mega Stone holder usually stays home (only one can evolve)

// ---------------------------------------------------------------- tables
export const PROTECT_MOVES = new Set(['protect', 'detect', 'spikyshield', 'banefulbunker', 'kingsshield',
  'obstruct', 'silktrap', 'burningbulwark', 'maxguard', 'matblock']);
const TYPE_ITEMS = {
  charcoal: 'Fire', mysticwater: 'Water', magnet: 'Electric', miracleseed: 'Grass', nevermeltice: 'Ice',
  blackbelt: 'Fighting', poisonbarb: 'Poison', softsand: 'Ground', sharpbeak: 'Flying', twistedspoon: 'Psychic',
  silverpowder: 'Bug', hardstone: 'Rock', spelltag: 'Ghost', dragonfang: 'Dragon', blackglasses: 'Dark',
  metalcoat: 'Steel', silkscarf: 'Normal', fairyfeather: 'Fairy', oddincense: 'Psychic', seaincense: 'Water',
  roseincense: 'Grass', rockincense: 'Rock', waveincense: 'Water',
  flameplate: 'Fire', splashplate: 'Water', zapplate: 'Electric', meadowplate: 'Grass', icicleplate: 'Ice',
  fistplate: 'Fighting', toxicplate: 'Poison', earthplate: 'Ground', skyplate: 'Flying', mindplate: 'Psychic',
  insectplate: 'Bug', stoneplate: 'Rock', spookyplate: 'Ghost', dracoplate: 'Dragon', dreadplate: 'Dark',
  ironplate: 'Steel', pixieplate: 'Fairy',
};
const RESIST_BERRY = {
  occaberry: 'Fire', passhoberry: 'Water', wacanberry: 'Electric', rindoberry: 'Grass', yacheberry: 'Ice',
  chopleberry: 'Fighting', kebiaberry: 'Poison', shucaberry: 'Ground', cobaberry: 'Flying', payapaberry: 'Psychic',
  tangaberry: 'Bug', chartiberry: 'Rock', kasibberry: 'Ghost', habanberry: 'Dragon', colburberry: 'Dark',
  babiriberry: 'Steel', chilanberry: 'Normal', roseliberry: 'Fairy',
};
const ATE = { aerilate: 'Flying', pixilate: 'Fairy', refrigerate: 'Ice', galvanize: 'Electric' };
const ATE_EXEMPT = new Set(['naturalgift', 'judgment', 'multiattack', 'weatherball', 'revelationdance',
  'technoblast', 'terrainpulse', 'hiddenpower', 'struggle', 'terablast']);
const WEATHER_BALL = { sunnyday: 'Fire', desolateland: 'Fire', raindance: 'Water', primordialsea: 'Water',
  sandstorm: 'Rock', snowscape: 'Ice', snow: 'Ice', hail: 'Ice' };
const TERRAIN_PULSE = { electricterrain: 'Electric', grassyterrain: 'Grass', psychicterrain: 'Psychic', mistyterrain: 'Fairy' };
const IVY_CUDGEL = { Wellspring: 'Water', Hearthflame: 'Fire', Cornerstone: 'Rock' };
const ABILITY_TYPE_IMMUNITY = { flashfire: 'Fire', wellbakedbody: 'Fire', waterabsorb: 'Water', dryskin: 'Water',
  stormdrain: 'Water', voltabsorb: 'Electric', lightningrod: 'Electric', motordrive: 'Electric', sapsipper: 'Grass',
  eartheater: 'Ground' };
const FLAG_IMMUNITY = { soundproof: 'sound', bulletproof: 'bullet', windrider: 'wind' };
const MOLD_BREAKER = new Set(['moldbreaker', 'teravolt', 'turboblaze']);
const PRIORITY_BLOCK = new Set(['dazzling', 'queenlymajesty', 'armortail']);
const FLINCH_IMMUNE = new Set(['innerfocus', 'shielddust']);
const STAT_DROP_IMMUNE = new Set(['clearbody', 'whitesmoke', 'fullmetalbody', 'mirrorarmor', 'contrary', 'defiant', 'competitive']);
const HEAL_HALF = new Set(['recover', 'roost', 'slackoff', 'softboiled', 'milkdrink', 'shoreup', 'moonlight',
  'morningsun', 'synthesis', 'healorder', 'strengthsap', 'wish', 'floralhealing', 'healpulse']);
const SPREAD_TARGETS = new Set(['allAdjacentFoes', 'allAdjacent']);
const NEEDS_TARGET = new Set(['normal', 'any', 'adjacentFoe', 'adjacentAlly', 'adjacentAllyOrSelf']);
const FOE_TARGETS = new Set(['normal', 'any', 'adjacentFoe']);

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const boostMult = (n) => (n >= 0 ? (2 + n) / 2 : 2 / (2 - n));
const accMult = (n) => (n >= 0 ? (3 + n) / 3 : 3 / (3 - n));
const isRain = (w) => w === 'raindance' || w === 'primordialsea';
const isSun = (w) => w === 'sunnyday' || w === 'desolateland';
const isSnow = (w) => w === 'snowscape' || w === 'snow' || w === 'hail';
const other = (side) => (side === 'p1' ? 'p2' : 'p1');

// ---------------------------------------------------------------- stats
function calcStat(base, ev, nature = 1, iv = 31) {
  return Math.floor((Math.floor((2 * base + iv + Math.floor(ev / 4)) * LEVEL / 100) + 5) * nature);
}
function calcHP(base, ev, iv = 31) {
  if (base === 1) return 1;
  return Math.floor((2 * base + iv + Math.floor(ev / 4)) * LEVEL / 100) + LEVEL + 10;
}

/** Unknown spread: bulk in HP, full investment in the main attacking stat, some Speed. */
export function estimateStats(species, moves = []) {
  const bs = species.baseStats || { hp: 80, atk: 80, def: 80, spa: 80, spd: 80, spe: 80 };
  const phys = moves.filter((m) => m.category === 'Physical').length;
  const spec = moves.filter((m) => m.category === 'Special').length;
  const main = phys === spec ? (bs.atk >= bs.spa ? 'atk' : 'spa') : (phys > spec ? 'atk' : 'spa');
  return {
    hp: calcHP(bs.hp, 252),
    atk: calcStat(bs.atk, main === 'atk' ? 252 : 0, main === 'atk' ? 1.1 : 1),
    def: calcStat(bs.def, 36),
    spa: calcStat(bs.spa, main === 'spa' ? 252 : 0, main === 'spa' ? 1.1 : 1),
    spd: calcStat(bs.spd, 36),
    spe: calcStat(bs.spe, 196),
  };
}

// ---------------------------------------------------------------- fighters
/** Normalised battler: species data, (estimated or exact) stats, HP fraction, volatile state. */
export function makeFighter(dex, o) {
  const sp = dex.species.get(o.species);
  const moves = (o.moves || []).map((m) => dex.moves.get(m)).filter((m) => m.exists);
  const est = estimateStats(sp, moves);
  const exact = !!o.stats;
  const stats = exact
    ? { hp: o.maxhp || est.hp, atk: o.stats.atk, def: o.stats.def, spa: o.stats.spa, spd: o.stats.spd, spe: o.stats.spe }
    : est;
  const maxhp = exact ? (o.maxhp || est.hp) : est.hp;          // foes only report percentages
  const hpFrac = o.fainted ? 0 : o.maxhp ? clamp((o.hp ?? o.maxhp) / o.maxhp, 0, 1) : 1;
  let ability = toID(o.ability);
  if (sp.exists && (sp.isMega || !ability)) ability = toID(sp.abilities[0]);
  return {
    species: sp, types: sp.exists ? sp.types : ['Normal'], weight: (sp.weightkg || 50) * weightMult(ability), stats, maxhp, hpFrac,
    status: o.status && o.status !== 'fnt' ? o.status : null, boosts: o.boosts || {}, item: toID(o.item),
    ability, moves, side: o.side, slot: o.slot ?? null, index: o.index ?? null,
    protectStreak: o.protectStreak || 0, moveActions: o.moveActions || 0, lastMove: o.lastMove || null,
    fainted: !!o.fainted, exact,
  };
}

function sheetFor(view, sideId, speciesName, dex) {
  const sp = dex.species.get(speciesName);
  const sheet = view.sides[sideId]?.sheet || [];
  const id = toID(sp.exists ? sp.name : speciesName);
  const base = toID(sp.exists ? sp.baseSpecies : speciesName);
  return sheet.find((s) => toID(s.species) === id)
    || sheet.find((s) => toID(dex.species.get(s.species).baseSpecies) === base) || null;
}

/** One of our own Pokémon (index into the request's side.pokemon; actives come first, in slot order). */
function ownFighter(dex, view, sideId, index) {
  const p = view.sides[sideId].pokemon[index];
  if (!p) return null;
  const act = p.active ? view.sides[sideId].active[index] : null;
  return makeFighter(dex, {
    species: speciesFromDetails(p.details), hp: p.hp, maxhp: p.maxhp, status: p.status, boosts: act?.boosts,
    item: p.item, ability: p.ability, moves: p.moves, stats: p.stats, side: sideId, slot: p.active ? index : null,
    index, protectStreak: act?.protectStreak, moveActions: act?.moveActions ?? 0, lastMove: act?.lastMove,
    fainted: p.fainted,
  });
}

/** A foe's active Pokémon as seen from our side: percentages plus its Open Team Sheet entry. */
function foeFighter(dex, view, sideId, slot) {
  const m = view.sides[sideId].active[slot];
  if (!m || m.fainted) return null;
  const sheet = sheetFor(view, sideId, m.species, dex);
  const known = view.sides[sideId].known?.[m.species] || {};
  const item = m.item !== undefined ? m.item : known.item !== undefined ? known.item : (sheet?.item || '');
  const ability = m.ability || known.ability || sheet?.ability || '';
  const moves = sheet?.moves?.length ? sheet.moves : (known.moves || []);
  return makeFighter(dex, {
    species: m.species, hp: m.hp, maxhp: m.maxhp || 100, status: m.status, boosts: m.boosts, item, ability, moves,
    side: sideId, slot, protectStreak: m.protectStreak, moveActions: m.moveActions ?? 1, lastMove: m.lastMove,
  });
}

/** The foe's whole team from its sheet (or the preview species), for team preview / switch prediction. */
function foeTeam(dex, view, sideId) {
  const sheet = view.sides[sideId].sheet || [];
  if (sheet.length) {
    return sheet.map((s) => makeFighter(dex, { species: s.species, hp: 100, maxhp: 100, item: s.item, ability: s.ability, moves: s.moves, side: sideId }));
  }
  return (view.sides[sideId].preview || []).map((p) => makeFighter(dex, { species: p.species, hp: 100, maxhp: 100, side: sideId }));
}

function megaVariant(me, dex) {
  const item = dex.items.get(me.item);
  if (!item.exists || !item.megaStone) return null;
  const target = typeof item.megaStone === 'string' ? item.megaStone
    : (item.megaStone[me.species.baseSpecies] || item.megaStone[me.species.name] || Object.values(item.megaStone)[0]);
  const mega = dex.species.get(target);
  if (!mega.exists || mega.name === me.species.name) return null;
  const stats = { ...me.stats };
  for (const k of ['atk', 'def', 'spa', 'spd', 'spe']) {
    stats[k] = Math.max(1, stats[k] + (mega.baseStats[k] - me.species.baseStats[k]));
  }
  const ability = toID(mega.abilities[0]);
  return { ...me, species: mega, types: mega.types, ability, stats, weight: (mega.weightkg || me.weight) * weightMult(ability), megaOf: me };
}

// ---------------------------------------------------------------- field
export function buildCtx(view, dex) {
  const pseudo = (view.field?.pseudo || []).map(toID);
  return {
    dex, weather: toID(view.field?.weather), terrain: toID(view.field?.terrain),
    trickroom: pseudo.includes('trickroom'), gravity: pseudo.includes('gravity'),
    conds: { p1: (view.sides.p1.conditions || []).map(toID), p2: (view.sides.p2.conditions || []).map(toID) },
    turn: view.turn || 0,
  };
}

function isGrounded(f, ctx) {
  if (ctx.gravity || f.item === 'ironball') return true;
  if (f.types.includes('Flying') || f.ability === 'levitate' || f.ability === 'eelevate' || f.item === 'airballoon') return false;
  return true;
}

function highestStat(f) {
  let best = 'atk';
  for (const k of ['atk', 'def', 'spa', 'spd', 'spe']) if (f.stats[k] > f.stats[best]) best = k;
  return best;
}

export function speedOf(f, ctx) {
  let s = f.stats.spe * boostMult(f.boosts.spe || 0);
  if (f.item === 'choicescarf') s *= 1.5;
  else if (f.item === 'ironball') s *= 0.5;
  const w = ctx.weather;
  if ((f.ability === 'swiftswim' && isRain(w)) || (f.ability === 'chlorophyll' && isSun(w))
    || (f.ability === 'sandrush' && w === 'sandstorm') || (f.ability === 'slushrush' && isSnow(w))
    || (f.ability === 'surgesurfer' && ctx.terrain === 'electricterrain')) s *= 2;
  if (f.ability === 'quickfeet' && f.status) s *= 1.5;
  if ((f.ability === 'protosynthesis' || f.ability === 'quarkdrive') && f.item === 'boosterenergy' && highestStat(f) === 'spe') s *= 1.5;
  if (f.status === 'par' && f.ability !== 'quickfeet') s *= 0.5;
  if ((ctx.conds[f.side] || []).includes('tailwind')) s *= 2;
  return s;
}

/** P(a acts before b). Foe speeds are estimates, so near-ties are coin flips. */
export function movesFirst(a, b, ctx, prioA = 0, prioB = 0) {
  if (prioA !== prioB) return prioA > prioB ? 1 : 0;
  let sa = speedOf(a, ctx), sb = speedOf(b, ctx);
  if (ctx.trickroom) [sa, sb] = [sb, sa];
  const r = sa / Math.max(1, sb);
  if (r > 1.08) return 1;
  if (r < 1 / 1.08) return 0;
  return 0.5;
}

function movePriority(f, move, ctx) {
  let p = move.priority || 0;
  if (move.id === 'grassyglide' && ctx.terrain === 'grassyterrain' && isGrounded(f, ctx)) p += 1;
  if (f.ability === 'prankster' && move.category === 'Status') p += 1;
  if (f.ability === 'galewings' && move.type === 'Flying' && f.hpFrac >= 0.999) p += 1;
  if (f.ability === 'triage' && move.flags?.heal) p += 3;
  return p;
}

// ---------------------------------------------------------------- damage
function weightBP(kg) {
  return kg >= 200 ? 120 : kg >= 100 ? 100 : kg >= 50 ? 80 : kg >= 25 ? 60 : kg >= 10 ? 40 : 20;
}
// Heavy Metal doubles, Light Metal halves (Low Kick / Grass Knot / Heavy Slam / Heat Crash).
function weightMult(ability) {
  return ability === 'heavymetal' ? 2 : ability === 'lightmetal' ? 0.5 : 1;
}

function variableBasePower(move, att, def, ctx, opts) {
  const id = move.id;
  const bp = move.basePower;
  switch (id) {
    case 'lowkick': case 'grassknot': return weightBP(def.weight);
    case 'heavyslam': case 'heatcrash': {
      const r = att.weight / Math.max(0.1, def.weight);
      return r >= 5 ? 120 : r >= 4 ? 100 : r >= 3 ? 80 : r >= 2 ? 60 : 40;
    }
    case 'gyroball': return Math.min(150, Math.floor(25 * speedOf(def, ctx) / Math.max(1, speedOf(att, ctx))) + 1);
    case 'electroball': {
      const r = speedOf(att, ctx) / Math.max(1, speedOf(def, ctx));
      return r >= 4 ? 150 : r >= 3 ? 120 : r >= 2 ? 80 : r >= 1 ? 60 : 40;
    }
    case 'eruption': case 'waterspout': case 'dragonenergy': return Math.max(1, Math.floor(150 * att.hpFrac));
    case 'flail': case 'reversal': {
      const p = att.hpFrac;
      return p >= 0.6875 ? 20 : p >= 0.354 ? 40 : p >= 0.208 ? 80 : p >= 0.104 ? 100 : p >= 0.042 ? 150 : 200;
    }
    case 'storedpower': case 'powertrip': return 20 + 20 * positiveBoosts(att);
    case 'punishment': return Math.min(200, 60 + 20 * positiveBoosts(def));
    case 'acrobatics': return att.item ? 55 : 110;
    case 'knockoff': return def.item && !stickyItem(def, ctx.dex) ? 97 : 65;
    case 'facade': return ['brn', 'par', 'psn', 'tox'].includes(att.status) ? 140 : 70;
    case 'hex': case 'infernalparade': return def.status ? 130 : 65;
    case 'brine': return def.hpFrac <= 0.5 ? 130 : 65;
    case 'venoshock': return ['psn', 'tox'].includes(def.status) ? 130 : 65;
    case 'barbbarrage': return ['psn', 'tox'].includes(def.status) ? 120 : 60;
    case 'payback': return movesFirst(def, att, ctx) >= 0.5 ? 100 : 50;
    case 'avalanche': case 'revenge': return movesFirst(def, att, ctx) >= 0.5 ? 100 : 60;
    case 'boltbeak': case 'fishiousrend': return movesFirst(att, def, ctx) >= 0.5 ? 170 : 85;
    case 'risingvoltage': return ctx.terrain === 'electricterrain' && isGrounded(def, ctx) ? 140 : 70;
    case 'expandingforce': return ctx.terrain === 'psychicterrain' && isGrounded(att, ctx) ? 120 : 80;
    case 'mistyexplosion': return ctx.terrain === 'mistyterrain' && isGrounded(att, ctx) ? 150 : 100;
    case 'psyblade': return ctx.terrain === 'electricterrain' && isGrounded(att, ctx) ? 120 : 80;
    case 'solarbeam': case 'solarblade': return ctx.weather && !isSun(ctx.weather) ? bp / 2 : bp;
    case 'lastrespects': return 50 + 50 * (opts.faintedAllies || 0);
    case 'ragefist': return 50 + 50 * Math.min(6, opts.timesHit || 0);
    case 'hardpress': case 'wringout': case 'crushgrip': return Math.max(1, Math.floor(100 * def.hpFrac));
    case 'steelroller': return ctx.terrain ? 130 : 0;
    case 'burnup': return att.types.includes('Fire') ? 130 : 0;
    case 'doubleshock': return att.types.includes('Electric') ? 120 : 0;
    case 'poltergeist': return def.item ? 110 : 0;
    case 'dreameater': return def.status === 'slp' ? 100 : 0;
    case 'belch': return 0;
    case 'fakeout': case 'firstimpression': return att.moveActions === 0 ? bp : 0;
    case 'magnitude': return 71;
    case 'return': case 'frustration': return 102;
    case 'present': case 'trumpcard': return 40;
    case 'beatup': return 20;
    case 'terablast': return 80;
    case 'fling': case 'naturalgift': case 'spitup': return 0;
    case 'counter': case 'mirrorcoat': case 'metalburst': case 'comeuppance': case 'bide': return 0;
    case 'finalgambit': case 'endeavor': return 0;
    default: return bp;
  }
}

function positiveBoosts(f) {
  return Object.values(f.boosts || {}).reduce((s, n) => s + Math.max(0, n), 0);
}

// Items the holder cannot lose (its own Mega Stone, ...).
function stickyItem(f, dex) {
  const item = dex.items.get(f.item);
  if (!item.exists) return false;
  if (item.megaStone) {
    const stones = typeof item.megaStone === 'string' ? [item.megaEvolves] : Object.keys(item.megaStone);
    return stones.includes(f.species.baseSpecies);
  }
  return !!item.zMove;
}

function hitCount(att, move, ctx) {
  const mh = move.multihit;
  if (!mh) return 1;
  if (Array.isArray(mh)) return att.ability === 'skilllink' ? mh[1] : att.item === 'loadeddice' ? Math.max(4, mh[0]) + 0.5 : (mh[0] + mh[1]) / 2 - 0.4;
  if (move.id === 'populationbomb') return att.item === 'loadeddice' ? 7 : 6.5;
  if (move.id === 'tripleaxel' || move.id === 'triplekick') return 4.7;   // 20/40/60 with 90% each
  return mh;
}

function accuracyOf(att, def, move, type, ctx) {
  if (move.accuracy === true || att.ability === 'noguard' || def.ability === 'noguard') return 1;
  if (['populationbomb', 'tripleaxel', 'triplekick'].includes(move.id)) return 1;   // folded into hits
  if (move.ohko) return 0.3;
  let acc = move.accuracy / 100;
  if ((move.id === 'thunder' || move.id === 'hurricane') && isRain(ctx.weather)) return 1;
  if ((move.id === 'thunder' || move.id === 'hurricane') && isSun(ctx.weather)) acc = 0.5;
  if (move.id === 'blizzard' && isSnow(ctx.weather)) return 1;
  if (move.id === 'toxic' && att.types.includes('Poison')) return 1;
  if (att.ability === 'compoundeyes') acc *= 1.3;
  if (att.ability === 'victorystar') acc *= 1.1;
  if (att.ability === 'hustle' && move.category === 'Physical') acc *= 0.8;
  if (att.item === 'widelens') acc *= 1.1;
  if (def.ability === 'sandveil' && ctx.weather === 'sandstorm') acc *= 0.8;
  if (def.ability === 'snowcloak' && isSnow(ctx.weather)) acc *= 0.8;
  if (ctx.gravity) acc *= 5 / 3;
  acc *= accMult(att.boosts.accuracy || 0) / accMult(def.boosts.evasion || 0);
  return clamp(acc, 0, 1);
}

function attackMods(att, move, type, phys, ctx) {
  let m = 1;
  const ab = att.ability;
  if ((ab === 'hugepower' || ab === 'purepower') && phys) m *= 2;
  if (ab === 'guts' && att.status && phys) m *= 1.5;
  if (ab === 'hustle' && phys) m *= 1.5;
  if (ab === 'gorillatactics' && phys) m *= 1.5;
  if (ab === 'solarpower' && !phys && isSun(ctx.weather)) m *= 1.5;
  if (ab === 'flowergift' && phys && isSun(ctx.weather)) m *= 1.5;
  if (ab === 'defeatist' && att.hpFrac <= 0.5) m *= 0.5;
  if (ab === 'slowstart' && phys) m *= 0.5;
  if (att.hpFrac <= 1 / 3 && ((ab === 'overgrow' && type === 'Grass') || (ab === 'blaze' && type === 'Fire')
    || (ab === 'torrent' && type === 'Water') || (ab === 'swarm' && type === 'Bug'))) m *= 1.5;
  if ((ab === 'steelworker' || ab === 'steelyspirit') && type === 'Steel') m *= 1.5;
  if (ab === 'dragonsmaw' && type === 'Dragon') m *= 1.5;
  if (ab === 'transistor' && type === 'Electric') m *= 1.3;
  if (ab === 'rockypayload' && type === 'Rock') m *= 1.5;
  if (ab === 'waterbubble' && type === 'Water') m *= 2;
  if (ab === 'toxicboost' && ['psn', 'tox'].includes(att.status) && phys) m *= 1.5;
  if (ab === 'flareboost' && att.status === 'brn' && !phys) m *= 1.5;
  if ((ab === 'protosynthesis' || ab === 'quarkdrive') && att.item === 'boosterenergy') {
    const hs = highestStat(att);
    if ((hs === 'atk' && phys) || (hs === 'spa' && !phys)) m *= 1.3;
  }
  if (att.item === 'choiceband' && phys) m *= 1.5;
  if (att.item === 'choicespecs' && !phys) m *= 1.5;
  if (att.item === 'lightball' && att.species.baseSpecies === 'Pikachu') m *= 2;
  if (att.item === 'thickclub' && att.species.baseSpecies === 'Marowak') m *= 2;
  return m;
}

function defenseMods(def, defAbility, defKey, ctx) {
  let m = 1;
  if (defAbility === 'furcoat' && defKey === 'def') m *= 2;
  if (defAbility === 'marvelscale' && def.status && defKey === 'def') m *= 1.5;
  if (defAbility === 'grasspelt' && ctx.terrain === 'grassyterrain' && defKey === 'def') m *= 1.5;
  if ((defAbility === 'protosynthesis' || defAbility === 'quarkdrive') && def.item === 'boosterenergy' && highestStat(def) === defKey) m *= 1.3;
  if (def.item === 'assaultvest' && defKey === 'spd') m *= 1.5;
  if (def.item === 'eviolite' && def.species.nfe) m *= 1.5;
  if (ctx.weather === 'sandstorm' && def.types.includes('Rock') && defKey === 'spd') m *= 1.5;
  if (isSnow(ctx.weather) && def.types.includes('Ice') && defKey === 'def') m *= 1.5;
  return m;
}

function basePowerMods(att, def, defAbility, move, type, ctx, opts) {
  let m = 1;
  const ab = att.ability, fl = move.flags || {};
  if (ab === 'technician' && move.basePower <= 60) m *= 1.5;
  if (ab === 'sheerforce' && (move.secondary || move.secondaries)) m *= 1.3;
  if (ab === 'ironfist' && fl.punch) m *= 1.2;
  if (ab === 'reckless' && (move.recoil || move.hasCrashDamage)) m *= 1.2;
  if (ab === 'toughclaws' && fl.contact) m *= 1.3;
  if (ab === 'strongjaw' && fl.bite) m *= 1.5;
  if (ab === 'megalauncher' && fl.pulse) m *= 1.5;
  if (ab === 'sharpness' && fl.slicing) m *= 1.5;
  if (ab === 'punkrock' && fl.sound) m *= 1.3;
  if (ab === 'sandforce' && ctx.weather === 'sandstorm' && ['Rock', 'Ground', 'Steel'].includes(type)) m *= 1.3;
  if (ab === 'supremeoverlord') m *= 1 + 0.1 * (opts.faintedAllies || 0);
  if (ab === 'analytic' && movesFirst(def, att, ctx) >= 0.5) m *= 1.3;
  if ((ab === 'fairyaura' || defAbility === 'fairyaura') && type === 'Fairy') m *= 1.33;
  if ((ab === 'darkaura' || defAbility === 'darkaura') && type === 'Dark') m *= 1.33;
  if (opts.allyAbility === 'battery' && move.category === 'Special') m *= 1.3;
  if (opts.allyAbility === 'powerspot') m *= 1.3;
  if (opts.allyAbility === 'steelyspirit' && type === 'Steel') m *= 1.5;
  if (TYPE_ITEMS[att.item] === type) m *= 1.2;
  if (att.item === 'muscleband' && move.category === 'Physical') m *= 1.1;
  if (att.item === 'wiseglasses' && move.category === 'Special') m *= 1.1;
  if (att.item === 'punchingglove' && fl.punch) m *= 1.1;
  const grounded = isGrounded(att, ctx);
  if (ctx.terrain === 'electricterrain' && type === 'Electric' && grounded) m *= 1.3;
  if (ctx.terrain === 'grassyterrain' && type === 'Grass' && grounded) m *= 1.3;
  if (ctx.terrain === 'psychicterrain' && type === 'Psychic' && grounded) m *= 1.3;
  if (ctx.terrain === 'mistyterrain' && type === 'Dragon' && isGrounded(def, ctx)) m *= 0.5;
  if (ctx.terrain === 'grassyterrain' && ['earthquake', 'bulldoze', 'magnitude'].includes(move.id) && isGrounded(def, ctx)) m *= 0.5;
  if (opts.helpingHand) m *= 1.5;
  return m;
}

function finalMods(att, def, defAbility, move, type, eff, phys, ctx, opts) {
  let m = 1;
  const fl = move.flags || {};
  if ((defAbility === 'multiscale' || defAbility === 'shadowshield') && def.hpFrac >= 0.999) m *= 0.5;
  if (['filter', 'solidrock', 'prismarmor'].includes(defAbility) && eff > 1) m *= 0.75;
  if (defAbility === 'fluffy') { if (fl.contact) m *= 0.5; if (type === 'Fire') m *= 2; }
  if (defAbility === 'icescales' && !phys) m *= 0.5;
  if (defAbility === 'punkrock' && fl.sound) m *= 0.5;
  if (defAbility === 'thickfat' && (type === 'Fire' || type === 'Ice')) m *= 0.5;
  if (defAbility === 'heatproof' && type === 'Fire') m *= 0.5;
  if (defAbility === 'waterbubble' && type === 'Fire') m *= 0.5;
  if (defAbility === 'purifyingsalt' && type === 'Ghost') m *= 0.5;
  if (defAbility === 'dryskin' && type === 'Fire') m *= 1.25;
  if (defAbility === 'auraguard' && fl.contact) m *= 0.5;
  if (opts.defAllyAbility === 'friendguard') m *= 0.75;
  if (att.ability === 'tintedlens' && eff < 1) m *= 2;
  if (att.ability === 'neuroforce' && eff > 1) m *= 1.25;
  if (att.item === 'expertbelt' && eff > 1) m *= 1.2;
  if (att.item === 'lifeorb') m *= 1.3;
  const berry = RESIST_BERRY[def.item];
  if (berry && berry === type && (eff > 1 || type === 'Normal')) m *= 0.5;
  if (att.ability === 'parentalbond' && !move.multihit && !fl.noparentalbond && !opts.spread) m *= 1.25;
  return m;
}

/** Damage estimate as fractions of the defender's max HP. */
export function estimateDamage(att, def, move, ctx, opts = {}) {
  const dex = ctx.dex;
  const zero = { min: 0, max: 0, avg: 0, type: move.type, accuracy: 0, hits: 0, blocked: true };
  if (!move.exists || move.category === 'Status') return zero;
  const id = move.id, fl = move.flags || {};
  const moldBreaker = MOLD_BREAKER.has(att.ability) || ['sunsteelstrike', 'moongeistbeam', 'photongeyser'].includes(id);
  const defAbility = moldBreaker ? '' : def.ability;
  let type = move.type, bpMod = 1;

  if (id === 'weatherball') { const t = WEATHER_BALL[ctx.weather]; if (t) type = t; }
  else if (id === 'terrainpulse') { const t = TERRAIN_PULSE[ctx.terrain]; if (t && isGrounded(att, ctx)) type = t; }
  else if (id === 'ivycudgel') type = IVY_CUDGEL[att.species.forme] || 'Grass';
  else if (id === 'ragingbull' || id === 'revelationdance') type = att.types[0];
  if (type === 'Normal' && ATE[att.ability] && !ATE_EXEMPT.has(id)) { type = ATE[att.ability]; bpMod *= 1.2; }

  let bp = variableBasePower(move, att, def, ctx, opts);
  if ((id === 'weatherball' && type !== 'Normal') || (id === 'terrainpulse' && type !== 'Normal')) bp = 100;
  if (!bp && !move.ohko && !['seismictoss', 'nightshade', 'superfang', 'naturesmadness', 'ruination'].includes(id)) return zero;

  // ---- immunities
  if (type === 'Ground' && id !== 'thousandarrows') {
    if (!isGrounded(def, ctx) && !(moldBreaker && def.ability === 'levitate' && !def.types.includes('Flying') && def.item !== 'airballoon')) return zero;
  } else if (!dex.getImmunity(type, def.types)) {
    const scrappy = att.ability === 'scrappy' && (type === 'Normal' || type === 'Fighting') && def.types.includes('Ghost');
    if (!scrappy) return zero;
  }
  if (ABILITY_TYPE_IMMUNITY[defAbility] === type) return zero;
  const flagImm = FLAG_IMMUNITY[defAbility];
  if (flagImm && fl[flagImm]) return zero;
  if (opts.ally && defAbility === 'telepathy') return zero;
  if (fl.powder && (def.types.includes('Grass') || def.item === 'safetygoggles' || defAbility === 'overcoat')) return zero;
  const prio = movePriority(att, move, ctx);
  if (prio > 0 && !opts.ally && (PRIORITY_BLOCK.has(defAbility) || PRIORITY_BLOCK.has(opts.defAllyAbility))) return zero;
  if (prio > 0 && !opts.ally && ctx.terrain === 'psychicterrain' && isGrounded(def, ctx)) return zero;
  if (fl.bullet && defAbility === 'bulletproof') return zero;

  // ---- effectiveness
  let typeMod = dex.getEffectiveness(type, def.types);
  if (id === 'freezedry' && def.types.includes('Water')) typeMod += 2;
  if (id === 'flyingpress') typeMod += dex.getEffectiveness('Flying', def.types);
  if (defAbility === 'wonderguard' && typeMod <= 0) return zero;
  const eff = 2 ** typeMod;
  const accuracy = accuracyOf(att, def, move, type, ctx);

  // ---- fixed / fractional damage
  if (id === 'seismictoss' || id === 'nightshade') {
    const f = Math.min(def.hpFrac, LEVEL / def.maxhp);
    return { min: f, max: f, avg: f, type, accuracy, hits: 1, blocked: false, eff };
  }
  if (id === 'superfang' || id === 'naturesmadness' || id === 'ruination') {
    const f = def.hpFrac / 2;
    return { min: f, max: f, avg: f, type, accuracy, hits: 1, blocked: false, eff };
  }
  if (move.ohko) {
    if (defAbility === 'sturdy') return zero;
    return { min: def.hpFrac, max: def.hpFrac, avg: def.hpFrac, type, accuracy, hits: 1, blocked: false, eff };
  }

  // ---- stats
  const phys = move.category === 'Physical';
  const atkKey = move.overrideOffensiveStat || (phys ? 'atk' : 'spa');
  const atkSrc = move.overrideOffensivePokemon === 'target' ? def : att;
  const defKey = move.overrideDefensiveStat || (phys ? 'def' : 'spd');
  const A = atkSrc.stats[atkKey] * (defAbility === 'unaware' ? 1 : boostMult(atkSrc.boosts[atkKey] || 0))
    * attackMods(att, move, type, phys, ctx);
  const D = def.stats[defKey] * (att.ability === 'unaware' || move.ignoreDefensive ? 1 : boostMult(def.boosts[defKey] || 0))
    * defenseMods(def, defAbility, defKey, ctx);
  const power = Math.max(1, Math.floor(bp * bpMod * basePowerMods(att, def, defAbility, move, type, ctx, opts)));
  const base = Math.floor(Math.floor(Math.floor(2 * LEVEL / 5 + 2) * power * A / Math.max(1, D)) / 50) + 2;

  let mod = 1;
  if (opts.spread) mod *= 0.75;
  if (isRain(ctx.weather)) { if (type === 'Water') mod *= 1.5; else if (type === 'Fire') mod *= 0.5; }
  if (isSun(ctx.weather)) { if (type === 'Fire') mod *= 1.5; else if (type === 'Water' && id !== 'hydrosteam') mod *= 0.5; }
  const stab = att.types.includes(type) ? (att.ability === 'adaptability' ? 2 : 1.5) : 1;
  mod *= stab * eff;
  if (att.status === 'brn' && phys && att.ability !== 'guts' && id !== 'facade') mod *= 0.5;
  const dconds = ctx.conds[def.side] || [];
  if (att.ability !== 'infiltrator' && ((phys && dconds.includes('reflect')) || (!phys && dconds.includes('lightscreen')) || dconds.includes('auroraveil'))) mod *= 2 / 3;
  mod *= finalMods(att, def, defAbility, move, type, eff, phys, ctx, opts);
  const hits = hitCount(att, move, ctx);
  const total = base * mod * hits / def.maxhp;
  return { min: total * 0.85, max: total, avg: total * 0.925, type, accuracy, hits, blocked: false, eff };
}

/** Expected value of one attack in "HP bars of the target": damage capped by remaining HP plus a KO premium. */
export function attackValue(att, def, move, ctx, opts = {}) {
  const d = estimateDamage(att, def, move, ctx, opts);
  if (d.blocked || d.max <= 0) return { value: 0, pKO: 0, dmg: 0, d };
  const hp = def.hpFrac;
  const sash = hp >= 0.999 && (def.item === 'focussash' || def.ability === 'sturdy') && d.hits <= 1;
  let pKO = 0;
  if (!sash) pKO = d.max <= hp ? 0 : d.min >= hp ? 1 : (d.max - hp) / (d.max - d.min);
  const cap = sash ? Math.max(0, hp - 1 / def.maxhp) : hp;
  const expected = Math.min(cap, d.avg);
  return { value: (expected + pKO * KO_BONUS) * d.accuracy, pKO: pKO * d.accuracy, dmg: expected * d.accuracy, d };
}

// ---------------------------------------------------------------- side effects
function flinchChance(att, def, move) {
  if (FLINCH_IMMUNE.has(def.ability) || def.item === 'covertcloak' || att.ability === 'sheerforce') return 0;
  const secs = [move.secondary, ...(move.secondaries || [])].filter(Boolean);
  const s = secs.find((x) => x.volatileStatus === 'flinch');
  if (!s) return 0;
  let c = (s.chance || 100) / 100;
  if (att.ability === 'serenegrace') c *= 2;
  return Math.min(1, c);
}

function statusImmune(def, status, move, X, defAlly) {
  const ctx = X.ctx, ab = def.ability;
  if (def.status) return true;
  if (['comatose', 'purifyingsalt'].includes(ab)) return true;
  if (ab === 'goodasgold' && move.category === 'Status') return true;
  if ((ab === 'shielddust' || def.item === 'covertcloak') && move.category !== 'Status') return true;
  if ((ctx.conds[def.side] || []).includes('safeguard')) return true;
  if (ctx.terrain === 'mistyterrain' && isGrounded(def, ctx)) return true;
  if (move.flags?.powder && (def.types.includes('Grass') || def.item === 'safetygoggles' || ab === 'overcoat')) return true;
  if (move.category === 'Status' && move.type === 'Electric' && (!X.dex.getImmunity('Electric', def.types) || ['voltabsorb', 'lightningrod', 'motordrive'].includes(ab))) return true;
  if (move.category === 'Status' && move.type === 'Grass' && ab === 'sapsipper') return true;
  switch (status) {
    case 'brn': return def.types.includes('Fire') || ['waterveil', 'waterbubble', 'thermalexchange'].includes(ab);
    case 'par': return def.types.includes('Electric') || ab === 'limber';
    case 'slp': return ['insomnia', 'vitalspirit', 'sweetveil'].includes(ab) || defAlly?.ability === 'sweetveil'
      || (ab === 'leafguard' && isSun(ctx.weather)) || (ctx.terrain === 'electricterrain' && isGrounded(def, ctx));
    case 'psn': case 'tox': return def.types.includes('Poison') || def.types.includes('Steel') || ab === 'immunity';
    case 'frz': return def.types.includes('Ice') || ab === 'magmaarmor' || isSun(ctx.weather);
    default: return false;
  }
}

function mainCategory(f) {
  const phys = f.moves.filter((m) => m.category === 'Physical').length;
  const spec = f.moves.filter((m) => m.category === 'Special').length;
  if (phys === spec) return f.stats.atk >= f.stats.spa ? 'Physical' : 'Special';
  return phys > spec ? 'Physical' : 'Special';
}

/** Probability that a foe protects (and succeeds) this turn. */
function protectChance(foe) {
  if (!foe.moves.some((m) => PROTECT_MOVES.has(m.id))) return 0;
  return 0.22 / 3 ** (foe.protectStreak || 0);
}

// Value of an attacking move's secondary effects against one target.
function secondaryValue(att, def, move, r, X, first) {
  let v = 0;
  const secs = [move.secondary, ...(move.secondaries || [])].filter(Boolean);
  const dropsBlocked = STAT_DROP_IMMUNE.has(def.ability) || def.item === 'clearamulet';
  const ctx = X.ctx;
  for (const s of secs) {
    if (att.ability === 'sheerforce') break;
    let chance = (s.chance || 100) / 100;
    if (att.ability === 'serenegrace') chance = Math.min(1, chance * 2);
    if (def.ability === 'shielddust' || def.item === 'covertcloak') continue;
    if (s.boosts && !dropsBlocked) {
      for (const [k, n] of Object.entries(s.boosts)) {
        if (n >= 0) continue;
        if (k === 'spe') v += chance * (X.ours.some((me) => movesFirst(def, me, ctx) > 0.5) && !ctx.trickroom ? 0.14 : 0.03);
        else if (k === 'atk' || k === 'spa') v += chance * (mainCategory(def) === (k === 'atk' ? 'Physical' : 'Special') ? 0.09 : 0.02);
        else v += chance * 0.04;
      }
    }
    if (s.status && !statusImmune(def, s.status, move, X)) v += chance * (s.status === 'slp' ? 0.4 : s.status === 'frz' ? 0.3 : 0.2);
    if (s.volatileStatus === 'confusion') v += chance * 0.05;
  }
  if (move.self?.boosts) {
    // Contrary flips the user's own stat changes (Close Combat's drops become boosts).
    const flip = att.ability === 'contrary' ? -1 : 1;
    for (const [, n] of Object.entries(move.self.boosts)) v += n * flip > 0 ? 0.06 * n * flip : 0;
  }
  if (move.id === 'knockoff' && def.item && !stickyItem(def, X.dex)) v += 0.08;
  if (move.drain && att.hpFrac < 0.7) v += r.dmg * (move.drain[0] / move.drain[1]) * 0.3;
  if (move.selfSwitch) v += 0.03;
  return v;
}

// Own costs of using an attack (recoil, item recoil, self drops, contact punishers), in own-HP units.
function selfCost(att, def, move, r, X) {
  let cost = 0;
  const magic = att.ability === 'magicguard';
  const dmgAbs = r.dmg * def.maxhp;
  if (move.recoil && att.ability !== 'rockhead' && !magic) {
    const frac = dmgAbs * move.recoil[0] / move.recoil[1] / att.maxhp;
    cost += frac * 0.35 + (frac >= att.hpFrac ? 0.4 : 0);
  }
  if ((move.mindBlownRecoil || ['steelbeam', 'chloroblast'].includes(move.id)) && !magic) cost += 0.5 * 0.35 + (att.hpFrac <= 0.5 ? 0.4 : 0);
  if (move.selfdestruct) cost += att.hpFrac * 0.6 + OWN_KO_COST * 0.6;
  if (move.hasCrashDamage) cost += (1 - r.d.accuracy) * 0.5 * 0.35;
  if (att.item === 'lifeorb' && !magic && r.dmg > 0) cost += 0.1 * 0.35;
  const flip = att.ability === 'contrary' ? -1 : 1;
  if (move.self?.boosts) for (const [, n] of Object.entries(move.self.boosts)) if (n * flip < 0) cost += 0.04 * -n * flip;
  if (move.flags?.contact && !(att.ability === 'longreach') && !(att.item === 'punchingglove' && move.flags.punch)) {
    if (def.item === 'rockyhelmet' && !magic) cost += (1 / 6) * 0.35;
    if ((def.ability === 'roughskin' || def.ability === 'ironbarbs') && !magic) cost += (1 / 8) * 0.35;
    if (def.ability === 'flamebody' || def.ability === 'static' || def.ability === 'effectspore') cost += 0.3 * 0.2;
    if (def.ability === 'aftermath') cost += 0.02;
  }
  return cost;
}

// Multiplier for moves that trade tempo or depend on the foe's action.
function tempoFactor(att, move, ctx) {
  const fl = move.flags || {};
  if (fl.charge) {
    if (att.item === 'powerherb') return 0.95;
    if ((move.id === 'solarbeam' || move.id === 'solarblade') && isSun(ctx.weather)) return 1;
    if (move.id === 'electroshot' && isRain(ctx.weather)) return 1;
    return 0.5;
  }
  if (fl.recharge) return 0.6;
  if (move.id === 'suckerpunch' || move.id === 'thunderclap') return 0.7;
  if (move.id === 'focuspunch') return 0.4;
  if (move.id === 'upperhand') return 0.25;
  return 1;
}

// ---------------------------------------------------------------- status-move heuristics
function healValue(me, frac, X, slot) {
  const inc = X.inc[slot];
  const missing = 1 - me.hpFrac;
  if (missing < 0.3) return 0.02;
  return Math.min(frac, missing) * 0.8 * (me.hpFrac < 0.55 ? 1 : 0.35) * (1 - (inc?.pKO || 0));
}

function setupValue(me, boosts, X, slot) {
  const inc = X.inc[slot] || { pKO: 0, sum: 0 };
  const cat = mainCategory(me);
  let stages = 0;
  for (const [k, n] of Object.entries(boosts)) {
    if (n <= 0) continue;
    const room = Math.max(0, Math.min(n, 6 - (me.boosts[k] || 0)));
    const useful = (k === 'atk' && cat === 'Physical') || (k === 'spa' && cat === 'Special') ? 1
      : k === 'spe' ? (X.ctx.trickroom ? 0 : X.foes.some((f) => movesFirst(f, me, X.ctx) > 0.5) ? 0.8 : 0.2)
        : (k === 'def' || k === 'spd') ? 0.45 : 0.2;
    stages += room * useful;
  }
  const already = positiveBoosts(me) >= 2 ? 0.45 : 1;
  const survive = 1 - inc.pKO;
  const pressure = clamp(1 - inc.sum * 0.8, 0.3, 1);
  return 0.22 * Math.min(stages, 3.5) * already * survive * pressure;
}

function trickRoomValue(X) {
  const team = [...X.ours, ...X.bench];
  if (!team.length || !X.foes.length) return 0;
  let now = 0, flipped = 0, n = 0;
  for (const m of team) for (const f of X.foes) { const p = movesFirst(m, f, X.ctx); now += p; flipped += 1 - p; n++; }
  const gain = (flipped - now) / n;
  if (X.ctx.trickroom) return gain > 0.3 ? 0.5 : -1;
  return gain > 0.15 ? 0.3 + 0.7 * gain : -0.5;
}

function tailwindValue(X) {
  if ((X.ctx.conds[X.side] || []).includes('tailwind')) return -1;
  if (X.ctx.trickroom) return -0.5;
  const team = [...X.ours, ...X.bench];
  if (!team.length || !X.foes.length) return 0;
  const ctx2 = { ...X.ctx, conds: { ...X.ctx.conds, [X.side]: [...(X.ctx.conds[X.side] || []), 'tailwind'] } };
  let now = 0, tw = 0, n = 0;
  for (const m of team) for (const f of X.foes) { now += movesFirst(m, f, X.ctx); tw += movesFirst(m, f, ctx2); n++; }
  const gain = (tw - now) / n;
  return gain <= 0.05 ? 0.02 : 0.25 + 0.9 * gain;
}

const WEATHER_ABUSERS = {
  raindance: { abilities: ['swiftswim', 'raindish', 'drizzle', 'hydration'], moves: ['thunder', 'hurricane', 'weatherball', 'electroshot'], type: 'Water' },
  sunnyday: { abilities: ['chlorophyll', 'solarpower', 'protosynthesis', 'orichalcumpulse', 'flowergift', 'leafguard'], moves: ['solarbeam', 'solarblade', 'weatherball', 'growth'], type: 'Fire' },
  sandstorm: { abilities: ['sandrush', 'sandforce', 'sandveil'], moves: ['weatherball', 'shoreup'], type: 'Rock' },
  snowscape: { abilities: ['slushrush', 'snowcloak', 'icebody'], moves: ['blizzard', 'auroraveil', 'weatherball'], type: 'Ice' },
};
function weatherValue(w, X) {
  const key = w === 'snow' || w === 'hail' ? 'snowscape' : w;
  if (X.ctx.weather === key) return -1;
  const ab = WEATHER_ABUSERS[key];
  if (!ab) return 0.05;
  const benefits = (f) => (ab.abilities.includes(f.ability) ? 1 : 0) + (f.moves.some((m) => ab.moves.includes(m.id)) ? 0.6 : 0)
    + (f.types.includes(ab.type) && f.moves.some((m) => m.type === ab.type && m.category !== 'Status') ? 0.5 : 0);
  const mine = [...X.ours, ...X.bench].reduce((s, f) => s + benefits(f), 0);
  const theirs = X.foes.reduce((s, f) => s + benefits(f), 0);
  return clamp(0.08 + 0.25 * mine - 0.2 * theirs, -0.3, 0.8);
}
const TERRAIN_ABUSERS = {
  grassyterrain: ['grassyglide', 'terrainpulse'], electricterrain: ['risingvoltage', 'psyblade', 'terrainpulse'],
  psychicterrain: ['expandingforce', 'terrainpulse'], mistyterrain: ['mistyexplosion', 'terrainpulse'],
};
function terrainValue(t, X) {
  if (X.ctx.terrain === t) return -1;
  const mine = [...X.ours, ...X.bench].filter((f) => f.moves.some((m) => (TERRAIN_ABUSERS[t] || []).includes(m.id))).length;
  return 0.08 + 0.2 * mine;
}

function statusInflictValue(me, foe, status, move, X) {
  const foeAlly = X.foes.find((f) => f !== foe);
  if (statusImmune(foe, status, move, X, foeAlly)) return 0;
  let v = { brn: 0.35, par: 0.3, slp: 0.55, psn: 0.15, tox: 0.2, frz: 0.3 }[status] || 0.1;
  if (status === 'brn') {
    if (['guts', 'marvelscale', 'flareboost'].includes(foe.ability)) return 0.02;
    if (mainCategory(foe) === 'Physical') v += 0.2; else v -= 0.1;
  }
  if (status === 'par') {
    if (X.ours.some((m) => movesFirst(foe, m, X.ctx) > 0.5)) v += 0.2;
    if (X.ctx.trickroom) v -= 0.15;
  }
  if (status === 'slp') v += 0.15 * (X.threatShare?.(foe) || 0);
  return v * accuracyOf(me, foe, move, move.type, X.ctx) * (move.flags?.protect ? 1 - protectChance(foe) : 1);
}

/** Actions for a status move. Foe-targeted moves pick the best foe. */
function statusActions(me, slot, move, idx, X, partner, partnerSlot, mega) {
  const id = move.id, tt = move.target;
  const base = { kind: 'status', slot, idx, move, fighter: me, mega, hits: [], value: 0.05, targetStr: '' };
  const text = (a) => `move ${idx + 1}${a.targetStr}${mega ? ' mega' : ''}`;
  const finish = (a) => { a.text = text(a); return [a]; };
  // Prankster-boosted (or otherwise priority) status moves bounce off Armor Tail /
  // Dazzling / Queenly Majesty on the target's side and off Psychic Terrain.
  const priorityBlocked = (f) => movePriority(me, move, X.ctx) > 0
    && (X.foes.some((g) => PRIORITY_BLOCK.has(g.ability)) || (X.ctx.terrain === 'psychicterrain' && isGrounded(f, X.ctx)));
  const forFoe = (valueFn) => {
    let best = null;
    for (const f of X.foes) {
      const v = priorityBlocked(f) ? 0 : valueFn(f);
      if (!best || v > best.value) best = { ...base, value: v, targetStr: ` ${f.slot + 1}`, foe: f };
    }
    return best ? finish(best) : [];
  };
  const ownSide = X.ctx.conds[X.side] || [];

  if (PROTECT_MOVES.has(id) || id === 'endure') {
    return finish({ ...base, kind: 'protect', pSuccess: 1 / 3 ** me.protectStreak, value: -TEMPO_PROTECT });
  }
  if (id === 'wideguard') return finish({ ...base, kind: 'wideguard', value: -0.05 });
  if (id === 'quickguard') return finish({ ...base, kind: 'quickguard', value: -0.05 });
  if (id === 'followme' || id === 'ragepowder') return partner ? finish({ ...base, kind: 'redirect', value: -0.05 }) : [];
  if (id === 'helpinghand') return partner ? finish({ ...base, kind: 'helpinghand', value: -0.05, targetStr: ` -${partnerSlot + 1}` }) : [];
  if (id === 'trickroom') return finish({ ...base, value: trickRoomValue(X) });
  if (id === 'tailwind') return finish({ ...base, value: tailwindValue(X) });
  if (id === 'reflect' || id === 'lightscreen' || id === 'auroraveil') {
    if (ownSide.includes(id) || (id === 'auroraveil' && !isSnow(X.ctx.weather))) return finish({ ...base, value: -1 });
    const cat = id === 'reflect' ? 'Physical' : id === 'lightscreen' ? 'Special' : null;
    const n = X.foes.filter((f) => !cat || mainCategory(f) === cat).length;
    return finish({ ...base, value: 0.15 + 0.15 * n });
  }
  if (move.weather) return finish({ ...base, value: weatherValue(toID(move.weather), X) });
  if (move.terrain) return finish({ ...base, value: terrainValue(toID(move.terrain), X) });
  if (id === 'bellydrum') return finish({ ...base, value: me.hpFrac > 0.5 ? setupValue(me, { atk: 6 }, X, slot) - 0.25 : -1 });
  if (id === 'curse' && !me.types.includes('Ghost')) return finish({ ...base, value: setupValue(me, { atk: 1, def: 1 }, X, slot) });
  if (id === 'tidyup') return finish({ ...base, value: setupValue(me, { atk: 1, spe: 1 }, X, slot) });
  if (move.volatileStatus === 'confusion' && FOE_TARGETS.has(tt)) return forFoe((f) => (f.ability === 'owntempo' ? 0 : 0.1) * (1 - protectChance(f)));
  if (move.boosts && (tt === 'self' || tt === 'adjacentAllyOrSelf') && Object.values(move.boosts).some((n) => n > 0)) {
    return finish({ ...base, value: setupValue(me, move.boosts, X, slot), targetStr: tt === 'adjacentAllyOrSelf' ? ` -${slot + 1}` : '' });
  }
  if (id === 'lifedew' || id === 'junglehealing' || id === 'lunarblessing') {
    const v = healValue(me, 0.25, X, slot) + (partner ? healValue(partner, 0.25, X, partnerSlot) : 0);
    return finish({ ...base, value: v });
  }
  if (id === 'healpulse') {
    if (!partner) return [];
    return finish({ ...base, value: healValue(partner, 0.5, X, partnerSlot), targetStr: ` -${partnerSlot + 1}` });
  }
  if ((move.heal || HEAL_HALF.has(id)) && tt === 'self') {
    const frac = move.heal ? move.heal[0] / move.heal[1] : 0.5;
    return finish({ ...base, value: healValue(me, frac, X, slot) });
  }
  if (id === 'strengthsap') return forFoe((f) => healValue(me, 0.5, X, slot) * 0.9 + (mainCategory(f) === 'Physical' ? 0.1 : 0.02));
  if (id === 'rest') return finish({ ...base, value: me.hpFrac < 0.4 ? 0.3 : -0.5 });
  if (move.status) return forFoe((f) => statusInflictValue(me, f, move.status, move, X));
  if (id === 'yawn') return forFoe((f) => statusInflictValue(me, f, 'slp', move, X) * 0.6);
  if (id === 'taunt') {
    return forFoe((f) => {
      if (['oblivious', 'goodasgold'].includes(f.ability) || X.foes.some((g) => g.ability === 'aromaveil')) return 0;
      const st = f.moves.filter((m) => m.category === 'Status').length;
      const setter = f.moves.some((m) => ['trickroom', 'tailwind'].includes(m.id));
      return (0.1 + 0.08 * st + (setter ? 0.2 : 0)) * (1 - protectChance(f));
    });
  }
  if (id === 'encore') {
    // Needs a move to repeat: nothing on a fresh switch-in; great on a Trick Room / setup user.
    return forFoe((f) => (!f.lastMove ? 0 : X.dex.moves.get(f.lastMove).category === 'Status' ? 0.35 : 0.1) * (1 - protectChance(f)));
  }
  if (id === 'disable' || id === 'torment' || id === 'imprison') return tt === 'self' ? finish({ ...base, value: 0.06 }) : forFoe(() => 0.08);
  if (id === 'destinybond') return finish({ ...base, value: (X.inc[slot]?.pKO || 0) > 0.5 ? 0.45 : 0.03 });
  if (id === 'haze') return finish({ ...base, value: 0.12 * X.foes.reduce((s, f) => s + positiveBoosts(f), 0) });
  if (id === 'substitute') return finish({ ...base, value: me.hpFrac > 0.5 ? 0.1 : -0.5 });
  if (id === 'stealthrock' || id === 'spikes' || id === 'toxicspikes' || id === 'stickyweb') {
    const foeSide = X.ctx.conds[X.foeSide] || [];
    if (foeSide.includes(id)) return finish({ ...base, value: -1 });
    return finish({ ...base, value: id === 'stickyweb' ? 0.2 : id === 'stealthrock' ? 0.1 : 0.05 });
  }
  if (id === 'coaching') return partner ? finish({ ...base, value: 0.12 + (mainCategory(partner) === 'Physical' ? 0.1 : 0), targetStr: ` -${partnerSlot + 1}` }) : [];
  if (id === 'partingshot') return forFoe((f) => (STAT_DROP_IMMUNE.has(f.ability) ? 0.02 : 0.15) * (1 - protectChance(f)));
  if (id === 'memento' || id === 'healingwish' || id === 'lunardance' || id === 'finalgambit') return tt === 'self' ? finish({ ...base, value: -0.5 }) : forFoe(() => -0.5);
  if (id === 'allyswitch') return finish({ ...base, value: 0.02 });
  if (id === 'trick' || id === 'switcheroo') return forFoe(() => 0.08);
  if (move.boosts && FOE_TARGETS.has(tt)) {
    return forFoe((f) => {
      if (STAT_DROP_IMMUNE.has(f.ability) || f.item === 'clearamulet') return 0;
      let v = 0;
      for (const [k, n] of Object.entries(move.boosts)) {
        if (n >= 0) continue;
        v += -n * ((k === 'atk' || k === 'spa') && mainCategory(f) === (k === 'atk' ? 'Physical' : 'Special') ? 0.08 : k === 'spe' ? 0.06 : 0.03);
      }
      return v * accuracyOf(me, f, move, move.type, X.ctx) * (1 - protectChance(f));
    });
  }
  // Anything else: a small value, with a legal target where one is required.
  if (FOE_TARGETS.has(tt)) return forFoe(() => 0.04);
  if (tt === 'adjacentAlly') return partner ? finish({ ...base, value: 0.04, targetStr: ` -${partnerSlot + 1}` }) : [];
  if (tt === 'adjacentAllyOrSelf') return finish({ ...base, value: 0.04, targetStr: ` -${slot + 1}` });
  return finish({ ...base, value: 0.04 });
}

// ---------------------------------------------------------------- attacking actions
function attackActions(me, slot, move, idx, mv, X, partner, partnerSlot, mega) {
  // Expanding Force from a grounded user on Psychic Terrain hits both opponents.
  const tt = (move.id === 'expandingforce' && X.ctx.terrain === 'psychicterrain' && isGrounded(me, X.ctx))
    ? 'allAdjacentFoes' : (mv.target || move.target);
  const text = (targetStr) => `move ${idx + 1}${targetStr}${mega ? ' mega' : ''}`;
  const foeAllyAbility = (f) => X.foes.find((g) => g !== f)?.ability;
  const build = (targets, targetStr, hitsPartner) => {
    const spread = targets.length + (hitsPartner ? 1 : 0) >= 2 && move.id !== 'dragondarts';
    const tempo = tempoFactor(me, move, X.ctx);
    let value = 0;
    const hits = [];
    for (const f of targets) {
      const r = attackValue(me, f, move, X.ctx, { spread, defAllyAbility: foeAllyAbility(f), faintedAllies: X.faintedAllies, allyAbility: partner?.ability });
      if (r.d.blocked) continue;
      const first = movesFirst(me, f, X.ctx, movePriority(me, move, X.ctx), 0);
      const flinch = flinchChance(me, f, move);
      const noProtect = move.flags?.protect ? 1 - protectChance(f) : 1;
      let v = (r.value + secondaryValue(me, f, move, r, X, first)) * noProtect * tempo;
      v -= selfCost(me, f, move, r, X) * noProtect;
      hits.push({ foe: f, pKO: r.pKO * noProtect * tempo, first, flinch: flinch * noProtect, dmg: r.dmg * noProtect * tempo, value: v });
      value += v;
    }
    if (!hits.length) return null;
    let allyPenalty = 0;
    if (hitsPartner && partner) {
      const r = attackValue(me, partner, move, X.ctx, { spread: true, ally: true });
      // Hurting our own partner weighs more than the same damage on a foe: it is
      // a Pokémon we still need, and there is almost always another move.
      const crippled = partner.hpFrac > 0 ? (Math.min(r.dmg, partner.hpFrac) / partner.hpFrac) ** 2 * 1.2 : 0;
      allyPenalty = r.dmg * 1.5 + crippled + r.pKO * (1 + OWN_KO_COST);
      value -= allyPenalty;
    }
    return { kind: 'attack', slot, idx, move, fighter: me, mega, hits, value, allyPenalty, text: text(targetStr) };
  };

  if (FOE_TARGETS.has(tt)) {
    if (move.id === 'dragondarts' && X.foes.length >= 2) {
      const a = build(X.foes, ` ${X.foes[0].slot + 1}`, false);
      return a ? [a] : [];
    }
    return X.foes.map((f) => build([f], ` ${f.slot + 1}`, false)).filter(Boolean);
  }
  if (tt === 'allAdjacentFoes') { const a = build(X.foes, '', false); return a ? [a] : []; }
  if (tt === 'allAdjacent') { const a = build(X.foes, '', !!partner); return a ? [a] : []; }
  if (tt === 'randomNormal' || tt === 'scripted' || tt === 'self' || tt === 'all' || tt === 'foeSide' || tt === 'allySide' || tt === 'allies') {
    // Locked / random-target damaging moves: expect an average foe.
    const per = X.foes.map((f) => build([f], '', false)).filter(Boolean);
    if (!per.length) return [];
    const avg = per.reduce((s, a) => s + a.value, 0) / per.length;
    return [{ ...per[0], value: avg, text: text('') }];
  }
  return [];
}

/** All damaging moves of `f` into `me` — what the foe could do to this slot. */
function foeThreats(f, me, X) {
  const out = new Map();
  const ally = X.foes.find((g) => g !== f);
  for (const m of f.moves) {
    if (m.category === 'Status') continue;
    const spread = SPREAD_TARGETS.has(m.target) && X.ours.length >= 2;
    const r = attackValue(f, me, m, X.ctx, { spread, defAllyAbility: X.ours.find((o) => o.slot !== me.slot)?.ability, allyAbility: ally?.ability });
    if (r.d.blocked || r.value <= 0) continue;
    const tempo = tempoFactor(f, m, X.ctx);
    out.set(m.id, { move: m.id, dmg: r.dmg * tempo, pKO: r.pKO * tempo, spread, priority: movePriority(f, m, X.ctx),
      value: (r.dmg + r.pKO * (OWN_KO_COST + 0.2 * me.hpFrac)) * tempo });
  }
  return out;
}

function incomingSummary(threatsByFoe) {
  let max = 0, sum = 0, pKO = 0;
  for (const ths of threatsByFoe) {
    let best = 0, bestKO = 0;
    for (const t of ths.values()) { if (t.dmg > best) best = t.dmg; if (t.pKO > bestKO) bestKO = t.pKO; }
    max = Math.max(max, best); sum += best; pKO = Math.max(pKO, bestKO);
  }
  return { max, sum, pKO };
}

// ---------------------------------------------------------------- joint evaluation
function scorePair(actions, X, threatsFor) {
  const { foes } = X;
  let score = 0;
  const denied = foes.map(() => 0);
  const block = actions.map(() => 0);
  const occupant = actions.map((a) => (a && a.kind !== 'pass' ? a.fighter : null));
  let wide = false, quick = false, redirect = -1, hhSlot = -1, protects = 0;

  // P(the user still stands when its action resolves): foes that act first and can KO it.
  const survival = (me, prio) => {
    let dead = 0;
    foes.forEach((f, t) => {
      let worst = 0;
      for (const th of threatsFor(me)[t].values()) worst = Math.max(worst, movesFirst(f, me, X.ctx, th.priority, prio) * th.pKO);
      dead = 1 - (1 - dead) * (1 - worst);
    });
    return 1 - dead;
  };

  actions.forEach((a, s) => {
    if (!a || a.kind === 'pass') return;
    const pAct = a.kind === 'switch' || !a.move ? 1 : survival(a.fighter, movePriority(a.fighter, a.move, X.ctx));
    score += a.value * pAct;
    if (a.kind === 'attack') {
      for (const h of a.hits) {
        const t = foes.indexOf(h.foe);
        if (t < 0) continue;
        denied[t] = 1 - (1 - denied[t]) * (1 - pAct * h.first * (h.pKO + (1 - h.pKO) * h.flinch));
      }
    } else if (a.kind === 'protect') { block[s] = a.pSuccess * pAct; protects++; }
    else if (a.kind === 'wideguard') wide = true;
    else if (a.kind === 'quickguard') quick = true;
    else if (a.kind === 'redirect') redirect = s;
    else if (a.kind === 'helpinghand') hhSlot = s;
  });

  // Two attackers into the same foe: overkill is wasted, a combined KO is not.
  foes.forEach((f, t) => {
    const parts = actions.filter((a) => a?.kind === 'attack').map((a) => a.hits.find((h) => h.foe === f)).filter(Boolean);
    if (parts.length !== 2) return;
    const combined = parts[0].dmg + parts[1].dmg;
    // A healing berry fires between the two hits.
    const need = f.hpFrac + (f.item === 'sitrusberry' && f.hpFrac > 0.5 ? 0.25 : 0);
    if (combined <= need) return;
    if (parts[0].pKO < 0.5 && parts[1].pKO < 0.5) {
      const p = clamp((combined - need) / Math.max(0.05, combined * 0.15), 0, 1);
      score += KO_BONUS * 0.8 * p;
      denied[t] = Math.max(denied[t], Math.min(parts[0].first, parts[1].first) * p);
    } else {
      score -= (combined - f.hpFrac) * 0.7;
    }
  });

  if (hhSlot >= 0) {
    const partnerAction = actions[1 - hhSlot];
    if (partnerAction?.kind === 'attack') score += 0.5 * partnerAction.hits.reduce((s, h) => s + h.dmg, 0);
    else score -= 0.1;
  }
  // A protecting partner is not hit by our own spread move.
  actions.forEach((a, s) => { if (a?.kind === 'attack' && a.allyPenalty && block[1 - s] > 0) score += a.allyPenalty * block[1 - s]; });
  if (protects === 2) score -= 0.3;

  // Expected damage taken back from each foe that still gets to act.
  foes.forEach((f, t) => {
    const pAct = 1 - denied[t];
    if (pAct <= 0.001) return;
    const blockEff = (s) => block[s] * (denied[t] + 0.65 * (1 - denied[t]));   // protecting only delays unless the threat dies
    const moveIds = new Set();
    occupant.forEach((me) => { if (me) for (const id of threatsFor(me)[t].keys()) moveIds.add(id); });
    let worst = 0;
    for (const id of moveIds) {
      let v = 0;
      let spread = false;
      occupant.forEach((me, s) => {
        if (!me) return;
        const th = threatsFor(me)[t].get(id);
        if (!th) return;
        if (th.spread) {
          spread = true;
          v += wide ? 0 : th.value * (1 - blockEff(s));
        } else {
          let target = s, thr = th;
          if (redirect >= 0 && redirect !== s && occupant[redirect]) {
            target = redirect;
            thr = threatsFor(occupant[redirect])[t].get(id) || { value: 0, priority: th.priority };
          }
          let b = blockEff(target);
          if (quick && thr.priority > 0) b = 1;
          v = Math.max(v, thr.value * (1 - b));
        }
      });
      if (spread || v > worst) worst = Math.max(worst, v);
    }
    score -= pAct * worst * INCOMING_WEIGHT;
  });
  return score;
}

// ---------------------------------------------------------------- decisions
function bestOffense(f, X, opts = {}) {
  let best = 0;
  for (const m of f.moves) {
    if (m.category === 'Status') continue;
    for (const foe of X.foes) {
      const spread = SPREAD_TARGETS.has(m.target) && X.foes.length >= 2;
      const v = attackValue({ ...f, moveActions: opts.fresh ? 0 : f.moveActions }, foe, m, X.ctx, { spread, faintedAllies: X.faintedAllies }).value;
      if (v > best) best = v;
    }
  }
  return best;
}

function intimidateBonus(f, X) {
  if (f.ability !== 'intimidate') return 0;
  let v = 0;
  for (const foe of X.foes) {
    if (['innerfocus', 'owntempo', 'oblivious', 'scrappy', 'guarddog', 'defiant', 'competitive', 'contrary', 'clearbody', 'whitesmoke', 'fullmetalbody', 'mirrorarmor'].includes(foe.ability) || foe.item === 'clearamulet') { v -= 0.05; continue; }
    if (mainCategory(foe) === 'Physical') v += 0.12;
  }
  return v;
}

/** Some legal move string for a slot: the first usable move with a target when it needs one. */
function legalFallback(a, slot) {
  const idx = Math.max(0, a.moves.findIndex((m) => !m.disabled));
  const mv = a.moves[idx];
  const tt = mv?.target;
  const target = !tt ? '' : FOE_TARGETS.has(tt) ? ' 1' : tt === 'adjacentAlly' ? ` -${slot === 0 ? 2 : 1}` : tt === 'adjacentAllyOrSelf' ? ` -${slot + 1}` : '';
  return `move ${idx + 1}${target}`;
}

const pairText = (pair, nActive) => pair.filter((a, i) => i < nActive).map((a) => (a ? a.text : 'pass')).join(', ');

function moveTurn(req, view, dex) {
  const { pairs, nActive } = evaluateTurn(req, view, dex);
  return pairs.length ? pairText(pairs[0].pair, nActive) : null;
}

/** Ranked plans for a move request, with the numbers behind them (tuning / debugging aid). */
export function explain(req, view, dex, n = 8) {
  const { pairs, nActive } = evaluateTurn(req, view, dex);
  const round = (x) => (x == null ? x : +Number(x).toFixed(3));
  return pairs.slice(0, n).map(({ score, pair }) => ({
    score: round(score),
    choice: pairText(pair, nActive),
    actions: pair.map((a) => a && ({
      text: a.text, kind: a.kind, value: round(a.value), allyPenalty: a.allyPenalty ? round(a.allyPenalty) : undefined,
      hits: a.hits?.map((h) => ({ foe: h.foe.species.name, dmg: round(h.dmg), pKO: round(h.pKO), first: h.first, flinch: round(h.flinch) })),
    })),
  }));
}

function evaluateTurn(req, view, dex) {
  const side = req.side.id || 'p2';
  const foeSide = other(side);
  const ctx = buildCtx(view, dex);
  const foes = [0, 1].map((s) => foeFighter(dex, view, foeSide, s)).filter(Boolean);
  const ownAll = req.side.pokemon.map((_, i) => ownFighter(dex, view, side, i));
  const nActive = req.active.length;
  const actives = req.active.map((a, i) => (a && ownAll[i] && !ownAll[i].fainted ? ownAll[i] : null));
  const alive = actives.filter(Boolean);
  const bench = ownAll.filter((f, i) => f && i >= nActive && !f.fainted);
  if (!foes.length || !alive.length) return { pairs: [], nActive };
  const X = {
    dex, ctx, side, foeSide, foes, ours: alive, bench, req, view,
    faintedAllies: ownAll.filter((f) => !f || f.fainted).length, inc: [],
  };
  const threatCache = new Map();
  const threatsFor = (me) => {
    if (!threatCache.has(me)) threatCache.set(me, foes.map((f) => foeThreats(f, me, X)));
    return threatCache.get(me);
  };
  actives.forEach((me, i) => { X.inc[i] = me ? incomingSummary(threatsFor(me)) : { max: 0, sum: 0, pKO: 0 }; });
  const totalThreat = foes.map((f) => alive.reduce((s, me) => s + Math.max(0, ...[...threatsFor(me)[foes.indexOf(f)].values()].map((t) => t.dmg)), 0));
  const threatSum = totalThreat.reduce((a, b) => a + b, 0) || 1;
  X.threatShare = (f) => totalThreat[foes.indexOf(f)] / threatSum;

  const candidates = req.active.map((a, i) => {
    const me = actives[i];
    if (!me || !a) return [{ kind: 'pass', text: 'pass', value: 0, fighter: null }];
    if (a.commanding) return [{ kind: 'pass', text: 'pass', value: 0, fighter: me }];
    const partnerSlot = i === 0 ? 1 : 0;
    const partner = actives[partnerSlot] || null;
    const listFor = (fighter, mega) => {
      const out = [];
      a.moves.forEach((mv, idx) => {
        if (mv.disabled) return;
        const move = dex.moves.get(mv.id || mv.move);
        if (!move.exists) return;
        const acts = move.category === 'Status'
          ? statusActions(fighter, i, move, idx, X, partner, partnerSlot, mega)
          : attackActions(fighter, i, move, idx, mv, X, partner, partnerSlot, mega);
        for (const act of acts) {
          if (!mv.target && move.category !== 'Status') act.text = `move ${idx + 1}${mega ? ' mega' : ''}`;   // locked move
          out.push(act);
        }
      });
      return out;
    };
    let list = listFor(me, false);
    if (a.canMegaEvo) {
      const mm = megaVariant(me, dex);
      // The bonus is scaled by survival like everything else, so a mega that
      // would die before acting still is not chosen.
      if (mm) list = list.concat(listFor(mm, true).map((act) => ({ ...act, value: act.value + MEGA_BONUS })));
    }
    // Voluntary switches: only when this Pokémon is doing little or is about to go down.
    const canSwitch = !a.trapped && !a.maybeTrapped && bench.length && !(me.moveActions === 0 && ctx.turn > 1);
    const offense = bestOffense(me, X);
    if (canSwitch && (offense < 0.35 || X.inc[i].pKO > 0.6)) {
      for (const b of bench) {
        const gain = bestOffense(b, X, { fresh: true }) - offense;
        const idx = ownAll.indexOf(b);
        list.push({ kind: 'switch', slot: i, fighter: b, value: -TEMPO_SWITCH + 0.5 * gain + intimidateBonus(b, X) + 0.05 * b.hpFrac, text: `switch ${idx + 1}`, hits: [] });
      }
    }
    if (!list.length) list.push({ kind: 'attack', text: legalFallback(a, i), value: 0, fighter: me, hits: [] });
    return list;
  });

  const pairs = [];
  const second = candidates[1] || [null];
  for (const a1 of candidates[0]) {
    for (const a2 of second) {
      if (a1?.mega && a2?.mega) continue;
      if (a1?.kind === 'switch' && a2?.kind === 'switch' && a1.text === a2.text) continue;
      pairs.push({ score: scorePair([a1, a2], X, threatsFor), pair: [a1, a2] });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  return { pairs, nActive };
}

function forcedSwitch(req, view, dex) {
  const side = req.side.id || 'p2';
  const ctx = buildCtx(view, dex);
  const foes = [0, 1].map((s) => foeFighter(dex, view, other(side), s)).filter(Boolean);
  const ownAll = req.side.pokemon.map((_, i) => ownFighter(dex, view, side, i));
  const nActive = req.forceSwitch.length;
  const alive = ownAll.filter((f, i) => f && i < nActive && !f.fainted && !req.forceSwitch[i]);
  const X = { dex, ctx, side, foeSide: other(side), foes, ours: alive, bench: [], faintedAllies: ownAll.filter((f) => !f || f.fainted).length, inc: [] };
  const used = new Set();
  return req.forceSwitch.map((must) => {
    if (!must) return 'pass';
    let best = null;
    ownAll.forEach((b, idx) => {
      if (!b || b.fainted || idx < nActive || used.has(idx)) return;
      let v = 0.1 * b.hpFrac + intimidateBonus(b, X);
      if (foes.length) {
        const incoming = incomingSummary(foes.map((f) => foeThreats(f, b, { ...X, ours: [b] })));
        v += bestOffense(b, X, { fresh: true }) - 0.8 * (incoming.max + incoming.pKO * OWN_KO_COST);
      }
      if (!best || v > best.v) best = { v, idx };
    });
    if (!best) return 'pass';
    used.add(best.idx);
    return `switch ${best.idx + 1}`;
  }).join(', ');
}

function teamPreview(req, view, dex) {
  const side = req.side.id || 'p2';
  const n = Math.min(req.maxChosenTeamSize || 4, req.side.pokemon.length);
  const ctx = buildCtx(view, dex);
  const ours = req.side.pokemon.map((_, i) => ownFighter(dex, view, side, i)).filter(Boolean);
  const foes = foeTeam(dex, view, other(side));
  const X = { dex, ctx, side, foeSide: other(side), foes, ours: [], bench: [], faintedAllies: 0, inc: [] };
  const scored = ours.map((me, i) => {
    // A Mega Stone holder is judged as the mega it becomes on turn 1.
    const mega = megaVariant(me, dex);
    const form = mega || me;
    let offense = 0, defense = 0;
    if (foes.length) {
      for (const f of foes) {
        let bestO = 0, bestD = 0;
        for (const m of form.moves) if (m.category !== 'Status') bestO = Math.max(bestO, attackValue({ ...form, moveActions: 0 }, f, m, ctx, {}).value);
        for (const m of f.moves) if (m.category !== 'Status') bestD = Math.max(bestD, attackValue(f, form, m, ctx, {}).value);
        offense += bestO; defense += bestD;
      }
      offense /= foes.length; defense /= foes.length;
    }
    const has = (id) => me.moves.some((m) => m.id === id);
    const slow = form.stats.spe < 80;
    let role = 0, lead = 0;
    if (has('fakeout')) { role += 0.1; lead += 0.25; }
    if (has('followme') || has('ragepowder')) { role += 0.05; lead += 0.1; }
    if (has('tailwind')) { role += 0.1; lead += 0.15; }
    if (has('trickroom')) { role += slow ? 0.1 : 0.03; lead += 0.15; }
    if (has('icywind') || has('electroweb')) role += 0.05;
    if (me.moves.some((m) => PROTECT_MOVES.has(m.id))) role += 0.05;
    if (me.ability === 'intimidate') { role += 0.1; lead += 0.15; }
    if (['drizzle', 'drought', 'sandstream', 'snowwarning', 'grassysurge', 'electricsurge', 'psychicsurge', 'mistysurge'].includes(me.ability)) lead += 0.1;
    return { i, me, mega: !!mega, score: offense - 0.6 * defense + role, lead };
  });
  // Bring the Mega: the Mega Stone holder this matchup scores best always makes
  // the four. A second holder is usually left home: a heavy penalty rather than
  // a ban, so two megas can still both come when the rest of the team is weak.
  const byScore = (a, b) => b.score - a.score;
  const megas = scored.filter((p) => p.mega).sort(byScore);
  let picked;
  if (megas.length && n > 1) {
    const rest = scored.filter((p) => p !== megas[0])
      .map((p) => (p.mega ? { ...p, score: p.score - SECOND_MEGA_PENALTY } : p))
      .sort(byScore).slice(0, n - 1);
    picked = [megas[0], ...rest];
  } else {
    picked = [...scored].sort(byScore).slice(0, n);
  }
  // A Trick Room setter leads with the slowest heavy hitter; otherwise the two best lead scores.
  const setter = picked.find((p) => p.me.moves.some((m) => m.id === 'trickroom') && picked.filter((q) => q.me.stats.spe < 80).length >= 2);
  let leads;
  if (setter) {
    const partner = picked.filter((p) => p !== setter).sort((a, b) => a.me.stats.spe - b.me.stats.spe)[0];
    leads = [setter, partner].filter(Boolean);
  } else {
    leads = [...picked].sort((a, b) => (b.score + b.lead) - (a.score + a.lead)).slice(0, 2);
  }
  const order = [...leads, ...picked.filter((p) => !leads.includes(p))].map((p) => p.i + 1);
  return `team ${order.join('')}`;
}

/** Choice string for a request, or null when the request needs no answer. */
export function decide(req, view, dex) {
  if (!req || req.wait) return null;
  if (req.teamPreview) return teamPreview(req, view, dex);
  if (req.forceSwitch) return forcedSwitch(req, view, dex);
  if (req.active) return moveTurn(req, view, dex) || 'default';
  return 'default';
}

// ---------------------------------------------------------------- pressure (the playbook's three questions)
// Every damaging move the attacker has, against one target, in the set's own
// order: range, KO odds, and whether it is blocked (type immunity, an ability,
// the Psychic Terrain priority block). Spread ranges already carry the x0.75.
function allHits(att, def, X) {
  const out = [];
  for (const m of att.moves) {
    if (m.category === 'Status') continue;
    const spread = SPREAD_TARGETS.has(m.target) && X.ours.length + X.foes.length >= 3;
    const r = attackValue(att, def, m, X.ctx, { spread });
    out.push({ move: m.name, type: r.d.type, min: Math.round(r.d.min * 100), max: Math.round(r.d.max * 100),
      ko: Math.round(r.pKO * 100), accuracy: Math.round(r.d.accuracy * 100), priority: movePriority(att, m, X.ctx),
      spread, blocked: !!r.d.blocked });
  }
  return out;
}

function bestHit(att, def, X) {
  let best = null;
  for (const m of att.moves) {
    if (m.category === 'Status') continue;
    const spread = SPREAD_TARGETS.has(m.target) && X.ours.length + X.foes.length >= 3;
    const r = attackValue(att, def, m, X.ctx, { spread });
    if (r.d.blocked) continue;
    const entry = { move: m.name, type: r.d.type, min: Math.round(r.d.min * 100), max: Math.round(r.d.max * 100),
      ko: Math.round(r.pKO * 100), accuracy: Math.round(r.d.accuracy * 100), priority: movePriority(att, m, X.ctx) };
    if (!best || entry.max > best.max) best = entry;
  }
  return best;
}

/**
 * Wolfe's three questions for the current turn, from `side`'s point of view:
 * the speed order of the active Pokémon (Trick Room / Tailwind / paralysis /
 * Scarf aware), what each of ours threatens on each of theirs, and what each of
 * theirs threatens on ours (best move, damage range, KO chance). At team preview
 * it ranks the opponent's six by the damage they threaten and lists our answers.
 * Uses only what the player sees: exact own stats, Open Team Sheets, estimated
 * foe stats, revealed items and abilities.
 */
export function pressure(view, dex, side = 'p1') {
  const foeSide = other(side);
  const ctx = buildCtx(view, dex);
  const ownAll = (view.sides[side].pokemon || []).map((_, i) => ownFighter(dex, view, side, i)).filter(Boolean);
  const ours = ownAll.filter((f) => f.slot !== null && !f.fainted);
  const foes = [0, 1].map((s) => foeFighter(dex, view, foeSide, s)).filter(Boolean);
  const base = { trickRoom: ctx.trickroom, tailwind: { [side]: ctx.conds[side].includes('tailwind'), [foeSide]: ctx.conds[foeSide].includes('tailwind') } };
  const X = { dex, ctx, side, foeSide, foes, ours, bench: [], faintedAllies: 0, inc: [] };
  const tag = (f) => ({ side: f.side, slot: f.slot, species: f.species.name, hp: Math.round(f.hpFrac * 100), speed: Math.round(speedOf(f, ctx)), estimated: !f.exact });

  if (!ours.length || !foes.length) {
    // Team preview (or nothing on the field): rank their six by the damage they threaten.
    const theirTeam = foeTeam(dex, view, foeSide);
    const mine = ownAll.filter((f) => !f.fainted);
    if (!mine.length || !theirTeam.length) return { ...base, preview: [] };
    const XP = { ...X, ours: mine, foes: theirTeam };
    const preview = theirTeam.map((f) => {
      const hitsOnUs = mine.map((o) => ({ target: o.species.name, ...(bestHit(f, o, XP) || { move: null, max: 0, min: 0, ko: 0 }) }))
        .sort((a, b) => b.max - a.max);
      const answers = mine.map((o) => ({ answer: o.species.name, ...(bestHit(o, f, XP) || { move: null, max: 0, min: 0, ko: 0 }) }))
        .filter((a) => a.max >= 50).sort((a, b) => b.max - a.max);
      return { species: f.species.name, item: f.item, ability: f.ability, worst: hitsOnUs[0], hitsOnUs, answers,
        danger: hitsOnUs.reduce((s, h) => s + Math.min(100, h.max), 0) / mine.length };
    }).sort((a, b) => b.danger - a.danger);
    return { ...base, preview };
  }

  const order = [...ours, ...foes].map(tag).sort((a, b) => (ctx.trickroom ? a.speed - b.speed : b.speed - a.speed));
  return {
    ...base,
    order,
    // `threats` keeps the best hit per target (move/min/max/ko) and adds `moves`,
    // the full list, so the Battle tab can show every move against both targets.
    ours: ours.map((o) => ({ ...tag(o), threats: foes.map((f) => ({ target: f.species.name, targetSlot: f.slot, ...(bestHit(o, f, X) || { move: null, max: 0, min: 0, ko: 0 }), moves: allHits(o, f, X) })) })),
    theirs: foes.map((f) => ({ ...tag(f), threats: ours.map((o) => ({ target: o.species.name, targetSlot: o.slot, ...(bestHit(f, o, X) || { move: null, max: 0, min: 0, ko: 0 }), moves: allHits(f, o, X) })) })),
  };
}
