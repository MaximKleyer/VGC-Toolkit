// Hand-built battle situations for the bot tests and for tuning (see explain() in bot.mjs):
//   node -e "import('./scenario.mjs').then(async (s) => console.log(JSON.stringify((await import('./bot.mjs')).explain(...), null, 1)))"
import ps from 'pokemon-showdown';
import { decide, buildCtx } from './bot.mjs';
import { newState, syncOwnSide, toID } from './protocol.mjs';
import { patchChampionsData } from './server.mjs';

const { Dex } = ps;
patchChampionsData();
export const dex = Dex.mod('champions');

const statAt50 = (base, ev = 0) => Math.floor((2 * base + 31 + Math.floor(ev / 4)) * 50 / 100) + 5;
const hpAt50 = (base, ev = 0) => Math.floor((2 * base + 31 + Math.floor(ev / 4)) * 50 / 100) + 60;

export function requestMon(o, active) {
  const sp = dex.species.get(o.species);
  const maxhp = hpAt50(sp.baseStats.hp, o.evs?.hp);
  const hp = Math.round(maxhp * (o.hpFrac ?? 1));
  const st = (k) => Math.round(statAt50(sp.baseStats[k], o.evs?.[k]) * (o.plus === k ? 1.1 : 1));
  return {
    ident: `p2: ${sp.name}`, details: `${sp.name}, L50`, active,
    condition: hp > 0 ? `${hp}/${maxhp}${o.status ? ' ' + o.status : ''}` : '0 fnt',
    stats: { atk: st('atk'), def: st('def'), spa: st('spa'), spd: st('spd'), spe: st('spe') },
    moves: o.moves.map((m) => dex.moves.get(m).id), baseAbility: toID(o.ability), ability: toID(o.ability), item: toID(o.item || ''),
  };
}
export function activeMon(side, slot, o) {
  const sp = dex.species.get(o.species);
  return {
    ident: `${side}${'ab'[slot]}: ${sp.name}`, species: sp.name, details: `${sp.name}, L50`, hp: o.hp ?? 100, maxhp: o.maxhp ?? 100,
    status: o.status || null, fainted: false, boosts: o.boosts || {}, mega: false, moveActions: o.moveActions ?? 1,
    protectStreak: o.protectStreak || 0, protectedTurn: -1, lastMove: o.lastMove || null,
  };
}

/** The bot (p2) facing foes (p1). `own`: up to six sets, the first two active. */
export function scenario({ own, foes, field = {}, conds = {}, turn = 2, canMega = [], teamPreview = false, forceSwitch = null }) {
  const view = newState({ id: 't', format: 'test', bot: 'smart', p1Name: 'You', p2Name: 'Bot' });
  view.turn = turn; view.started = true;
  view.field = { weather: field.weather || null, terrain: field.terrain || null, pseudo: field.pseudo || [] };
  view.sides.p1.conditions = conds.p1 || [];
  view.sides.p2.conditions = conds.p2 || [];
  view.sides.p1.sheet = foes.map((f) => ({ species: dex.species.get(f.species).name, item: f.item || '', ability: f.ability || '', moves: f.moves || [] }));
  foes.forEach((f, i) => { if (!f.bench) view.sides.p1.active[i] = activeMon('p1', i, f); });
  const nActive = teamPreview ? 0 : 2;
  const side = { name: 'Bot', id: 'p2', pokemon: own.map((o, i) => requestMon(o, i < nActive)) };
  own.forEach((o, i) => {
    if (i >= nActive) return;
    const sp = dex.species.get(o.species);
    const maxhp = hpAt50(sp.baseStats.hp, o.evs?.hp);
    view.sides.p2.active[i] = activeMon('p2', i, { ...o, hp: Math.round(maxhp * (o.hpFrac ?? 1)), maxhp });
  });
  syncOwnSide(view, side);
  let req;
  if (teamPreview) req = { teamPreview: true, maxChosenTeamSize: 4, side };
  else if (forceSwitch) req = { forceSwitch, side };
  else {
    req = {
      side,
      active: own.slice(0, 2).map((o, i) => ({
        canMegaEvo: canMega.includes(i),
        moves: o.moves.map((m) => { const mv = dex.moves.get(m); return { move: mv.name, id: mv.id, pp: 16, maxpp: 16, target: mv.target, disabled: false }; }),
      })),
    };
  }
  return { view, req, ctx: buildCtx(view, dex) };
}
export const choose = (s) => decide(s.req, s.view, dex).split(', ');

