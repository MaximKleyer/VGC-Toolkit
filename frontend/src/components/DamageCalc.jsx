import React, { useContext, useEffect, useRef, useState } from 'react';
import { DataCtx } from '../App.jsx';
import { post, combatant, emptySlot, SETS_KEY, loadSets } from '../api.js';
import {
  MoveSelect, PokemonPicker, Sprite, StatPointsEditor, TypeChip,
  useFullMon, useLearnset, Toggle, HpBarFull, itemLabel, stonesFor, CategoryIcon, MoveTags, FieldEffects
} from './shared.jsx';

const emptySide = () => ({ ...emptySlot(), hpPct: 100 });
const WEATHER_ABILITIES = { Drought: 'sun', Drizzle: 'rain',
  'Sand Stream': 'sand', 'Snow Warning': 'snow' };
const TERRAIN_ABILITIES = { 'Electric Surge': 'electric', 'Grassy Surge': 'grassy',
  'Misty Surge': 'misty', 'Psychic Surge': 'psychic' };
const WEATHER_LABELS = { sun: 'Sun', rain: 'Rain', sand: 'Sand', snow: 'Snow' };
const TERRAIN_LABELS = { electric: 'Electric Terrain', grassy: 'Grassy Terrain',
  misty: 'Misty Terrain', psychic: 'Psychic Terrain' };
const SIDE_FIELD = () => ({
  protect: false, helpingHand: false, reflect: false,
  lightScreen: false, auroraVeil: false, friendGuard: false, crit: false,
});

/* ---------------- roll readout: 16 numbers, KO-coded ---------------- */
function RollNumbers({ result }) {
  const maxHp = result.defender_hp;
  const curHp = result.defender_current_hp ?? maxHp;
  const chipped = curHp < maxHp;
  return (
    <div className="rollnums mono">
      {result.rolls.map((r, i) => {
        const pctMax = ((r / maxHp) * 100).toFixed(1);
        // KO color uses CURRENT HP (matches ko_chances); keep the tooltip in sync.
        const tip = chipped
          ? `${pctMax}% of max HP · ${((r / curHp) * 100).toFixed(1)}% of current HP`
          : `${pctMax}% of max HP`;
        return (
          <span key={i}
            className={r >= curHp ? 'roll-ko' : 'roll-live'}
            title={tip}>
            {r}{i < result.rolls.length - 1 ? ',' : ''}
          </span>
        );
      })}
    </div>
  );
}

