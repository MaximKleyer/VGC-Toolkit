import React, { useContext, useEffect, useState } from 'react';
import { DataCtx } from '../App.jsx';
import { post, combatant, emptySlot } from '../api.js';
import {
  MoveSelect, PokemonPicker, Sprite, StatPointsEditor, TypeChip,
  useFullMon, useLearnset,
} from './shared.jsx';
import LiveAnalysis from './LiveAnalysis.jsx';
import PlaybookCheck from './PlaybookCheck.jsx';
import SpeedTiers from './SpeedTiers.jsx';
import AbilityOverride from './AbilityOverride.jsx';

const TEAMS_KEY = 'vgc-toolkit-teams-v1';
const loadTeamLibrary = () => {
  try { return JSON.parse(localStorage.getItem(TEAMS_KEY)) || []; }
  catch { return []; }
};

function SlotCard({ index, slot, selected, onSelect, onClear }) {
  if (!slot.pokemonId)
    return (
      <button className={`slot-tile empty ${selected ? 'selected' : ''}`} onClick={onSelect}>
        <span className="plus">+</span>
        <span className="dim">Slot {index + 1}</span>
      </button>
    );
  return (
    <div className={`slot-tile ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <button className="slot-x" onClick={(e) => { e.stopPropagation(); onClear(); }}>×</button>
      <span className="slot-num mono dim">{index + 1}</span>
      <Sprite id={slot.pokemonId} size={72} />
      <div className="slot-name">{slot.displayName || slot.pokemonId}</div>
      <div className="slot-types">
        {(slot.types || []).map((t) => <TypeChip key={t} t={t} />)}
      </div>
      <div className="slot-align warn small">{slot.alignment}</div>
      <ul className="slot-moves dim small">
        {slot.moves.filter(Boolean).map((m) => <li key={m}>{m}</li>)}
      </ul>
    </div>
  );
}

function ItemSelect({ slot, mon, upd }) {
  const { items } = useContext(DataCtx);
  if (mon.mega_stone)
    return (
      <div className="locked-item">
        <span>{mon.mega_stone}</span>
        <span className="chip warn small">MEGA STONE · LOCKED</span>
      </div>
    );
  const groups = {
    'Held items': items.filter((i) => i.category === 'held'),
    Berries: items.filter((i) => i.category === 'berry'),
  };
  return (
    <select value={slot.item} onChange={(e) => upd({ item: e.target.value })}>
      <option value="">None</option>
      {Object.entries(groups).map(([label, list]) => (
        <optgroup label={label} key={label}>
          {list.map((i) => <option key={i.id} value={i.name}>{i.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

function AlignmentSelect({ slot, upd }) {
  const { alignments } = useContext(DataCtx);
  const L = { atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
  return (
    <select value={slot.alignment} onChange={(e) => upd({ alignment: e.target.value })}>
      {Object.entries(alignments).map(([name, a]) => (
        <option key={name} value={name}>
          {name}{a.boost ? ` (+${L[a.boost]} −${L[a.reduce]})` : ''}
        </option>
      ))}
    </select>
  );
}

function SlotEditor({ slot, onChange, onClose, errors }) {
  const { mon, error: monError } = useFullMon(slot.pokemonId);
  const learnset = useLearnset(slot.pokemonId);
  const upd = (patch) => onChange({ ...slot, ...patch });

  // Mega stone autofill: a mega's item IS its stone, locked.
  useEffect(() => {
    if (mon && mon.mega_stone && slot.item !== mon.mega_stone)
      upd({ item: mon.mega_stone });
    if (mon && !mon.mega_stone && slot.item && !slot.itemUserSet)
      upd({ item: '' });
  }, [mon && mon.id]); // eslint-disable-line

  const setMove = (i, name) => {
    const next = [...slot.moves];
    next[i] = name;
    upd({ moves: next });
  };

  return (
    <section className="panel editor">
      <div className="editor-head">
        <Sprite id={slot.pokemonId} size={56} />
        <div className="editor-pick">
          <PokemonPicker
            value={slot.pokemonId}
            onPick={(p) => onChange({
              ...emptySlot(),
              pokemonId: p.id,
              displayName: p.name,
              types: p.types,
            })}
          />
        </div>
        <span className="spacer" />
        <button onClick={onClose}>Close ×</button>
      </div>

      {mon && (
        <div className="editor-grid">
          <div className="editor-col">
            <h4>Moves</h4>
            {slot.moves.map((m, i) => (
              <MoveSelect key={i} moves={learnset} value={m} onChange={(v) => setMove(i, v)} />
            ))}
            <h4>Ability</h4>
            <div className="ability-list">
              {mon.abilities.map((a) => (
                <button
                  key={a}
                  className={`ability-btn ${(slot.ability || mon.abilities[0]) === a ? 'on' : ''}`}
                  onClick={() => upd({ ability: a })}
                >
                  {a}
                </button>
              ))}
              {mon.abilities.length === 0 && (
                <span className="dim small">No ability yet — set one below.</span>
              )}
            </div>
            {(mon.abilities_provisional || mon.ability_override) && <AbilityOverride mon={mon} />}
            <h4>Held item</h4>
            <ItemSelect
              slot={slot}
              mon={mon}
              upd={(p) => upd({ ...p, itemUserSet: !!p.item })}
            />
            <h4>Alignment</h4>
            <AlignmentSelect slot={slot} upd={upd} />
          </div>
          <div className="editor-col">
            <StatPointsEditor
              baseStats={mon.base}
              spread={slot.spread}
              alignment={slot.alignment}
              onChange={(spread) => upd({ spread })}
            />
          </div>
        </div>
      )}
      {monError && (
        <div className="errors banner">
          Couldn't load this Pokémon ({monError}) — is the backend running?
        </div>
      )}
      {errors && errors.length > 0 && (
        <ul className="errors">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
      )}
    </section>
  );
}

function SlotEditorWrapper(props) {
  if (!props.slot.pokemonId)
    return (
      <section className="panel editor">
        <div className="editor-head">
          <div className="editor-pick">
            <PokemonPicker
              value={null}
              onPick={(p) => props.onChange({
                ...emptySlot(),
                pokemonId: p.id,
                displayName: p.name,
                types: p.types,
              })}
              placeholder="Search a Pokémon for this slot…"
            />
          </div>
          <span className="spacer" />
          <button onClick={props.onClose}>Close ×</button>
        </div>
      </section>
    );
  return <SlotEditor {...props} />;
}

export default function TeamBuilder({ team, setTeam }) {
  const { pokemon } = useContext(DataCtx);
  const [active, setActive] = useState(null);
  const [showSpeed, setShowSpeed] = useState(false);
  const [showTeams, setShowTeams] = useState(false);
  const [teamName, setTeamName] = useState('');
  const [library, setLibrary] = useState(loadTeamLibrary);

  const persistLibrary = (next) => {
    setLibrary(next);
    localStorage.setItem(TEAMS_KEY, JSON.stringify(next));
  };
  const saveTeam = () => {
    const name = teamName.trim();
    if (!name) return;
    const entry = { id: `${Date.now()}`, name, savedAt: new Date().toISOString(),
                    slots: team };
    const existing = library.findIndex((t) => t.name === name);
    const next = existing >= 0
      ? library.map((t, i) => (i === existing ? { ...entry, id: t.id } : t))
      : [...library, entry];
    persistLibrary(next);
    setTeamName('');
  };
  const loadTeam = (id) => {
    const t = library.find((x) => x.id === id);
    if (!t) return;
    const slots = t.slots.slice(0, 6).map((s) => ({ ...emptySlot(), ...s }));
    while (slots.length < 6) slots.push(emptySlot());
    setTeam(slots);
    setValidation(null);
    setActive(null);
  };
  const [validation, setValidation] = useState(null);
  const { regulation } = useContext(DataCtx);  // selected in the header
  const [paste, setPaste] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const filled = team.filter((s) => s.pokemonId);
  const payload = () => ({
    team: filled.map((s) => ({ pokemon: combatant(s), moves: s.moves.filter(Boolean) })),
    regulation,
  });

  const setSlot = (i, slot) => {
    const next = [...team];
    next[i] = slot;
    setTeam(next);
    setValidation(null);
  };

  const run = async (fn) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const validate = () => run(async () => setValidation(await post('/team/validate', payload())));

  const doImport = () => run(async () => {
    const r = await post('/team/import', { paste, regulation });
    const slots = r.team.map((m) => ({
      ...emptySlot(),
      pokemonId: m.pokemon.pokemon_id,
      displayName: pokemon.find((p) => p.id === m.pokemon.pokemon_id)?.name,
      types: pokemon.find((p) => p.id === m.pokemon.pokemon_id)?.types || [],
      spread: m.pokemon.spread,
      alignment: m.pokemon.alignment,
      ability: m.pokemon.ability || '',
      item: m.pokemon.item || '',
      itemUserSet: !!m.pokemon.item,
      moves: [...m.moves, '', '', '', ''].slice(0, 4),
    }));
    while (slots.length < 6) slots.push(emptySlot());
    setTeam(slots);
    setValidation(r.validation);
    setShowPaste(false);
  });

  const doExport = () => run(async () => {
    const r = await post('/team/export', payload());
    setPaste(r.paste);
    setShowPaste(true);
  });

  return (
    <div className="builder-layout">
      <div className="builder-main">
        <div className="toolbar">
          <button onClick={() => setShowPaste(!showPaste)}>Import / export paste</button>
          <button className={showTeams ? 'active-toggle' : ''}
            onClick={() => setShowTeams(!showTeams)}>
            My teams ({library.length})
          </button>
          <span className="spacer" />
          <button
            className={showSpeed ? 'primary active-toggle' : ''}
            onClick={() => { setShowSpeed(!showSpeed); if (!showSpeed) setActive(null); }}
          >
            Speed tiers {showSpeed ? 'ON' : ''}
          </button>
          <button className="primary" onClick={validate} disabled={busy || filled.length === 0}>
            Validate team
          </button>
        </div>

        {showTeams && (
          <div className="panel teams-panel">
            <div className="toolbar">
              <input placeholder="Team name (e.g. Rain v3)" value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                style={{ flex: 1 }} />
              <button className="primary" onClick={saveTeam}
                disabled={!teamName.trim() || filled.length === 0}>
                Save current team
              </button>
            </div>
            {library.length === 0 ? (
              <p className="dim small">No saved teams yet. Your working team
              autosaves on its own — this library is for keeping multiple
              named teams.</p>
            ) : (
              <ul className="team-library">
                {library.map((t) => (
                  <li key={t.id}>
                    <div className="team-lib-sprites">
                      {t.slots.filter((s) => s.pokemonId).map((s, i) => (
                        <Sprite key={i} id={s.pokemonId} size={30} />
                      ))}
                    </div>
                    <span className="team-lib-name">{t.name}</span>
                    <span className="dim small">
                      {new Date(t.savedAt).toLocaleDateString()}
                    </span>
                    <button onClick={() => loadTeam(t.id)}>Load</button>
                    <button className="chip-x"
                      onClick={() => persistLibrary(library.filter((x) => x.id !== t.id))}>
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {showPaste && (
          <div className="paste-box">
            <textarea
              rows={11}
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder={'Tyranitar-Mega @ Tyranitarite\nAbility: Sand Stream\nLevel: 50\nEVs: 17 HP / 26 Atk / 1 Def / 1 SpD / 21 Spe\nAdamant Nature\n- Rock Slide\n- Protect\n- Knock Off\n- Dragon Dance'}
            />
            <div className="toolbar">
              <button className="primary" onClick={doImport} disabled={busy || !paste.trim()}>
                Import paste → team
              </button>
              <button onClick={doExport} disabled={busy || filled.length === 0}>
                Export current team → paste
              </button>
            </div>
          </div>
        )}

        {error && <div className="errors banner">{error}</div>}
        {validation && (
          <div className={validation.valid ? 'banner ok-banner' : 'banner errors'}>
            {validation.valid
              ? `✓ Team is legal for Regulation ${regulation}`
              : ['Team has problems:', ...validation.team_errors].join(' ')}
          </div>
        )}

        <div className="slot-strip">
          {team.map((slot, i) => (
            <SlotCard
              key={i}
              index={i}
              slot={slot}
              selected={active === i && !showSpeed}
              onSelect={() => { setActive(i); setShowSpeed(false); }}
              onClear={() => { setSlot(i, emptySlot()); if (active === i) setActive(null); }}
            />
          ))}
        </div>

        {showSpeed && <SpeedTiers slots={team} regulation={regulation} />}

        {!showSpeed && active !== null && (
          <SlotEditorWrapper
            slot={team[active]}
            onChange={(s) => setSlot(active, s)}
            onClose={() => setActive(null)}
            errors={team[active].pokemonId
              ? validation?.member_errors?.[filled.indexOf(team[active])] ?? null
              : null}
          />
        )}
      </div>
      <PlaybookCheck slots={team} />
      <LiveAnalysis slots={team} />
    </div>
  );
}
