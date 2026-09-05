import React, { useEffect, useRef, useState } from 'react';
import { TypeChip } from './shared.jsx';

// Presentational pieces for the Battle tab: sprites, coloured names (you =
// blue, opponent = red), HP, the field strip (weather / terrain / room / side
// conditions with turns left), the structured battle log and the per-action
// playback banner.

export const toID = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Showdown species name -> sprite file id ("Charizard-Mega-Y" -> "charizard-megay").
export function psSpriteId(species) {
  const s = String(species || '');
  const i = s.indexOf('-');
  return i < 0 ? toID(s) : `${toID(s.slice(0, i))}-${toID(s.slice(i + 1))}`;
}
const SPRITES = 'https://play.pokemonshowdown.com/sprites';

export function BattleSprite({ species, back, size = 96, className = '' }) {
  const id = psSpriteId(species);
  const base = toID(String(species).split('-')[0]);
  const urls = back
    ? [`${SPRITES}/gen5-back/${id}.png`, `${SPRITES}/gen5-back/${base}.png`, `${SPRITES}/gen5/${id}.png`]
    : [`${SPRITES}/gen5/${id}.png`, `${SPRITES}/home/${id}.png`, `${SPRITES}/gen5/${base}.png`];
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [species, back]);
  if (i >= urls.length) {
    return <div className={`sprite-fallback ${className}`} style={{ width: size, height: size }}>?</div>;
  }
  return (
    <img className={`battle-sprite ${className}`} src={urls[i]} width={size} height={size} alt={species}
      onError={() => setI(i + 1)} />
  );
}

// ---------------------------------------------------------------- sides & names
export const sideOfPos = (pos) => (String(pos || '').startsWith('p1') ? 'p1' : 'p2');
export const who = (pos) => String(pos || '').replace(/^p[12][a-c]?:\s*/, '');
// "p2a: Kingambit" -> "p2a"
export const posKey = (pos) => { const m = /^(p[12][a-c]?)/.exec(String(pos || '')); return m ? m[1] : null; };

export function Name({ pos, name, side }) {
  return <b className={`mon-name ${side || sideOfPos(pos)}`}>{name ?? who(pos)}</b>;
}

// ---------------------------------------------------------------- HP & status
const STATUS_LABEL = { brn: 'BRN', par: 'PAR', psn: 'PSN', tox: 'TOX', slp: 'SLP', frz: 'FRZ', fnt: 'FNT' };
const STATUS_VERB = { brn: 'burned', par: 'paralyzed', psn: 'poisoned', tox: 'badly poisoned', slp: 'put to sleep', frz: 'frozen' };
const STAT_NAME = { atk: 'Attack', def: 'Defense', spa: 'Sp. Atk', spd: 'Sp. Def', spe: 'Speed', accuracy: 'accuracy', evasion: 'evasiveness' };

export function hpText(cond) {
  const [hp, rest] = String(cond || '').split(' ');
  if (hp === '0' || rest === 'fnt') return '0 HP';
  const [a, b] = hp.split('/').map(Number);
  return b === 100 ? `${a}%` : `${a}/${b} HP (${Math.round((a / b) * 100)}%)`;
}

export function HpBar({ mon, exact }) {
  const pct = mon.maxhp ? Math.max(0, Math.round((mon.hp / mon.maxhp) * 100)) : 0;
  const cls = pct > 50 ? 'ok' : pct > 20 ? 'warn' : 'bad';
  return (
    <div className="battle-hp">
      <div className="battle-hp-bar"><div className={`battle-hp-fill ${cls}`} style={{ width: `${pct}%` }} /></div>
      <b className="mono small hp-text">
        {exact && mon.maxhp !== 100 ? `${mon.hp}/${mon.maxhp} (${pct}%)` : `${pct}%`}
      </b>
    </div>
  );
}