/* ---------------- side panel ---------------- */
function SidePanel({ label, side, setSide, sets, onSaveSet, onDeleteSet, teamStrip,
  onAbility, opponent, attackField }) {
  const { mon, error: monError } = useFullMon(side.pokemonId);
  const learnset = useLearnset(side.pokemonId);
  const { alignments, items, metaSets } = useContext(DataCtx);
  const metaEntries = Object.entries(metaSets?.pokemon || {});
  const [setName, setSetName] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [paste, setPaste] = useState('');
  const [err, setErr] = useState(null);
  const [bestOpen, setBestOpen] = useState(false);
  const [best, setBest] = useState(null);
  const [bestErr, setBestErr] = useState(null);
  const upd = (patch) => setSide({ ...side, ...patch });

  useEffect(() => {
    if (mon && mon.mega_stone && side.item !== mon.mega_stone)
      upd({ item: mon.mega_stone });
  }, [mon && mon.id]); // eslint-disable-line

  // Weather/terrain setters announce themselves so the field can follow.
  const resolvedAbility = side.ability || (mon && mon.abilities[0]) || '';
  useEffect(() => {
    if (resolvedAbility && onAbility) onAbility(resolvedAbility);
  }, [mon && mon.id, resolvedAbility]); // eslint-disable-line

  // Best moves vs the opposing Pokémon (opt-in; refreshes like the calc does).
  const oppId = opponent && opponent.pokemonId;
  const bestKey = JSON.stringify([
    side.pokemonId ? combatant(side) : null,
    oppId ? combatant(opponent) : null, attackField]);
  useEffect(() => {
    if (!bestOpen || !side.pokemonId || !oppId) { setBest(null); return; }
    let live = true;
    const t = setTimeout(() => {
      post('/damage/best-moves', {
        attacker: combatant(side), defender: combatant(opponent),
        field: attackField, top_n: 6,
      }).then((r) => { if (live) { setBest(r.moves); setBestErr(null); } })
        .catch((e) => { if (live) setBestErr(e.message); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [bestOpen, bestKey]); // eslint-disable-line

  // All sets, always visible — loading one switches this side to that Pokemon.
  const mySets = [...sets].sort((a, b) =>
    (a.displayName + a.name).localeCompare(b.displayName + b.name));

  const loadSet = (id) => {
    if (id.startsWith('meta|')) {
      const [, pid, idx] = id.split('|');
      const entry = metaSets.pokemon[pid];
      const s = entry?.sets[Number(idx)];
      if (!s) return;
      setSide({
        ...emptySide(), pokemonId: pid, displayName: entry.name,
        spread: s.spread, alignment: s.alignment,
        ability: s.ability || '', item: s.item || '',
        moves: [...s.moves, '', '', '', ''].slice(0, 4),
      });
      return;
    }
    const s = sets.find((x) => x.id === id);
    if (s) setSide({ ...emptySide(), ...s.state, pokemonId: s.pokemonId,
                     displayName: s.displayName, types: s.types, moves: s.moves });
  };

  const doImport = async () => {
    setErr(null);
    try {
      const r = await post('/team/import', { paste });
      const m = r.team[0];
      if (!m) throw new Error('no set found in paste');
      setSide({
        ...emptySide(),
        pokemonId: m.pokemon.pokemon_id,
        spread: m.pokemon.spread,
        alignment: m.pokemon.alignment,
        ability: m.pokemon.ability || '',
        item: m.pokemon.item || '',
        moves: [...m.moves, '', '', '', ''].slice(0, 4),
      });
      setShowImport(false); setPaste('');
    } catch (e) { setErr(e.message); }
  };

  const setMove = (i, name) => {
    const next = [...side.moves]; next[i] = name; upd({ moves: next });
  };

  // Fill a suggested move into the first empty slot (or replace the last).
  const addBestMove = (name) => {
    if (side.moves.includes(name)) return;
    const next = [...side.moves];
    const empty = next.findIndex((m) => !m);
    next[empty === -1 ? next.length - 1 : empty] = name;
    upd({ moves: next });
  };

  const stones = stonesFor(mon, items);
  const groupedItems = {
    ...(stones.length ? { 'Mega Stone': stones } : {}),
    'Held items': items.filter((i) => i.category === 'held'),
    Berries: items.filter((i) => i.category === 'berry'),
  };

  return (
    <section className="panel side-panel">
      <h3 className="panel-title">{label}</h3>
      {teamStrip}
      <div className="row">
        <label style={{ flex: 2 }}>
          Pokémon
          <PokemonPicker value={side.pokemonId}
            onPick={(p) => setSide({ ...emptySide(), pokemonId: p.id,
                                     displayName: p.name, types: p.types })} />
        </label>
        <label>
          Saved set
          <select value="" onChange={(e) => e.target.value && loadSet(e.target.value)}>
            <option value="">{mySets.length || metaEntries.length ? '(load a set…)' : '(no saved sets)'}</option>
            {mySets.length > 0 && (
              <optgroup label="My sets">
                {mySets.map((s) => (
                  <option key={s.id} value={s.id}>{s.displayName} — {s.name}</option>
                ))}
              </optgroup>
            )}
            {metaEntries.some(([pid]) => !side.pokemonId || pid === side.pokemonId) && (
              <optgroup label={`Meta sets (${metaSets.info?.label || 'ladder'}${metaSets.info?.regulation ? ` · Reg ${metaSets.info.regulation}` : ''})`}>
                {metaEntries
                  .filter(([pid]) => !side.pokemonId || pid === side.pokemonId)
                  .flatMap(([pid, e]) => e.sets.map((s, i) => (
                    <option key={`${pid}-${i}`} value={`meta|${pid}|${i}`}>
                      {e.name} — {s.name} ({e.usage}%)
                    </option>
                  )))}
              </optgroup>
            )}
          </select>
        </label>
      </div>

      {mon && (
        <>
          <div className="row">
            <label>
              Ability
              <select value={side.ability} onChange={(e) => upd({ ability: e.target.value })}>
                <option value="">{mon.abilities[0] ? `${mon.abilities[0]} (default)` : '—'}</option>
                {mon.abilities.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
            <label>
              Item
              {mon.mega_stone ? (
                <div className="locked-item small">{mon.mega_stone}</div>
              ) : (
                <select value={side.item} onChange={(e) => upd({ item: e.target.value })}>
                  <option value="">None</option>
                  {Object.entries(groupedItems).map(([g, list]) => (
                    <optgroup key={g} label={g}>
                      {list.map((i) => <option key={i.id} value={i.name}>{itemLabel(i)}</option>)}
                    </optgroup>
                  ))}
                </select>
              )}
            </label>
            <label>
              Alignment
              <select value={side.alignment} onChange={(e) => upd({ alignment: e.target.value })}>
                {Object.keys(alignments).map((n) => <option key={n}>{n}</option>)}
              </select>
            </label>
          </div>
          <HpBarFull baseStats={mon.base} spread={side.spread}
            alignment={side.alignment} pct={side.hpPct}
            onChange={(v) => upd({ hpPct: v })} />
          <StatPointsEditor baseStats={mon.base} spread={side.spread}
            alignment={side.alignment} onChange={(spread) => upd({ spread })}
            stages={side.stages}
            onStage={(k, v) => upd({ stages: { ...side.stages, [k]: v } })} />
          <div className="row battle-state">
            <label>
              Status
              <select value={side.status || ''} onChange={(e) => upd({ status: e.target.value || null })}>
                <option value="">Healthy</option>
                <option value="burn">Burned</option>
                <option value="paralysis">Paralyzed</option>
              </select>
            </label>
            {side.item === 'Metronome' && (
              <label title="Metronome: x1.2 per consecutive use of the same move, up to x2 from the 5th repeat">
                Consecutive uses
                <input type="number" min={0} max={5} value={side.moveStreak || 0}
                  onChange={(e) => upd({ moveStreak: Math.max(0, Math.min(5, Number(e.target.value) || 0)) })} />
              </label>
            )}
          </div>
          <div className="moves-grid">
            {side.moves.map((m, i) => (
              <MoveSelect key={i} moves={learnset} value={m} onChange={(v) => setMove(i, v)} />
            ))}
          </div>
          {oppId && (
            <button className="best-moves-toggle"
              onClick={() => setBestOpen((o) => !o)}>
              {bestOpen ? '▾' : '▸'} Best moves vs {opponent.displayName || 'opponent'}
            </button>
          )}
          {bestOpen && oppId && (
            <div className="best-moves">
              {bestErr && <div className="dim small">Couldn't rank moves ({bestErr})</div>}
              {!best && !bestErr && <div className="dim small">Ranking…</div>}
              {best && best.length === 0 && (
                <div className="dim small">No damaging move hits this target.</div>
              )}
              {best && best.map((bm) => {
                const used = side.moves.includes(bm.move);
                return (
                  <div key={bm.move} className="best-move-row">
                    <TypeChip t={bm.type} />
                    <span className="bm-name">{bm.move}</span>
                    <span className="mono bm-pct">{bm.pct_range[0]}–{bm.pct_range[1]}%</span>
                    {bm.ohko_chance >= 100 ? <span className="chip ko">OHKO</span>
                      : bm.ohko_chance > 0
                        ? <span className="chip">{bm.ohko_chance}% OHKO</span>
                      : bm.guaranteed_2hko ? <span className="chip">2HKO</span> : null}
                    {bm.recharge && (
                      <span className="dim small" title="Forces a recharge turn">recharge</span>
                    )}
                    <button className="bm-add" disabled={used}
                      title={used ? 'Already in moveset' : 'Add to moveset'}
                      onClick={() => addBestMove(bm.move)}>
                      {used ? '✓' : '+ use'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <div className="row set-actions">
            <input placeholder="Set name…" value={setName}
              onChange={(e) => setSetName(e.target.value)} />
            <button disabled={!setName.trim()}
              onClick={() => { onSaveSet(setName.trim(), side, mon); setSetName(''); }}>
              Save set
            </button>
            <button onClick={() => setShowImport(!showImport)}>Import</button>
          </div>
          {sets.some((s) => s.pokemonId === side.pokemonId) && (
            <div className="set-chips">
              {sets.filter((s) => s.pokemonId === side.pokemonId).map((s) => (
                <span key={s.id} className="chip">
                  {s.name}
                  <button className="chip-x" onClick={() => onDeleteSet(s.id)}>×</button>
                </span>
              ))}
            </div>
          )}
        </>
      )}
      {showImport && (
        <div className="paste-box">
          <textarea rows={8} value={paste} onChange={(e) => setPaste(e.target.value)}
            placeholder={'Kingambit @ Chople Berry\nAbility: Defiant\nEVs: 32 HP / 32 Atk / 2 SpD\nAdamant Nature\n- Kowtow Cleave\n- Sucker Punch\n- Iron Head\n- Protect'} />
          <button className="primary" onClick={doImport} disabled={!paste.trim()}>
            Import into this side
          </button>
        </div>
      )}
      {monError && (
        <div className="errors banner">
          Couldn't load this Pokémon ({monError}) — is the backend running?
        </div>
      )}
      {err && <div className="errors banner">{err}</div>}
    </section>
  );
}

/* ---------------- field panel ---------------- */
function Seg({ options, value, onChange }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o} className={value === o ? 'on' : ''} onClick={() => onChange(o)}>
          {o}
        </button>
      ))}
    </div>
  );
}

function SideToggles({ side, setSide, title }) {
  return (
    <div className="side-toggles">
      <div className="dim small">{title}</div>
      {[['protect', 'Protect'], ['helpingHand', 'Helping Hand'], ['crit', 'Crits'],
        ['reflect', 'Reflect'], ['lightScreen', 'Light Screen'],
        ['auroraVeil', 'Aurora Veil'], ['friendGuard', 'Friend Guard']].map(([k, label]) => (
        <Toggle key={k} small checked={side[k]} label={label}
          onChange={() => setSide({ ...side, [k]: !side[k] })} />
      ))}
    </div>
  );
}

function FieldPanel({ field, setField, left, setLeft, right, setRight }) {
  return (
    <section className="panel field-panel">
      <h3 className="panel-title">Field</h3>
      <Seg options={['Singles', 'Doubles']} value={field.mode}
        onChange={(mode) => setField({ ...field, mode })} />
      <Seg options={['none', 'sun', 'rain', 'sand', 'snow']} value={field.weather}
        onChange={(weather) => setField({ ...field, weather })} />
      <Seg options={['none', 'electric', 'grassy', 'misty', 'psychic']} value={field.terrain}
        onChange={(terrain) => setField({ ...field, terrain })} />
      <FieldEffects kind="weather" k={field.weather} className="small dim" />
      <FieldEffects kind="terrain" k={field.terrain} className="small dim" />
      <div className="row toggles" style={{ justifyContent: 'center' }}>
        {[['gravity', 'Gravity'], ['fairyAura', 'Fairy Aura'], ['darkAura', 'Dark Aura']].map(([k, label]) => (
          <Toggle key={k} checked={field[k]} label={label}
            onChange={() => setField({ ...field, [k]: !field[k] })} />
        ))}
      </div>
      <div className="side-toggle-grid">
        <SideToggles side={left} setSide={setLeft} title="POKÉMON 1 SIDE" />
        <SideToggles side={right} setSide={setRight} title="POKÉMON 2 SIDE" />
      </div>
    </section>
  );
}

/* ---------------- custom set library (middle column) ---------------- */
function CustomSets({ sets, onSave, onDelete }) {
  const { pokemon } = useContext(DataCtx);
  const [name, setName] = useState('');
  const [paste, setPaste] = useState('');
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const [showAll, setShowAll] = useState(false);

  const save = async () => {
    setErr(null); setMsg(null);
    try {
      const r = await post('/team/import', { paste });
      const m = r.team[0];
      if (!m) throw new Error('no set found in paste');
      const info = pokemon.find((p) => p.id === m.pokemon.pokemon_id);
      const side = {
        ...emptySide(),
        pokemonId: m.pokemon.pokemon_id,
        spread: m.pokemon.spread,
        alignment: m.pokemon.alignment,
        ability: m.pokemon.ability || '',
        item: m.pokemon.item || '',
        moves: [...m.moves, '', '', '', ''].slice(0, 4),
      };
      const label = name.trim() || 'Custom set';
      onSave(label, side, { name: info?.name || m.pokemon.pokemon_id,
                            types: info?.types || [] });
      setMsg(`Saved: ${info?.name || m.pokemon.pokemon_id} — ${label}`);
      setName('');
      setPaste('');
    } catch (e) { setErr(e.message); }
  };

  return (
    <section className="panel field-panel">
      <h3 className="panel-title">Custom sets</h3>
      <input placeholder="Set name (e.g. Bulky Chople)" value={name}
        onChange={(e) => setName(e.target.value)} style={{ width: '100%' }} />
      <textarea rows={8} value={paste} onChange={(e) => setPaste(e.target.value)}
        style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12 }}
        placeholder={'Kingambit @ Chople Berry\nAbility: Defiant\nEVs: 32 HP / 32 Atk / 2 SpD\nAdamant Nature\n- Kowtow Cleave\n- Sucker Punch\n- Iron Head\n- Protect'} />
      <button className="primary" style={{ width: '100%' }}
        onClick={save} disabled={!paste.trim()}>
        Save to set library
      </button>
      {msg && <div className="ok small">{msg}</div>}
      {err && <div className="errors banner">{err}</div>}
      <button onClick={() => setShowAll(!showAll)} style={{ width: '100%' }}>
        {showAll ? 'Hide' : 'Manage'} saved sets ({sets.length})
      </button>
      {showAll && (
        <ul className="set-manage">
          {sets.length === 0 && <li className="dim small">Nothing saved yet.</li>}
          {sets.map((s) => (
            <li key={s.id}>
              <Sprite id={s.pokemonId} size={26} />
              <span className="small">{s.displayName} — {s.name}</span>
              <button className="chip-x" onClick={() => onDelete(s.id)}>×</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------------- move list (top of page, per side) ---------------- */
function MoveList({ sideKey, side, title, results, selected, setSelected }) {
  const { moves: moveDb } = useContext(DataCtx) || {};
  return (
    <div className="movelist">
      <div className="dim small">{title}</div>
      {side.moves.map((m, i) => {
        const r = results[`${sideKey}-${i}`];
        if (!m) return <div key={i} className="movelist-row dim">(no move)</div>;
        return (
          <button key={i}
            className={`movelist-row ${selected === `${sideKey}-${i}` ? 'on' : ''}`}
            onClick={() => setSelected(`${sideKey}-${i}`)}>
            <span className="movelist-name">
              <CategoryIcon category={moveDb?.[m]?.category} /> {m}
              <MoveTags m={moveDb?.[m]} compact showCategory={false} showAccuracy />
            </span>
            <span className="mono">
              {r ? (r.category === 'Status' ? '—'
                : `${r.pct_range[0]} – ${r.pct_range[1]}%`) : '…'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ---------------- main ---------------- */
export default function DamageCalc({ team, preset, onPresetConsumed }) {
  const { oppTeam } = useContext(DataCtx);   // Team Builder -> Opponent team
  const [p1, setP1] = useState(emptySide());
  const [p2, setP2] = useState(emptySide());
  const [field, setField] = useState({ mode: 'Doubles', weather: 'none',
    terrain: 'none', gravity: false, fairyAura: false, darkAura: false });
  const [s1, setS1] = useState(SIDE_FIELD());
  const [s2, setS2] = useState(SIDE_FIELD());
  const [results, setResults] = useState({});
  const [selected, setSelected] = useState(null);
  const [sets, setSets] = useState(loadSets);
  const [fieldNote, setFieldNote] = useState(null);  // transient "ability set the field" bubble
  const fieldRef = useRef(field);
  const noteTimer = useRef(null);
  const seq = useRef(0);
  useEffect(() => { fieldRef.current = field; }, [field]);

  useEffect(() => {
    if (!preset) return;
    if (preset.p1) setP1({ ...emptySide(), ...preset.p1 });
    if (preset.p2) setP2({ ...emptySide(), ...preset.p2 });
    onPresetConsumed && onPresetConsumed();
  }, [preset]); // eslint-disable-line

  const persistSets = (next) => {
    setSets(next);
    localStorage.setItem(SETS_KEY, JSON.stringify(next));
  };
  const saveSet = (name, side, mon) => persistSets([...sets, {
    id: `${Date.now()}`, name, pokemonId: side.pokemonId,
    displayName: mon.name, types: mon.types,
    state: { spread: side.spread, alignment: side.alignment, ability: side.ability,
             item: side.item, status: side.status, stages: side.stages, hpPct: side.hpPct },
    moves: side.moves,
  }]);
  const deleteSet = (id) => persistSets(sets.filter((s) => s.id !== id));

  const buildField = (atkSide, defSide) => ({
    weather: field.weather, terrain: field.terrain,
    is_doubles: field.mode === 'Doubles',
    gravity: field.gravity, fairy_aura: field.fairyAura, dark_aura: field.darkAura,
    is_crit: atkSide.crit, helping_hand: atkSide.helpingHand,
    reflect: defSide.reflect, light_screen: defSide.lightScreen,
    aurora_veil: defSide.auroraVeil, friend_guard: defSide.friendGuard,
    defender_protected: defSide.protect,
  });

  const calcKey = JSON.stringify([combatant(p1), combatant(p2), p1.moves, p2.moves, field, s1, s2]);
  useEffect(() => {
    if (!p1.pokemonId || !p2.pokemonId) { setResults({}); return; }
    const mySeq = ++seq.current;
    const t = setTimeout(async () => {
      const out = {};
      const jobs = [];
      const fire = (key, attacker, defender, move, f) =>
        jobs.push(post('/damage', { attacker, defender, move, field: f })
          .then((r) => { out[key] = r; }).catch(() => {}));
      p1.moves.forEach((m, i) => m &&
        fire(`p1-${i}`, combatant(p1), combatant(p2), m, buildField(s1, s2)));
      p2.moves.forEach((m, i) => m &&
        fire(`p2-${i}`, combatant(p2), combatant(p1), m, buildField(s2, s1)));
      await Promise.all(jobs);
      if (seq.current !== mySeq) return;
      setResults(out);
      setSelected((sel) => (sel && out[sel] ? sel : Object.keys(out)[0] || null));
    }, 350);
    return () => clearTimeout(t);
  }, [calcKey]); // eslint-disable-line

  const sel = selected && results[selected];

  const onAbility = (ability) => {
    const cur = fieldRef.current;
    let next = cur;
    const changes = [];
    const w = WEATHER_ABILITIES[ability];
    if (w && cur.weather !== w) {
      next = { ...next, weather: w };
      changes.push(WEATHER_LABELS[w]);
    }
    const t = TERRAIN_ABILITIES[ability];
    if (t && cur.terrain !== t) {
      next = { ...next, terrain: t };
      changes.push(TERRAIN_LABELS[t]);
    }
    if (next === cur) return;          // ability isn't a setter, or field already matches
    fieldRef.current = next;
    setField(next);
    setFieldNote(`${ability} set the field to ${changes.join(' + ')}`);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setFieldNote(null), 4000);
  };

  const teamStrip = (
    <div className="team-strip">
      {team.map((slot, i) => (
        <button key={i} className="team-strip-btn" disabled={!slot.pokemonId}
          title={slot.displayName || `Slot ${i + 1}`}
          onClick={() => setP1({ ...emptySide(), ...slot, hpPct: 100 })}>
          {slot.pokemonId ? <Sprite id={slot.pokemonId} size={34} />
            : <span className="dim">{i + 1}</span>}
        </button>
      ))}
    </div>
  );

  // The opponent team's six as a strip for Pokémon 2, mirroring your team's strip on Pokémon 1.
  const oppStrip = oppTeam?.some((s) => s.pokemonId) ? (
    <div className="team-strip" title="Opponent team (Team Builder → Opponent team): click to load that set">
      {oppTeam.map((slot, i) => (
        <button key={i} className="team-strip-btn opp" disabled={!slot.pokemonId}
          title={slot.pokemonId
            ? `${slot.nickname ? `${slot.nickname} · ` : ''}${slot.displayName || slot.pokemonId}${slot.item ? ` @ ${slot.item}` : ''}`
            : `Slot ${i + 1}`}
          onClick={() => setP2({ ...emptySide(), ...slot, hpPct: 100 })}>
          {slot.pokemonId ? <Sprite id={slot.pokemonId} size={34} />
            : <span className="dim">{i + 1}</span>}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div className="page calc-page">
      <section className="panel results-top">
        <div className="movelists">
          <MoveList sideKey="p1" side={p1} results={results}
            selected={selected} setSelected={setSelected}
            title={`${p1.displayName || 'POKÉMON 1'}'S MOVES`} />
          <MoveList sideKey="p2" side={p2} results={results}
            selected={selected} setSelected={setSelected}
            title={`${p2.displayName || 'POKÉMON 2'}'S MOVES`} />
        </div>
        {sel ? (
          <div className="sel-result">
            <p className="description mono">{sel.description}</p>
            <RollNumbers result={sel} />
            <div className="result-line">
              <span className="ko-chips">
                {Object.entries(sel.ko_chances).filter(([, v]) => v > 0).map(([k, v]) => (
                  <span key={k} className={`chip ${v === 100 ? 'ko' : ''}`}>
                    {k.toUpperCase()} {v}%
                  </span>
                ))}
              </span>
            </div>
            {sel.notes.length > 0 && (
              <ul className="notes">{sel.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
            )}
          </div>
        ) : (
          <p className="dim">Pick both Pokémon and at least one move — results appear here.</p>
        )}
      </section>

      <div className="calc3">
        <SidePanel label="Pokémon 1" side={p1} setSide={setP1} sets={sets}
          onSaveSet={saveSet} onDeleteSet={deleteSet} teamStrip={teamStrip}
          onAbility={onAbility} opponent={p2} attackField={buildField(s1, s2)} />
        <div className="calc-middle">
          {fieldNote && (
            <div className="field-note" role="status" aria-live="polite">
              {fieldNote}
            </div>
          )}
          <FieldPanel field={field} setField={setField}
            left={s1} setLeft={setS1} right={s2} setRight={setS2} />
          <CustomSets sets={sets} onSave={saveSet} onDelete={deleteSet} />
        </div>
        <SidePanel label="Pokémon 2" side={p2} setSide={setP2} sets={sets}
          onSaveSet={saveSet} onDeleteSet={deleteSet} teamStrip={oppStrip}
          onAbility={onAbility} opponent={p1} attackField={buildField(s2, s1)} />
      </div>
    </div>
  );
}
