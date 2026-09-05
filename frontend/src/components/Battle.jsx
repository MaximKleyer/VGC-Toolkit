import React, { useContext, useEffect, useRef, useState } from 'react';
import { DataCtx } from '../App.jsx';
import { get, post, combatant } from '../api.js';
import { TypeChip } from './shared.jsx';
// The sidecar's own protocol reducer: replaying a turn client-side with it
// guarantees the animation ends in exactly the server's state.
import { applyLine, STALL_MOVES } from '../../../sim/protocol.mjs';
import {
  BattleSprite, MonCard, Name, FieldStrip, PressurePanel, LogView, LogLine, StepBanner, formatLine, hpText, who,
  posKey, effectiveMoveType, weatherInfo, terrainInfo, toID,
} from './BattleView.jsx';

// ---------------------------------------------------------------- sim API
// The Showdown sidecar (sim/server.mjs) is reached through the Vite `/sim` proxy.
async function simFetch(path, opts) {
  const r = await fetch('/sim' + path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || `${r.status} ${r.statusText}`), { body });
  return body;
}
const simGet = (p) => simFetch(p);
const simPost = (p, b) => simFetch(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
});

const DEFAULT_FORMAT = 'gen9championsvgc2026regmb';
const BATTLE_KEY = 'vgc-toolkit-battle-id-v1';   // resume the running battle after a refresh
const SETUP_KEY = 'vgc-toolkit-battle-setup-v1'; // remember the setup screen's choices
function loadSetup() { try { return JSON.parse(localStorage.getItem(SETUP_KEY)) || {}; } catch { return {}; } }
const SETUP = loadSetup();
const TARGETED = new Set(['normal', 'any', 'adjacentFoe', 'adjacentAlly', 'adjacentAllyOrSelf']);
const clone = (x) => (typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- turn playback
// A turn's protocol lines are grouped into visible steps: each move (with the
// damage / effectiveness / faint lines that follow it), each switch, the
// end-of-turn residuals, field changes. Steps are replayed one by one.
const STEP_STARTERS = new Set(['move', 'switch', 'drag', 'replace', 'cant', 'turn', 'upkeep',
  '-fieldstart', '-fieldend', '-sidestart', '-sideend', '-mega', 'detailschange', 'win', 'tie']);
const STEP_DELAY = { move: 1100, switch: 700, drag: 700, replace: 500, cant: 700, turn: 450, upkeep: 550, win: 900, tie: 900 };

export function groupSteps(lines) {
  const steps = [];
  let cur = null;
  for (const line of lines) {
    const p = line.split('|');
    const c = p[1];
    // Every line must land in some step so the replay's line counter stays in
    // sync with the server log; timestamps etc. go into a silent step.
    const silent = !c || c === 't:' || c === 'request';
    const starts = !silent && (STEP_STARTERS.has(c) || (c === '-weather' && !line.includes('[upkeep]')));
    if (starts || !cur) { cur = { kind: silent ? 'noise' : c, lines: [], attacker: null, target: null, hits: [] }; steps.push(cur); }
    cur.lines.push(line);
    if (c === 'move') { cur.attacker = p[2]; cur.target = /^p[12][a-c]/.test(p[4] || '') ? p[4] : null; }
    if (c === '-damage') cur.hits.push(p[2]);
  }
  return steps;
}

// ---------------------------------------------------------------- the tab
export default function Battle({ team }) {
  const { moves: moveDb, regulation, items } = useContext(DataCtx);
  // The engine's request payload names items by id ("colburberry"); show names.
  const itemName = (id) => {
    if (!id) return 'no item';
    const hit = (items || []).find((it) => toID(it.name) === toID(id));
    return hit ? hit.name : id;
  };
  const [health, setHealth] = useState(null);        // null = checking, false = sidecar down
  const [formats, setFormats] = useState([]);
  const [format, setFormat] = useState(DEFAULT_FORMAT);
  const [bot, setBot] = useState(() => (SETUP.bot === 'greedy' ? 'smart' : SETUP.bot) || 'smart');
  const [myPaste, setMyPaste] = useState(() => SETUP.myPaste || '');
  const [myMode, setMyMode] = useState(() => SETUP.myMode || 'builder');   // builder | paste
  const [oppPaste, setOppPaste] = useState(() => SETUP.oppPaste || '');
  const [oppMembers, setOppMembers] = useState(() => SETUP.oppMembers || null);
  const [battle, setBattle] = useState(null);        // authoritative server state
  const [view, setView] = useState(null);            // what is drawn (lags during playback)
  const [playing, setPlaying] = useState(false);
  // Wolfe's three questions for the turn (speed order, what you threaten, what
  // they threaten), computed by the sidecar from your view only.
  const [pressure, setPressure] = useState(null);
  useEffect(() => {
    if (!battle?.id || battle.ended) { setPressure(null); return; }
    if (playing || !battle.request) return;
    simGet(`/battle/${battle.id}/pressure`).then(setPressure).catch(() => setPressure(null));
  }, [battle?.id, battle?.request?.rqid, battle?.turn, battle?.ended, playing]); // eslint-disable-line
  const [step, setStep] = useState(null);            // current playback step banner
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [problems, setProblems] = useState(null);
  const [choices, setChoices] = useState({});        // slot -> {move, target, mega} | {switch}
  const [picking, setPicking] = useState(null);      // slot whose move needs a target
  const [preview, setPreview] = useState([]);        // team-preview picks (0-based, in order)
  const battleRef = useRef(null);
  const runningRef = useRef(false);
  const skipRef = useRef(false);
  battleRef.current = battle;

  const dropBattle = (msg) => {
    setBattle(null);
    if (msg) setError(msg);
    try { localStorage.removeItem(BATTLE_KEY); } catch { /* ignore */ }
  };
  const filled = team.filter((s) => s.pokemonId);
  const filledKey = JSON.stringify(filled.map((s) => [s.pokemonId, s.item, s.ability, s.alignment, s.spread, s.moves]));

  // Sidecar health + available Champions doubles formats (follows the regulation selector).
  useEffect(() => {
    simGet('/health')
      .then((h) => { setHealth(h); return simGet('/formats'); })
      .then((fs) => {
        const dbl = fs.filter((f) => f.gameType === 'doubles' && /VGC/.test(f.name) && !/Bo3/.test(f.name));
        setFormats(dbl);
        const match = dbl.find((f) => f.name.includes(`Reg ${regulation}`));
        if (match) setFormat(match.id);
        else if (dbl.length && !dbl.some((f) => f.id === DEFAULT_FORMAT)) setFormat(dbl[dbl.length - 1].id);
      })
      .catch(() => setHealth(false));
  }, [regulation]);

  // Your paste, derived from the Team Builder team.
  useEffect(() => {
    if (myMode !== 'builder') return;
    const withMoves = filled.filter((s) => s.moves.some(Boolean));   // exporter needs >= 1 move
    if (!withMoves.length) { setMyPaste(''); return; }
    post('/team/export', {
      team: withMoves.map((s) => ({ pokemon: combatant(s), moves: s.moves.filter(Boolean) })),
      regulation,
    })
      .then((r) => setMyPaste(r.paste))
      .catch((e) => setError(e.message));
  }, [myMode, filledKey]);

  // Poll while the bot is acting (no pending request for you yet).
  useEffect(() => {
    if (!battle || battle.request || battle.ended) return undefined;
    const t = setInterval(async () => {
      try {
        const st = await simGet(`/battle/${battle.id}`);
        if (st.request || st.ended || st.log.length !== battle.log.length) setBattle(st);
      } catch (e) {
        if (/404|no such battle/.test(e.message)) dropBattle('That battle no longer exists (the simulator was restarted). Start a new one.');
      }
    }, 600);
    return () => clearInterval(t);
  }, [battle?.id, battle?.request, battle?.ended, battle?.log?.length]);

  // Remember the setup choices and the running battle across page refreshes.
  useEffect(() => {
    try {
      localStorage.setItem(SETUP_KEY, JSON.stringify({
        bot, myMode, oppPaste, oppMembers, myPaste: myMode === 'paste' ? myPaste : '',
      }));
    } catch { /* ignore */ }
  }, [bot, myMode, oppPaste, oppMembers, myPaste]);
  useEffect(() => {
    try {
      if (battle?.id && !battle.ended) localStorage.setItem(BATTLE_KEY, battle.id);
      else if (battle?.ended) localStorage.removeItem(BATTLE_KEY);
    } catch { /* ignore */ }
  }, [battle?.id, battle?.ended]);
  useEffect(() => {
    if (!health) return;
    let saved = null;
    try { saved = localStorage.getItem(BATTLE_KEY); } catch { /* ignore */ }
    if (!saved) return;
    simGet(`/battle/${saved}`)
      .then((st) => { if (st.ended) dropBattle(); else setBattle(st); })
      .catch(() => dropBattle());
  }, [health]);

  // Team preview: the opponent's six can arrive a moment after the request that
  // created the battle; fetch once more if they are still missing.
  useEffect(() => {
    if (!battle?.request?.teamPreview) return undefined;
    if (battle.sides.p2.preview?.length || battle.sides.p2.sheet?.length) return undefined;
    const t = setTimeout(() => simGet(`/battle/${battle.id}`).then(setBattle).catch(() => {}), 400);
    return () => clearTimeout(t);
  }, [battle?.id, battle?.request?.teamPreview, battle?.sides?.p2?.preview?.length, battle?.sides?.p2?.sheet?.length]);

  // ---- playback: animate new log lines step by step into `view` ----
  useEffect(() => {
    if (!battle) { setView(null); return; }
    if (!view || view.id !== battle.id) { setView({ ...clone(battle), anim: null }); return; }
    if (runningRef.current) return;                   // the running loop catches up by itself
    if (battle.log.length <= view.log.length) {
      setView((v) => (v ? { ...v, request: battle.request, ended: battle.ended, winner: battle.winner,
        errors: battle.errors, fieldTimers: battle.fieldTimers, teamPreview: battle.teamPreview, anim: null } : v));
      return;
    }
    runningRef.current = true;
    skipRef.current = false;
    setPlaying(true);
    const work = clone(view);
    (async () => {
      try {
        for (;;) {
          const target = battleRef.current;
          if (!target || target.id !== work.id) break;
          const fresh = target.log.slice(work.log.length);
          if (!fresh.length) break;
          const steps = groupSteps(fresh);
          const moveCount = steps.filter((s) => s.kind === 'move').length;
          const scale = steps.length > 14 ? 14 / steps.length : 1;
          let moveIdx = 0;
          for (const s of steps) {
            for (const line of s.lines) { applyLine(work, line); work.log.push(line); }
            if (skipRef.current || s.kind === 'noise') continue;
            const tokens = s.lines.map(formatLine).filter(Boolean);
            if (!tokens.length) continue;                 // nothing visible happened (e.g. quiet upkeep)
            if (s.kind === 'move') moveIdx += 1;
            work.anim = { attacker: s.attacker, hits: s.hits, kind: s.kind };
            setView(clone(work));
            setStep({ kind: s.kind, index: s.kind === 'move' ? moveIdx : null, total: moveCount, tokens });
            await sleep((STEP_DELAY[s.kind] || 400) * scale);
          }
        }
      } finally {
        const final = battleRef.current;
        setView(final && final.id === work.id ? { ...clone(final), anim: null } : null);
        setStep(null);
        setPlaying(false);
        runningRef.current = false;
      }
    })();
  }, [battle, view?.id]);

  const rollOpponent = async () => {
    setBusy(true); setError(null);
    try {
      const r = await get(`/meta/random-team?regulation=${encodeURIComponent(regulation)}`);
      setOppPaste(r.paste); setOppMembers(r.members);
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const start = async () => {
    setBusy(true); setError(null); setProblems(null);
    try {
      const st = await simPost('/battle', {
        format, bot, p1: { name: 'You', paste: myPaste }, p2: { name: 'Bot', paste: oppPaste },
      });
      setBattle(st); setChoices({}); setPreview([]); setPicking(null);
    } catch (e) {
      setError(e.message);
      if (e.body?.problems) setProblems(e.body.problems);
    }
    setBusy(false);
  };

  const submit = async (choice) => {
    setBusy(true); setError(null);
    try {
      const st = await simPost(`/battle/${battle.id}/choice`, { choice });
      setBattle(st); setChoices({}); setPicking(null);
    } catch (e) {
      if (/404|no such battle/.test(e.message)) {
        dropBattle('That battle no longer exists (the simulator was restarted). Start a new one.');
        setBusy(false);
        return;
      }
      if (e.body?.id) setBattle(e.body);
      const last = e.body?.errors?.slice(-1)[0];
      setError(last ? last.replace(/^\[Invalid choice\]\s*/, '') : e.message);
    }
    setBusy(false);
  };

  // ---------------- setup screen ----------------
  if (health === null) return <section className="panel"><p className="dim">Checking the simulator…</p></section>;
  if (health === false) {
    return (
      <section className="panel">
        <h3 className="panel-title">Battle simulator</h3>
        <p>The Showdown simulator sidecar isn't running. In a third terminal:</p>
        <pre className="mono">cd sim{'\n'}npm install   # first time only{'\n'}npm start</pre>
        <p className="dim small">It listens on port 8001; the dev server proxies <code>/sim</code> to it.</p>
        <button onClick={() => window.location.reload()}>Retry</button>
      </section>
    );
  }

  if (!battle || !view) {
    return (
      <div className="battle-setup">
        <section className="panel">
          <h3 className="panel-title">Your team</h3>
          <div className="segmented">
            <button className={myMode === 'builder' ? 'on' : ''} onClick={() => setMyMode('builder')}>From Team Builder ({filled.length})</button>
            <button className={myMode === 'paste' ? 'on' : ''} onClick={() => setMyMode('paste')}>Paste</button>
          </div>
          <textarea className="mono" rows={12} value={myPaste} readOnly={myMode === 'builder'}
            onChange={(e) => setMyPaste(e.target.value)}
            placeholder={myMode === 'builder' ? 'Add Pokémon (with moves) in the Team Builder…' : 'Showdown paste (SP on the EVs line)…'} />
        </section>
        <section className="panel">
          <h3 className="panel-title">Opponent (bot)</h3>
          <div className="row">
            <button onClick={rollOpponent} disabled={busy}>🎲 Random ladder team</button>
            <label>Bot
              <select value={bot} onChange={(e) => setBot(e.target.value)}>
                <option value="smart">Smart (damage calc + threat model)</option>
                <option value="random">Random legal moves</option>
                <option value="default">Showdown default choice</option>
              </select>
            </label>
            <label>Format
              <select value={format} onChange={(e) => setFormat(e.target.value)}>
                {(formats.length ? formats : [{ id: DEFAULT_FORMAT, name: 'VGC 2026 Reg M-B' }]).map((f) => (
                  <option key={f.id} value={f.id}>{f.name.replace('[Gen 9 Champions] ', '')}</option>
                ))}
              </select>
            </label>
          </div>
          {health && !(health.bots || []).includes(bot) && (
            <p className="small" style={{ color: 'var(--warn)' }}>
              ⚠ The simulator sidecar on port 8001 is running older code that does not know the
              “{bot}” bot — it would play random moves. Stop it, run <code>{'cd sim && npm start'}</code>,
              then reload this page.
            </p>
          )}
          {formats.find((f) => f.id === format)?.provisional && (
            <p className="small dim">
              Provisional M-C: Showdown has no M-C format yet, so this is Reg M-B with its
              species/learnset legality checks off (clauses, Level 50 and pick-4 still apply) and
              the confirmed M-C mega abilities patched in.
            </p>
          )}
          {oppMembers && (
            <p className="small dim">
              {oppMembers.map((m) => `${m.name}${m.item ? ` @ ${m.item}` : ''}`).join(' · ')}
            </p>
          )}
          <textarea className="mono" rows={10} value={oppPaste} onChange={(e) => setOppPaste(e.target.value)}
            placeholder="Roll a random ladder team or paste one…" />
          <div className="row">
            <button className="primary" onClick={start} disabled={busy || !myPaste.trim() || !oppPaste.trim()}>
              Start battle
            </button>
            {error && <span className="small danger">{error}</span>}
          </div>
          {problems && <ul className="notes">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
        </section>
      </div>
    );
  }

  // ---------------- battle screen ----------------
  const req = playing ? null : battle.request;     // controls only after the replay finishes
  const me = view.sides.p1;
  const foe = view.sides.p2;
  const weatherName = view.fieldTimers?.weather?.name ?? view.field?.weather ?? null;
  const terrainName = view.fieldTimers?.terrain?.name ?? view.field?.terrain ?? null;
  const foeName = (i) => foe.active[i]?.species || '(empty)';
  const ownFainted = (i) => (req?.side?.pokemon?.[i]?.condition || '').endsWith(' fnt');
  const ownAbility = (i) => req?.side?.pokemon?.[i]?.ability || req?.side?.pokemon?.[i]?.baseAbility || '';
  const animFor = (pk) => {
    const a = view.anim;
    if (!a) return null;
    if (a.attacker && posKey(a.attacker) === pk) return 'attack';
    if ((a.hits || []).some((h) => posKey(h) === pk)) return 'hit';
    return null;
  };

  const targetOptions = (m, slot) => {
    const opts = [];
    if (['normal', 'any', 'adjacentFoe'].includes(m.target)) {
      opts.push({ v: 1, label: foeName(0), side: 'p2' }, { v: 2, label: foeName(1), side: 'p2' });
    }
    if (['normal', 'any', 'adjacentAlly'].includes(m.target)) {
      const ally = req.side.pokemon[slot === 0 ? 1 : 0];
      if (ally && ally.active && !ally.condition.endsWith(' fnt')) opts.push({ v: -(slot === 0 ? 2 : 1), label: who(ally.ident), side: 'p1' });
    }
    if (m.target === 'adjacentAllyOrSelf') {
      opts.push({ v: -(slot + 1), label: 'Self', side: 'p1' });
      opts.push({ v: -(slot === 0 ? 2 : 1), label: 'Ally', side: 'p1' });
    }
    return opts;
  };

  const pickMove = (slot, idx, m) => {
    const opts = TARGETED.has(m.target) ? targetOptions(m, slot) : [];
    // Functional updates: two quick clicks must not overwrite each other.
    const base = (prev) => ({ move: idx, mega: prev[slot]?.mega });
    if (opts.length === 0) { setChoices((prev) => ({ ...prev, [slot]: base(prev) })); setPicking(null); }
    else if (opts.length === 1) { setChoices((prev) => ({ ...prev, [slot]: { ...base(prev), target: opts[0].v } })); setPicking(null); }
    else { setChoices((prev) => ({ ...prev, [slot]: base(prev) })); setPicking(slot); }
  };

  const choiceString = () => {
    if (!req) return null;
    if (req.teamPreview) return preview.length >= (battle.teamPreview?.pick || 4) ? `team ${preview.map((i) => i + 1).join('')}` : null;
    const parts = [];
    if (req.forceSwitch) {
      req.forceSwitch.forEach((must, i) => parts.push(!must ? 'pass' : choices[i]?.switch ? `switch ${choices[i].switch}` : null));
    } else if (req.active) {
      req.active.forEach((a, i) => {
        if (!a || ownFainted(i)) { parts.push('pass'); return; }
        const c = choices[i];
        if (!c) { parts.push(null); return; }
        if (c.switch) { parts.push(`switch ${c.switch}`); return; }
        if (c.move === undefined) { parts.push(null); return; }   // e.g. only Mega ticked so far
        const m = a.moves[c.move];
        const needs = TARGETED.has(m.target) && targetOptions(m, i).length > 1;
        if (needs && c.target === undefined) { parts.push(null); return; }
        parts.push(`move ${c.move + 1}${c.target !== undefined ? ` ${c.target}` : ''}${c.mega ? ' mega' : ''}`);
      });
    }
    return parts.length && parts.every(Boolean) ? parts.join(', ') : null;
  };
  const ready = choiceString();
  const bench = req?.side?.pokemon
    ? req.side.pokemon.map((p, idx) => ({ p, idx })).filter(({ p }) => !p.active && !p.condition.endsWith(' fnt'))
    : [];

  // "Your plan" showcase: one line per slot once everything is chosen.
  const planLines = () => {
    if (!req?.active) return [];
    return req.active.map((a, i) => {
      const mon = req.side.pokemon[i];
      if (!a || ownFainted(i)) return null;
      const c = choices[i];
      if (!c) return null;
      if (c.switch) {
        const to = req.side.pokemon[c.switch - 1];
        return [{ name: who(mon.ident), side: 'p1' }, ' ▸ switch to ', { name: who(to?.ident), side: 'p1' }];
      }
      if (c.move === undefined) return null;
      const m = a.moves[c.move];
      const out = [{ name: who(mon.ident), side: 'p1' }, ' ▸ ', { em: m.move }];
      if (c.target !== undefined) {
        const t = c.target > 0 ? { name: foeName(c.target - 1), side: 'p2' }
          : { name: c.target === -(i + 1) ? 'itself' : who(req.side.pokemon[i === 0 ? 1 : 0]?.ident), side: 'p1' };
        out.push(' → ', t);
      } else if (TARGETED.has(m.target)) {
        out.push(' → (pick a target)');
      }
      if (c.mega) out.push(' ✦ Mega Evolve');
      return out;
    }).filter(Boolean);
  };

  const conditionsClass = `${weatherInfo(weatherName)?.cls || ''} ${terrainInfo(terrainName)?.cls || ''}`;

  return (
    <div className="battle">
      <div className="row" style={{ alignItems: 'center' }}>
        <strong>Turn {view.turn}</strong>
        <span className="dim small">{format.replace('gen9champions', '')} · bot: {battle.bot}</span>
        <span className="spacer" />
        <button onClick={start} disabled={busy}>Rematch</button>
        <button onClick={() => dropBattle()}>New setup</button>
      </div>
      {view.ended && !playing && (
        <div className="battle-banner">
          {view.winner ? `${view.winner === me.name ? 'You' : view.winner} won the battle!` : 'The battle ended in a tie.'}
        </div>
      )}

      {/* team preview */}
      {req?.teamPreview && (
        <section className="panel">
          <h3 className="panel-title">Team preview — bring {battle.teamPreview?.pick || 4}</h3>
          <div className="small dim">
            <Name side="p2" name="Opponent" />'s team{foe.sheet?.length ? ' (open team sheet: hover for sets)' : ''}
          </div>
          <div className="battle-preview foe-preview">
            {(foe.sheet?.length ? foe.sheet : (foe.preview || [])).map((p, i) => (
              <div key={i} className="battle-preview-card p2"
                title={p.moves?.length ? `${p.ability || ''}\n${p.moves.join(' / ')}` : undefined}>
                <BattleSprite species={p.species} size={56} />
                <Name side="p2" name={p.species} />
                {p.item && <div className="small dim">{p.item}</div>}
              </div>
            ))}
            {!(foe.sheet?.length || foe.preview?.length) && (
              <span className="dim small">waiting for the opponent's team…</span>
            )}
          </div>
          <div className="small dim"><Name side="p1" name="Your" /> team: click {battle.teamPreview?.pick || 4} in lead order</div>
          <div className="battle-preview">
            {req.side.pokemon.map((p, i) => {
              const k = preview.indexOf(i);
              const species = p.details.split(',')[0];
              return (
                <button key={p.ident} className={`battle-preview-card p1 ${k >= 0 ? 'on' : ''}`}
                  onClick={() => setPreview(k >= 0 ? preview.filter((x) => x !== i)
                    : preview.length < (battle.teamPreview?.pick || 4) ? [...preview, i] : preview)}>
                  <BattleSprite species={species} size={56} />
                  <Name side="p1" name={`${k >= 0 ? `#${k + 1} ` : ''}${species}`} />
                  <div className="small dim">{itemName(p.item)}</div>
                </button>
              );
            })}
          </div>
          <button className="primary" disabled={!ready || busy} onClick={() => submit(ready)}>Bring these</button>
        </section>
      )}

      {/* field + conditions */}
      {view.started && (
        <div className="battle-arena">
          <section className={`panel battle-field ${conditionsClass}`}>
            <div className="battle-row foe">
              <MonCard mon={foe.active[0]} side="p2" anim={animFor('p2a')} />
              <MonCard mon={foe.active[1]} side="p2" anim={animFor('p2b')} />
            </div>
            <div className="battle-row">
              <MonCard mon={me.active[0]} side="p1" back exact anim={animFor('p1a')} />
              <MonCard mon={me.active[1]} side="p1" back exact anim={animFor('p1b')} />
            </div>
          </section>
          <FieldStrip timers={view.fieldTimers} field={view.field} sides={view.sides} />
        </div>
      )}
      {pressure && !playing && <PressurePanel data={pressure} />}

      {/* playback banner */}
      <StepBanner step={step} onSkip={() => { skipRef.current = true; }} />

      {/* controls */}
      {req && !req.teamPreview && !view.ended && (
        <section className="panel">
          <div className="battle-controls">
            {(req.forceSwitch || req.active).map((slotReq, i) => {
              const mon = req.side.pokemon[i];
              const c = choices[i] || {};
              if (req.forceSwitch) {
                if (!slotReq) return <div key={i} className="battle-slot dim small">{mon ? who(mon.ident) : 'slot'}: no switch needed</div>;
                return (
                  <div key={i} className="battle-slot">
                    <div>Replace <Name side="p1" name={mon ? who(mon.ident) : `slot ${i + 1}`} /></div>
                    <div className="battle-bench">
                      {bench.map(({ p, idx }) => (
                        <button key={p.ident} className={c.switch === idx + 1 ? 'on' : ''}
                          onClick={() => setChoices((prev) => ({ ...prev, [i]: { switch: idx + 1 } }))}>
                          <Name side="p1" name={who(p.ident)} /> <span className="dim small">{hpText(p.condition)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              }
              if (!slotReq || ownFainted(i)) return <div key={i} className="battle-slot dim small">slot {i + 1}: empty</div>;
              return (
                <div key={i} className={`battle-slot ${c.move !== undefined || c.switch ? 'chosen' : ''}`}>
                  <div className="row" style={{ alignItems: 'center' }}>
                    <Name side="p1" name={who(mon.ident)} />
                    <b className="dim small">{hpText(mon.condition)}</b>
                    <span className="spacer" />
                    {slotReq.canMegaEvo && (
                      <label className="small"><input type="checkbox" checked={!!c.mega}
                        onChange={(e) => {
                          // Only one Pokémon can Mega Evolve per battle: ticking one clears the other.
                          const on = e.target.checked;
                          setChoices((prev) => {
                            const next = { ...prev, [i]: { ...(prev[i] || {}), mega: on } };
                            if (on) for (const k of Object.keys(next)) if (Number(k) !== i && next[k]) next[k] = { ...next[k], mega: false };
                            return next;
                          });
                        }} /> Mega Evolve</label>
                    )}
                  </div>
                  <div className="battle-moves">
                    {slotReq.moves.map((m, idx) => {
                      const et = effectiveMoveType(m.move, moveDb?.[m.move]?.type, weatherName, ownAbility(i));
                      // Consecutive Protect odds (1/3, 1/9, ...) and first-turn-only moves.
                      const mine = view.sides.p1.active[i];
                      const mid = toID(m.move);
                      const streak = STALL_MOVES.has(mid) ? (mine?.protectStreak || 0) : 0;
                      const firstTurnOnly = (mid === 'fakeout' || mid === 'firstimpression') && (mine?.moveActions || 0) > 0;
                      const warn = streak ? `${Math.round(100 / 3 ** streak)}% chance (${streak} in a row)`
                        : firstTurnOnly ? 'fails after the first turn out' : null;
                      return (
                        <button key={m.id} className={`battle-move ${c.move === idx ? 'on' : ''}`} disabled={m.disabled || busy}
                          title={m.disabled ? 'disabled' : `target: ${m.target}`} onClick={() => pickMove(i, idx, m)}>
                          <span className="battle-move-name">{m.move}</span>
                          <span className="small dim">
                            {et.type && <TypeChip t={et.type} />}
                            {et.why && <span className="move-type-note"> {et.why}</span>}
                            {warn && <span className="move-type-note"> ⚠ {warn}</span>}
                            {' '}{m.pp}/{m.maxpp} PP
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {picking === i && c.move !== undefined && (
                    <div className="battle-targets">
                      <span className="small dim">Target:</span>
                      {targetOptions(slotReq.moves[c.move], i).map((o) => (
                        <button key={o.v} className={c.target === o.v ? 'on' : ''}
                          onClick={() => { setChoices((prev) => ({ ...prev, [i]: { ...(prev[i] || {}), target: o.v } })); setPicking(null); }}>
                          <Name side={o.side} name={o.label} />
                        </button>
                      ))}
                    </div>
                  )}
                  {!slotReq.trapped && bench.length > 0 && (
                    <div className="battle-bench">
                      <span className="small dim">Switch:</span>
                      {bench.map(({ p, idx }) => (
                        <button key={p.ident} className={c.switch === idx + 1 ? 'on' : ''}
                          onClick={() => { setChoices((prev) => ({ ...prev, [i]: { switch: idx + 1 } })); setPicking(null); }}>
                          <Name side="p1" name={who(p.ident)} /> <span className="dim small">{hpText(p.condition)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {ready ? (
            <div className="plan-card">
              <div className="small dim">Your plan for turn {view.turn}</div>
              {(req.forceSwitch ? [] : planLines()).map((tokens, i) => <LogLine key={i} tokens={tokens} inline={false} />)}
              {req.forceSwitch && <div className="small">Replacements chosen.</div>}
              <div className="row" style={{ alignItems: 'center' }}>
                <button className="primary" disabled={busy} onClick={() => submit(ready)}>
                  {busy ? 'Resolving…' : 'Confirm turn'}
                </button>
                <span className="mono small dim">{ready}</span>
              </div>
            </div>
          ) : (
            <div className="row" style={{ marginTop: 8, alignItems: 'center' }}>
              <span className="dim small">Pick an action for each Pokémon to see your plan.</span>
            </div>
          )}
          {error && <div className="small danger">{error}</div>}
        </section>
      )}
      {!req && !view.ended && view.started && !playing && <p className="dim small">Waiting for the bot…</p>}

      {/* log */}
      <section className="panel">
        <h3 className="panel-title" style={{ margin: 0 }}>Battle log</h3>
        <LogView log={view.log} />
      </section>
    </div>
  );
}