export const KINGAMBIT = { species: 'Kingambit', item: 'Black Glasses', ability: 'Defiant', moves: ['Kowtow Cleave', 'Sucker Punch', 'Iron Head', 'Protect'], evs: { hp: 252, atk: 252 }, plus: 'atk' };
export const GARCHOMP = { species: 'Garchomp', item: 'Life Orb', ability: 'Rough Skin', moves: ['Earthquake', 'Dragon Claw', 'Swords Dance', 'Protect'], evs: { atk: 252, spe: 252 } };
export const SALAMENCE = { species: 'Salamence', item: 'Salamencite', ability: 'Intimidate', moves: ['Double-Edge', 'Dragon Claw', 'Tailwind', 'Protect'], evs: { atk: 252, spe: 252 } };
export const INCINEROAR = { species: 'Incineroar', item: 'Sitrus Berry', ability: 'Intimidate', moves: ['Fake Out', 'Flare Blitz', 'Knock Off', 'Parting Shot'], evs: { hp: 252, atk: 252 } };
export const AMOONGUSS = { species: 'Amoonguss', item: 'Rocky Helmet', ability: 'Regenerator', moves: ['Spore', 'Pollen Puff', 'Rage Powder', 'Protect'], evs: { hp: 252, def: 252 } };
export const FLUTTER = { species: 'Flutter Mane', item: 'Choice Specs', ability: 'Protosynthesis', moves: ['Moonblast', 'Shadow Ball', 'Icy Wind', 'Dazzling Gleam'] };
export const LUCARIO = { species: 'Lucario', item: 'Life Orb', ability: 'Inner Focus', moves: ['Close Combat', 'Aura Sphere', 'Flash Cannon', 'Protect'], evs: { atk: 252, spa: 252 } };
export const ROTOM = { species: 'Rotom-Wash', item: 'Sitrus Berry', ability: 'Levitate', moves: ['Hydro Pump', 'Thunderbolt', 'Will-O-Wisp', 'Protect'] };
export const CORVIKNIGHT = { species: 'Corviknight', item: 'Leftovers', ability: 'Mirror Armor', moves: ['Brave Bird', 'Iron Head', 'Tailwind', 'Roost'] };
export const FARIGIRAF = { species: 'Farigiraf', item: 'Throat Spray', ability: 'Armor Tail', moves: ['Trick Room', 'Psychic', 'Helping Hand', 'Protect'], evs: { hp: 252, spa: 252 } };
export const TORKOAL = { species: 'Torkoal', item: 'Charcoal', ability: 'Drought', moves: ['Eruption', 'Heat Wave', 'Earth Power', 'Protect'], evs: { hp: 252, spa: 252 } };

export const STARAPTOR = { species: 'Staraptor', item: 'Staraptite', ability: 'Intimidate', moves: ['Close Combat', 'Protect', 'Brave Bird', 'Tailwind'], evs: { hp: 232, atk: 8, spe: 252 }, plus: 'spe' };
export const PRIMARINA = { species: 'Primarina', item: 'Expert Belt', ability: 'Liquid Voice', moves: ['Hyper Voice', 'Moonblast', 'Icy Wind', 'Protect'], evs: { hp: 252, spa: 252 }, plus: 'spa' };
export const SINISTCHA = { species: 'Sinistcha', item: 'Colbur Berry', ability: 'Heatproof', moves: ['Matcha Gotcha', 'Rage Powder', 'Trick Room', 'Protect'], evs: { hp: 252, def: 112, spd: 144 } };
export const GOLISOPOD = { species: 'Golisopod', item: 'Golisopite', ability: 'Emergency Exit', moves: ['First Impression', 'Iron Head', 'Close Combat', 'Rock Slide'], evs: { hp: 252, atk: 252 }, plus: 'atk' };
export const WHIMSICOTT = { species: 'Whimsicott', item: 'Focus Sash', ability: 'Prankster', moves: ['Tailwind', 'Moonblast', 'Encore', 'Protect'], evs: { spa: 252, spe: 252 }, plus: 'spe' };
