import React, { useContext, useEffect, useState } from 'react';
import { DataCtx } from '../App.jsx';
import { post, emptySlot, emptyTeam, padTeam, slotsFromImport, teamMembers } from '../api.js';
import {
  MoveSelect, PokemonPicker, Sprite, StatPointsEditor, TypeChip,
  useFullMon, useLearnset, itemLabel, stonesFor, megaSwitchTarget, switchForm, CategoryIcon, accuracyLabel,
} from './shared.jsx';
import LiveAnalysis from './LiveAnalysis.jsx';
import PlaybookCheck from './PlaybookCheck.jsx';
import SpeedTiers from './SpeedTiers.jsx';
import AbilityOverride from './AbilityOverride.jsx';

function SlotCard({ index, slot, selected, onSelect, onClear }) {
  const { moves: moveDb } = useContext(DataCtx) || {};
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
      {slot.nickname && <div className="slot-nick">{slot.nickname}</div>}
      <div className="slot-name">{slot.displayName || slot.pokemonId}</div>
      <div className="slot-types">
        {(slot.types || []).map((t) => <TypeChip key={t} t={t} />)}
      </div>
      <div className="slot-align warn small">{slot.alignment}</div>
      <ul className="slot-moves dim small">
        {slot.moves.filter(Boolean).map((m) => (
          <li key={m} title={moveDb?.[m]?.short_desc}>
            <CategoryIcon category={moveDb?.[m]?.category} /> {m}
            <span className="slot-move-acc mono">{accuracyLabel(moveDb?.[m])}</span>
          </li>
        ))}
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
  const stones = stonesFor(mon, items);
  const groups = {
    ...(stones.length ? { 'Mega Stone': stones } : {}),
    'Held items': items.filter((i) => i.category === 'held'),
    Berries: items.filter((i) => i.category === 'berry'),
  };
  return (
    <select value={slot.item} onChange={(e) => upd({ item: e.target.value })}>
      <option value="">None</option>
      {Object.entries(groups).map(([label, list]) => (
        <optgroup label={label} key={label}>
          {list.map((i) => <option key={i.id} value={i.name}>{itemLabel(i)}</option>)}
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

// "Mega Evolve" on a base form holding its stone, "Base form" on a Mega.
function MegaSwitch({ slot, mon, onChange, compact }) {
  const { items, pokemon } = useContext(DataCtx);
  const target = megaSwitchTarget(slot, mon, items, pokemon);
  if (!target) return null;
  return (
    <button className={`mega-switch ${compact ? 'small' : ''}`}
      title={target.mega ? `Show this set as ${target.id} (same spread, moves and item; ability follows the form)`
                         : 'Show this set as the base form it is brought as'}
      onClick={(e) => { e.stopPropagation(); switchForm(slot, target.id).then(onChange); }}>
      ✦ {target.label}
    </button>
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
        <MegaSwitch slot={slot} mon={mon} onChange={onChange} />
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
  const { pokemon, teamLibrary, saveTeamEntry, deleteTeamEntry, oppTeam, setOppTeam } = useContext(DataCtx);
  const [active, setActive] = useState(null);
  const [showSpeed, setShowSpeed] = useState(false);
  const [showTeams, setShowTeams] = useState(false);
  const [showOpp, setShowOpp] = useState(false);
  const [teamName, setTeamName] = useState('');
  const [oppPaste, setOppPaste] = useState('');
  const [oppName, setOppName] = useState('');
  const mine = teamLibrary.filter((t) => (t.kind || 'mine') !== 'opponent');
  const opps = teamLibrary.filter((t) => t.kind === 'opponent');
  const oppFilled = oppTeam.filter((s) => s.pokemonId);

  const saveTeam = () => {
    const name = teamName.trim();
    if (!name) return;
    saveTeamEntry({ kind: 'mine', name, slots: team });
    setTeamName('');
  };
  const loadTeam = (id) => {
    const t = teamLibrary.find((x) => x.id === id);
    if (!t) return;
    setTeam(padTeam(t.slots));
    setValidation(null);
    setActive(null);
  };
  const saveOpp = () => {
    const name = oppName.trim();
    if (!name) return;
    saveTeamEntry({ kind: 'opponent', name, slots: oppTeam });
    setOppName('');
  };
  const [validation, setValidation] = useState(null);
  const { regulation } = useContext(DataCtx);  // selected in the header
  const [paste, setPaste] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const filled = team.filter((s) => s.pokemonId);
  const payload = () => ({ team: teamMembers(filled), regulation });

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
    setTeam(slotsFromImport(r, pokemon));
    setValidation(r.validation);
    setShowPaste(false);
  });
  // The opponent team: what the Damage Calc's Pokémon 2 strip, the Team Preview
  // tab and the Battle tab's opponent picker read.
  const importOpp = () => run(async () => {
    const r = await post('/team/import', { paste: oppPaste, regulation });
    setOppTeam(slotsFromImport(r, pokemon));
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
            My teams ({mine.length})
          </button>
          <button className={showOpp ? 'active-toggle' : ''}
            onClick={() => setShowOpp(!showOpp)}>
            Opponent team ({oppFilled.length})
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
            {mine.length === 0 ? (
              <p className="dim small">No saved teams yet. Your working team
              autosaves on its own — this library is for keeping multiple
              named teams. Saved teams also appear in the Battle tab.</p>
            ) : (
              <ul className="team-library">
                {mine.map((t) => (
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
                    <button title="Use this team as the opponent you are calcing against"
                      onClick={() => { setOppTeam(padTeam(t.slots)); setShowOpp(true); }}>
                      As opponent
                    </button>
                    <button className="chip-x" onClick={() => deleteTeamEntry(t.id)}>×</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {showOpp && (
          <div className="panel teams-panel opp-panel">
            <p className="dim small" style={{ margin: 0 }}>
              The team you are calcing against. It feeds the Damage Calc (the Pokémon 2 strip),
              the Team Preview tab and the Battle tab's opponent. Nicknames, genders and Shiny
              lines in a paste are fine.
            </p>
            <textarea rows={8} className="mono" value={oppPaste} onChange={(e) => setOppPaste(e.target.value)}
              placeholder={'Kids (Kingambit) @ Black Glasses\nAbility: Defiant\nLevel: 50\nEVs: 32 HP / 32 Atk / 1 SpD / 1 Spe\nAdamant Nature\n- Kowtow Cleave\n- Sucker Punch\n- Swords Dance\n- Protect'} />
            <div className="toolbar">
              <button className="primary" onClick={importOpp} disabled={busy || !oppPaste.trim()}>
                Import paste → opponent team
              </button>
              <button onClick={() => setOppTeam(emptyTeam())} disabled={!oppFilled.length}>Clear</button>
              <span className="spacer" />
              <input placeholder="Save as… (e.g. Rain team from ladder)" value={oppName}
                onChange={(e) => setOppName(e.target.value)} style={{ minWidth: 220 }} />
              <button onClick={saveOpp} disabled={!oppName.trim() || !oppFilled.length}>Save opponent team</button>
            </div>
            {oppFilled.length > 0 && (
              <div className="opp-strip">
                {oppTeam.map((s, i) => s.pokemonId && (
                  <div key={i} className="opp-chip"
                    title={`${s.displayName}${s.item ? ` @ ${s.item}` : ''}\n${s.ability || ''}\n${(s.moves || []).filter(Boolean).join(' / ')}`}>
                    <Sprite id={s.pokemonId} size={52} />
                    <span className="opp-chip-name">{s.nickname || s.displayName}</span>
                    {s.nickname && <span className="dim small">{s.displayName}</span>}
                    <span className="dim small">{s.item || 'no item'}</span>
                    <div className="slot-types">{(s.types || []).map((t) => <TypeChip key={t} t={t} />)}</div>
                    <MegaSwitch slot={s} mon={{ id: s.pokemonId }} compact
                      onChange={(ns) => setOppTeam(oppTeam.map((x, j) => (j === i ? ns : x)))} />
                  </div>
                ))}
              </div>
            )}
            {opps.length > 0 && (
              <ul className="team-library">
                {opps.map((t) => (
                  <li key={t.id}>
                    <div className="team-lib-sprites">
                      {t.slots.filter((s) => s.pokemonId).map((s, i) => (
                        <Sprite key={i} id={s.pokemonId} size={30} />
                      ))}
                    </div>
                    <span className="team-lib-name">{t.name}</span>
                    <span className="chip team-lib-kind">opponent</span>
                    <span className="dim small">{new Date(t.savedAt).toLocaleDateString()}</span>
                    <button onClick={() => setOppTeam(padTeam(t.slots))}>Load</button>
                    <button title="Edit this team as your own" onClick={() => { setTeam(padTeam(t.slots)); setValidation(null); setActive(null); }}>
                      As mine
                    </button>
                    <button className="chip-x" onClick={() => deleteTeamEntry(t.id)}>×</button>
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
