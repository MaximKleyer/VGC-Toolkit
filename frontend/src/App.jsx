import React, { createContext, useEffect, useState } from 'react';
import { emptyTeam, padTeam, loadTeamLibrary, TEAMS_KEY } from './api.js';
import { emptySlot } from './api.js';

const CURRENT_TEAM_KEY = 'vgc-toolkit-team-current-v1';
const OPP_TEAM_KEY = 'vgc-toolkit-opp-team-v1';   // the opponent team you are calcing against
function restoreOppTeam() {
  try {
    const raw = JSON.parse(localStorage.getItem(OPP_TEAM_KEY));
    if (Array.isArray(raw) && raw.length) return padTeam(raw);
  } catch { /* fall through */ }
  return emptyTeam();
}

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
const THEME_KEY = 'vgc-toolkit-theme-v1';
const THEMES = [['navy', 'Navy'], ['ember', 'Ember'], ['arena', 'Arena'], ['volt', 'Volt'], ['crimson', 'Crimson'], ['daylight', 'Daylight']];
const TAB_KEY = 'vgc-toolkit-tab-v1';

export default function App() {
  const [staticData, setStaticData] = useState(null);
  const [pokemon, setPokemon] = useState(null);
  const [abilities, setAbilities] = useState([]);
  // The item pool follows the regulation: experimental items exist only in theirs.
  const [items, setItems] = useState([]);
  const [regs, setRegs] = useState([]);
  // Colour theme: stamps data-theme on <html>; styles.css maps each name to a token set.
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem(THEME_KEY) || 'navy'; } catch { return 'navy'; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  }, [theme]);
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
  // The opponent team (Team Builder -> Opponent team) and the shared team library.
  const [oppTeam, setOppTeam] = useState(restoreOppTeam);
  useEffect(() => {
    try { localStorage.setItem(OPP_TEAM_KEY, JSON.stringify(oppTeam)); } catch { /* ignore */ }
  }, [oppTeam]);
  const [teamLibrary, setTeamLibrary] = useState(loadTeamLibrary);
  const persistLibrary = (next) => {
    setTeamLibrary(next);
    try { localStorage.setItem(TEAMS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };
  // Save (or replace by name within its kind) a named team: {kind, name, slots}.
  const saveTeamEntry = React.useCallback((entry) => {
    const kind = entry.kind || 'mine';
    const fresh = { id: `${Date.now()}`, savedAt: new Date().toISOString(), ...entry, kind };
    const at = teamLibrary.findIndex((t) => (t.kind || 'mine') === kind && t.name === entry.name);
    persistLibrary(at >= 0 ? teamLibrary.map((t, i) => (i === at ? { ...fresh, id: t.id } : t)) : [...teamLibrary, fresh]);
  }, [teamLibrary]); // eslint-disable-line
  const deleteTeamEntry = React.useCallback((id) => persistLibrary(teamLibrary.filter((t) => t.id !== id)), [teamLibrary]); // eslint-disable-line

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
      get('/typechart'),
      get('/moves'),
      get('/meta/sets').catch(() => ({ info: {}, pokemon: {} })),
    ])
      .then(([regInfo, alignments, typechart, moveList, metaSets]) => {
        const moves = {};
        for (const m of moveList) moves[m.name] = m;
        const available = regInfo.regulations.map((r) => r.regulation);
        setRegs(regInfo.regulations);
        // keep a saved choice only while it still exists; otherwise the newest
        setRegulation((cur) => (cur && available.includes(cur) ? cur : regInfo.default));
        setStaticData({ alignments, typechart, moves, metaSets });
      })
      .catch((e) => setError(e.message));
  }, []);

  // The legal roster and item pool for the selected regulation, plus the
  // ability-name list (which grows when a custom ability is saved). Refetched
  // when the regulation changes or server-side data is edited (dataVersion).
  useEffect(() => {
    if (!regulation) return;
    try { localStorage.setItem(REGULATION_KEY, regulation); } catch { /* ignore */ }
    let live = true;
    Promise.all([
      get(`/pokemon?regulation=${encodeURIComponent(regulation)}`),
      get('/abilities').catch(() => []),
      get(`/items?regulation=${encodeURIComponent(regulation)}`),
    ])
      .then(([list, abilityNames, itemList]) => {
        if (!live) return;
        list.sort((a, b) => a.name.localeCompare(b.name));
        setPokemon(list);
        setAbilities(abilityNames);
        setItems(itemList);
      })
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [regulation, dataVersion]);

  // Memoised so context consumers don't re-render on unrelated App state.
  const data = React.useMemo(
    () => ({ ...staticData, items, pokemon, abilities, regulation, regulations: regs,
             setRegulation, dataVersion, refreshData,
             oppTeam, setOppTeam, teamLibrary, saveTeamEntry, deleteTeamEntry }),
    [staticData, items, pokemon, abilities, regulation, regs, dataVersion, refreshData,
     oppTeam, teamLibrary, saveTeamEntry, deleteTeamEntry]);

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
              <option key={r.regulation} value={r.regulation} title={r.note || undefined}>
                {r.label || r.regulation} · {r.forms} forms{r.experimental ? ' · predictions' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="reg-badge" title="Colour theme (saved in this browser)">
          Theme
          <select value={theme} onChange={(e) => setTheme(e.target.value)}>
            {THEMES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
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
