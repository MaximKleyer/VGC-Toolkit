// Pure Showdown-protocol helpers for the sidecar (no engine dependency, so
// they are unit-testable without pokemon-showdown installed: `node --test sim/`).
//
// applyLine(state, line) folds one protocol line from the HUMAN player's stream
// into the UI state: active slots, HP/status/boosts, revealed items/abilities,
// weather/terrain/side conditions, team preview, turn counter, result.

export const toID = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Moves that share the consecutive-use counter (1, then 1/3, 1/9, ... to succeed).
export const STALL_MOVES = new Set(['protect', 'detect', 'spikyshield', 'banefulbunker', 'kingsshield',
  'obstruct', 'silktrap', 'burningbulwark', 'maxguard', 'matblock', 'endure']);

export function parsePos(pos) {
  // "p2a: Kingambit" -> {side:'p2', slot:0, name:'Kingambit'}
  const m = /^(p[12])([a-c])?(?::\s*(.*))?$/.exec(pos || '');
  if (!m) return null;
  return { side: m[1], slot: m[2] ? m[2].charCodeAt(0) - 97 : 0, name: m[3] || '' };
}

export function parseHP(cond) {
  // "181/182 brn" | "75/100" | "0 fnt"
  const [hpPart, status] = String(cond || '').trim().split(' ');
  if (hpPart === '0' || status === 'fnt') return { hp: 0, maxhp: 100, status: 'fnt', fainted: true };
  const [hp, maxhp] = hpPart.split('/').map(Number);
  return { hp, maxhp: maxhp || 100, status: status || null, fainted: false };
}

export function speciesFromDetails(details) {
  // "Kingambit, L50, M, shiny" -> "Kingambit"
  return String(details || '').split(',')[0].trim();
}

export function newSide(name, id) {
  // preview: species seen at team preview (|poke|); sheet: full sets from Open
  // Team Sheets (|showteam|, parsed by the server since it needs the engine).
  return { id, name, active: [null, null], pokemon: [], conditions: [], preview: [], sheet: [], known: {} };
}

export function newState({ id, format, bot, p1Name, p2Name }) {
  return {
    id, format, bot, turn: 0, started: false, ended: false, winner: null,
    request: null, errors: [], log: [],
    field: { weather: null, terrain: null, pseudo: [] },
    sides: { p1: newSide(p1Name, 'p1'), p2: newSide(p2Name, 'p2') },
    teamPreview: null,
  };
}

const clean = (s) => String(s || '').replace(/^move:\s*/, '');

