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
  spread: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
  alignment: 'Serious',
  ability: '',
  item: '',
  stages: {},
  status: null,
  moves: ['', '', '', ''],
});

export const SETS_KEY = 'vgc-toolkit-sets-v1';
export const loadSets = () => {
  try { return JSON.parse(localStorage.getItem(SETS_KEY)) || []; }
  catch { return []; }
};
