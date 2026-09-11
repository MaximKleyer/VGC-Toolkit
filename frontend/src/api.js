const BASE = '/api';

async function handle(resp) {
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    let detail = body.detail;
    // FastAPI 422s return a list of {loc, msg}; render them readably instead
    // of letting the banner show "[object Object]".
    if (Array.isArray(detail))
      detail = detail
        .map((d) => `${(d.loc || []).slice(1).join('.')}: ${d.msg}`.replace(/^: /, ''))
        .join('; ');
    throw new Error(detail || `${resp.status} ${resp.statusText}`);
  }
  return resp.json();
}

export const get = (path) => fetch(BASE + path).then(handle);
export const post = (path, body) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(handle);
export const put = (path, body) =>
  fetch(BASE + path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(handle);

// A Combatant payload from UI slot state.
// The Showdown sidecar (sim/server.mjs), reached through the Vite `/sim` proxy.
async function simFetch(path, opts) {
  const r = await fetch('/sim' + path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || `${r.status} ${r.statusText}`), { body });
  return body;
}
export const simGet = (p) => simFetch(p);
export const simPost = (p, b) => simFetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
export const simDelete = (p) => simFetch(p, { method: 'DELETE' });

export function combatant(slot) {
  return {
    pokemon_id: slot.pokemonId,
    spread: slot.spread,
    alignment: slot.alignment,
    ability: slot.ability || null,
    item: slot.item || null,
    stages: slot.stages || {},
    status: slot.status || null,
    current_hp_fraction: (slot.hpPct ?? 100) / 100,
    move_streak: slot.moveStreak || 0,   // Metronome item: prior consecutive uses
  };
}

export const emptySlot = () => ({
  pokemonId: null,
  nickname: '',
  spread: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
  alignment: 'Serious',
  ability: '',
  item: '',
  stages: {},
  status: null,
  moves: ['', '', '', ''],
});

// The team library: named teams of yours (kind "mine") and opponents' (kind
// "opponent"), shared by the Team Builder, Damage Calc, Team Preview and Battle tabs.
export const TEAMS_KEY = 'vgc-toolkit-teams-v1';
export const loadTeamLibrary = () => {
  try { return (JSON.parse(localStorage.getItem(TEAMS_KEY)) || []).map((t) => ({ kind: 'mine', ...t })); }
  catch { return []; }
};
export const emptyTeam = () => Array(6).fill(null).map(emptySlot);
export const padTeam = (slots) => {
  const out = (slots || []).slice(0, 6).map((s) => ({ ...emptySlot(), ...s }));
  while (out.length < 6) out.push(emptySlot());
  return out;
};
// A /team/import response -> six builder slots (names and types from the roster list).
export function slotsFromImport(r, pokemon) {
  return padTeam(r.team.map((m) => {
    const p = (pokemon || []).find((x) => x.id === m.pokemon.pokemon_id);
    return {
      ...emptySlot(), pokemonId: m.pokemon.pokemon_id, displayName: p?.name, types: p?.types || [],
      nickname: m.nickname || '', spread: m.pokemon.spread, alignment: m.pokemon.alignment,
      ability: m.pokemon.ability || '', item: m.pokemon.item || '', itemUserSet: !!m.pokemon.item,
      moves: [...m.moves, '', '', '', ''].slice(0, 4),
    };
  }));
}
// Builder slots -> the members of a /team/validate, /team/export or /team/playbook request.
export const teamMembers = (slots) => slots.filter((s) => s.pokemonId).map((s) => ({
  pokemon: combatant(s), moves: s.moves.filter(Boolean), nickname: s.nickname || null,
}));

export const SETS_KEY = 'vgc-toolkit-sets-v1';
export const loadSets = () => {
  try { return JSON.parse(localStorage.getItem(SETS_KEY)) || []; }
  catch { return []; }
};
