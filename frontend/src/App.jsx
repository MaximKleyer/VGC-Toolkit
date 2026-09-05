import React, { createContext, useEffect, useState } from 'react';
import { emptySlot } from './api.js';

const CURRENT_TEAM_KEY = 'vgc-toolkit-team-current-v1';

function restoreTeam() {
  try {
    const raw = JSON.parse(localStorage.getItem(CURRENT_TEAM_KEY));
    if (!Array.isArray(raw)) throw new Error('no saved team');
    const slots = raw.slice(0, 6).map((s) => ({ ...emptySlot(), ...s }));
    while (slots.length < 6) slots.push(emptySlot());
    return slots;
  } catch {
    return Array.from({ length: 6 }, emptySlot);
  }
}
import { get } from './api.js';
import TeamBuilder from './components/TeamBuilder.jsx';
import TeamPreview from './components/TeamPreview.jsx';
import DamageCalc from './components/DamageCalc.jsx';
import ThreatScan from './components/ThreatScan.jsx';
import Battle from './components/Battle.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';

export const DataCtx = createContext(null);

const TABS = [
  ['builder', 'Team Builder'],
  ['damage', 'Damage Calc'],
  ['threats', 'Threat Scan'],
  ['preview', 'Team Preview'],
  ['battle', 'Battle'],
];

const REGULATION_KEY = 'vgc-toolkit-regulation-v1';
const TAB_KEY = 'vgc-toolkit-tab-v1';

export default function App() {
  const [staticData, setStaticData] = useState(null);
  const [pokemon, setPokemon] = useState(null);
  const [abilities, setAbilities] = useState([]);
  const [regs, setRegs] = useState([]);
  const [regulation, setRegulation] = useState(() => {
    try { return localStorage.getItem(REGULATION_KEY) || null; } catch { return null; }
  });
  // Bumped when the user edits data server-side (e.g. sets a provisional
  // ability) so the roster and per-Pokémon caches refetch.
  const [dataVersion, setDataVersion] = useState(0);
  const refreshData = React.useCallback(() => setDataVersion((v) => v + 1), []);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState(() => {
    try { return localStorage.getItem(TAB_KEY) || 'builder'; } catch { return 'builder'; }
  });
  useEffect(() => { try { localStorage.setItem(TAB_KEY, tab); } catch { /* ignore */ } }, [tab]);
  const [team, setTeam] = useState(restoreTeam);
  const [calcPreset, setCalcPreset] = useState(null);

  // autosave the working team
  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(CURRENT_TEAM_KEY, JSON.stringify(team)); }
      catch { /* storage full or unavailable */ }
    }, 400);
    return () => clearTimeout(t);
  }, [team]);

  // Regulation-independent data, plus the regulations present in the dataset.
  useEffect(() => {
    Promise.all([
      get('/regulations'),
      get('/alignments'),
      get('/items'),
      get('/typechart'),
      get('/moves'),
      get('/meta/sets').catch(() => ({ info: {}, pokemon: {} })),
    ])
      .then(([regInfo, alignments, items, typechart, moveList, metaSets]) => {
        const moves = {};
        for (const m of moveList) moves[m.name] = m;
        const available = regInfo.regulations.map((r) => r.regulation);
        setRegs(regInfo.regulations);
        // keep a saved choice only while it still exists; otherwise the newest
        setRegulation((cur) => (cur && available.includes(cur) ? cur : regInfo.default));
        setStaticData({ alignments, items, typechart, moves, metaSets });
      })
      .catch((e) => setError(e.message));
  }, []);

  // The legal roster for the selected regulation, plus the ability-name list
  // (which grows when a custom ability is saved). Refetched when the
  // regulation changes or server-side data is edited (dataVersion).
  useEffect(() => {
    if (!regulation) return;
    try { localStorage.setItem(REGULATION_KEY, regulation); } catch { /* ignore */ }
    let live = true;
    Promise.all([
      get(`/pokemon?regulation=${encodeURIComponent(regulation)}`),
      get('/abilities').catch(() => []),
    ])
      .then(([list, abilityNames]) => {
        if (!live) return;
        list.sort((a, b) => a.name.localeCompare(b.name));
        setPokemon(list);
        setAbilities(abilityNames);
      })
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [regulation, dataVersion]);

  // Memoised so context consumers don't re-render on unrelated App state.
  const data = React.useMemo(
    () => ({ ...staticData, pokemon, abilities, regulation, regulations: regs,
             setRegulation, dataVersion, refreshData }),
    [staticData, pokemon, abilities, regulation, regs, dataVersion, refreshData]);

  if (error)
    return (
      <div className="boot-error">
        <h1>Champions VGC Toolkit</h1>
        <p>
          Can't reach the backend ({error}). Start it with{' '}
          <code>py -m uvicorn vgc_toolkit.main:app --reload</code> and reload
          this page.
        </p>
      </div>
    );
  if (!staticData || !pokemon) return <div className="boot-error">Loading roster…</div>;

  return (
    <DataCtx.Provider value={data}>
      <header className="topbar">
        <h1 className="brand">
          Champions <span>VGC Toolkit</span>
        </h1>
        <nav className="tabs">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              className={tab === id ? 'tab active' : 'tab'}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <label className="reg-badge" title="Which regulation's legal roster to build and scan with">
          Reg
          <select value={regulation} onChange={(e) => setRegulation(e.target.value)}>
            {regs.map((r) => (
              <option key={r.regulation} value={r.regulation}>
                {r.regulation} · {r.forms} forms
              </option>
            ))}
          </select>
        </label>
      </header>
      <main>
        <ErrorBoundary key={tab}>
        {tab === 'builder' && <TeamBuilder team={team} setTeam={setTeam} />}
        {tab === 'damage' && (
          <DamageCalc team={team} preset={calcPreset}
            onPresetConsumed={() => setCalcPreset(null)} />
        )}
        {tab === 'threats' && (
          <ThreatScan team={team}
            sendToCalc={(p) => { setCalcPreset(p); setTab('damage'); }} />
        )}
        {tab === 'preview' && (
          <TeamPreview team={team}
            sendToCalc={(p) => { setCalcPreset(p); setTab('damage'); }} />
        )}
        {tab === 'battle' && <Battle team={team} />}
        </ErrorBoundary>
      </main>
    </DataCtx.Provider>
  );
}
