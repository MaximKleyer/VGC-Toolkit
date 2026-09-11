import React, { useContext, useMemo, useState } from 'react';
import { DataCtx } from '../App.jsx';
import { post, combatant, emptySlot, padTeam } from '../api.js';
import { PokemonPicker, Sprite, TypeChip } from './shared.jsx';
import SimLab from './SimLab.jsx';

const FIELD_OPTIONS = [
  ['auto', 'Auto (your setter)'],
  ['none', 'Neutral (no weather)'],
  ['rain', 'Rain'], ['sun', 'Sun'], ['sand', 'Sand'], ['snow', 'Snow'],
];

const SPEED_GLYPH = { true: '›', false: '‹' };

function cellStyle(score) {
  const f = Math.min(1, Math.abs(score) / 100);
  const a = 0.10 + 0.42 * f;
  const bg = score >= 0
    ? `rgba(46, 213, 115, ${a})`
    : `rgba(255, 82, 82, ${a})`;
  return { background: bg };
}

function MatrixCell({ c }) {
  const speed = c.speed_tie ? '=' : SPEED_GLYPH[c.i_outspeed];
  const speedColor = c.speed_tie ? '#9bb3cc'
    : c.i_outspeed ? '#7bdba1' : '#ff8a8a';
  const title =
    `YOU: ${c.my_move || '—'} ${c.my_pct}% (KO ~${c.my_ko_turns}T)\n`
    + `THEM: ${c.their_move || '—'} ${c.their_pct}% (KO ~${c.their_ko_turns}T)\n`
    + (c.speed_tie ? 'Speed tie'
      : c.i_outspeed ? 'You outspeed' : 'They outspeed')
    + `  ·  score ${c.score}`;
  return (
    <td className="tp-cell" style={cellStyle(c.score)} title={title}>
      <div className="tp-cell-out">{c.my_pct}%</div>
      <div className="tp-cell-in">
        <span style={{ color: speedColor, fontWeight: 700 }}>{speed}</span>
        {' '}{c.their_pct}%
      </div>
    </td>
  );
}

function PairSprites({ ids }) {
  return (
    <span className="tp-pair">
      {ids.map((id, i) => <Sprite key={i} id={id} size={34} />)}
    </span>
  );
}

// A slot with moves is a scouted set and is analysed as such; a bare
// {pokemonId} is read from the ladder's most-likely set.
const toOppMon = (s) => ((s.moves || []).some(Boolean)
  ? { pokemon_id: s.pokemonId, spread: s.spread, alignment: s.alignment, ability: s.ability || null,
      item: s.item || null, moves: (s.moves || []).filter(Boolean) }
  : { pokemon_id: s.pokemonId });

