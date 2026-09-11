import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { DataCtx } from '../App.jsx';
import { get } from '../api.js';

const STAT_LABELS = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
export const MAX_SP_TOTAL = 66;
export const MAX_SP_STAT = 32;

export function TypeChip({ t }) {
  return <span className={`type-chip type-${t.toLowerCase()}`}>{t}</span>;
}

// ---- field effect listings (Damage Calc field panel, Battle tab field strip) ----
export const FIELD_EFFECTS = {
  terrain: {
    electric: [
      'Electric moves x1.3 from grounded users',
      'Grounded Pokémon cannot fall asleep (Yawn fails on them)',
      'Rising Voltage doubles into grounded targets · Terrain Pulse becomes Electric, 100 BP',
      'Surge Surfer doubles Speed · Electric Seed gives +1 Def',
    ],
    grassy: [
      'Grass moves x1.3 from grounded users',
      'Grounded Pokémon heal 1/16 of their HP each turn',
      'Earthquake, Bulldoze and Magnitude do half damage to grounded targets',
      'Grassy Glide gets +1 priority (grounded user) · Terrain Pulse becomes Grass, 100 BP · Grassy Seed gives +1 Def',
    ],
    psychic: [
      'Psychic moves x1.3 from grounded users',
      'Grounded Pokémon cannot be hit by priority moves aimed at them: Fake Out, Sucker Punch, Aqua Jet, Extreme Speed, Prankster status moves (moves on an ally still work)',
      'Expanding Force x1.5 and hits both opponents (grounded user) · Terrain Pulse becomes Psychic, 100 BP',
      'Psychic Seed gives +1 SpD',
    ],
    misty: [
      'Dragon moves do half damage to grounded targets',
      'Grounded Pokémon cannot be statused or confused (a status they already have stays)',
      'Misty Explosion x1.5 (grounded user) · Terrain Pulse becomes Fairy, 100 BP',
      'Misty Seed gives +1 SpD',
    ],
  },
  weather: {
    sun: [
      'Fire moves x1.5, Water moves x0.5 · nothing can be frozen',
      'Solar Beam and Solar Blade skip their charge turn · Weather Ball is Fire, 100 BP',
      'Chlorophyll doubles Speed · Solar Power, Flower Gift, Leaf Guard, Dry Skin (damage) apply',
    ],
    rain: [
      'Water moves x1.5, Fire moves x0.5',
      'Hurricane and Thunder never miss · Electro Shot skips its charge turn · Weather Ball is Water, 100 BP',
      'Swift Swim doubles Speed · Rain Dish and Dry Skin heal',
    ],
    sand: [
      'Rock types get x1.5 Sp. Def',
      '1/16 chip damage each turn to anything not Rock, Ground or Steel (Overcoat, Sand Veil, Sand Rush, Sand Force are exempt)',
      'Sand Rush doubles Speed · Sand Force x1.3 on Rock, Ground and Steel moves · Weather Ball is Rock, 100 BP',
    ],
    snow: [
      'Ice types get x1.5 Defense',
      'Blizzard never misses · Aurora Veil can be set · Weather Ball is Ice, 100 BP',
      'Slush Rush doubles Speed · Ice Body heals',
    ],
  },
};
// Terrains and weather last 5 turns (8 with the matching Rock for weather).
export function FieldEffects({ kind, k, className = '' }) {
  const lines = FIELD_EFFECTS[kind]?.[k];
  if (!lines) return null;
  return (
    <ul className={`field-effects ${className}`}>
      {lines.map((l) => <li key={l}>{l}</li>)}
    </ul>
  );
}

