import React, { useContext, useEffect, useState } from 'react';
import { DataCtx } from '../App.jsx';
import { post, combatant, emptySlot, loadSets } from '../api.js';
import {
  MoveSelect, PokemonPicker, Sprite, StatPointsEditor, TypeChip,
  useFullMon, useLearnset,
} from './shared.jsx';

const DEF_SPEED_LABELS = {
  outspeeds_even_uninvested: ['Outspeeds (even 0 SP)', 'speed-bad'],
  outspeeds_at_max_speed: ['Outspeeds at max', 'speed-warn'],
  speed_tie_at_max: ['Speed tie at max', 'speed-tie'],
  you_outspeed: ['You outspeed', 'speed-ok'],
  outspeeds_you: ['Outspeeds you', 'speed-bad'],
  speed_tie: ['Speed tie', 'speed-tie'],
};
const OFF_SPEED_LABELS = {
  you_outspeed_even_their_max: ['Faster than their max', 'speed-ok'],
  speed_tie_at_their_max: ['Tie at their max', 'speed-tie'],
  you_outspeed_uninvested: ['Faster if they skip Spe', 'speed-warn'],
  they_outspeed: ['They outspeed', 'speed-bad'],
};
const emptyBuild = () => ({ ...emptySlot() });

function BuildPanel({ build, setBuild, team, title, note }) {
  const { mon } = useFullMon(build.pokemonId);
  const learnset = useLearnset(build.pokemonId);
  const { alignments, items } = useContext(DataCtx);
  const sets = loadSets();
  const upd = (patch) => setBuild({ ...build, ...patch });
  const setMove = (i, name) => {
    const next = [...build.moves]; next[i] = name; upd({ moves: next });
  };
  return (
    <section className="panel side-panel">
      <h3 className="panel-title">{title}</h3>
      <div className="team-strip">
        {team.map((slot, i) => (
          <button key={i} className="team-strip-btn" disabled={!slot.pokemonId}
            title={slot.displayName || `Slot ${i + 1}`}
            onClick={() => setBuild({ ...emptyBuild(), ...slot })}>
            {slot.pokemonId ? <Sprite id={slot.pokemonId} size={34} />
              : <span className="dim">{i + 1}</span>}
          </button>
        ))}
      </div>
      <div className="row">
        <label style={{ flex: 2 }}>
          Pokémon
          <PokemonPicker value={build.pokemonId}
            onPick={(p) => setBuild({ ...emptyBuild(), pokemonId: p.id,
                                      displayName: p.name, types: p.types })} />
        </label>
        <label>
          Saved set
          <select value="" onChange={(e) => {
            const s = sets.find((x) => x.id === e.target.value);
            if (s) setBuild({ ...emptyBuild(), ...s.state,
                              pokemonId: s.pokemonId, displayName: s.displayName,
                              types: s.types, moves: s.moves });
          }}>
            <option value="">{sets.length ? '(load a set…)' : '(no saved sets)'}</option>
            {sets.map((s) => (
              <option key={s.id} value={s.id}>{s.displayName} — {s.name}</option>
            ))}
          </select>
        </label>
      </div>
      {mon && (
        <>
          <div className="row">
            <label>
              Ability
              <select value={build.ability} onChange={(e) => upd({ ability: e.target.value })}>
                <option value="">{mon.abilities[0] ? `${mon.abilities[0]} (default)` : '—'}</option>
                {mon.abilities.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
            <label>
              Item
              {mon.mega_stone ? (
                <div className="locked-item small">{mon.mega_stone}</div>
              ) : (
                <select value={build.item} onChange={(e) => upd({ item: e.target.value })}>
                  <option value="">None</option>
                  {items.map((i) => <option key={i.id} value={i.name}>{i.name}</option>)}
                </select>
              )}
            </label>
            <label>
              Alignment
              <select value={build.alignment} onChange={(e) => upd({ alignment: e.target.value })}>
                {Object.keys(alignments).map((n) => <option key={n}>{n}</option>)}
              </select>
            </label>
          </div>
          <StatPointsEditor baseStats={mon.base} spread={build.spread}
            alignment={build.alignment} onChange={(spread) => upd({ spread })} />
          <div className="moves-grid">
            {build.moves.map((m, i) => (
              <MoveSelect key={i} moves={learnset} value={m}
                onChange={(v) => setMove(i, v)} />
            ))}
          </div>
          {note && <p className="dim small">{note}</p>}
        </>
      )}
    </section>
  );
}

export default function ThreatScan({ team, sendToCalc }) {
  const { moves: moveDb, metaSets, regulation, regulations } = useContext(DataCtx);
  const metaAvailable = Object.keys(metaSets?.pokemon || {}).length > 0;
  // How many regulations behind the selected one the ladder data is. One step
  // behind is normal right after a regulation change (its ladder has not run
  // yet), so only two or more counts as stale.
  const metaReg = metaSets?.info?.regulation || null;
  // Published regulations only: an experimental tag (none at present) counts as the
  // regulation it is based on, since ladders exist only for published ones.
  const regOrder = (regulations || []).filter((r) => !r.experimental).map((r) => r.regulation);
  const selBase = (regulations || []).find((r) => r.regulation === regulation)?.based_on || regulation;
  const metaLag = metaReg && regOrder.includes(metaReg) && regOrder.includes(selBase)
    ? regOrder.indexOf(selBase) - regOrder.indexOf(metaReg)
    : 0;
  const metaStale = metaLag >= 2;
  const metaTitle = !metaReg ? undefined
    : metaStale ? `This ladder data is from Regulation ${metaReg}, ${metaLag} regulations behind ${regulation}; refresh it`
    : metaLag === 1 ? `Ladder data is from Regulation ${metaReg}, the newest published; ${regulation} stats will exist once its ladder has run`
    : undefined;
  const [mode, setMode] = useState('threats');
  const [build, setBuild] = useState(emptyBuild);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // mode 1
  const [practical, setPractical] = useState(true);
  const [useMeta, setUseMeta] = useState(true);
  // Default to the FULL pool (ladder sets for known mons, theoretical fillers
  // for everyone else) so a first scan isn't silently limited to ranked Pokémon.
  const [metaOnly, setMetaOnly] = useState(false);
  const [scope, setScope] = useState('one');
  const [scan, setScan] = useState(null);
  const [teamScan, setTeamScan] = useState(null);
  const [atkOverride, setAtkOverride] = useState(null);
  const filledSlots = team.filter((s) => s.pokemonId);

  useEffect(() => { setScan(null); }, [build.pokemonId]);
  // mode 2
  const [pool, setPool] = useState({ hp: 0, def: 0, alignment: 'neutral' });
  const [offense, setOffense] = useState(null);
  // mode 3
  const [atkSide, setAtkSide] = useState(emptyBuild);
  const [atkMove, setAtkMove] = useState('');
  const [atkSp, setAtkSp] = useState(32);
  const [atkBoost, setAtkBoost] = useState(true);
  const [survField, setSurvField] = useState({ weather: 'none', is_crit: false,
    helping_hand: false, is_doubles: true });
  const [survMode, setSurvMode] = useState('guaranteed');
  const [solution, setSolution] = useState(null);
  const [picked, setPicked] = useState(0);
  const atkLearnset = useLearnset(atkSide.pokemonId);
  const { mon: atkMon } = useFullMon(atkSide.pokemonId);

  const run = (fn) => async () => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const attackerFromThreat = (t) => {
    if (t.meta && t.set) {
      return {
        pokemonId: t.attacker, displayName: t.attacker_name, types: [],
        spread: t.set.spread, alignment: t.set.alignment,
        ability: t.set.ability || '', item: t.set.item || '',
        stages: {}, status: null, hpPct: 100,
        moves: [...t.set.moves, '', '', ''].slice(0, 4),
      };
    }
    const cat = moveDb[t.move]?.category;
    const offenseKey = cat === 'Physical' ? 'atk' : 'spa';
    return {
      pokemonId: t.attacker, displayName: t.attacker_name, types: [],
      spread: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0,
                [offenseKey]: 32 },
      alignment: cat === 'Physical' ? 'Adamant' : 'Modest',
      ability: t.ability || '', item: '', stages: {}, status: null,
      moves: [t.move, '', '', ''],
    };
  };

  // Every pool-dependent scan sends the header's selected regulation so the
  // attacker pool matches the roster the Builder is using.
  const doThreatScan = run(async () => {
    if (scope === 'team') {
      setTeamScan(await post('/matchup/threats/team', {
        team: filledSlots.map((s) => combatant(s)), top_n: 25, practical,
        use_meta_sets: metaAvailable && useMeta,
        meta_only: metaAvailable && useMeta && metaOnly,
        regulation,
      }));
      return;
    }
    setScan(await post('/matchup/threats', {
      defender: combatant(build), top_n: 30, practical,
      use_meta_sets: metaAvailable && useMeta,
      meta_only: metaAvailable && useMeta && metaOnly,
      regulation,
    }));
  });

  const doOffenseScan = run(async () => {
    setOffense(await post('/matchup/offense', {
      attacker: combatant(build),
      moves: build.moves.filter(Boolean),
      pool_hp_sp: pool.hp, pool_def_sp: pool.def,
      pool_alignment: pool.alignment, top_n: 30,
      regulation,
    }));
  });

  const doSolve = run(async () => {
    setSolution(null); setPicked(0);
    const cat = moveDb[atkMove]?.category;
    const offenseKey = cat === 'Physical' ? 'atk' : 'spa';
    const attacker = atkOverride
      ? {
          pokemon_id: atkOverride.attacker,
          spread: atkOverride.spread,
          alignment: atkOverride.alignment,
          ability: atkOverride.ability || null,
          item: atkOverride.item || null,
        }
      : {
          pokemon_id: atkSide.pokemonId,
          spread: { [offenseKey]: atkSp },
          alignment: atkBoost ? (cat === 'Physical' ? 'Adamant' : 'Modest') : 'Serious',
          ability: atkSide.ability || null,
        };
    const r = await post('/matchup/survive', {
      defender_id: build.pokemonId,
      alignment: build.alignment,
      ability: build.ability || null,
      item: build.item || null,
      moves: build.moves.filter(Boolean),
      attacker,
      move: atkMove,
      field: survField,
      mode: survMode,
    });
    setSolution(r);
  });

  const toCalc = (attackerSide) => sendToCalc({ p1: build, p2: attackerSide });

  return (
    <div className="page">
      <div className="segmented mode-switch">
        {[['threats', 'Threats to me'], ['offense', 'Who I threaten'],
          ['survive', 'Survival calc']].map(([v, label]) => (
          <button key={v} className={mode === v ? 'on' : ''}
            onClick={() => setMode(v)}>{label}</button>
        ))}
      </div>

      <div className="calc-grid">
        <BuildPanel build={build} setBuild={setBuild} team={team}
          title={mode === 'offense' ? 'Your attacker' : 'Your build'}
          note={mode === 'survive'
            ? 'The solver replaces this spread — Pokémon, alignment, ability, item, and moves carry into the result paste.'
            : mode === 'offense'
              ? 'Your selected moves are what gets thrown at the pool.'
              : null} />

        <section className="panel">
          <h3 className="panel-title">
            {mode === 'threats' ? 'Scan settings'
              : mode === 'offense' ? 'Pool bulk benchmark' : 'The attack to survive'}
          </h3>

          {mode === 'threats' && (
            <>
              <div className="segmented">
                <button className={scope === 'one' ? 'on' : ''}
                  onClick={() => setScope('one')}>
                  This Pokémon
                </button>
                <button className={scope === 'team' ? 'on' : ''}
                  disabled={filledSlots.length < 2}
                  title={filledSlots.length < 2 ? 'Add 2+ team members in the Builder' : ''}
                  onClick={() => setScope('team')}>
                  Whole team ({filledSlots.length})
                </button>
              </div>
              {metaAvailable && (
                <div className="segmented">
                  <button className={useMeta ? 'on' : ''} onClick={() => setUseMeta(true)}
                    title={metaTitle}>
                    Meta sets ({metaSets.info?.label || 'ladder'}
                    {metaSets.info?.regulation ? ` · Reg ${metaSets.info.regulation}` : ''}
                    {metaStale ? ' ⚠' : ''})
                  </button>
                  <button className={!useMeta ? 'on' : ''} onClick={() => setUseMeta(false)}>
                    Theoretical max
                  </button>
                </div>
              )}
              {metaAvailable && useMeta && (
                <label className="toggle">
                  <input type="checkbox" checked={metaOnly}
                    onChange={() => setMetaOnly(!metaOnly)} />
                  Ladder data only (hide theoretical fillers for unranked Pokémon)
                </label>
              )}
              <label className="toggle">
                <input type="checkbox" checked={practical}
                  onChange={() => setPractical(!practical)} />
                Practical mode (skip recharge & sub-70% accuracy moves)
              </label>
              <p className="dim small">
                {metaAvailable && useMeta
                  ? (metaOnly
                    ? 'Only Pokémon with ladder usage are scanned, each with its real sets — actual spreads, items (Scarf speed included), and moves. Untick "Ladder data only" to include every legal form.'
                    : 'Known ladder Pokémon attack with their real sets — actual spreads, items (Scarf speed included), and moves, one row per set. Everything else falls back to the 32 SP + boosting assumption.')
                  : 'Every legal form throws its best learnset move at this exact build. Attackers assume 32 SP + boosting alignment.'}
              </p>
              <button className="primary big" onClick={doThreatScan}
                disabled={busy || (scope === 'team'
                  ? filledSlots.length < 2 : !build.pokemonId)}>
                {busy ? 'Scanning…'
                  : scope === 'team' ? `Scan team (${filledSlots.length})` : 'Scan threats'}
              </button>
            </>
          )}

          {mode === 'offense' && (
            <>
              <label>
                Pool HP investment
                <div className="row" style={{ alignItems: 'center' }}>
                  <input type="range" min="0" max="32" value={pool.hp}
                    onChange={(e) => setPool({ ...pool, hp: +e.target.value })}
                    style={{ flex: 1 }} />
                  <span className="mono">{pool.hp} SP</span>
                </div>
              </label>
              <label>
                Pool defense investment
                <div className="row" style={{ alignItems: 'center' }}>
                  <input type="range" min="0" max="32" value={pool.def}
                    onChange={(e) => setPool({ ...pool, def: +e.target.value })}
                    style={{ flex: 1 }} />
                  <span className="mono">{pool.def} SP</span>
                </div>
              </label>
              <div className="segmented">
                {[['boost', '+Def nature'], ['neutral', 'Neutral'], ['reduce', '−Def nature']].map(([v, l]) => (
                  <button key={v} className={pool.alignment === v ? 'on' : ''}
                    onClick={() => setPool({ ...pool, alignment: v })}>{l}</button>
                ))}
              </div>
              <p className="dim small">
                Defense investment applies to whichever stat your best move
                targets. 0 SP neutral answers "who do I OHKO uninvested";
                32/32 +Def answers "who can I still break at max bulk".
              </p>
              <button className="primary big" onClick={doOffenseScan}
                disabled={busy || !build.pokemonId || !build.moves.some(Boolean)}>
                {busy ? 'Scanning…' : 'Scan targets'}
              </button>
            </>
          )}

          {mode === 'survive' && (
            <>
              {atkOverride && (
                <div className="banner ok-banner small">
                  Using ladder set: {atkOverride.name}
                  {atkOverride.item ? ` @ ${atkOverride.item}` : ''} — exact
                  spread and item applied.{' '}
                  <button className="chip-x" onClick={() => setAtkOverride(null)}>
                    × use manual settings
                  </button>
                </div>
              )}
              <label>
                Attacker
                <PokemonPicker value={atkSide.pokemonId}
                  onPick={(p) => { setAtkSide({ ...emptyBuild(), pokemonId: p.id,
                    displayName: p.name, types: p.types }); setAtkMove(''); setAtkOverride(null); }} />
              </label>
              <div className="row">
                <label style={{ flex: 2 }}>
                  Move
                  <MoveSelect
                    moves={atkLearnset.filter((m) => m.category !== 'Status')}
                    value={atkMove} onChange={setAtkMove} />
                </label>
                <label>
                  Ability
                  <select value={atkSide.ability}
                    onChange={(e) => setAtkSide({ ...atkSide, ability: e.target.value })}>
                    <option value="">{atkMon?.abilities?.[0] ? `${atkMon.abilities[0]} (default)` : '—'}</option>
                    {(atkMon?.abilities || []).map((a) => <option key={a}>{a}</option>)}
                  </select>
                </label>
              </div>
              <label>
                Their offensive investment
                <div className="row" style={{ alignItems: 'center' }}>
                  <input type="range" min="0" max="32" value={atkSp}
                    onChange={(e) => setAtkSp(+e.target.value)} style={{ flex: 1 }} />
                  <span className="mono">{atkSp} SP</span>
                  <label className="toggle small">
                    <input type="checkbox" checked={atkBoost}
                      onChange={() => setAtkBoost(!atkBoost)} />
                    boosting nature
                  </label>
                </div>
              </label>
              <div className="row">
                <label>
                  Weather
                  <select value={survField.weather}
                    onChange={(e) => setSurvField({ ...survField, weather: e.target.value })}>
                    {['none', 'sun', 'rain', 'sand', 'snow'].map((w) => <option key={w}>{w}</option>)}
                  </select>
                </label>
                {[['is_crit', 'Crit'], ['helping_hand', 'Helping Hand'],
                  ['is_doubles', 'Doubles']].map(([k, l]) => (
                  <label key={k} className="toggle small">
                    <input type="checkbox" checked={survField[k]}
                      onChange={() => setSurvField({ ...survField, [k]: !survField[k] })} />
                    {l}
                  </label>
                ))}
              </div>
              <div className="segmented">
                {[['guaranteed', 'Always survives'], ['avoid_ohko', 'Avoids guaranteed KO'],
                  ['two_hits', 'Survives 2 hits']].map(([v, l]) => (
                  <button key={v} className={survMode === v ? 'on' : ''}
                    onClick={() => setSurvMode(v)}>{l}</button>
                ))}
              </div>
              <button className="primary big" onClick={doSolve}
                disabled={busy || !build.pokemonId || !atkSide.pokemonId || !atkMove}>
                {busy ? 'Solving…' : 'Find minimum bulk'}
              </button>
            </>
          )}
        </section>
      </div>

      {error && <div className="errors banner">{error}</div>}

      {mode === 'threats' && scope === 'team' && teamScan && (
        <section className="panel">
          <h3 className="panel-title">
            Top threats to your team
            {teamScan.meta_label && (
              <span className="dim small"> · {teamScan.meta_label}</span>
            )}
          </h3>
          <table className="threat-table">
            <thead>
              <tr>
                <th>#</th><th>Attacker</th><th>Set</th>
                {teamScan.members.map((m) => (
                  <th key={m.id} className="mono small">
                    <Sprite id={m.id} size={26} title={m.name} />
                  </th>
                ))}
                <th className="mono">OHKOs</th><th></th>
              </tr>
            </thead>
            <tbody>
              {teamScan.rows.map((r, i) => {
                const worst = r.per_member.reduce(
                  (a, b) => (b.pct_range[1] > a.pct_range[1] ? b : a));
                return (
                  <tr key={`${r.attacker}|${r.set_name || 'theory'}|${i}`}>
                    <td className="mono dim">{i + 1}</td>
                    <td><Sprite id={r.attacker} size={28} /> {r.attacker_name}</td>
                    <td>
                      {r.meta ? (
                        <>
                          <div className="small">{r.set_name}</div>
                          <span className="chip ok">{r.usage}% usage</span>
                        </>
                      ) : (
                        <span className="dim small">theoretical · {r.ability || '—'}</span>
                      )}
                    </td>
                    {r.per_member.map((m) => {
                      const sev = m.ohko_chance > 0
                        ? { bg: 'rgba(255,82,82,0.16)', fg: '#ff6b6b' }
                        : m.pct_range[1] >= 50
                          ? { bg: 'rgba(255,176,32,0.14)', fg: '#ffb020' }
                          : { bg: 'rgba(46,213,115,0.10)', fg: '#7bdba1' };
                      return (
                        <td key={m.id} className="mono small">
                          {m.move ? (
                            <div style={{ background: sev.bg, color: sev.fg,
                                borderRadius: 8, padding: '3px 7px',
                                display: 'inline-block', textAlign: 'center' }}
                              title={`${m.move}: ${m.pct_range[0]}–${m.pct_range[1]}%`
                                + (m.ohko_chance > 0 ? ` · ${m.ohko_chance}% OHKO` : '')}>
                              <div style={{ fontWeight: 700 }}>
                                {Math.round(m.pct_range[1])}%
                              </div>
                              <div style={{ fontSize: '0.68rem', opacity: 0.85,
                                  whiteSpace: 'nowrap' }}>
                                {m.move}
                              </div>
                            </div>
                          ) : <span className="dim">—</span>}
                        </td>
                      );
                    })}
                    <td className="mono">
                      <span className={r.ohko_count >= 2 ? 'ohko-strong' : ''}>
                        {r.ohko_count}/{r.per_member.length}
                      </span>
                    </td>
                    <td>
                      <button title={`Open in calc vs ${worst.id}`}
                        onClick={() => {
                          const slot = team.find((s) => s.pokemonId === worst.id);
                          if (!slot) return;
                          sendToCalc({
                            p1: { ...emptyBuild(), ...slot },
                            p2: attackerFromThreat({
                              attacker: r.attacker, attacker_name: r.attacker_name,
                              move: worst.move, ability: r.ability,
                              meta: r.meta, set: r.set,
                            }),
                          });
                        }}>→ Calc</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="dim small">
            Cells show each set's best move as max % of that member's HP —
            hover for the move and roll range. Switch to "This Pokémon" for
            per-member Survive solving.
          </p>
        </section>
      )}

      {mode === 'threats' && scope === 'one' && scan && (
        <section className="panel">
          <h3 className="panel-title">
            Top threats to {scan.defender.name}
            <span className="dim small"> · scanned {scan.scanned} attackers</span>
          </h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th><th>Attacker</th><th>Set</th><th>Move</th>
                <th className="mono">Damage %</th><th className="mono">OHKO</th>
                <th>Speed</th><th></th>
              </tr>
            </thead>
            <tbody>
              {scan.top_threats.map((t, i) => {
                const [label, cls] = DEF_SPEED_LABELS[t.speed] || [t.speed, ''];
                return (
                  <tr key={`${t.attacker}|${t.set_name || 'theory'}|${i}`}>
                    <td className="mono dim">{i + 1}</td>
                    <td><Sprite id={t.attacker} size={28} /> {t.attacker_name}</td>
                    <td>
                      {t.meta ? (
                        <>
                          <div className="small">{t.set_name}</div>
                          <span className="chip ok">{t.usage}% usage</span>
                        </>
                      ) : (
                        <span className="dim small">theoretical · {t.ability || '—'}</span>
                      )}
                    </td>
                    <td>{t.move}</td>
                    <td className="mono">{t.pct_range[0]}–{t.pct_range[1]}</td>
                    <td className={`mono ${t.ohko_chance === 100 ? 'danger' : t.ohko_chance > 0 ? 'warn' : 'dim'}`}>
                      {t.ohko_chance > 0 ? `${t.ohko_chance}%` : t.guaranteed_2hko ? '2HKO' : '—'}
                    </td>
                    <td><span className={`chip ${cls}`}>{label}</span></td>
                    <td className="row-actions">
                      <button onClick={() => toCalc(attackerFromThreat(t))}>→ Calc</button>
                      <button onClick={() => {
                        setAtkSide(attackerFromThreat(t));
                        setAtkMove(t.move);
                        setAtkOverride(t.meta ? { ...t.set, attacker: t.attacker } : null);
                        setMode('survive');
                      }}>Survive</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {mode === 'offense' && offense && (
        <section className="panel">
          <h3 className="panel-title">
            {offense.attacker.name}'s reach
            <span className="dim small"> · {offense.scanned} targets · pool at {offense.pool.hp_sp} HP / {offense.pool.def_sp} Def SP</span>
          </h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th><th>Target</th><th>Best move</th>
                <th className="mono">Damage %</th><th className="mono">OHKO</th>
                <th>Speed</th>
              </tr>
            </thead>
            <tbody>
              {offense.targets.map((t, i) => {
                const [label, cls] = OFF_SPEED_LABELS[t.speed] || [t.speed, ''];
                return (
                  <tr key={t.target}>
                    <td className="mono dim">{i + 1}</td>
                    <td><Sprite id={t.target} size={28} /> {t.target_name}{' '}
                      {t.types.map((x) => <TypeChip key={x} t={x} />)}</td>
                    <td>{t.move}</td>
                    <td className="mono">{t.pct_range[0]}–{t.pct_range[1]}</td>
                    <td className={`mono ${t.ohko_chance === 100 ? 'ok' : t.ohko_chance > 0 ? 'warn' : 'dim'}`}>
                      {t.ohko_chance > 0 ? `${t.ohko_chance}%` : t.guaranteed_2hko ? '2HKO' : '—'}
                    </td>
                    <td><span className={`chip ${cls}`}>{label}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {mode === 'survive' && solution && (
        <section className="panel">
          <h3 className="panel-title">
            {solution.solvable ? 'Minimum bulk found' : 'Not survivable'}
          </h3>
          {solution.solvable ? (
            <div className="surv-result">
              <div className="surv-solutions">
                {solution.solutions.map((s, i) => (
                  <button key={i}
                    className={`surv-sol ${picked === i ? 'on' : ''}`}
                    onClick={() => setPicked(i)}>
                    <span className="mono big-sol">
                      {s.hp_sp} HP / {s.def_sp} {s.def_stat === 'def' ? 'Def' : 'SpD'}
                    </span>
                    <span className="dim small mono">
                      takes {s.pct_range[0]}–{s.pct_range[1]}% · {s.leftover} SP free
                    </span>
                  </button>
                ))}
              </div>
              <div className="surv-paste">
                <textarea readOnly rows={9} className="mono"
                  value={solution.solutions[picked]?.paste || ''} />
                <button onClick={() => navigator.clipboard
                  ?.writeText(solution.solutions[picked]?.paste || '')}>
                  Copy paste
                </button>
                <p className="dim small">
                  Import this in the Team Builder when you're ready — nothing
                  in your team is changed automatically.
                </p>
              </div>
            </div>
          ) : (
            <p className="warn">
              Even at 32 HP / 32 {solution.attack.defense_stat === 'def' ? 'Def' : 'SpD'},
              this attack deals {solution.best_attempt.pct_range[0]}–{solution.best_attempt.pct_range[1]}%.
              Try a defensive alignment, a resist berry, or a different answer.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
