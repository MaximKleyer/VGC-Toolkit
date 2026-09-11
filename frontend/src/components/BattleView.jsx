import React, { useEffect, useRef, useState } from 'react';
import { TypeChip, FieldEffects } from './shared.jsx';

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

// "149/182 brn" | "72/100" | "50/100g" | "0 fnt" -> numbers. The champions engine
// mod tags the opponent's HP with a bar-colour letter at exactly 50% and 20%
// ("50/100g"); reading that as a number is what used to print NaN.
export function parseCond(cond) {
  const [hpPart, status] = String(cond || '').trim().split(' ');
  if (hpPart === '0' || status === 'fnt') return { hp: 0, maxhp: 100, pct: 0, exact: false, status: 'fnt', fainted: true };
  const m = /^(\d+)(?:\/(\d+))?/.exec(hpPart || '');
  const hp = m ? Number(m[1]) : 0;
  const maxhp = m && m[2] ? Number(m[2]) : 100;
  return { hp, maxhp, pct: Math.round((hp / maxhp) * 100), exact: maxhp !== 100, status: status || null, fainted: false };
}
export function hpText(cond) {
  const h = parseCond(cond);
  if (h.fainted) return '0 HP';
  return h.exact ? `${h.hp}/${h.maxhp} HP (${h.pct}%)` : `${h.pct}%`;
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

const STAT_SHORT = { atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe', accuracy: 'Acc', evasion: 'Eva' };

// One Pokémon on the field: a status plate (name, HP, status, stat stages, item /
// ability) above its sprite. `targetable` makes it a click target while a move
// is being aimed; `marks` are the actions already aimed at it; `badge` is the
// action chosen for one of your own. anim: 'attack' | 'hit' | null.
export function Battler({ mon, side, back, exact, anim, targetable, marks = [], onClick, badge }) {
  const cls = ['battler', side, mon?.fainted && 'fainted', anim && `anim-${anim}`, targetable && 'targetable',
    marks.length && 'targeted', !mon && 'empty'].filter(Boolean).join(' ');
  if (!mon) return <div className={cls}><div className="battler-sprite"><span className="dim small">empty</span></div></div>;
  const boosts = Object.entries(mon.boosts || {}).filter(([, v]) => v);
  const click = targetable ? onClick : undefined;
  return (
    <div className={cls} onClick={click} role={targetable ? 'button' : undefined} tabIndex={targetable ? 0 : undefined}
      onKeyDown={targetable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}>
      <div className="plate">
        <div className="plate-head">
          <Name side={side} name={mon.species} />
          {mon.mega ? <span className="mega-mark" title="Mega Evolved">✦</span> : null}
          {mon.status && mon.status !== 'fnt' && (
            <span className={`chip status-${mon.status}`}>{STATUS_LABEL[mon.status] || mon.status}</span>
          )}
        </div>
        <HpBar mon={mon} exact={exact} />
        {(boosts.length > 0 || mon.item || mon.ability) && (
          <div className="plate-meta">
            {boosts.map(([k, v]) => (
              <span key={k} className={`stage ${v > 0 ? 'up' : 'down'}`}>{STAT_SHORT[k] || k} {v > 0 ? '+' : '−'}{Math.abs(v)}</span>
            ))}
            {(mon.item || mon.ability) && (
              <span className="dim small">{mon.item ? `@ ${mon.item}` : ''}{mon.item && mon.ability ? ' · ' : ''}{mon.ability || ''}</span>
            )}
          </div>
        )}
      </div>
      <div className="battler-sprite">
        <BattleSprite species={mon.species} back={back} size={back ? 128 : 112}
          className={anim === 'attack' ? 'lunge' : anim === 'hit' ? 'shake' : ''} />
        {targetable && <div className="target-hint">target</div>}
        {marks.length > 0 && <div className="target-mark">◎ {marks.join(' · ')}</div>}
      </div>
      {badge && <div className="battler-badge"><LogLine tokens={badge} inline /></div>}
    </div>
  );
}

// ---------------------------------------------------------------- field conditions
// `key` indexes FIELD_EFFECTS (shared.jsx) for the effect listing on the card.
export const WEATHER = {
  SunnyDay: { label: 'Harsh sunlight', cls: 'w-sun', icon: '☀️', type: 'Fire', key: 'sun' },
  RainDance: { label: 'Rain', cls: 'w-rain', icon: '🌧️', type: 'Water', key: 'rain' },
  Sandstorm: { label: 'Sandstorm', cls: 'w-sand', icon: '🌪️', type: 'Rock', key: 'sand' },
  Snow: { label: 'Snow', cls: 'w-snow', icon: '❄️', type: 'Ice', key: 'snow' },
  Snowscape: { label: 'Snow', cls: 'w-snow', icon: '❄️', type: 'Ice', key: 'snow' },
  Hail: { label: 'Hail', cls: 'w-snow', icon: '❄️', type: 'Ice', key: 'snow' },
};
export const TERRAIN = {
  'Electric Terrain': { label: 'Electric Terrain', cls: 't-electric', icon: '⚡', key: 'electric' },
  'Grassy Terrain': { label: 'Grassy Terrain', cls: 't-grassy', icon: '🌿', key: 'grassy' },
  'Psychic Terrain': { label: 'Psychic Terrain', cls: 't-psychic', icon: '🔮', key: 'psychic' },
  'Misty Terrain': { label: 'Misty Terrain', cls: 't-misty', icon: '🌫️', key: 'misty' },
};
export const weatherInfo = (name) => (name ? WEATHER[name] || { label: name, cls: 'w-other', icon: '🌀' } : null);
export const terrainInfo = (name) => (name ? TERRAIN[name] || { label: name, cls: 't-other', icon: '▦' } : null);

// Keyed by ability id: the engine's request names abilities as ids ("aerilate").
const ATE = { aerilate: 'Flying', pixilate: 'Fairy', refrigerate: 'Ice', galvanize: 'Electric', dragonize: 'Dragon' };
const ABILITY_LABEL = { aerilate: 'Aerilate', pixilate: 'Pixilate', refrigerate: 'Refrigerate', galvanize: 'Galvanize',
  dragonize: 'Dragonize', liquidvoice: 'Liquid Voice' };
// The type a move will actually have right now (Weather Ball under weather,
// Normal moves under an -ate ability, sound moves under Liquid Voice). `why`
// explains the change; `flags` are the move's flags when the caller has them.
export function effectiveMoveType(moveName, baseType, weatherName, ability, flags) {
  const w = weatherInfo(weatherName);
  const ab = toID(ability);
  if (moveName === 'Weather Ball') {
    if (w?.type) return { type: w.type, why: `${w.label}: 100 BP` };
    if (ATE[ab]) return { type: ATE[ab], why: ABILITY_LABEL[ab] };
    return { type: 'Normal' };
  }
  if (ab === 'liquidvoice' && flags?.sound && baseType !== 'Water') return { type: 'Water', why: ABILITY_LABEL[ab] };
  if (baseType === 'Normal' && ATE[ab]) return { type: ATE[ab], why: ABILITY_LABEL[ab] };
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
        {w?.key && <FieldEffects kind="weather" k={w.key} className="small" />}
      </div>
      <div className={`field-card ${t ? t.cls : 'none'}`}>
        <div className="field-card-title">{t ? `${t.icon} ${t.label}` : '▦ No terrain'}</div>
        {t && <div className="field-card-turns">{turnsText(timers?.terrain?.turns)}</div>}
        {t?.key && <FieldEffects kind="terrain" k={t.key} className="small" />}
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
const clean = (s) => String(s || '').replace(/^(move|ability|item): /, '');
const isPos = (x) => /^p[12][a-c]?:/.test(x || '');
// "[from] brn" -> "burn": what caused residual damage or healing, in words.
const SOURCE = { brn: 'burn', psn: 'poison', tox: 'poison', sandstorm: 'sandstorm', hail: 'hail', snow: 'snow',
  recoil: 'recoil', drain: 'drain', confusion: 'confusion' };
function sourceOf(parts) {
  const from = parts.slice(3).find((x) => String(x).startsWith('[from]'));
  if (!from) return null;
  const text = clean(from.slice(6).trim());
  return SOURCE[text.toLowerCase()] || text;
}

// A log's HP memory (slot -> last known HP) so damage and heal lines can say
// how much changed. LogView keeps one per render; the playback banner has none.
export const newHpMemo = () => new Map();
function hpToken(memo, pos, cond) {
  const h = parseCond(cond);
  const key = posKey(pos);
  let delta = null;
  if (memo && key) {
    const prev = memo.get(key);
    if (prev && !prev.fainted) {
      if (prev.exact && (h.exact || h.fainted)) delta = { n: (h.fainted ? 0 : h.hp) - prev.hp, exact: true };
      else if (!prev.exact && !h.exact) delta = { n: h.pct - prev.pct, exact: false };
    }
    memo.set(key, h);
  }
  return { hp: h, delta };
}

// A log line -> {kind, side?, eff?, tokens} or null. Tokens: string | {name, side} |
// {hp, delta} | {move} | {status, text} | {stat, dir} | {src} | {em}. `kind` and
// `side` (whose Pokémon the line is about) drive the log's typography.
export function formatLine(line, memo) {
  const p = line.split('|');
  const c = p[1];
  if (NOISE.has(c)) return null;
  const mem = memo instanceof Map ? memo : null;
  const src = sourceOf(p);
  const srcTok = src ? [{ src }] : [];
  const sideName = (pos) => ({ name: sideOfPos(pos) === 'p1' ? 'your' : "the opponent's", side: sideOfPos(pos) });
  const L = (kind, tokens, extra) => ({ kind, tokens, ...(extra || {}) });
  const S = (pos) => ({ side: sideOfPos(pos) });
  switch (c) {
    case 'turn': return L('turn', [{ em: `Turn ${p[2]}` }]);
    case 'move': {
      const spread = p.slice(4).some((x) => String(x).startsWith('[spread]'));
      const self = isPos(p[4]) && posKey(p[4]) === posKey(p[2]);
      const tail = spread ? [{ em: ' (spread)' }] : isPos(p[4]) && !self ? [' on ', N(p[4])] : [];
      return L('move', [N(p[2]), ' used ', { move: p[3] }, ...tail, '.'], S(p[2]));
    }
    case 'switch': case 'drag':
      mem?.set(posKey(p[2]), parseCond(p[4]));
      return L('switch', [sideOfPos(p[2]) === 'p1' ? 'You sent out ' : 'The opponent sent out ', N(p[2]),
        c === 'drag' ? ' (dragged in).' : '.'], S(p[2]));
    case 'replace':
      mem?.set(posKey(p[2]), parseCond(p[4]));
      return L('switch', [N(p[2]), ' revealed itself.'], S(p[2]));
    case 'detailschange': return L('mega', [N(p[2]), ` became ${String(p[3]).split(',')[0]}!`], S(p[2]));
    case '-mega': return L('mega', [N(p[2]), ' Mega Evolved!'], S(p[2]));
    case '-damage': case '-sethp': return L('damage', [N(p[2]), ' ', hpToken(mem, p[2], p[3]), ...srcTok], S(p[2]));
    case '-heal': return L('heal', [N(p[2]), ' ', hpToken(mem, p[2], p[3]), ...srcTok], S(p[2]));
    case 'faint':
      mem?.set(posKey(p[2]), parseCond('0 fnt'));
      return L('faint', [N(p[2]), ' fainted!'], S(p[2]));
    case '-status': return L('status', [N(p[2]), ' was ', { status: p[3], text: STATUS_VERB[p[3]] || p[3] }, '!'], S(p[2]));
    case '-curestatus': return L('status', [N(p[2]), ` was cured of ${STATUS_LABEL[p[3]] || p[3]}.`], S(p[2]));
    case '-boost':
      return L('boost', [N(p[2]), "'s ", { stat: `${STAT_NAME[p[3]] || p[3]} rose${Number(p[4]) > 1 ? ' sharply' : ''}`, dir: 'up' }, '!'], S(p[2]));
    case '-unboost':
      return L('boost', [N(p[2]), "'s ", { stat: `${STAT_NAME[p[3]] || p[3]} fell${Number(p[4]) > 1 ? ' harshly' : ''}`, dir: 'down' }, '!'], S(p[2]));
    case '-crit': return L('effect', ['A critical hit!'], { eff: 'crit' });
    case '-supereffective': return L('effect', isPos(p[2]) ? ["It's super effective on ", N(p[2]), '!'] : ["It's super effective!"], { eff: 'super' });
    case '-resisted': return L('effect', isPos(p[2]) ? ["It's not very effective on ", N(p[2]), '…'] : ["It's not very effective…"], { eff: 'resist' });
    case '-immune': return L('effect', ["It doesn't affect ", N(p[2]), '.'], { eff: 'immune' });
    case '-miss': return L('effect', [N(p[2]), "'s attack missed", ...(isPos(p[3]) ? [' ', N(p[3])] : []), '.'], { eff: 'miss' });
    case '-fail': return L('effect', ['But it failed.'], { eff: 'fail' });
    case 'cant': {
      // |cant|POKEMON|REASON|MOVE|[of] SOURCE — blocked by an ability (Armor Tail, Dazzling, Damp …)
      // or unable to act (flinch, paralysis, sleep, recharge …).
      const reason = String(p[3] || '');
      const of = p.slice(4).find((x) => String(x).startsWith('[of] '));
      if (reason.startsWith('ability:') && of) {
        return L('cant', [N(p[2]), `'s ${clean(reason)} blocked `, N(of.slice(5)), "'s ", { move: p[4] }, '!'], S(p[2]));
      }
      const why = { flinch: 'flinched and could not move!', par: 'is paralyzed! It cannot move!', slp: 'is fast asleep.',
        frz: 'is frozen solid!', recharge: 'must recharge!', 'ability: Truant': 'is loafing around!' }[reason];
      return L('cant', why ? [N(p[2]), ` ${why}`] : [N(p[2]), ` can't move (${clean(reason)}).`], S(p[2]));
    }
    case '-weather':
      if (p.includes('[upkeep]')) return null;
      return L('field', [p[2] === 'none' ? 'The weather cleared.' : `${weatherInfo(p[2])?.label || p[2]} started.`]);
    case '-fieldstart': return L('field', [`${clean(p[2])} took effect.`]);
    case '-fieldend': return L('field', [`${clean(p[2])} ended.`]);
    case '-sidestart': return L('field', [`${clean(p[3])} started on `, sideName(p[2]), ' side.']);
    case '-sideend': return L('field', [`${clean(p[3])} ended on `, sideName(p[2]), ' side.']);
    case '-ability': return L('ability', [N(p[2]), "'s ", { em: p[3] }, '!'], S(p[2]));
    case '-item': return L('item', [N(p[2]), "'s ", { em: p[3] }, ...srcTok, '.'], S(p[2]));
    case '-enditem': {
      // Eaten ([eat]), knocked off / stolen ([from] move: ...), or simply consumed (Focus Sash).
      const fromMove = p.slice(3).some((x) => /^\[from\] move:/.test(String(x)));
      const verb = p.includes('[eat]') ? ' ate its ' : fromMove ? ' lost its ' : ' used its ';
      return L('item', [N(p[2]), verb, { em: p[3] }, ...(fromMove ? srcTok : []), '.'], S(p[2]));
    }
    case '-activate': {
      const what = clean(p[3]);
      if (what === 'Protect' || what === 'Detect' || what === 'Endure') return L('protect', [N(p[2]), ` is protected by ${what}!`], S(p[2]));
      if (String(p[3] || '').startsWith('ability:')) return L('ability', [N(p[2]), "'s ", { em: what }, '!'], S(p[2]));
      return L('info', [N(p[2]), `: ${what}.`], S(p[2]));
    }
    case '-hitcount': return L('info', [`Hit ${p[3]} time(s)!`]);
    case '-prepare': return L('info', [N(p[2]), ` is preparing ${p[3]}.`], S(p[2]));
    case '-singleturn': case '-singlemove': {
      const what = clean(p[3]);
      if (what === 'Protect') return L('protect', [N(p[2]), ' protected itself.'], S(p[2]));
      if (what === 'Endure') return L('protect', [N(p[2]), ' braced itself.'], S(p[2]));
      if (what === 'Wide Guard' || what === 'Quick Guard') return L('protect', [`${what} shields `, sideName(p[2]), ' side!'], S(p[2]));
      if (what === 'Helping Hand') return L('info', [N(p[2]), ' is ready to be helped!'], S(p[2]));
      if (what === 'Focus Punch') return L('info', [N(p[2]), ' is tightening its focus.'], S(p[2]));
      return L('info', [N(p[2]), `: ${what}.`], S(p[2]));
    }
    case '-message': case 'message': return L('info', [p[2]]);
    case 'win': return L('result', [{ em: `${p[2]} won the battle!` }]);
    case 'tie': return L('result', [{ em: 'The battle ended in a tie.' }]);
    default: return L('info', [`${c}: ${p.slice(2).join(' ')}`]);
  }
}

const hpClass = (pct) => (pct > 50 ? 'ok' : pct > 20 ? 'warn' : 'bad');
// "149/182 82% −33": exact HP (your side) in mono, the percentage as a coloured
// pill, then the change since the last line about this slot.
function HpToken({ hp: h, delta }) {
  const change = delta && delta.n !== 0 ? (
    <span className={`log-hp-delta ${delta.n < 0 ? 'down' : 'up'}`}>
      {delta.n < 0 ? '−' : '+'}{Math.abs(delta.n)}{delta.exact ? '' : '%'}
    </span>
  ) : null;
  if (h.fainted) return <span className="log-hp bad"><span className="log-hp-pct">0 HP</span>{change}</span>;
  return (
    <span className={`log-hp ${hpClass(h.pct)}`}>
      {h.exact && <span className="log-hp-num">{h.hp}/{h.maxhp}</span>}
      <span className="log-hp-pct">{h.pct}%</span>
      {change}
    </span>
  );
}

// Renders a formatted line ({kind, side, eff, tokens}) or a bare token array.
export function LogLine({ line, tokens, inline }) {
  const toks = tokens || line?.tokens || [];
  const Tag = inline ? 'span' : 'div';
  const cls = ['log-line', line?.kind && `kind-${line.kind}`, line?.side && `side-${line.side}`, line?.eff && `eff-${line.eff}`]
    .filter(Boolean).join(' ');
  return (
    <Tag className={cls}>
      {toks.map((t, i) => {
        if (typeof t === 'string') return t;
        if (t.name !== undefined) return <b key={i} className={`mon-name ${t.side}`}>{t.name}</b>;
        if (t.hp !== undefined) return <HpToken key={i} hp={t.hp} delta={t.delta} />;
        if (t.move !== undefined) return <b key={i} className="log-move">{t.move}</b>;
        if (t.status !== undefined) return <b key={i} className={`log-status-word status-${t.status}`}>{t.text}</b>;
        if (t.stat !== undefined) return <span key={i} className={`log-stat ${t.dir}`}>{t.stat}</span>;
        if (t.src !== undefined) return <span key={i} className="log-src"> ({t.src})</span>;
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
  const memo = newHpMemo();
  const turns = [];
  let cur = { turn: 0, items: [] };
  for (const line of log) {
    if (line.startsWith('|turn|')) { turns.push(cur); cur = { turn: Number(line.split('|')[2]), items: [] }; continue; }
    const item = formatLine(line, memo);
    if (item) cur.items.push(item);
  }
  turns.push(cur);
  const blocks = turns.filter((t) => t.items.length || t.turn > 0);
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
          {b.items.map((item, i) => <LogLine key={i} line={item} />)}
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
        {step.tokens.length ? step.tokens.map((t, i) => <LogLine key={i} line={t} />) : <span className="dim">…</span>}
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
  // One table per attacker: its damaging moves down the side, the two targets
  // across the top, the best move on each target in bold. Older sidecars send
  // only the best hit, so fall back to the one-line form when `moves` is absent.
  const cell = (h, best) => {
    if (!h) return <span className="dim">—</span>;
    if (h.blocked) return <span className="dim">no effect</span>;
    return (
      <span className={best ? 'hit best' : 'hit'}>
        <span className="mono">{h.min}–{h.max}%</span>
        {h.ko ? <span className={`hit-ko ${h.ko >= 50 ? 'hi' : ''}`}>KO {h.ko}%</span> : null}
      </span>
    );
  };
  const table = (attacker, attackerSide, targetSide) => {
    const threats = attacker.threats || [];
    if (!threats.length || !threats[0].moves) {
      return threats.map((t) => (
        <div key={`${attacker.species}-${t.target}`} className="small row-line">
          <Name side={attackerSide} name={attacker.species} /> → <Name side={targetSide} name={t.target} />: {hit(t)}
        </div>
      ));
    }
    const moves = threats[0].moves.map((m) => m.move);
    return (
      <table key={`${attackerSide}${attacker.slot}`} className="hit-table">
        <thead>
          <tr>
            <th><Name side={attackerSide} name={attacker.species} /></th>
            {threats.map((t) => <th key={t.target}><Name side={targetSide} name={t.target} /></th>)}
          </tr>
        </thead>
        <tbody>
          {moves.map((mv) => {
            const info = threats[0].moves.find((m) => m.move === mv);
            return (
              <tr key={mv}>
                <td className="hit-move">
                  {mv}{' '}
                  {info?.type && <TypeChip t={info.type} />}
                  {info?.spread ? <span className="dim" title="spread move: both targets, x0.75 each"> ⇶</span> : null}
                  {info?.priority ? <span className="dim" title={`priority ${info.priority > 0 ? '+' : ''}${info.priority}`}> ⚡{info.priority > 0 ? '+' : ''}{info.priority}</span> : null}
                </td>
                {threats.map((t) => {
                  const h = t.moves.find((m) => m.move === mv);
                  return <td key={t.target}>{cell(h, !!h && !h.blocked && t.move === mv)}</td>;
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  };
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
          {data.ours.map((o) => table(o, 'p1', 'p2'))}
        </div>
        <div>
          <div className="dim small">They threaten</div>
          {data.theirs.map((f) => table(f, 'p2', 'p1'))}
        </div>
      </div>
      <div className="dim small">~ = estimated from base stats. Then ask: how can they respond to what I threaten, and how do I respond to what they threaten?</div>
    </section>
  );
}