// ---- move labels: category icon, the flags abilities and items key off, accuracy ----
const CATEGORY_INFO = {
  Physical: { glyph: '⚔', desc: 'Physical: Attack against Defense' },
  Special: { glyph: '✦', desc: 'Special: Sp. Atk against Sp. Def' },
  Status: { glyph: '◌', desc: 'Status: no damage' },
};
export function CategoryIcon({ category, withText = false }) {
  const info = CATEGORY_INFO[category] || CATEGORY_INFO.Status;
  return (
    <span className={`cat-icon cat-${String(category || 'status').toLowerCase()}`} title={info.desc}>
      {info.glyph}{withText && <span className="cat-text">{category}</span>}
    </span>
  );
}
// [flag, glyph, label, why it matters in Champions]
const FLAG_TAGS = [
  ['contact', '👊', 'Contact', 'Contact move: Rough Skin, Rocky Helmet, Poison Touch, Spicy Spray, Tough Claws and Aura Guard apply'],
  ['sound', '🔊', 'Sound', 'Sound move: goes through Substitute; blocked by Soundproof; Liquid Voice makes it Water; Punk Rock'],
  ['pulse', '🌀', 'Pulse', 'Pulse move: Mega Launcher x1.5'],
  ['bullet', '⚫', 'Ball', 'Ball / bomb move: blocked by Bulletproof'],
  ['punch', '🥊', 'Punch', 'Punch move: Iron Fist x1.2'],
  ['bite', '🦷', 'Bite', 'Biting move: Strong Jaw x1.5'],
  ['slicing', '🔪', 'Slicing', 'Slicing move: Sharpness x1.5'],
  ['wind', '🌬', 'Wind', 'Wind move: Wind Rider / Wind Power'],
  ['dance', '💃', 'Dance', 'Dance move: copied by Dancer'],
  ['powder', '🌫', 'Powder', 'Powder move: Grass types, Overcoat and Safety Goggles are immune'],
  ['charge', '⏳', 'Charge', 'Charges for a turn first (weather or Power Herb can skip it)'],
  ['recharge', '💤', 'Recharge', 'Must recharge the turn after it hits'],
];
const SPREAD_TARGETS = { allAdjacentFoes: 'both opponents', allAdjacent: 'everyone else, your partner included' };
export const accuracyLabel = (m) => (m == null || m.accuracy == null ? '—' : `${m.accuracy}%`);
export function AccuracyLabel({ m }) {
  if (!m) return null;
  return (
    <span className="move-acc mono" title={m.accuracy == null ? 'Never misses' : `${m.accuracy}% accuracy`}>
      {accuracyLabel(m)}
    </span>
  );
}
// Category, spread / priority and flag tags for a move-db entry. `compact`
// shows glyphs only (the tooltip keeps the words).
export function moveTagList(m) {
  if (!m) return [];
  const flags = m.flags || {};
  const out = [];
  const spread = SPREAD_TARGETS[m.target];
  if (spread) out.push({ key: 'spread', glyph: '⇶', label: 'Spread', desc: `Spread move: hits ${spread} (x0.75 with two targets)` });
  if (m.priority) {
    const p = `${m.priority > 0 ? '+' : ''}${m.priority}`;
    out.push({ key: 'priority', glyph: `⚡${p}`, label: `Priority ${p}`, desc: `Priority ${p}: moves ${m.priority > 0 ? 'before' : 'after'} normal-priority moves` });
  }
  for (const [f, glyph, label, desc] of FLAG_TAGS) if (flags[f]) out.push({ key: f, glyph, label, desc });
  return out;
}
// `compact` shows glyphs only (the tooltip keeps the words); `max` folds the
// rest into a "+n" tag so rows stay one line.
export function MoveTags({ m, compact = false, showCategory = true, showAccuracy = false, max = Infinity }) {
  if (!m) return null;
  const tags = moveTagList(m);
  const shown = tags.slice(0, max);
  const rest = tags.slice(max);
  return (
    <span className={`move-tags ${compact ? 'compact' : ''}`}>
      {showCategory && <CategoryIcon category={m.category} withText={!compact} />}
      {shown.map((t) => (
        <span key={t.key} className={`move-tag flag-${t.key}`} title={t.desc}>{t.glyph}{!compact && ` ${t.label}`}</span>
      ))}
      {rest.length > 0 && (
        <span className="move-tag more" title={rest.map((t) => t.label).join(', ')}>+{rest.length}</span>
      )}
      {showAccuracy && <AccuracyLabel m={m} />}
    </span>
  );
}