// anim: 'attack' | 'hit' | null
export function MonCard({ mon, side, back, exact, anim }) {
  if (!mon) return <div className={`battle-mon empty ${side}`}><span className="dim small">no Pokémon</span></div>;
  const boosts = Object.entries(mon.boosts || {}).filter(([, v]) => v);
  return (
    <div className={`battle-mon ${side} ${mon.fainted ? 'fainted' : ''} ${anim ? `anim-${anim}` : ''}`}>
      <BattleSprite species={mon.species} back={back}
        className={anim === 'attack' ? 'lunge' : anim === 'hit' ? 'shake' : ''} />
      <div className="battle-mon-info">
        <div className="battle-mon-name">
          <Name side={side} name={mon.species} />{mon.mega ? ' ✦' : ''}
          {mon.status && mon.status !== 'fnt' && (
            <span className={`chip status-${mon.status}`}>{STATUS_LABEL[mon.status] || mon.status}</span>
          )}
        </div>
        <HpBar mon={mon} exact={exact} />
        <div className="small dim">
          {mon.item ? `@ ${mon.item}` : ''}{mon.ability ? ` · ${mon.ability}` : ''}
          {boosts.length > 0 && ' · ' + boosts.map(([k, v]) => `${v > 0 ? '+' : ''}${v} ${k}`).join(' ')}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- field conditions
export const WEATHER = {
  SunnyDay: { label: 'Harsh sunlight', cls: 'w-sun', icon: '☀️', type: 'Fire' },
  RainDance: { label: 'Rain', cls: 'w-rain', icon: '🌧️', type: 'Water' },
  Sandstorm: { label: 'Sandstorm', cls: 'w-sand', icon: '🌪️', type: 'Rock' },
  Snow: { label: 'Snow', cls: 'w-snow', icon: '❄️', type: 'Ice' },
  Snowscape: { label: 'Snow', cls: 'w-snow', icon: '❄️', type: 'Ice' },
  Hail: { label: 'Hail', cls: 'w-snow', icon: '❄️', type: 'Ice' },
};
export const TERRAIN = {
  'Electric Terrain': { label: 'Electric Terrain', cls: 't-electric', icon: '⚡' },
  'Grassy Terrain': { label: 'Grassy Terrain', cls: 't-grassy', icon: '🌿' },
  'Psychic Terrain': { label: 'Psychic Terrain', cls: 't-psychic', icon: '🔮' },
  'Misty Terrain': { label: 'Misty Terrain', cls: 't-misty', icon: '🌫️' },
};
export const weatherInfo = (name) => (name ? WEATHER[name] || { label: name, cls: 'w-other', icon: '🌀' } : null);
export const terrainInfo = (name) => (name ? TERRAIN[name] || { label: name, cls: 't-other', icon: '▦' } : null);

const ATE = { Aerilate: 'Flying', Pixilate: 'Fairy', Refrigerate: 'Ice', Galvanize: 'Electric', Dragonize: 'Dragon' };
// The type a move will actually have right now (Weather Ball under weather,
// Normal moves under an -ate ability). `why` explains the change.
export function effectiveMoveType(moveName, baseType, weatherName, ability) {
  const w = weatherInfo(weatherName);
  if (moveName === 'Weather Ball') {
    if (w?.type) return { type: w.type, why: `${w.label}: 100 BP` };
    if (ATE[ability]) return { type: ATE[ability], why: ability };
    return { type: 'Normal' };
  }
  if (baseType === 'Normal' && ATE[ability]) return { type: ATE[ability], why: ability };
  return { type: baseType };
}

const turnsText = (n) => (n == null ? '' : n === 1 ? '1 turn left' : `${n} turns left`);

export function FieldStrip({ timers, field, sides }) {
  const weather = timers?.weather?.name ?? field?.weather ?? null;
  const terrain = timers?.terrain?.name ?? field?.terrain ?? null;
  const pseudo = timers?.pseudo ?? (field?.pseudo || []).map((n) => ({ name: n }));
  const sideConds = (id) => timers?.sides?.[id] ?? (sides?.[id]?.conditions || []).map((n) => ({ name: n }));
  const w = weatherInfo(weather);
  const t = terrainInfo(terrain);
  return (
    <aside className="field-strip">
      <div className={`field-card ${w ? w.cls : 'none'}`}>
        <div className="field-card-title">{w ? `${w.icon} ${w.label}` : '☁️ Clear skies'}</div>
        {w && <div className="field-card-turns">{turnsText(timers?.weather?.turns)}</div>}
        {w?.type && <div className="small">Weather Ball → <TypeChip t={w.type} /></div>}
      </div>
      <div className={`field-card ${t ? t.cls : 'none'}`}>
        <div className="field-card-title">{t ? `${t.icon} ${t.label}` : '▦ No terrain'}</div>
        {t && <div className="field-card-turns">{turnsText(timers?.terrain?.turns)}</div>}
      </div>
      {pseudo.map((p) => (
        <div key={p.name} className="field-card t-room">
          <div className="field-card-title">🌀 {p.name}</div>
          <div className="field-card-turns">{turnsText(p.turns)}</div>
        </div>
      ))}
      {['p2', 'p1'].map((id) => sideConds(id).map((c) => (
        <div key={id + c.name} className={`field-card side-${id}`}>
          <div className="field-card-title">
            {c.name}{c.layers > 1 ? ` ×${c.layers}` : ''} · <Name side={id} name={id === 'p1' ? 'your side' : 'their side'} />
          </div>
          {c.turns != null && <div className="field-card-turns">{turnsText(c.turns)}</div>}
        </div>
      )))}
    </aside>
  );
}

// ---------------------------------------------------------------- log
const NOISE = new Set(['', 't:', 'j', 'l', 'request', 'inactive', 'inactiveoff', 'player', 'teamsize',
  'gen', 'tier', 'rule', 'clearpoke', 'poke', 'teampreview', 'start', 'upkeep', '-anim', 'debug',
  'seed', 'gametype', 'rated', 'c', 'chat', 'raw', 'html', 'uhtml', 'uhtmlchange', 'split', '-hint', 'n',
  'showteam', 'bigerror', 'error', 'callback', 'title', 'join', 'leave', 'name']);
const N = (pos) => ({ name: who(pos), side: sideOfPos(pos) });
const H = (cond) => ({ hp: hpText(cond) });
const clean = (s) => String(s || '').replace(/^(move|ability|item): /, '');
const isPos = (x) => /^p[12][a-c]?:/.test(x || '');

// A log line -> array of tokens (string | {name, side} | {hp} | {em}) or null.
export function formatLine(line) {
  const p = line.split('|');
  const c = p[1];
  if (NOISE.has(c)) return null;
  const from = p.slice(3).find((x) => x.startsWith('[from]'));
  const src = from ? ` (${clean(from.slice(6).trim())})` : '';
  const sideName = (pos) => ({ name: sideOfPos(pos) === 'p1' ? 'your' : "the opponent's", side: sideOfPos(pos) });
  switch (c) {
    case 'turn': return [{ em: `Turn ${p[2]}` }];
    case 'move': {
      const spread = p.slice(4).some((x) => String(x).startsWith('[spread]'));
      const self = isPos(p[4]) && posKey(p[4]) === posKey(p[2]);
      if (spread) return [N(p[2]), ` used ${p[3]}`, { em: ' (spread)' }, '.'];
      return [N(p[2]), ` used ${p[3]}`, ...(isPos(p[4]) && !self ? [' on ', N(p[4])] : []), '.'];
    }
    case 'switch': case 'drag':
      return [sideOfPos(p[2]) === 'p1' ? 'You sent out ' : 'The opponent sent out ', N(p[2]),
        c === 'drag' ? ' (dragged in).' : '.'];
    case 'replace': return [N(p[2]), ' revealed itself.'];
    case 'detailschange': return [N(p[2]), ` became ${String(p[3]).split(',')[0]}!`];
    case '-mega': return [N(p[2]), ' Mega Evolved!'];
    case '-damage': return [N(p[2]), ' → ', H(p[3]), src];
    case '-heal': return [N(p[2]), ' healed → ', H(p[3]), src];
    case '-sethp': return [N(p[2]), ' → ', H(p[3])];
    case 'faint': return [N(p[2]), ' fainted!'];
    case '-status': return [N(p[2]), ` was ${STATUS_VERB[p[3]] || p[3]}!`];
    case '-curestatus': return [N(p[2]), ` was cured of ${STATUS_LABEL[p[3]] || p[3]}.`];
    case '-boost': return [N(p[2]), `'s ${STAT_NAME[p[3]] || p[3]} rose${Number(p[4]) > 1 ? ' sharply' : ''}!`];
    case '-unboost': return [N(p[2]), `'s ${STAT_NAME[p[3]] || p[3]} fell${Number(p[4]) > 1 ? ' harshly' : ''}!`];
    case '-crit': return ['A critical hit!'];
    case '-supereffective': return isPos(p[2]) ? ["It's super effective on ", N(p[2]), '!'] : ["It's super effective!"];
    case '-resisted': return isPos(p[2]) ? ["It's not very effective on ", N(p[2]), '…'] : ["It's not very effective…"];
    case '-immune': return ["It doesn't affect ", N(p[2]), '.'];
    case '-miss': return [N(p[2]), "'s attack missed", ...(isPos(p[3]) ? [' ', N(p[3])] : []), '.'];
    case '-fail': return ['But it failed.'];
    case 'cant': {
      // |cant|POKEMON|REASON|MOVE|[of] SOURCE — blocked by an ability (Armor Tail, Dazzling, Damp …)
      // or unable to act (flinch, paralysis, sleep, recharge …).
      const reason = String(p[3] || '');
      const of = p.slice(4).find((x) => String(x).startsWith('[of] '));
      if (reason.startsWith('ability:') && of) {
        return [N(p[2]), `'s ${clean(reason)} blocked `, N(of.slice(5)), `'s ${p[4]}!`];
      }
      const why = { flinch: 'flinched and could not move!', par: 'is paralyzed! It cannot move!', slp: 'is fast asleep.',
        frz: 'is frozen solid!', recharge: 'must recharge!', 'ability: Truant': 'is loafing around!' }[reason];
      return why ? [N(p[2]), ` ${why}`] : [N(p[2]), ` can't move (${clean(reason)}).`];
    }
    case '-weather':
      if (p.includes('[upkeep]')) return null;
      return [p[2] === 'none' ? 'The weather cleared.' : `${weatherInfo(p[2])?.label || p[2]} started.`];
    case '-fieldstart': return [`${clean(p[2])} took effect.`];
    case '-fieldend': return [`${clean(p[2])} ended.`];
    case '-sidestart': return [`${clean(p[3])} started on `, sideName(p[2]), ' side.'];
    case '-sideend': return [`${clean(p[3])} ended on `, sideName(p[2]), ' side.'];
    case '-ability': return [N(p[2]), `'s ${p[3]}!`];
    case '-item': return [N(p[2]), `'s ${p[3]}${src}.`];
    case '-enditem': return [N(p[2]), ` used its ${p[3]}.`];
    case '-activate': {
      const what = clean(p[3]);
      if (what === 'Protect' || what === 'Detect' || what === 'Endure') return [N(p[2]), ` is protected by ${what}!`];
      return [N(p[2]), `: ${what}.`];
    }
    case '-hitcount': return [`Hit ${p[3]} time(s)!`];
    case '-prepare': return [N(p[2]), ` is preparing ${p[3]}.`];
    case '-singleturn': case '-singlemove': {
      const what = clean(p[3]);
      if (what === 'Protect') return [N(p[2]), ' protected itself.'];
      if (what === 'Endure') return [N(p[2]), ' braced itself.'];
      if (what === 'Wide Guard' || what === 'Quick Guard') return [`${what} shields `, sideName(p[2]), ' side!'];
      if (what === 'Helping Hand') return [N(p[2]), ' is ready to be helped!'];
      if (what === 'Focus Punch') return [N(p[2]), ' is tightening its focus.'];
      return [N(p[2]), `: ${what}.`];
    }
    case '-message': case 'message': return [p[2]];
    case 'win': return [{ em: `${p[2]} won the battle!` }];
    case 'tie': return [{ em: 'The battle ended in a tie.' }];
    default: return [`${c}: ${p.slice(2).join(' ')}`];
  }
}

export function LogLine({ tokens, inline }) {
  const Tag = inline ? 'span' : 'div';
  return (
    <Tag className="log-line">
      {tokens.map((t, i) => {
        if (typeof t === 'string') return t;
        if (t.name !== undefined) return <b key={i} className={`mon-name ${t.side}`}>{t.name}</b>;
        if (t.hp !== undefined) return <b key={i} className="log-hp">{t.hp}</b>;
        return <em key={i} className="log-em">{t.em}</em>;
      })}
    </Tag>
  );
}

// Log grouped by turn; the latest two turns shown by default.
export function LogView({ log }) {
  const [showAll, setShowAll] = useState(false);
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [log.length, showAll]);
  const turns = [];
  let cur = { turn: 0, lines: [] };
  for (const line of log) {
    if (line.startsWith('|turn|')) { turns.push(cur); cur = { turn: Number(line.split('|')[2]), lines: [] }; }
    else cur.lines.push(line);
  }
  turns.push(cur);
  const blocks = turns
    .map((t) => ({ ...t, items: t.lines.map(formatLine).filter(Boolean) }))
    .filter((t) => t.items.length || t.turn > 0);
  const shown = showAll ? blocks : blocks.slice(-2);
  return (
    <div className="battle-log" ref={ref}>
      {blocks.length > 2 && (
        <button className="small log-toggle" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show latest turns only' : `Show all ${blocks.length} turns`}
        </button>
      )}
      {shown.map((b, bi) => (
        <div key={`${b.turn}:${bi}`} className={`log-turn ${bi === shown.length - 1 ? 'current' : ''}`}>
          <div className="log-turn-head">{b.turn > 0 ? `Turn ${b.turn}` : 'Battle start'}</div>
          {b.items.map((tokens, i) => <LogLine key={i} tokens={tokens} />)}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- playback banner
const ORD = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
const STEP_LABEL = {
  switch: 'Switch', drag: 'Dragged in', replace: 'Reveal', turn: 'New turn', upkeep: 'End of turn',
  cant: "Can't move", '-fieldstart': 'Field', '-fieldend': 'Field', '-weather': 'Weather',
  '-sidestart': 'Side', '-sideend': 'Side', '-mega': 'Mega Evolution', detailschange: 'Form change',
  win: 'Result', tie: 'Result',
};

export function StepBanner({ step, onSkip }) {
  if (!step) return null;
  return (
    <div className={`step-banner kind-${String(step.kind).replace(/^-/, '')}`}>
      {step.index
        ? <span className="step-order">{ORD[step.index] || `${step.index}th`}{step.total ? ` of ${step.total}` : ''}</span>
        : <span className="step-order dim">{STEP_LABEL[step.kind] || 'Event'}</span>}
      <div className="step-lines">
        {step.tokens.length ? step.tokens.map((t, i) => <LogLine key={i} tokens={t} />) : <span className="dim">…</span>}
      </div>
      <button className="small" onClick={onSkip}>Skip ▸▸</button>
    </div>
  );
}

// ---------------------------------------------------------------- turn read (Wolfe's three questions)
// data comes from GET /sim/battle/:id/pressure: speed order, what each of yours
// threatens on each of theirs and vice versa; at team preview, their six ranked
// by the damage they threaten with your answers.
export function PressurePanel({ data }) {
  if (!data) return null;
  const hit = (h) => (h && h.move ? `${h.move} ${h.min}–${h.max}%${h.ko ? ` · KO ${h.ko}%` : ''}` : '—');
  if (data.preview) {
    if (!data.preview.length) return null;
    return (
      <section className="panel pressure">
        <div className="panel-title">Team preview read</div>
        {data.preview.slice(0, 4).map((p) => (
          <div key={p.species} className="small row-line">
            <Name side="p2" name={p.species} />
            {p.worst?.move ? <> threatens <Name side="p1" name={p.worst.target} /> with {p.worst.move} ({p.worst.min}–{p.worst.max}%)</> : ' threatens little'}.
            {' '}Your answers:{' '}
            {p.answers.length
              ? p.answers.slice(0, 3).map((a, i) => (
                <span key={a.answer}>{i ? ', ' : ''}<Name side="p1" name={a.answer} /> <span className="dim">({a.move} {a.max}%)</span></span>
              ))
              : <span className="danger">none</span>}
          </div>
        ))}
        <div className="dim small">Bring at least two answers to their scariest Pokémon; rule out what you will not bring, from both sides.</div>
      </section>
    );
  }
  return (
    <section className="panel pressure">
      <div className="panel-title">Turn read{data.trickRoom ? ' · Trick Room' : ''}</div>
      <div className="small row-line">
        Speed order:{' '}
        {data.order.map((o, i) => (
          <span key={`${o.side}${o.slot}`}>{i ? ' › ' : ''}<Name side={o.side} name={o.species} /> <span className="dim">{o.speed}{o.estimated ? '~' : ''}</span></span>
        ))}
      </div>
      <div className="pressure-grid">
        <div>
          <div className="dim small">You threaten</div>
          {data.ours.map((o) => o.threats.map((t) => (
            <div key={`${o.species}-${t.target}`} className="small row-line">
              <Name side="p1" name={o.species} /> → <Name side="p2" name={t.target} />: {hit(t)}
            </div>
          )))}
        </div>
        <div>
          <div className="dim small">They threaten</div>
          {data.theirs.map((f) => f.threats.map((t) => (
            <div key={`${f.species}-${t.target}`} className="small row-line">
              <Name side="p2" name={f.species} /> → <Name side="p1" name={t.target} />: {hit(t)}
            </div>
          )))}
        </div>
      </div>
      <div className="dim small">~ = estimated from base stats. Then ask: how can they respond to what I threaten, and how do I respond to what they threaten?</div>
    </section>
  );
}
