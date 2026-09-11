// node --test sim/   (no pokemon-showdown needed)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLine, newState, parseHP, parsePos, syncOwnSide } from './protocol.mjs';

test('position and HP parsing', () => {
  assert.deepEqual(parsePos('p2b: Incineroar'), { side: 'p2', slot: 1, name: 'Incineroar' });
  assert.deepEqual(parsePos('p1: You'), { side: 'p1', slot: 0, name: 'You' });
  assert.equal(parsePos('nonsense'), null);
  assert.deepEqual(parseHP('181/182 brn'), { hp: 181, maxhp: 182, status: 'brn', fainted: false });
  assert.deepEqual(parseHP('75/100'), { hp: 75, maxhp: 100, status: null, fainted: false });
  assert.deepEqual(parseHP('0 fnt'), { hp: 0, maxhp: 100, status: 'fnt', fainted: true });
  // The champions mod's HP-bar colour tag at 50% / 20% ("50/100g", "20/100r") is not part of the number.
  assert.deepEqual(parseHP('50/100g'), { hp: 50, maxhp: 100, status: null, fainted: false });
  assert.deepEqual(parseHP('20/100r par'), { hp: 20, maxhp: 100, status: 'par', fainted: false });
});

test('a doubles turn reduces into UI state', () => {
  const st = newState({ id: 'x', format: 'gen9championsvgc2026regmb', bot: 'greedy', p1Name: 'You', p2Name: 'Bot' });
  const lines = [
    '|player|p1|You|1|',
    '|player|p2|Bot|2|',
    '|clearpoke',
    '|poke|p1|Golisopod, L50, M|',
    '|poke|p2|Kingambit, L50, M|',
    '|poke|p2|Incineroar, L50, F|',
    '|teampreview|4',
    '|start',
    '|switch|p1a: Golisopod|Golisopod, L50, M|182/182',
    '|switch|p1b: Farigiraf|Farigiraf, L50, F|227/227',
    '|switch|p2a: Kingambit|Kingambit, L50, M|100/100',
    '|switch|p2b: Incineroar|Incineroar, L50, F|100/100',
    '|turn|1',
    '|-mega|p1a: Golisopod|Golisopod|Golisopodite',
    '|detailschange|p1a: Golisopod|Golisopod-Mega, L50, M',
    '|move|p2a: Kingambit|Kowtow Cleave|p1a: Golisopod',
    '|-damage|p1a: Golisopod|120/182',
    '|-enditem|p2a: Kingambit|Chople Berry|[eat]',
    '|-ability|p2a: Kingambit|Defiant|boost',
    '|-boost|p2a: Kingambit|atk|2',
    '|-unboost|p2a: Kingambit|atk|1',
    '|-status|p1a: Golisopod|brn',
    '|-weather|SunnyDay',
    '|-fieldstart|move: Grassy Terrain',
    '|-fieldstart|move: Trick Room',
    '|-sidestart|p1: You|move: Tailwind',
    '|-damage|p2b: Incineroar|0 fnt',
    '|faint|p2b: Incineroar',
    '|turn|2',
  ];
  for (const l of lines) assert.equal(applyLine(st, l).ended, false);

  assert.equal(st.started, true);
  assert.equal(st.turn, 2);
  assert.deepEqual(st.teamPreview, { pick: 4 });
  assert.deepEqual(st.sides.p2.preview.map((p) => p.species), ['Kingambit', 'Incineroar']);

  const goli = st.sides.p1.active[0];
  assert.equal(goli.species, 'Golisopod-Mega');
  assert.equal(goli.mega, true);
  assert.equal(goli.item, 'Golisopodite');
  assert.deepEqual([goli.hp, goli.maxhp, goli.status], [120, 182, 'brn']);

  const king = st.sides.p2.active[0];
  assert.deepEqual([king.hp, king.maxhp], [100, 100]);
  assert.equal(king.item, '');                       // berry eaten
  assert.equal(king.ability, 'Defiant');
  assert.deepEqual(king.boosts, { atk: 1 });          // +2 then -1

  assert.equal(st.sides.p2.active[1].fainted, true);
  // Fainting keeps the known max HP so the UI can still show "0/227".
  applyLine(st, '|-damage|p1b: Farigiraf|0 fnt');
  assert.deepEqual([st.sides.p1.active[1].hp, st.sides.p1.active[1].maxhp, st.sides.p1.active[1].fainted], [0, 227, true]);
  assert.equal(st.field.weather, 'SunnyDay');
  assert.equal(st.field.terrain, 'Grassy Terrain');
  assert.deepEqual(st.field.pseudo, ['Trick Room']);
  assert.deepEqual(st.sides.p1.conditions, ['Tailwind']);

  // Revealed foe info survives a switch-out / switch-in.
  applyLine(st, '|switch|p2a: Sneasler|Sneasler, L50, M|100/100');
  applyLine(st, '|switch|p2a: Kingambit|Kingambit, L50, M|100/100');
  assert.equal(st.sides.p2.active[0].ability, 'Defiant');
  assert.equal(st.sides.p2.active[0].item, '');

  applyLine(st, '|-fieldend|move: Trick Room');
  applyLine(st, '|-weather|none');
  applyLine(st, '|-sideend|p1: You|move: Tailwind');
  assert.deepEqual(st.field.pseudo, []);
  assert.equal(st.field.weather, null);
  assert.deepEqual(st.sides.p1.conditions, []);

  assert.deepEqual(applyLine(st, '|win|You'), { ended: true });
  assert.equal(st.winner, 'You');
  assert.equal(st.request, null);
});