export function PokemonPicker({ value, onPick, placeholder = 'Search Pokémon…' }) {
  const { pokemon } = useContext(DataCtx);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  const selected = pokemon.find((p) => p.id === value);
  const results = useMemo(() => {
    if (!query) return pokemon.slice(0, 12);
    const q = query.toLowerCase();
    return pokemon.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 12);
  }, [pokemon, query]);

  useEffect(() => {
    const close = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  return (
    <div className="picker" ref={boxRef}>
      <input
        value={open ? query : selected ? selected.name : ''}
        placeholder={placeholder}
        onFocus={() => { setOpen(true); setQuery(''); }}
        onChange={(e) => setQuery(e.target.value)}
      />
      {selected && !open && (
        <span className="picker-types">
          {selected.types.map((t) => <TypeChip key={t} t={t} />)}
        </span>
      )}
      {open && (
        <ul className="picker-list">
          {results.map((p) => (
            <li key={p.id}
                onMouseDown={(e) => { e.preventDefault(); onPick(p); setOpen(false); }}>
              <span>
                {p.name}
                {p.abilities_provisional && (
                  <span className="prov-tag" style={{ marginLeft: 6 }}
                    title="Champions hasn't announced this form's ability — set one in the Team Builder">
                    ability?
                  </span>
                )}
                {p.experimental && (
                  <span className="prov-tag" style={{ marginLeft: 6 }}
                    title="A prediction from Reg M-C Experimental, not a confirmed Champions Pokémon">
                    predicted
                  </span>
                )}
              </span>
              <span className="picker-types">
                {p.types.map((t) => <TypeChip key={t} t={t} />)}
              </span>
              <span className="mono dim">{p.base.hp}/{p.base.atk}/{p.base.def}/{p.base.spa}/{p.base.spd}/{p.base.spe}</span>
            </li>
          ))}
          {results.length === 0 && <li className="dim">No matches</li>}
        </ul>
      )}
    </div>
  );
}

export function SpreadEditor({ spread, onChange }) {
  const total = Object.values(spread).reduce((a, b) => a + b, 0);
  const remaining = MAX_SP_TOTAL - total;
  const set = (k, v) => {
    v = Math.max(0, Math.min(MAX_SP_STAT, Number(v) || 0));
    const next = { ...spread, [k]: v };
    const nextTotal = Object.values(next).reduce((a, b) => a + b, 0);
    if (nextTotal <= MAX_SP_TOTAL) onChange(next);
  };
  return (
    <div className="spread">
      <div className="spread-grid">
        {Object.keys(STAT_LABELS).map((k) => (
          <label key={k}>
            <span>{STAT_LABELS[k]}</span>
            <input
              type="number" min="0" max={MAX_SP_STAT}
              value={spread[k]}
              onChange={(e) => set(k, e.target.value)}
              className="mono"
            />
          </label>
        ))}
      </div>
      <div className="sp-budget">
        <div className="sp-bar">
          <div className="sp-fill" style={{ width: `${(total / MAX_SP_TOTAL) * 100}%` }} />
        </div>
        <span className={`mono ${remaining === 0 ? 'ok' : ''}`}>{total}/{MAX_SP_TOTAL} SP</span>
      </div>
    </div>
  );
}

export function useLearnset(pokemonId) {
  const [moves, setMoves] = useState([]);
  useEffect(() => {
    if (!pokemonId) { setMoves([]); return; }
    let live = true;
    get(`/pokemon/${pokemonId}/learnset`)
      .then((r) => live && setMoves(r.moves))
      .catch(() => live && setMoves([]));
    return () => { live = false; };
  }, [pokemonId]);
  return moves;
}

export function useFullMon(pokemonId) {
  // dataVersion is bumped by App when server-side data is edited (e.g. a
  // provisional ability saved), so an already-loaded form refetches.
  const { dataVersion } = useContext(DataCtx) || {};
  const [mon, setMon] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!pokemonId) { setMon(null); setError(null); return; }
    let live = true;
    setError(null);
    get(`/pokemon/${pokemonId}`)
      .then((m) => live && setMon(m))
      .catch((e) => live && (setMon(null), setError(e.message)));
    return () => { live = false; };
  }, [pokemonId, dataVersion]);
  return { mon, error };
}