export default function TeamPreview({ team, sendToCalc }) {
  const { metaSets, regulation, oppTeam, teamLibrary } = useContext(DataCtx);
  const oppImported = (oppTeam || []).filter((s) => s.pokemonId);
  const metaAvailable = Object.keys(metaSets?.pokemon || {}).length > 0;
  const library = teamLibrary || [];
  const savedMine = library.filter((t) => (t.kind || 'mine') !== 'opponent');
  const savedOpp = library.filter((t) => t.kind === 'opponent');

  // Your side: the Team Builder's working team, or any saved team.
  const [mySource, setMySource] = useState('builder');
  const mySlots = useMemo(() => {
    if (mySource === 'builder') return team;
    const t = library.find((x) => x.id === mySource);
    return t ? padTeam(t.slots) : team;
  }, [mySource, team, library]);
  const myFilled = useMemo(() => mySlots.filter((s) => s.pokemonId), [mySlots]);

  // Their side: six slots that may carry full sets (imported or saved teams) or just a species.
  const [opp, setOpp] = useState(Array(6).fill(null));
  const [oppSource, setOppSource] = useState('');
  const [fieldMode, setFieldMode] = useState('auto');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const oppFilled = opp.filter(Boolean);
  const setOppAt = (i, slot) =>
    setOpp((o) => o.map((x, idx) => (idx === i ? slot : x)));
  const loadOpp = (key) => {
    setOppSource(key);
    if (!key) return;
    const slots = key === 'current' ? oppImported : (library.find((t) => t.id === key)?.slots || []).filter((s) => s.pokemonId);
    setOpp(Array(6).fill(null).map((_, i) => (slots[i] ? { ...emptySlot(), ...slots[i] } : null)));
  };
  const scouted = oppFilled.filter((s) => (s.moves || []).some(Boolean)).length;

  const analyze = async () => {
    setBusy(true); setError(null);
    try {
      const body = {
        my_team: myFilled.map((s) => ({
          ...combatant(s), moves: (s.moves || []).filter(Boolean),
        })),
        opp_team: oppFilled.map(toOppMon),
        regulation,
      };
      if (fieldMode !== 'auto') {
        body.field = { weather: fieldMode === 'none' ? 'none' : fieldMode,
                       terrain: 'none' };
      }
      setResult(await post('/matchup/team-preview', body));
    } catch (e) {
      setError(e.message || 'request failed — is the backend running?');
    } finally {
      setBusy(false);
    }
  };

  const projectedSet = result
    ? new Set(result.opponent.projected_lead.pair) : new Set();

  return (
    <div className="tp-wrap">
      <section className="panel">
        <h3 className="panel-title">Team Preview</h3>
        <p className="dim small">
          Your exact builds vs the opponent's six. Their spreads aren't shown
          at preview, so known Pokémon are read from their most-likely ladder
          set{metaAvailable ? '' : ' (meta data not loaded)'}; the rest assume
          max offense. Everything is a 1v1 doubles approximation — priority
          moves, Protect, and double-targeting aren't modelled.
        </p>

        <div className="tp-teams">
          <div>
            <h4 className="tp-h4">
              Your team ({myFilled.length})
              {savedMine.length > 0 && (
                <select value={mySource} onChange={(e) => setMySource(e.target.value)} style={{ marginLeft: 10 }}
                  title="Analyse the Team Builder's team or one of your saved teams">
                  <option value="builder">Team Builder</option>
                  {savedMine.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              )}
            </h4>
            {myFilled.length === 0 ? (
              <p className="dim small">Build a team in the Builder tab first.</p>
            ) : (
              <div className="tp-myrow">
                {myFilled.map((s) => (
                  <div key={s.pokemonId} className="tp-mychip"
                    title={s.displayName}>
                    <Sprite id={s.pokemonId} size={40} />
                    <span className="small">{s.displayName}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <h4 className="tp-h4">
              Opponent ({oppFilled.length}{scouted ? `, ${scouted} with real sets` : ''})
              <select value={oppSource} onChange={(e) => loadOpp(e.target.value)} style={{ marginLeft: 10 }}
                title="Load a team: the Team Builder's imported opponent, or any saved team. Saved sets are analysed with their real spreads and moves.">
                <option value="">Load a team…</option>
                {oppImported.length > 0 && (
                  <option value="current">Team Builder opponent ({oppImported.map((s) => s.nickname || s.displayName).join(', ')})</option>
                )}
                {savedOpp.length > 0 && (
                  <optgroup label="Saved opponent teams">
                    {savedOpp.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </optgroup>
                )}
                {savedMine.length > 0 && (
                  <optgroup label="My saved teams (as the opponent)">
                    {savedMine.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </optgroup>
                )}
              </select>
              {oppFilled.length > 0 && (
                <button className="small" style={{ marginLeft: 8 }} onClick={() => { setOpp(Array(6).fill(null)); setOppSource(''); }}>Clear</button>
              )}
            </h4>
            <div className="tp-opp-grid">
              {opp.map((s, i) => (
                <PokemonPicker key={i} value={s?.pokemonId || null}
                  placeholder={`Opp #${i + 1}`}
                  onPick={(p) => { setOppAt(i, { ...emptySlot(), pokemonId: p.id, displayName: p.name, types: p.types }); setOppSource(''); }} />
              ))}
            </div>
            {oppFilled.length > 0 && (
              <div className="dim small" style={{ marginTop: 6 }}>
                {oppFilled.map((s) => `${s.nickname || s.displayName || s.pokemonId}${(s.moves || []).some(Boolean) ? '' : ' (ladder set)'}`).join(' · ')}
              </div>
            )}
          </div>
        </div>

        <div className="tp-controls">
          <label>
            Field context
            <select value={fieldMode}
              onChange={(e) => setFieldMode(e.target.value)}>
              {FIELD_OPTIONS.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
          <button className="primary big" onClick={analyze}
            disabled={busy || myFilled.length < 1 || oppFilled.length < 1}>
            {busy ? 'Analyzing…' : 'Analyze matchup'}
          </button>
        </div>
        {error && <div className="banner errors">{error}</div>}
      </section>

      {result && (
        <>
          <section className="panel tp-summary">
            <p>{result.summary}</p>
            <div className="tp-field-chip">
              Analysis under:{' '}
              <strong>
                {result.field.weather !== 'none' ? result.field.weather
                  : result.field.terrain !== 'none' ? result.field.terrain
                    : 'neutral'}
              </strong>
              {result.field.source && (
                <span className="dim"> · {result.field.source}</span>
              )}
            </div>
          </section>

          <section className="panel">
            <h3 className="panel-title">Their likely leads</h3>
            <div className="tp-leads">
              {[...result.opponent.mons]
                .sort((a, b) => b.lead_pct - a.lead_pct)
                .map((m) => (
                  <div key={m.id}
                    className={`tp-lead-row ${projectedSet.has(m.id) ? 'projected' : ''}`}>
                    <Sprite id={m.id} size={36} />
                    <div className="tp-lead-name">
                      {m.name}
                      {projectedSet.has(m.id) &&
                        <span className="chip ok">projected lead</span>}
                      {m.meta && m.usage &&
                        <span className="chip dim-chip">{m.usage}% used</span>}
                    </div>
                    <div className="tp-lead-bar-wrap">
                      <div className={`tp-lead-bar tier-${m.lead_tier}`}
                        style={{ width: `${Math.max(4, m.lead_pct)}%` }} />
                      <span className="tp-lead-pct mono">{m.lead_pct}%</span>
                    </div>
                    <div className="tp-lead-why dim small">
                      {m.lead_reasons.length
                        ? m.lead_reasons.join(' · ') : 'no strong lead signals'}
                    </div>
                  </div>
                ))}
            </div>
            <p className="dim small">
              Likelihood blends lead-defining traits (Fake Out, Intimidate,
              weather/terrain setting, Tailwind/Trick Room, redirection, Scarf)
              with how hard each Pokémon pressures your team.
            </p>
          </section>

          <section className="panel">
            <h3 className="panel-title">Matchup matrix</h3>
            <p className="dim small">
              Each cell: your best move's max % (top) and their best back at you
              (bottom). The arrow shows who's faster
              (<span style={{ color: '#7bdba1' }}>›</span> you,{' '}
              <span style={{ color: '#ff8a8a' }}>‹</span> them). Green favors
              you, red favors them. Hover for the full KO math.
            </p>
            <div className="tp-matrix-scroll">
              <table className="tp-matrix">
                <thead>
                  <tr>
                    <th className="tp-corner">you ↓ / them →</th>
                    {result.matrix.cols.map((id, j) => (
                      <th key={id} title={result.matrix.col_names[j]}>
                        <Sprite id={id} size={30} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.matrix.rows.map((rid, i) => (
                    <tr key={rid}>
                      <th className="tp-rowhead" title={result.matrix.row_names[i]}>
                        <Sprite id={rid} size={30} />
                      </th>
                      {result.matrix.cells[i].map((c, j) => (
                        <MatrixCell key={j} c={c} />
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <h3 className="panel-title">Your best leads</h3>
            <div className="tp-rec-grid">
              {result.your_leads.map((lo, i) => (
                <div key={i} className="tp-rec-card">
                  <div className="tp-rec-head">
                    <PairSprites ids={lo.pair} />
                    <div>
                      <div className="tp-rec-title">
                        {lo.pair_names.join(' + ')}
                      </div>
                      {lo.notes.length > 0 && (
                        <div className="dim small">{lo.notes.join(' · ')}</div>
                      )}
                    </div>
                  </div>
                  {lo.why?.length > 0 && (
                    <ul className="tp-notes small">
                      {lo.why.map((w, k) => <li key={k} className={w.startsWith('watch') ? 'danger' : ''}>{w}</li>)}
                    </ul>
                  )}
                  {lo.beats.length > 0 && (
                    <div className="tp-rec-line">
                      <span className="dim small">beats</span>
                      {lo.beats.map((n) => (
                        <span key={n} className="chip ok">{n}</span>
                      ))}
                    </div>
                  )}
                  {lo.loses_to.length > 0 && (
                    <div className="tp-rec-line">
                      <span className="dim small">watch</span>
                      {lo.loses_to.map((n) => (
                        <span key={n} className="chip bad">{n}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <h3 className="panel-title">Recommended four to bring</h3>
            {result.my_megas?.length > 1 && (
              <p className="dim small">Your team carries {result.my_megas.length} Megas ({result.my_megas.join(', ')}); only one Pokémon can Mega Evolve per game, so every four below brings at most one of them.</p>
            )}
            <div className="tp-rec-grid">
              {result.bring_four.map((b, i) => (
                <div key={i} className="tp-rec-card">
                  <div className="tp-bring-mons">
                    {b.mons.map((id, k) => (
                      <div key={id} className="tp-bring-mon"
                        title={`${b.mon_names[k]}${b.lead && b.lead.includes(id) ? ' · lead' : ''}${b.mega === b.mon_names[k] ? ' · Mega Evolves' : ''}`}>
                        <Sprite id={id} size={40} />
                        {b.lead && b.lead.includes(id) &&
                          <span className="tp-lead-tag">LEAD</span>}
                        {b.mega === b.mon_names[k] && <span className="tp-mega-tag">✦</span>}
                      </div>
                    ))}
                  </div>
                  <div className="tp-bench dim small">
                    bench: {b.bench_names.join(', ')}
                  </div>
                  {(b.why || b.notes).length > 0 && (
                    <ul className="tp-notes small">
                      {(b.why || b.notes).map((n, k) => <li key={k}>{n}</li>)}
                    </ul>
                  )}
                  {b.lead && (
                    <button className="ghost small"
                      onClick={() => {
                        const a = myFilled.find((s) => s.pokemonId === b.lead[0]);
                        const d = result.opponent.mons.find(
                          (m) => projectedSet.has(m.id));
                        if (!a || !d) return;
                        sendToCalc({
                          p1: { ...emptySlot(), ...a },
                          p2: {
                            ...emptySlot(), pokemonId: d.id,
                            spread: d.set.spread, alignment: d.set.alignment,
                            ability: d.set.ability || '', item: d.set.item || '',
                            moves: [...d.set.moves, '', '', ''].slice(0, 4),
                          },
                        });
                      }}>
                      open lead vs projected threat in calc →
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>

          <SimLab mySlots={myFilled} oppMons={result.opponent?.mons || []} regulation={regulation} />
        </>
      )}
    </div>
  );
}