/** Fold one protocol line into state. Returns {ended:boolean}. */
export function applyLine(state, line) {
  const parts = line.split('|');
  const cmd = parts[1];
  const sideOf = (pos) => (pos ? state.sides[pos.side] : null);
  const activeOf = (pos) => { const s = sideOf(pos); return s ? s.active[pos.slot] : null; };
  switch (cmd) {
    case 'player': {
      const [, , pid, name] = parts;
      if (state.sides[pid] && name) state.sides[pid].name = name;
      break;
    }
    case 'teampreview': state.teamPreview = { pick: Number(parts[2]) || 4 }; break;
    case 'clearpoke': state.sides.p1.preview = []; state.sides.p2.preview = []; break;
    case 'poke': {
      const [, , pid, details] = parts;
      if (state.sides[pid]) state.sides[pid].preview.push({ species: speciesFromDetails(details), details });
      break;
    }
    case 'start': state.started = true; break;
    case 'turn': {
      state.turn = Number(parts[2]);
      // A Protect streak survives only if the Pokémon protected on the previous turn.
      for (const s of Object.values(state.sides)) {
        for (const m of s.active) if (m && m.protectedTurn !== state.turn - 1) m.protectStreak = 0;
      }
      break;
    }
    case 'switch': case 'drag': case 'replace': {
      const pos = parsePos(parts[2]);
      if (!pos) break;
      const mon = { ident: parts[2], species: speciesFromDetails(parts[3]), details: parts[3],
                    ...parseHP(parts[4]), boosts: {}, mega: false,
                    moveActions: 0, protectStreak: 0, protectedTurn: -1, lastMove: null };
      Object.assign(mon, sideOf(pos).known[mon.species] || {});   // remembered item/ability
      sideOf(pos).active[pos.slot] = mon;
      break;
    }
    case 'detailschange': case '-formechange': {
      const mon = activeOf(parsePos(parts[2]));
      if (mon) { mon.species = speciesFromDetails(parts[3]); mon.details = parts[3]; }
      break;
    }
    case '-mega': {
      const mon = activeOf(parsePos(parts[2]));
      if (mon) { mon.mega = true; if (parts[4]) mon.item = parts[4]; }
      break;
    }
    case '-damage': case '-heal': case '-sethp': {
      const mon = activeOf(parsePos(parts[2]));
      if (!mon) break;
      const hp = parseHP(parts[3]);
      if (hp.fainted) { mon.hp = 0; mon.fainted = true; mon.status = 'fnt'; }   // keep maxhp
      else Object.assign(mon, hp);
      break;
    }
    case 'faint': {
      const mon = activeOf(parsePos(parts[2]));
      if (mon) { mon.hp = 0; mon.fainted = true; mon.status = 'fnt'; }
      break;
    }
    case 'move': {
      // Counts move attempts since switching in (Fake Out / First Impression only work
      // before the first one) and remembers moves the opponent has revealed.
      const pos = parsePos(parts[2]);
      const mon = activeOf(pos);
      if (mon) {
        mon.moveActions = (mon.moveActions || 0) + 1;
        mon.lastMove = parts[3] || null;
        const k = (sideOf(pos).known[mon.species] ||= {});
        k.moves = k.moves || [];
        if (parts[3] && !k.moves.includes(parts[3])) k.moves.push(parts[3]);
      }
      break;
    }
    case 'cant': { const mon = activeOf(parsePos(parts[2])); if (mon) mon.moveActions = (mon.moveActions || 0) + 1; break; }
    case '-singleturn': {
      // Successful Protect / Detect / Spiky Shield / ... / Endure: the streak grows.
      const mon = activeOf(parsePos(parts[2]));
      if (mon && /^(move: )?(Protect|Endure)$/.test(parts[3] || '')) {
        mon.protectStreak = (mon.protectStreak || 0) + 1;
        mon.protectedTurn = state.turn;
      }
      break;
    }
    case '-fail': {
      // A failed Protect resets the engine's counter.
      const mon = activeOf(parsePos(parts[2]));
      if (mon && STALL_MOVES.has(toID(mon.lastMove))) mon.protectStreak = 0;
      break;
    }
    case '-status': { const mon = activeOf(parsePos(parts[2])); if (mon) mon.status = parts[3]; break; }
    case '-curestatus': {
      const mon = activeOf(parsePos(parts[2]));
      if (mon && (!parts[3] || mon.status === parts[3])) mon.status = null;
      break;
    }
    case '-boost': case '-unboost': {
      const mon = activeOf(parsePos(parts[2]));
      if (mon) {
        const n = Number(parts[4]) * (cmd === '-boost' ? 1 : -1);
        mon.boosts[parts[3]] = Math.max(-6, Math.min(6, (mon.boosts[parts[3]] || 0) + n));
        if (!mon.boosts[parts[3]]) delete mon.boosts[parts[3]];
      }
      break;
    }
    case '-setboost': { const mon = activeOf(parsePos(parts[2])); if (mon) mon.boosts[parts[3]] = Number(parts[4]); break; }
    case '-clearboost': case '-clearnegativeboost': case '-clearpositiveboost': {
      const mon = activeOf(parsePos(parts[2]));
      if (mon) {
        for (const k of Object.keys(mon.boosts)) {
          if (cmd === '-clearboost' || (cmd === '-clearnegativeboost' && mon.boosts[k] < 0)
              || (cmd === '-clearpositiveboost' && mon.boosts[k] > 0)) delete mon.boosts[k];
        }
      }
      break;
    }
    case '-clearallboost': {
      for (const s of Object.values(state.sides)) for (const m of s.active) if (m) m.boosts = {};
      break;
    }
    case '-item': case '-enditem': {
      const pos = parsePos(parts[2]);
      const mon = activeOf(pos);
      if (mon) {
        mon.item = cmd === '-item' ? parts[3] : '';
        (sideOf(pos).known[mon.species] ||= {}).item = mon.item;
      }
      break;
    }
    case '-ability': {
      const pos = parsePos(parts[2]);
      const mon = activeOf(pos);
      if (mon) {
        mon.ability = parts[3];
        (sideOf(pos).known[mon.species] ||= {}).ability = parts[3];
      }
      break;
    }
    case '-weather': {
      const w = parts[2];
      state.field.weather = !w || w === 'none' ? null : w;
      break;
    }
    case '-fieldstart': case '-fieldend': {
      const name = clean(parts[2]);
      if (cmd === '-fieldstart') {
        if (/Terrain$/.test(name)) state.field.terrain = name;
        else if (!state.field.pseudo.includes(name)) state.field.pseudo.push(name);
      } else {
        if (state.field.terrain === name) state.field.terrain = null;
        state.field.pseudo = state.field.pseudo.filter((x) => x !== name);
      }
      break;
    }
    case '-sidestart': case '-sideend': {
      const side = sideOf(parsePos(parts[2]));
      const name = clean(parts[3]);
      if (!side) break;
      if (cmd === '-sidestart') { if (!side.conditions.includes(name)) side.conditions.push(name); }
      else side.conditions = side.conditions.filter((x) => x !== name);
      break;
    }
    case 'win': state.ended = true; state.winner = parts[2]; state.request = null; return { ended: true };
    case 'tie': state.ended = true; state.winner = null; state.request = null; return { ended: true };
    default: break;
  }
  return { ended: false };
}

/** Mirror a player's own side from its |request| payload (exact HP, moves, items, stats). */
export function syncOwnSide(state, side) {
  if (!side) return;
  const s = state.sides[side.id] || state.sides.p1;
  s.name = side.name || s.name;
  s.pokemon = side.pokemon.map((p) => ({
    ident: p.ident, species: speciesFromDetails(p.details), details: p.details,
    ...parseHP(p.condition), active: !!p.active, item: p.item || '',
    ability: p.ability || p.baseAbility || '', moves: p.moves || [], stats: p.stats || null,
  }));
}
