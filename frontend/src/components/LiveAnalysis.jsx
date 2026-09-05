import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { DataCtx } from '../App.jsx';
import { get, post, combatant } from '../api.js';
import { Sprite, TypeChip } from './shared.jsx';

const ALL_TYPES = ['Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice',
  'Fighting', 'Poison', 'Ground', 'Flying', 'Psychic', 'Bug', 'Rock',
  'Ghost', 'Dragon', 'Dark', 'Steel', 'Fairy'];
const SPEED_CONTROL = new Set(['Tailwind', 'Trick Room', 'Icy Wind',
  'Electroweb', 'Thunder Wave', 'Bulldoze']);

// Abilities that set a field condition — used to tag whether a Pokémon's
// signature spike is self-enabled or provided by a teammate. (Mirrors the
// backend's SELF_WEATHER_ABILITIES / SELF_TERRAIN_ABILITIES.)
const FIELD_SETTERS = {
  Drought: 'sun', Drizzle: 'rain', 'Sand Stream': 'sand', 'Snow Warning': 'snow',
  'Orichalcum Pulse': 'sun', 'Electric Surge': 'electric', 'Grassy Surge': 'grassy',
  'Psychic Surge': 'psychic', 'Misty Surge': 'misty', 'Hadron Engine': 'electric',
};

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function LiveAnalysis({ slots }) {
  const { typechart, moves: moveDb, regulation } = useContext(DataCtx);
  const filled = slots.filter((s) => s.pokemonId);
  // Both keys include the regulation so pool-dependent analyses (suggestions,
  // threat scans) refetch when the header selector changes.
  const memberKey = JSON.stringify([regulation, filled.map((s) => [s.pokemonId, s.ability])]);
  const fullKey = useDebounced(
    JSON.stringify([regulation, filled.map((s) => [combatant(s), s.moves])]), 900);

  // ---- defensive profiles (cached per id+ability) ----
  const [profiles, setProfiles] = useState({});
  useEffect(() => {
    filled.forEach((s) => {
      const key = `${s.pokemonId}|${s.ability}`;
      if (profiles[key]) return;
      get(`/matchup/${s.pokemonId}/profile${s.ability ? `?ability=${encodeURIComponent(s.ability)}` : ''}`)
        .then((p) => setProfiles((prev) => ({ ...prev, [key]: p })))
        .catch(() => {});
    });
  }, [memberKey]); // eslint-disable-line

  const memberProfiles = filled
    .map((s) => profiles[`${s.pokemonId}|${s.ability}`])
    .filter(Boolean);

  // ---- signature spikes (field-conditional move boosts), cached per id+ability ----
  const [spikes, setSpikes] = useState({});
  useEffect(() => {
    filled.forEach((s) => {
      const key = `${s.pokemonId}|${s.ability}`;
      if (spikes[key]) return;
      post('/matchup/signature-spikes', { pokemon: combatant(s), top_n: 4 })
        .then((r) => setSpikes((prev) => ({ ...prev, [key]: r })))
        .catch(() => {});
    });
  }, [memberKey]); // eslint-disable-line
  const memberSpikes = filled.map((s) => spikes[`${s.pokemonId}|${s.ability}`] || null);
  // which field condition (if any) each filled member sets via its ability
  const memberSets = memberSpikes.map((r) => (r ? FIELD_SETTERS[r.ability] : null) || null);

  // ---- aggregates ----
  const weak = {}, resist = {}, immune = {};
  for (const p of memberProfiles)
    for (const t of ALL_TYPES) {
      const m = p.matchups[t];
      if (m > 1) weak[t] = (weak[t] || 0) + 1;
      else if (m === 0) immune[t] = (immune[t] || 0) + 1;
      else if (m < 1) resist[t] = (resist[t] || 0) + 1;
    }

  const coverage = useMemo(() => {
    const cov = Object.fromEntries(ALL_TYPES.map((t) => [t, 0]));
    for (const s of filled)
      for (const name of s.moves.filter(Boolean)) {
        const mv = moveDb[name];
        if (!mv || mv.category === 'Status') continue;
        for (const t of ALL_TYPES)
          cov[t] = Math.max(cov[t], typechart[mv.type][t]);
      }
    return cov;
  }, [fullKey]); // eslint-disable-line
  const blindSpots = ALL_TYPES.filter((t) => coverage[t] <= 1);

  const issues = [];
  const allMoves = filled.flatMap((s) => s.moves.filter(Boolean));
  if (filled.length >= 2 && !allMoves.some((m) => SPEED_CONTROL.has(m)))
    issues.push('No speed control — add Tailwind, Trick Room, or Icy Wind');
  const sharedWeak = Object.entries(weak).filter(([, n]) => n >= 2);
  for (const [t, n] of sharedWeak)
    issues.push(`${n} members share a ${t} weakness`);
  if (filled.length >= 2 && allMoves.length > 0 && blindSpots.length > 4)
    issues.push(`Poor coverage — no super effective hits vs ${blindSpots.slice(0, 4).join(', ')}${blindSpots.length > 4 ? '…' : ''}`);

  // ---- suggested teammates (server) ----
  const [suggest, setSuggest] = useState(null);
  useEffect(() => {
    if (filled.length === 0 || filled.length >= 6) { setSuggest(null); return; }
    let live = true;
    post('/matchup/suggest', { team: filled.map((s) => s.pokemonId), regulation })
      .then((r) => live && setSuggest(r.suggestions))
      .catch(() => {});
    return () => { live = false; };
  }, [memberKey]); // eslint-disable-line

  // ---- threats (per-member scans, cached by exact build) ----
  const scanCache = useRef({});
  const [threats, setThreats] = useState(null);
  const [scanning, setScanning] = useState(false);
  useEffect(() => {
    if (filled.length === 0) { setThreats(null); return; }
    let live = true;
    (async () => {
      setScanning(true);
      const perMember = [];
      for (const s of filled) {
        // Key on the regulation too: the attacker pool differs per regulation,
        // so a cached M-B scan must not be reused after switching to M-C.
        const key = JSON.stringify([combatant(s), regulation]);
        if (!scanCache.current[key]) {
          try {
            scanCache.current[key] = await post('/matchup/threats', {
              defender: combatant(s), top_n: 60, regulation,
            });
          } catch { scanCache.current[key] = { top_threats: [] }; }
        }
        perMember.push({ member: s.pokemonId, scan: scanCache.current[key] });
      }
      if (!live) return;
      const agg = {};
      for (const { member, scan } of perMember)
        for (const t of scan.top_threats) {
          if (t.ohko_chance === 0 && !t.guaranteed_2hko) continue;
          const e = agg[t.attacker] ||
            (agg[t.attacker] = { name: t.attacker_name, id: t.attacker, hits: [] });
          e.hits.push({ member, move: t.move, pct: t.pct_range,
                        ohko: t.ohko_chance, speed: t.speed });
        }
      const list = Object.values(agg)
        .filter((e) => filled.length === 1 || e.hits.length >= 2)
        .sort((a, b) => b.hits.length - a.hits.length ||
          Math.max(...b.hits.map((h) => h.ohko)) - Math.max(...a.hits.map((h) => h.ohko)));
      setThreats(list.slice(0, 8));
      setScanning(false);
    })();
    return () => { live = false; };
  }, [fullKey]); // eslint-disable-line

  if (filled.length === 0)
    return (
      <aside className="live-analysis">
        <section className="panel">
          <h3 className="panel-title">Team analysis</h3>
          <p className="dim">Add a Pokémon to start the live analysis.</p>
        </section>
      </aside>
    );

  return (
    <aside className="live-analysis">
      <section className="panel">
        <h3 className="panel-title">Team analysis</h3>
        <div className="progress mono">{filled.length}/6 Pokémon</div>
        {issues.length > 0 ? (
          <ul className="issues">
            {issues.map((i, n) => <li key={n}>⚠ {i}</li>)}
          </ul>
        ) : (
          <p className="ok small">No structural issues detected so far.</p>
        )}
      </section>

      <section className="panel">
        <h3 className="panel-title">Move coverage</h3>
        <div className="cov-grid">
          {ALL_TYPES.map((t) => (
            <div key={t} className="cov-cell">
              <TypeChip t={t} />
              <span className={`mono ${coverage[t] >= 2 ? 'ok' : coverage[t] === 0 ? 'dim' : ''}`}>
                {coverage[t]}×
              </span>
            </div>
          ))}
        </div>
        {blindSpots.length > 0 && (
          <p className="dim small">Blind spots: {blindSpots.join(', ')}</p>
        )}
      </section>

      {memberSpikes.some((r) => r && r.spikes.length > 0) && (
        <section className="panel">
          <h3 className="panel-title">Signature spikes</h3>
          <ul className="spike-list">
            {filled.map((s, i) => {
              const r = memberSpikes[i];
              if (!r || r.spikes.length === 0) return null;
              return (
                <li key={`${s.pokemonId}-${i}`} className="spike-member">
                  <Sprite id={s.pokemonId} size={30} title={r.name} />
                  <div className="spike-detail">
                    <div className="spike-name">{r.name}</div>
                    {r.spikes.slice(0, 2).map((sp) => {
                      let tag = `needs ${sp.condition} setter`, cls = 'spike-need';
                      if (sp.self_enabled) {
                        tag = `self · ${sp.setter_ability}`; cls = 'spike-self';
                      } else {
                        const j = filled.findIndex((m, k) =>
                          k !== i && memberSets[k] === sp.condition_key);
                        if (j >= 0) { tag = `via ${memberSpikes[j].name}`; cls = 'spike-team'; }
                      }
                      return (
                        <div key={sp.move} className="spike-row">
                          <TypeChip t={sp.type} />
                          <span className="spike-move">{sp.move}</span>
                          <span className="mono spike-mult">×{sp.multiplier}</span>
                          <span className="dim small">{sp.condition}</span>
                          <span className={`spike-tag ${cls}`}>{tag}</span>
                        </div>
                      );
                    })}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="panel">
        <h3 className="panel-title">Defensive spread</h3>
        <div className="def-chips">
          {Object.entries(weak).map(([t, n]) => (
            <span key={t} className="chip speed-bad"><TypeChip t={t} /> {n}↑</span>
          ))}
          {Object.entries(resist).map(([t, n]) => (
            <span key={t} className="chip speed-ok"><TypeChip t={t} /> {n}↓</span>
          ))}
          {Object.entries(immune).map(([t, n]) => (
            <span key={t} className="chip"><TypeChip t={t} /> {n} immune</span>
          ))}
        </div>
      </section>

      <section className="panel">
        <h3 className="panel-title">
          Threats {scanning && <span className="dim small">scanning…</span>}
        </h3>
        {threats && threats.length > 0 ? (
          <ul className="threat-list">
            {threats.map((t) => (
              <li key={t.id}>
                <Sprite id={t.id} size={36} />
                <div>
                  <div>{t.name}</div>
                  {t.hits.map((h) => (
                    <div key={h.member} className="mono small dim">
                      {h.member}: {h.move} {h.pct[0]}–{h.pct[1]}%
                      {h.ohko > 0 ? ` · OHKO ${h.ohko}%` : ' · 2HKO'}
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="dim small">
            {scanning ? 'Running full-pool scans…'
              : filled.length === 1 ? 'No OHKO/2HKO threats found.'
              : 'No attacker pressures two or more members.'}
          </p>
        )}
      </section>

      {suggest && (
        <section className="panel">
          <h3 className="panel-title">Suggested teammates</h3>
          <ul className="suggest-list">
            {suggest.map((s) => (
              <li key={s.pokemon_id}>
                <Sprite id={s.pokemon_id} size={40} />
                <div>
                  <div>{s.name}</div>
                  <div className="dim small">{s.reason}</div>
                </div>
                <span className="mono ok score">{s.score}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
