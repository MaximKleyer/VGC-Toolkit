import React, { useEffect, useMemo, useRef, useState } from 'react';
import { post, combatant, emptySlot, teamMembers, simGet, simPost, simDelete } from '../api.js';
import { Sprite } from './shared.jsx';

// Simulation lab: bot-vs-bot self-play between your six and theirs through the
// Showdown sidecar (sim/lab.mjs). Every lead + bring-four of yours is played
// against the ways they are likely to pick, and every KO and point of damage
// is attributed, so the panel can show the certified lead, the four to bring,
// a simulated matchup grid, the answers to each of their Pokemon and their
// best leads against you.
//
// mySlots: your filled Team Builder slots (with moves); oppMons: the Team
// Preview result's opponent list (id, name, lead_pct, set), so the lab plays
// the exact sets the calc analysis used.

const DEFAULT_FORMAT = 'gen9championsvgc2026regmb';
const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const ci = (r) => `${pct(r.lo)}–${pct(r.hi)}`;
const BUDGET_INFO = {
  quick: 'about 400 games, a quarter of a minute',
  standard: 'about 750 games, half a minute',
  deep: 'about 1500 games, about a minute',
};

// Cell colour for the matchup grid: green when yours comes out ahead, red when theirs does.
const edgeStyle = (edge) => {
  const a = Math.min(0.55, Math.abs(edge) * 0.6);
  return { background: edge >= 0 ? `rgba(70, 190, 110, ${a})` : `rgba(230, 80, 80, ${a})` };
};