export function MoveSelect({ moves, value, onChange, placeholder = '— move —' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const boxRef = useRef(null);
  const selected = moves.find((m) => m.name === value);
  const shown = query
    ? moves.filter((m) => m.name.toLowerCase().includes(query.toLowerCase()))
    : moves;

  const close = () => { setOpen(false); setQuery(''); };

  return (
    <div className="move-select" ref={boxRef} tabIndex={-1}
      onBlur={(e) => {
        if (!boxRef.current.contains(e.relatedTarget)) close();
      }}>
      <button type="button" className="move-select-btn"
        onClick={() => (open ? close() : setOpen(true))}>
        {selected ? (
          <>
            <span className="ms-name">{selected.name}</span>
            <span className="ms-meta">
              <TypeChip t={selected.type} />
              <CategoryIcon category={selected.category} />
              <MoveTags m={selected} compact showCategory={false} max={3} />
              <span className="ms-bp mono" title="base power">{pickerBp(selected)}</span>
              <AccuracyLabel m={selected} />
            </span>
          </>
        ) : (
          <span className="dim">{placeholder}</span>
        )}
      </button>
      {open && (
        <div className="move-select-pop">
          <input autoFocus placeholder="Filter moves…" value={query}
            onChange={(e) => setQuery(e.target.value)} />
          <div className="ms-head dim">
            <span>Move</span><span>Type</span><span title="Physical / Special / Status">Cat</span>
            <span title="Spread, priority, contact, sound, pulse, ball, punch, bite, slicing, wind, dance, powder, charge, recharge — hover a glyph">Flags</span>
            <span title="base power">BP</span><span title="accuracy">Acc</span>
          </div>
          <ul>
            {value && (
              <li className="ms-clear" onMouseDown={(e) => {
                e.preventDefault(); onChange(''); close();
              }}>× clear move</li>
            )}
            {shown.map((m) => (
              <li key={m.name} title={m.short_desc || m.category}
                className={m.name === value ? 'active' : ''}
                onMouseDown={(e) => {
                  e.preventDefault(); onChange(m.name); close();
                }}>
                <span className="ms-name">{m.name}</span>
                <TypeChip t={m.type} />
                <CategoryIcon category={m.category} />
                <MoveTags m={m} compact showCategory={false} max={3} />
                <span className="ms-bp mono" title="base power">{pickerBp(m)}</span>
                <AccuracyLabel m={m} />
              </li>
            ))}
            {!shown.length && <li className="dim">no matches</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

// Items scoped to an experimental regulation are labelled so a prediction is
// never mistaken for a confirmed Champions item.
export const itemLabel = (i) => (i.experimental ? `${i.name} · predicted` : i.name);

// The Mega Stones a base form can hold: every stone whose mega form belongs to
// this species (gender variants share one stone, so Meowstic-M can hold the
// stone that lists meowstic-f-mega). A mega form itself has its stone locked.
const speciesRoot = (id) => String(id || '').replace(/-mega(-[xyz])?$/, '').replace(/-(m|f)$/, '');
export function stonesFor(mon, items) {
  if (!mon || mon.mega_of || !items) return [];
  const root = speciesRoot(mon.id);
  return items.filter((i) => i.category === 'mega_stone' && i.mega_form && speciesRoot(i.mega_form) === root);
}

// The form a slot can switch to: a base form holding its own stone becomes
// the Mega the stone names (the species' own gender variant when the stone
// lists the other one); a Mega goes back to its base form. `mon` may be the
// full pokedex entry or just {id}; `roster` is the /pokemon list, used to
// resolve gendered megas when the full entry is not loaded.
export function megaSwitchTarget(slot, mon, items, roster) {
  const id = slot?.pokemonId;
  if (!id) return null;
  const isMega = !!(mon?.mega_of) || /-mega(-[xyz])?$/.test(id);
  if (isMega) return { id: mon?.mega_of || id.replace(/-mega(-[xyz])?$/, ''), label: 'Base form', mega: false };
  const stone = (items || []).find((i) => i.category === 'mega_stone' && i.name === slot.item);
  if (!stone?.mega_form || speciesRoot(stone.mega_form) !== speciesRoot(id)) return null;
  const forms = mon?.mega_forms || [];
  const own = `${id}-mega`;
  const known = (x) => forms.includes(x) || (roster || []).some((p) => p.id === x);
  const target = forms.includes(stone.mega_form) ? stone.mega_form : (known(own) ? own : stone.mega_form);
  return { id: target, label: 'Mega Evolve', mega: true };
}

// Switch a slot to another form of the same species, keeping spread, alignment,
// moves, item and nickname. The ability follows the form: kept if the new form
// has it, otherwise the form's first ability (blank for an unannounced one).
export async function switchForm(slot, targetId) {
  const full = await get(`/pokemon/${targetId}`);
  const abilities = full.abilities || [];
  const ability = abilities.includes(slot.ability) ? slot.ability : (abilities[0] || '');
  return { ...slot, pokemonId: full.id, displayName: full.name, types: full.types, ability,
           item: full.mega_stone || slot.item, itemUserSet: true };
}

export function CombatantPanel({ slot, onChange, title, withBattleState = false }) {
  const { alignments, items } = useContext(DataCtx);
  const { mon } = useFullMon(slot.pokemonId);
  const upd = (patch) => onChange({ ...slot, ...patch });

  const grouped = useMemo(() => ({
    held: items.filter((i) => i.category === 'held'),
    berry: items.filter((i) => i.category === 'berry'),
    mega_stone: items.filter((i) => i.category === 'mega_stone'),
  }), [items]);

  return (
    <section className="panel">
      {title && <h3 className="panel-title">{title}</h3>}
      <PokemonPicker
        value={slot.pokemonId}
        onPick={(p) => upd({ pokemonId: p.id, ability: '', moves: ['', '', '', ''] })}
      />
      {mon && (
        <>
          <div className="row">
            <label>
              Ability
              <select value={slot.ability} onChange={(e) => upd({ ability: e.target.value })}>
                <option value="">{mon.abilities[0] ? `${mon.abilities[0]} (default)` : '—'}</option>
                {mon.abilities.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
            <label>
              Item
              <select value={slot.item} onChange={(e) => upd({ item: e.target.value })}>
                <option value="">None</option>
                <optgroup label="Held items">
                  {grouped.held.map((i) => <option key={i.id} value={i.name}>{itemLabel(i)}</option>)}
                </optgroup>
                <optgroup label="Berries">
                  {grouped.berry.map((i) => <option key={i.id} value={i.name}>{itemLabel(i)}</option>)}
                </optgroup>
                <optgroup label="Mega stones">
                  {grouped.mega_stone.map((i) => <option key={i.id} value={i.name}>{itemLabel(i)}</option>)}
                </optgroup>
              </select>
            </label>
            <label>
              Alignment
              <select value={slot.alignment} onChange={(e) => upd({ alignment: e.target.value })}>
                {Object.entries(alignments).map(([name, a]) => (
                  <option key={name} value={name}>
                    {name}
                    {a.boost ? ` (+${STAT_LABELS[a.boost]} −${STAT_LABELS[a.reduce]})` : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <SpreadEditor spread={slot.spread} onChange={(spread) => upd({ spread })} />
          {withBattleState && (
            <div className="row battle-state">
              <label>
                Status
                <select value={slot.status || ''} onChange={(e) => upd({ status: e.target.value || null })}>
                  <option value="">Healthy</option>
                  <option value="burn">Burned</option>
                  <option value="paralysis">Paralyzed</option>
                </select>
              </label>
              {['atk', 'def', 'spa', 'spd'].map((k) => (
                <label key={k}>
                  {STAT_LABELS[k]} stage
                  <select
                    value={slot.stages?.[k] || 0}
                    onChange={(e) => upd({ stages: { ...slot.stages, [k]: Number(e.target.value) } })}
                    className="mono"
                  >
                    {[-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6].map((s) => (
                      <option key={s} value={s}>{s > 0 ? `+${s}` : s}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/* ---- sprites (Showdown CDN with fallback chain) ---- */
const SPRITE_FIXES = {
  'tauros-paldea-combat': 'tauros-paldeacombat',
  'tauros-paldea-blaze': 'tauros-paldeablaze',
  'tauros-paldea-aqua': 'tauros-paldeaaqua',
  'lycanroc-day': 'lycanroc',
  'lycanroc-night': 'lycanroc-midnight',
  'basculegion-m': 'basculegion',
  'palafin-zero': 'palafin',
  'kommo-o': 'kommoo',
  'hakamo-o': 'hakamoo',
  'jangmo-o': 'jangmoo',
  'mr-rime': 'mrrime',
  'mr-mime': 'mrmime',
  'farfetch-d': 'farfetchd',
  'sirfetch-d': 'sirfetchd',
  'mime-jr': 'mimejr',
  'porygon-z': 'porygonz',
  'ho-oh': 'hooh',
};

export function spriteId(id) {
  if (SPRITE_FIXES[id]) return SPRITE_FIXES[id];
  return id
    .replace('-mega-x', '-megax')
    .replace('-mega-y', '-megay')
    .replace('-mega-z', '-megaz')
    .replace('meowstic-m-mega', 'meowstic-mega')
    .replace(/^meowstic-m$/, 'meowstic');
}

// Candidate sprite names, most-likely first. Showdown's filename
// conventions vary (suffix joined, all punctuation stripped), and brand-new
// Champions/Z-A megas may not exist at all — those fall back to the base
// form's sprite rather than a placeholder.
function spriteCandidates(id) {
  const sid = spriteId(id);
  const names = [sid];
  const parts = sid.split('-');
  if (parts.length >= 3) names.push(`${parts[0]}-${parts.slice(1).join('')}`);
  if (parts.length >= 2) names.push(parts.join(''));
  if (/-mega/.test(id)) {
    // New megas missing from the CDN fall back to the base form's sprite.
    names.push(spriteId(id.replace(/-mega(-[xyz])?$/, '')));
  }
  return [...new Set(names)];
}

export function Sprite({ id, size = 72, title }) {
  const [stage, setStage] = useState(0);
  useEffect(() => setStage(0), [id]);
  if (!id) return null;
  const urls = [];
  for (const n of spriteCandidates(id)) {
    urls.push(`https://play.pokemonshowdown.com/sprites/home/${n}.png`);
    urls.push(`https://play.pokemonshowdown.com/sprites/dex/${n}.png`);
  }
  urls.push(`https://play.pokemonshowdown.com/sprites/gen5/${spriteId(id)}.png`);
  if (stage >= urls.length)
    return (
      <div className="sprite-fallback" title={title || undefined}
        style={{ width: size, height: size }}>?</div>
    );
  return (
    <img
      className="sprite"
      src={urls[stage]}
      width={size}
      height={size}
      alt={title || id}
      title={title || undefined}
      onError={() => setStage(stage + 1)}
    />
  );
}

/* ---- client-side stat math (mirrors core/stats.py exactly) ---- */
export function calcStats(base, spread, alignment, alignments) {
  const a = alignments[alignment] || {};
  const out = { hp: Math.floor((2 * base.hp + 31 + 2 * spread.hp) / 2) + 60 };
  for (const k of ['atk', 'def', 'spa', 'spd', 'spe']) {
    const mult = a.boost === k ? 1.1 : a.reduce === k ? 0.9 : 1.0;
    out[k] = Math.floor((Math.floor((2 * base[k] + 31 + 2 * spread[k]) / 2) + 5) * mult);
  }
  return out;
}

/* ---- vertical stat rows: base / slider / input / computed total ---- */
const STAGES = [6, 5, 4, 3, 2, 1, 0, -1, -2, -3, -4, -5, -6];
const STAGE_STATS = new Set(['atk', 'def', 'spa', 'spd', 'spe']);

// Mirror of the backend apply_stage: floor(stat*(2+n)/2) up, floor(stat*2/(2-n)) down.
function applyStage(stat, stage) {
  if (!stage) return stat;
  return stage > 0
    ? Math.floor((stat * (2 + stage)) / 2)
    : Math.floor((stat * 2) / (2 - stage));
}

// Full-width HP bar (Damage Calc) — green/yellow/red, with live HP values.
export function HpBarFull({ baseStats, spread, alignment, pct, onChange }) {
  const { alignments } = useContext(DataCtx);
  const maxHp = calcStats(baseStats, spread, alignment, alignments).hp;
  const p = pct ?? 100;
  const cur = Math.round((maxHp * p) / 100);
  const color = p > 50 ? '#3fb950' : p > 20 ? '#d8a629' : '#f85149';
  return (
    <div className="hp-bar-full">
      <span className="hp-bar-full-label">HP</span>
      <input type="range" min="1" max="100" value={p} className="hp-bar"
        style={{ background: `linear-gradient(to right, ${color} ${p}%, #243044 ${p}%)` }}
        onChange={(e) => onChange(Number(e.target.value))} />
      <span className="mono hp-bar-full-val">{cur} / {maxHp} · {p}%</span>
    </div>
  );
}

export function StatPointsEditor({ baseStats, spread, alignment, onChange,
                                  stages, onStage }) {
  const { alignments } = useContext(DataCtx);
  const total = Object.values(spread).reduce((a, b) => a + b, 0);
  const finals = calcStats(baseStats, spread, alignment, alignments);
  const align = alignments[alignment] || {};
  const calcMode = !!onStage;
  const set = (k, v) => {
    v = Math.max(0, Math.min(MAX_SP_STAT, Number(v) || 0));
    const next = { ...spread, [k]: v };
    if (Object.values(next).reduce((a, b) => a + b, 0) <= MAX_SP_TOTAL) onChange(next);
  };
  const LABELS = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
  return (
    <div className={`statpoints ${calcMode ? 'statpoints-calc' : ''}`}>
      <div className="statpoints-head">
        <span>STAT POINTS</span>
        <span className={`mono ${total === MAX_SP_TOTAL ? 'danger' : 'dim'}`}>
          {total}/{MAX_SP_TOTAL}
        </span>
      </div>
      {Object.keys(LABELS).map((k) => {
        const stage = calcMode && STAGE_STATS.has(k) ? (stages?.[k] || 0) : 0;
        const shown = applyStage(finals[k], stage);
        const totalClass = stage > 0 ? 'stat-up' : stage < 0 ? 'stat-down'
          : align.boost === k ? 'warn' : align.reduce === k ? 'cool' : '';
        return (
        <div className="stat-row" key={k}>
          <span className={`stat-label ${align.boost === k ? 'warn' : align.reduce === k ? 'cool' : ''}`}>
            {LABELS[k]}
          </span>
          <span className="mono dim stat-base">{baseStats[k]}</span>
          <input
            type="range" min="0" max={MAX_SP_STAT}
            value={spread[k]}
            onChange={(e) => set(k, e.target.value)}
          />
          <input
            type="number" min="0" max={MAX_SP_STAT}
            className="mono stat-num"
            value={spread[k]}
            onChange={(e) => set(k, e.target.value)}
          />
          {calcMode && (
            STAGE_STATS.has(k) ? (
              <select className="stat-stage mono" value={stages?.[k] || 0}
                onChange={(e) => onStage(k, Number(e.target.value))}>
                {STAGES.map((s) => (
                  <option key={s} value={s}>{s > 0 ? `+${s}` : s}</option>
                ))}
              </select>
            ) : (
              <span className="stat-mod-empty" />
            )
          )}
          <span className={`mono stat-total ${totalClass}`}>
            {shown}
          </span>
        </div>
        );
      })}
    </div>
  );
}

// Sliding on/off toggle switch — used for the Damage Calc field/side booleans.
export function Toggle({ checked, onChange, label, small }) {
  return (
    <label className={`switch ${small ? 'switch-sm' : ''}`}>
      <input type="checkbox" checked={!!checked} onChange={onChange} />
      <span className="switch-track"><span className="switch-thumb" /></span>
      {label && <span className="switch-label">{label}</span>}
    </label>
  );
}

// Base power label for move lists. Weight-based moves have no fixed number (Low
// Kick into a 460 kg Snorlax is 120 BP; the calc works it out from the weights),
// other variable-power moves show '?'.
const WEIGHT_MOVES = new Set(['Low Kick', 'Grass Knot', 'Heavy Slam', 'Heat Crash']);
export function bpLabel(m) {
  if (m.category === 'Status') return 'Status';
  if (m.base_power) return m.base_power;
  return WEIGHT_MOVES.has(m.name) ? 'wt' : '?';
}
// The move picker shows the category as an icon, so its BP cell needs no word.
const pickerBp = (m) => (m.category === 'Status' ? '—' : bpLabel(m));
