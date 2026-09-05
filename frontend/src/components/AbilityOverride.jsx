import React, { useContext, useEffect, useState } from 'react';
import { DataCtx } from '../App.jsx';
import { put } from '../api.js';

const MAX_ABILITIES = 3;

/**
 * Editor for forms whose Champions ability has not been announced yet
 * (`abilities_provisional` on the form). Pick any ability the data set knows,
 * or type a new one; Save persists it server-side (data/ability_overrides.json)
 * so the roster, team validation, and every threat/speed scan use it. Reset
 * restores whatever pokedex.json ships.
 */
export default function AbilityOverride({ mon }) {
  const { abilities: known = [], refreshData } = useContext(DataCtx);
  const [list, setList] = useState(mon.abilities);
  const [custom, setCustom] = useState('');
  const [status, setStatus] = useState(null); // { ok, text }
  const [busy, setBusy] = useState(false);

  // Follow the server copy whenever it changes (a save, a refetch, a new form).
  const serverKey = `${mon.id}|${mon.abilities.join('|')}`;
  useEffect(() => { setList(mon.abilities); setStatus(null); }, [serverKey]);

  const add = (name) => {
    const a = (name || '').trim();
    if (!a || list.includes(a) || list.length >= MAX_ABILITIES) return;
    setList([...list, a]);
    setCustom('');
  };
  const remove = (a) => setList(list.filter((x) => x !== a));
  const dirty = list.join('|') !== mon.abilities.join('|');

  const save = async (next) => {
    setBusy(true);
    setStatus(null);
    try {
      await put(`/pokemon/${mon.id}/abilities`, { abilities: next });
      setStatus({ ok: true, text: next.length ? 'Saved — applied to every scan.' : 'Reset to shipped data.' });
      refreshData();
    } catch (e) {
      setStatus({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ability-override">
      <div className="ability-override-row">
        <span className="prov-tag">
          {mon.abilities_provisional ? 'ability not announced' : 'ability overridden'}
        </span>
        <span className="dim small">
          {mon.abilities_provisional
            ? `Champions hasn't confirmed ${mon.name}'s ability${mon.ability_override ? ' · currently using yours' : ''}. Set a working one here; it applies everywhere until you change it.`
            : `Champions has confirmed ${mon.name}'s ability, but your override is still in effect. Reset to use the confirmed data.`}
        </span>
      </div>
      <div className="ability-override-row">
        {list.map((a) => (
          <button key={a} className="ability-btn on" title="Remove" onClick={() => remove(a)}>
            {a} ×
          </button>
        ))}
        {list.length === 0 && <span className="dim small">none set</span>}
      </div>
      {list.length < MAX_ABILITIES && (
        <div className="ability-override-row">
          <select value="" onChange={(e) => add(e.target.value)} disabled={busy}>
            <option value="">+ known ability…</option>
            {known.filter((a) => !list.includes(a)).map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
          <input
            value={custom}
            placeholder="or type any ability"
            disabled={busy}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(custom); } }}
          />
          <button onClick={() => add(custom)} disabled={busy || !custom.trim()}>Add</button>
        </div>
      )}
      <div className="ability-override-row">
        <button onClick={() => save(list)} disabled={busy || !dirty}>Save</button>
        {mon.ability_override && (
          <button onClick={() => save([])} disabled={busy}>Reset to shipped data</button>
        )}
        {status && (
          <span className="small" style={{ color: status.ok ? 'var(--ok)' : 'var(--bad, #d64545)' }}>
            {status.text}
          </span>
        )}
      </div>
    </div>
  );
}
