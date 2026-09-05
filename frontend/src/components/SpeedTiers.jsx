import React, { useEffect, useState } from 'react';
import { post, combatant } from '../api.js';
import { Sprite, TypeChip } from './shared.jsx';

const FIELD_DEFAULT = { weather: 'none', terrain: 'none', tailwind: false, opposing_tailwind: false, trick_room: false };
const POOL_DEFAULT = { sp: 32, alignment: 'boost' };
const ALIGN_OPTS = [['boost', '+Spe nature'], ['neutral', 'Neutral'], ['reduce', '−Spe nature']];

export default function SpeedTiers({ slots, regulation }) {
  const [field, setField] = useState(FIELD_DEFAULT);
  const [pool, setPool] = useState(POOL_DEFAULT);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('');
  const filled = slots.filter((s) => s.pokemonId);
  const key = JSON.stringify([filled.map(combatant), field, pool, regulation]);

  useEffect(() => {
    let live = true;
    // The pool must be the selected regulation's roster, not the backend default.
    post('/speed/tiers', { team: filled.map(combatant), field, pool, regulation })
      .then((r) => live && (setData(r), setError(null)))
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [key]); // eslint-disable-line

  const rows = (data?.rows || []).filter(
    (r) => !filter || r.name.toLowerCase().includes(filter.toLowerCase()) || r.is_team);

  return (
    <section className="panel speedtiers">
      <div className="speed-controls">
        <h3 className="panel-title">Speed tiers</h3>
        <label>
          Weather
          <select value={field.weather} onChange={(e) => setField({ ...field, weather: e.target.value })}>
            {['none', 'sun', 'rain', 'sand', 'snow'].map((w) => <option key={w}>{w}</option>)}
          </select>
        </label>
        <label>
          Terrain
          <select value={field.terrain} onChange={(e) => setField({ ...field, terrain: e.target.value })}>
            {['none', 'electric', 'grassy', 'psychic', 'misty'].map((t) => <option key={t}>{t}</option>)}
          </select>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={field.tailwind}
            onChange={() => setField({ ...field, tailwind: !field.tailwind })} />
          Your Tailwind
        </label>
        <label className="toggle">
          <input type="checkbox" checked={field.opposing_tailwind}
            onChange={() => setField({ ...field, opposing_tailwind: !field.opposing_tailwind })} />
          Opposing Tailwind
        </label>
        <label className="toggle">
          <input type="checkbox" checked={field.trick_room}
            onChange={() => setField({ ...field, trick_room: !field.trick_room })} />
          Trick Room
        </label>
        <span className="spacer" />
        <div className="pool-bench">
          <span className="dim small">Everyone else:</span>
          <div className="segmented">
            {ALIGN_OPTS.map(([v, label]) => (
              <button key={v}
                className={pool.alignment === v ? 'on' : ''}
                onClick={() => setPool({ ...pool, alignment: v })}>
                {label}
              </button>
            ))}
          </div>
          <input type="range" min="0" max="32" value={pool.sp}
            onChange={(e) => setPool({ ...pool, sp: Number(e.target.value) })} />
          <span className="mono">{pool.sp} SP</span>
        </div>
        <input
          className="speed-filter"
          placeholder="Filter Pokémon…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {data && (
        <p className="dim small">
          Sorted {data.order}. Pool rows show 32 SP + speed alignment
          (uninvested in parentheses); your team rows use their exact builds.
          {field.weather !== 'none' && ' Conditional speed abilities are applied.'}
        </p>
      )}
      {error && <div className="errors banner">{error}</div>}
      <div className="speed-table-wrap">
        <table className="data-table speed-table">
          <thead>
            <tr>
              <th>#</th><th></th><th>Pokémon</th>
              <th className="mono">Speed</th><th>Build</th><th>Modifiers</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.id}-${r.is_team ? 'team' : 'pool'}`}
                  className={r.is_team ? 'team-row' : ''}>
                <td className="mono dim">{i + 1}</td>
                <td><Sprite id={r.id} size={28} /></td>
                <td>
                  {r.name}{' '}
                  {r.types.map((t) => <TypeChip key={t} t={t} />)}
                  {r.is_team && <span className="chip ko"> YOURS</span>}
                </td>
                <td className="mono speed-val">{r.speed}</td>
                <td className="dim small">{r.detail}</td>
                <td className="small warn">{(r.applied || []).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