test('own side mirrors the request payload exactly', () => {
  const st = newState({ id: 'y', format: 'f', bot: 'random', p1Name: 'You', p2Name: 'Bot' });
  syncOwnSide(st, {
    name: 'You',
    pokemon: [
      { ident: 'p1: Golisopod', details: 'Golisopod, L50, M', condition: '120/182 brn', active: true,
        item: 'golisopodite', baseAbility: 'emergencyexit', moves: ['firstimpression', 'ironhead'] },
      { ident: 'p1: Rillaboom', details: 'Rillaboom, L50, M', condition: '0 fnt', active: false, item: '', ability: 'grassysurge', moves: [] },
    ],
  });
  const [g, r] = st.sides.p1.pokemon;
  assert.equal(g.species, 'Golisopod');
  assert.deepEqual([g.hp, g.maxhp, g.status, g.active, g.item, g.ability], [120, 182, 'brn', true, 'golisopodite', 'emergencyexit']);
  assert.equal(r.fainted, true);
  assert.equal(r.ability, 'grassysurge');
});

test('protect streaks, move attempts and revealed moves are tracked', () => {
  const st = newState({ id: 'x', format: 'f', bot: 'smart', p1Name: 'You', p2Name: 'Bot' });
  const run = (...lines) => lines.forEach((l) => applyLine(st, l));
  run('|switch|p1a: Garchomp|Garchomp, L50, M|182/182', '|switch|p2a: Kingambit|Kingambit, L50, M|100/100', '|turn|1');
  const chomp = () => st.sides.p1.active[0];
  const gambit = () => st.sides.p2.active[0];
  assert.equal(chomp().moveActions, 0);
  run('|move|p1a: Garchomp|Protect|p1a: Garchomp', '|-singleturn|p1a: Garchomp|Protect',
      '|move|p2a: Kingambit|Kowtow Cleave|p1a: Garchomp', '|-activate|p1a: Garchomp|move: Protect', '|turn|2');
  assert.equal(chomp().protectStreak, 1, 'one successful Protect');
  assert.equal(chomp().moveActions, 1);
  assert.equal(chomp().lastMove, 'Protect');
  assert.deepEqual(st.sides.p2.known.Kingambit.moves, ['Kowtow Cleave'], 'revealed moves are remembered');
  run('|move|p1a: Garchomp|Protect|p1a: Garchomp', '|-singleturn|p1a: Garchomp|Protect', '|turn|3');
  assert.equal(chomp().protectStreak, 2, 'second in a row (1/3 odds next)');
  run('|move|p1a: Garchomp|Protect|p1a: Garchomp', '|-fail|p1a: Garchomp', '|turn|4');
  assert.equal(chomp().protectStreak, 0, 'a failed Protect resets the counter');
  run('|move|p1a: Garchomp|Protect|p1a: Garchomp', '|-singleturn|p1a: Garchomp|Protect', '|turn|5');
  assert.equal(chomp().protectStreak, 1);
  run('|move|p1a: Garchomp|Earthquake|', '|turn|6');
  assert.equal(chomp().protectStreak, 0, 'a turn without protecting clears the streak');
  assert.equal(chomp().moveActions, 5);
  run('|switch|p1a: Kingambit|Kingambit, L50, M|207/207');
  assert.equal(chomp().moveActions, 0, 'switching in starts fresh (Fake Out works again)');
  assert.equal(gambit().moveActions, 1);
});

test('syncOwnSide follows the request side id', () => {
  const st = newState({ id: 'x', format: 'f', bot: 'smart', p1Name: 'You', p2Name: 'Bot' });
  syncOwnSide(st, { id: 'p2', name: 'Bot', pokemon: [{ ident: 'p2: Kingambit', details: 'Kingambit, L50, M', condition: '207/207', active: true, moves: ['kowtowcleave'], item: 'blackglasses', ability: 'defiant', stats: { atk: 205, def: 140, spa: 80, spd: 105, spe: 70 } }] });
  assert.equal(st.sides.p2.pokemon.length, 1);
  assert.equal(st.sides.p2.pokemon[0].stats.atk, 205);
  assert.equal(st.sides.p1.pokemon.length, 0);
});
