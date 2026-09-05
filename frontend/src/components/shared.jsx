import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { DataCtx } from '../App.jsx';
import { get } from '../api.js';

const STAT_LABELS = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
export const MAX_SP_TOTAL = 66;
export const MAX_SP_STAT = 32;

export function TypeChip({ t }) {
  return <span className={`type-chip type-${t.toLowerCase()}`}>{t}</span>;
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
              <span className="ms-bp mono">{selected.category === 'Status'
                ? 'Status' : selected.base_power}</span>
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
          <ul>
            {value && (
              <li className="ms-clear" onMouseDown={(e) => {
                e.preventDefault(); onChange(''); close();
              }}>× clear move</li>
            )}
            {shown.map((m) => (
              <li key={m.name} title={m.category}
                className={m.name === value ? 'active' : ''}
                onMouseDown={(e) => {
                  e.preventDefault(); onChange(m.name); close();
                }}>
                <span className="ms-name">{m.name}</span>
                <TypeChip t={m.type} />
                <span className="ms-bp mono">{m.category === 'Status'
                  ? 'Status' : m.base_power}</span>
              </li>
            ))}
            {!shown.length && <li className="dim">no matches</li>}
          </ul>
        </div>
      )}
    </div>
  );
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
                  {grouped.held.map((i) => <option key={i.id} value={i.name}>{i.name}</option>)}
                </optgroup>
                <optgroup label="Berries">
                  {grouped.berry.map((i) => <option key={i.id} value={i.name}>{i.name}</option>)}
                </optgroup>
                <optgroup label="Mega stones">
                  {grouped.mega_stone.map((i) => <option key={i.id} value={i.name}>{i.name}</option>)}
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
