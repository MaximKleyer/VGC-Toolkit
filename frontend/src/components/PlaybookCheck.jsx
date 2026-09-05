import React, { useContext, useEffect, useState } from 'react';
import { DataCtx } from '../App.jsx';
import { post, combatant } from '../api.js';

// Wolfe's VGC Playbook applied to the working team: composition, speed-control
// plan, offensive / defensive synergy, items, role-first movesets, spreads and a
// matchup pass against the ladder sets. Backed by POST /api/team/playbook.
const ICON = { pass: '✓', warn: '⚠', fail: '✗', info: 'ⓘ' };
const SECTIONS = [
  ['composition', 'Composition'], ['speed', 'Speed control'], ['offense', 'Offensive synergy'],
  ['defense', 'Defensive synergy'], ['items', 'Items'], ['moves', 'Movesets'], ['spreads', 'Spreads'],
  ['matchups', 'Matchup pass'],
];

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function PlaybookCheck({ slots }) {
  const { regulation } = useContext(DataCtx);
  const filled = slots.filter((s) => s.pokemonId && s.moves.some(Boolean));
  const key = useDebounced(JSON.stringify([regulation, filled.map((s) => [combatant(s), s.moves])]), 900);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (filled.length < 2) { setResult(null); return; }
    setBusy(true);
    post('/team/playbook', {
      team: filled.map((s) => ({ pokemon: combatant(s), moves: s.moves.filter(Boolean) })),
      regulation,
    })
      .then((r) => { setResult(r); setError(null); })
      .catch((e) => setError(String(e.message || e)))
      .finally(() => setBusy(false));
  }, [key]); // eslint-disable-line

  const copyWorksheet = () => {
    if (!result) return;
    navigator.clipboard?.writeText(result.worksheet.markdown).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  if (filled.length < 2) {
    return (
      <section className="panel playbook">
        <h3 className="panel-title">Wolfe's playbook check</h3>
        <p className="dim small">Add at least two Pokémon with moves to run the checklist (composition, speed
          control, synergy, items, spreads and a matchup pass against the ladder).</p>
      </section>
    );
  }
  const checks = result?.checks || [];
  const visible = checks.filter((c) => showInfo || c.status !== 'info');
  const s = result?.summary || {};
  return (
    <section className="panel playbook">
      <div className="row">
        <h3 className="panel-title">Wolfe's playbook check</h3>
        {result && (
          <span className="small">
            <span className="ok">{ICON.pass} {s.pass}</span>{' · '}
            <span className="warn">{ICON.warn} {s.warn}</span>{' · '}
            <span className="danger">{ICON.fail} {s.fail}</span>
            {busy && <span className="dim"> · updating…</span>}
          </span>
        )}
        <span className="spacer" />
        <label className="small dim">
          <input type="checkbox" checked={showInfo} onChange={(e) => setShowInfo(e.target.checked)} /> show notes
        </label>
        <button onClick={copyWorksheet} disabled={!result}>{copied ? 'Copied' : 'Copy worksheet'}</button>
      </div>
      {error && <p className="danger small">{error}</p>}
      {result && (
        <p className="small">
          Speed control: <b>{result.speed.primary || 'none'}</b>
          {result.speed.backups?.length ? <span className="dim"> · backups: {result.speed.backups.join(', ')}</span> : null}
          {' · '}
          {result.members.map((m) => `${m.name} (${m.role}${m.side ? `, ${m.side.toLowerCase()}` : ''})`).join(' · ')}
        </p>
      )}
      {SECTIONS.map(([id, label]) => {
        const rows = visible.filter((c) => c.section === id);
        if (!rows.length) return null;
        return (
          <div key={id} className="pb-section">
            <div className="pb-section-title small dim">{label}</div>
            {rows.map((c) => (
              <div key={c.id} className={`pb-check pb-${c.status}`} title={c.source ? `Playbook ${c.source}` : ''}>
                <span className="pb-icon">{ICON[c.status]}</span>
                <div>
                  <div className="pb-title">{c.title}</div>
                  {c.detail && <div className="pb-detail dim small">{c.detail}</div>}
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </section>
  );
}