export default function SimLab({ mySlots, oppMons, regulation }) {
  const [budget, setBudget] = useState('standard');
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState(null);
  const jobRef = useRef(null);

  const myWithMoves = useMemo(() => mySlots.filter((s) => (s.moves || []).some(Boolean)), [mySlots]);
  const myIds = myWithMoves.map((s) => s.pokemonId);
  const oppIds = (oppMons || []).map((m) => m.id);
  const ready = myWithMoves.length >= 4 && (oppMons || []).length >= 4;

  useEffect(() => {
    simGet('/health').then(setHealth).catch(() => setHealth(false));
  }, []);

  // Poll the running job.
  useEffect(() => {
    if (!job || job.status !== 'running') return undefined;
    const t = setInterval(async () => {
      try { const j = await simGet(`/lab/${job.id}`); setJob(j); } catch (e) { setError(e.message); clearInterval(t); }
    }, 600);
    return () => clearInterval(t);
  }, [job?.id, job?.status]);
  useEffect(() => () => { if (jobRef.current) simDelete(`/lab/${jobRef.current}`).catch(() => {}); }, []);

  const formatFor = async () => {
    try {
      const formats = await simGet('/formats');
      const re = new RegExp(`\\bReg ${regulation}\\b`);
      const hit = formats.find((f) => re.test(f.name)) || formats.find((f) => f.name.includes(regulation));
      return hit ? hit.id : DEFAULT_FORMAT;
    } catch { return DEFAULT_FORMAT; }
  };

  const run = async () => {
    setBusy(true); setError(null); setJob(null);
    try {
      const format = await formatFor();
      const mine = await post('/team/export', { team: teamMembers(myWithMoves), regulation });
      const theirs = await post('/team/export', {
        team: oppMons.map((m) => ({
          pokemon: combatant({ ...emptySlot(), pokemonId: m.id, spread: m.set?.spread || {}, alignment: m.set?.alignment || m.set?.nature || 'Serious', ability: m.set?.ability || '', item: m.set?.item || '' }),
          moves: (m.set?.moves || []).filter(Boolean), nickname: null,
        })),
        regulation,
      });
      const r = await simPost('/lab', {
        format, budget,
        p1: { name: 'You', paste: mine.paste }, p2: { name: 'Them', paste: theirs.paste },
        oppLeadPct: oppMons.map((m) => m.lead_pct || 0),
      });
      jobRef.current = r.id;
      setJob({ id: r.id, status: 'running', progress: { done: 0, total: 0, phase: 'starting' } });
    } catch (e) {
      setError(e.body?.problems ? `${e.message}: ${e.body.problems.join('; ')}` : e.message);
    }
    setBusy(false);
  };
  const stop = () => { if (job) simDelete(`/lab/${job.id}`).catch(() => {}); };

  const res = job?.status === 'done' ? job.results : null;
  const names = res?.names;
  const myName = (i) => names?.mine[i] || myWithMoves[i]?.displayName || '?';
  const theirName = (j) => names?.theirs[j] || oppMons[j]?.name || '?';

  return (
    <section className="panel lab">
      <h3 className="panel-title">Simulation lab</h3>
      <p className="dim small">
        Plays real engine games, the sidecar bot on both sides, for every lead and four of yours against the ways
        they are likely to pick, then attributes every KO. Bot play is not human play: read the win rates as evidence,
        and the intervals as how much of it there is.
      </p>
      {health === false && (
        <p className="warn small">The simulator sidecar is not running. Start it with <code>cd sim && npm start</code>.</p>
      )}
      {health && !health.lab && (
        <p className="warn small">The running sidecar predates the lab. Restart it with <code>cd sim && npm start</code>.</p>
      )}
      <div className="lab-controls">
        <label className="small">Depth{' '}
          <select value={budget} onChange={(e) => setBudget(e.target.value)} disabled={job?.status === 'running'}>
            {Object.keys(BUDGET_INFO).map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        <span className="dim small">{BUDGET_INFO[budget]}</span>
        {job?.status === 'running'
          ? <button className="small" onClick={stop}>Stop</button>
          : <button className="primary" disabled={!ready || busy || health === false} onClick={run}>Run simulation</button>}
        {!ready && <span className="dim small">Needs four of yours with moves and four of theirs (run the matchup analysis first).</span>}
      </div>
      {error && <p className="error small">{error}</p>}
      {job?.status === 'running' && (
        <div className="lab-progress">
          <div className="lab-bar"><div className="lab-fill" style={{ width: `${job.progress?.total ? (100 * job.progress.done) / job.progress.total : 2}%` }} /></div>
          <span className="small dim">{job.progress?.phase}: {job.progress?.done || 0}/{job.progress?.total || '?'} games{job.progress?.seconds ? `, ${Math.round(job.progress.seconds)}s` : ''}</span>
        </div>
      )}
      {job?.status === 'error' && <p className="error small">Simulation failed: {job.error}</p>}
      {job?.status === 'stopped' && <p className="dim small">Stopped before it finished.</p>}
      {res && <LabResults res={res} myIds={myIds} oppIds={oppIds} myName={myName} theirName={theirName} />}
    </section>
  );
}

function Mon({ id, name, size = 36 }) {
  return <span className="lab-mon" title={name}><Sprite id={id} size={size} /><span className="small">{name}</span></span>;
}

function LabResults({ res, myIds, oppIds, myName, theirName }) {
  const top = res.configs[0];
  const mvp = [...res.mine].filter((m) => m.winRateBrought != null && m.winRateBenched != null)
    .sort((a, b) => (b.winRateBrought - b.winRateBenched) - (a.winRateBrought - a.winRateBenched))[0];
  return (
    <div className="lab-results">
      <p className="small">
        <b>{res.games} games</b> in {res.seconds}s ({res.budget}); overall win rate <b>{pct(res.overall.winRate)}</b>
        {' '}<span className="dim">[{ci(res.overall)}]</span> across every lead and four tried against their likely picks, so the
        best choices below sit well above it. Win rates and the ranking count only games against their likely picks;
        the {res.sweepGames} games of the sweep, where the top choices met every lead pair of theirs equally, feed the
        "if they lead" tables and the grid.
      </p>

      {top && (
        <div className="lab-card lab-top">
          <div className="lab-card-title">Certified lead</div>
          <div className="lab-line">
            <div className="lab-mons">
              {top.lead.map((i) => <Mon key={i} id={myIds[i]} name={myName(i)} size={44} />)}
              <span className="dim small">back</span>
              {top.back.map((i) => <Mon key={i} id={myIds[i]} name={myName(i)} />)}
            </div>
            <div className="lab-rate">
              <b>{pct(top.winRate)}</b> <span className="dim small">[{ci(top)}] over {top.games} games against their likely picks</span>
              {top.anyLead && <div className="small">{pct(top.anyLead.winRate)} <span className="dim">[{ci(top.anyLead)}] over {top.anyLead.games} when every lead of theirs is equally likely</span></div>}
              <div className="dim small">bench: {top.benchNames.join(', ')} · about {Math.round(top.avgTurns)} turns a game</div>
            </div>
          </div>
          {top.vsLeads.length > 0 && (
            <table className="lab-table">
              <thead><tr><th>If they lead (most likely first)</th><th>Likely</th><th>You win</th><th>Games</th></tr></thead>
              <tbody>
                {top.vsLeads.map((v) => (
                  <tr key={v.lead.join('-')} className={v.winRate < 0.4 ? 'bad' : v.winRate > 0.6 ? 'good' : ''}>
                    <td>{v.names.join(' + ')}</td><td className="dim">{pct(v.likelihood)}</td><td>{pct(v.winRate)}</td><td className="dim">{v.games}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="lab-two">
        <div className="lab-card">
          <div className="lab-card-title">Leads and backs, ranked</div>
          <table className="lab-table">
            <thead><tr><th>Lead</th><th>Back</th><th>Win</th><th>95%</th><th>Games</th><th title="the same choice when every lead pair of theirs is equally likely (sweep games)">Any lead</th></tr></thead>
            <tbody>
              {res.configs.map((c) => (
                <tr key={c.key}>
                  <td>{c.leadNames.join(' + ')}</td><td className="dim">{c.backNames.join(', ')}</td>
                  <td><b>{pct(c.winRate)}</b></td><td className="dim">{ci(c)}</td><td className="dim">{c.games}</td>
                  <td className="dim">{c.anyLead ? `${pct(c.anyLead.winRate)} (${c.anyLead.games})` : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="dim small">Ranked by the low end of the interval, so a 70% over 40 games beats a 100% over 2. "Any lead" is the sweep: the same choice against every lead pair of theirs equally, which is why it can differ from the headline.</p>
        </div>
        <div className="lab-card">
          <div className="lab-card-title">Four to bring</div>
          <table className="lab-table">
            <thead><tr><th>Four</th><th>Win</th><th>Games</th><th>Best lead</th></tr></thead>
            <tbody>
              {res.fours.map((f) => (
                <tr key={f.key}>
                  <td>
                    <span className="lab-mons">{f.four.map((i) => <Sprite key={i} id={myIds[i]} size={28} title={myName(i)} />)}</span>
                    <span className="dim small"> bench {f.benchNames.join(', ')}</span>
                  </td>
                  <td><b>{pct(f.winRate)}</b> <span className="dim small">[{ci(f)}]</span></td>
                  <td className="dim">{f.games}</td>
                  <td className="small">{f.best ? f.best.leadNames.join(' + ') : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="lab-card-title" style={{ marginTop: 10 }}>Lead pairs, any back</div>
          <div className="small">
            {res.leads.map((l) => <div key={l.key}>{l.names.join(' + ')}: <b>{pct(l.winRate)}</b> <span className="dim">[{ci(l)}] over {l.games}</span></div>)}
          </div>
        </div>
      </div>

      <div className="lab-card">
        <div className="lab-card-title">Simulated matchups</div>
        <p className="dim small">Per game where both were brought: how often yours KOs theirs / how often theirs KOs yours. Hover for damage.</p>
        <div className="scroll-x">
          <table className="lab-grid">
            <thead><tr><th /> {res.names.theirs.map((n, j) => <th key={j}><Sprite id={oppIds[j]} size={30} title={n} /><div className="small">{n}</div></th>)}</tr></thead>
            <tbody>
              {res.matchup.map((row, i) => (
                <tr key={i}>
                  <th><Sprite id={myIds[i]} size={30} title={myName(i)} /><div className="small">{myName(i)}</div></th>
                  {row.map((c, j) => (
                    <td key={j} style={c.games ? edgeStyle(c.edge) : undefined}
                      title={c.games ? `${myName(i)} vs ${theirName(j)}: ${c.games} games together. ${myName(i)} deals ${pct(c.dealt)} of its HP a game and KOs it ${pct(c.koRate)} of games; takes ${pct(c.taken)} and is KO'd ${pct(c.koedRate)}.` : 'never on the field together'}>
                      {c.games ? <><b>{pct(c.koRate)}</b><span className="dim"> / {pct(c.koedRate)}</span></> : <span className="dim">–</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="lab-two">
        <div className="lab-card">
          <div className="lab-card-title">Their Pokémon, most dangerous first</div>
          {res.theirs.map((f) => (
            <div key={f.idx} className="lab-threat">
              <div className="lab-line">
                <Mon id={oppIds[f.idx]} name={f.name} />
                <div className="small">
                  <b>{f.kosPerGame.toFixed(2)}</b> KOs a game · they win <b>{pct(f.theirWinRateBrought)}</b> when it comes
                  {f.theirWinRateLead != null && <> · {pct(f.theirWinRateLead)} when it leads</>} · KO'd {pct(f.faintRate)} of games
                </div>
              </div>
              <div className="small">
                <span className="dim">answers: </span>
                {f.answers.length ? f.answers.map((a) => <span key={a.idx} className="lab-answer">{a.name} <span className="dim">KOs it {pct(a.koRate)}, KO'd {pct(a.koedRate)}</span></span>) : <span className="dim">not enough games</span>}
              </div>
              {f.preys.length > 0 && (
                <div className="small"><span className="dim">it beats: </span>{f.preys.map((p) => <span key={p.idx} className="lab-answer bad">{p.name} <span className="dim">KO'd {pct(p.koedRate)}</span></span>)}</div>
              )}
            </div>
          ))}
        </div>
        <div className="lab-card">
          <div className="lab-card-title">Your Pokémon</div>
          <p className="dim small">
            Win rates use the {res.uniformGames} first-round games, where every lead and four played the same number of
            times; the later rounds pile games onto the best sets, which would only measure who sits in them. KOs and
            KO'd are per game brought, over all {res.games} games.
          </p>
          {mvp && <p className="small">Most valuable: <b>{mvp.name}</b>, {pct(mvp.winRateBrought)} when brought against {pct(mvp.winRateBenched)} when benched.</p>}
          <table className="lab-table">
            <thead><tr><th>Pokémon</th><th>Brought</th><th>Benched</th><th>Lead</th><th>KOs/g</th><th>KO'd</th></tr></thead>
            <tbody>
              {res.mine.map((m) => (
                <tr key={m.idx}>
                  <td><Mon id={myIds[m.idx]} name={m.name} size={28} /></td>
                  <td>{pct(m.winRateBrought)} <span className="dim small">({m.broughtGames})</span></td>
                  <td>{pct(m.winRateBenched)} <span className="dim small">({m.benchGames})</span></td>
                  <td>{pct(m.winRateLead)} <span className="dim small">({m.leadGames})</span></td>
                  <td>{m.kosPerGame.toFixed(2)}</td>
                  <td>{pct(m.faintRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="small" style={{ marginTop: 6 }}>
            {res.mine.map((m) => (
              <div key={m.idx}><b>{m.name}</b>: <span className="dim">scores best against</span> {m.bestInto.map((b) => b.name).join(', ') || '–'} <span className="dim">· suffers most against</span> {m.worstInto.map((b) => b.name).join(', ') || '–'}</div>
            ))}
          </div>
          <p className="dim small">
            Scored from games where both were on the field: KOs landed minus KOs taken, plus a quarter of the damage
            traded. A KO is credited to the Pokémon that lands the finishing hit, so a spread attacker that cleans up
            weakened targets scores well against Pokémon it could not beat one on one.
          </p>
          {res.oppLeads.length > 0 && (
            <>
              <div className="lab-card-title" style={{ marginTop: 10 }}>Their leads against you</div>
              <p className="dim small">Every lead pair they can bring, ranked by how well it does for them (low end of the interval first). Game counts follow how often the sampler and the sweep chose each lead.</p>
              <table className="lab-table">
                <thead><tr><th>Their lead</th><th>Likely</th><th>They win</th><th>95%</th><th>Games</th></tr></thead>
                <tbody>
                  {res.oppLeads.map((l) => (
                    <tr key={l.lead.join('-')} className={l.theirWinRate > 0.5 ? 'bad' : ''}>
                      <td>{l.names.join(' + ')}</td><td className="dim">{pct(l.likelihood)}</td><td><b>{pct(l.theirWinRate)}</b></td><td className="dim">{ci(l)}</td><td className="dim">{l.games}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
