// Pokemon Showdown simulator sidecar for the Champions VGC Toolkit.
//
// Wraps the real Showdown engine (npm `pokemon-showdown`, which ships the
// `champions` mod and the "[Gen 9 Champions] VGC 2026 Reg M-B" doubles format)
// behind a tiny HTTP API the Battle tab talks to through the Vite `/sim` proxy.
// The human is always p1; p2 is driven by a built-in bot. State is reduced
// from p1's protocol stream, so the UI only ever sees what a real player would
// (exact HP for its own side, percentages for the opponent).
//
//   POST /sim/battle            {format, p1:{name,paste|team}, p2:{name,paste|team}, bot}
//   GET  /sim/battle/:id        current state
//   POST /sim/battle/:id/choice {choice}  -> p1's choice, e.g. "move 1 2, move 2 1 mega"
//                                          or "team 1234" or "switch 3"
//   POST /sim/validate          {format, paste|team} -> {problems: [...]|null, team}
//   GET  /sim/formats           formats whose name contains "Champions"
//   POST /sim/lab               {format, p1:{name,paste|team}, p2:{...}, oppLeadPct, budget, seed}
//                               -> {id}: a Matchup Lab job (lab.mjs), bot-vs-bot self-play
//   GET  /sim/lab/:id           {status, progress, results}; DELETE stops it
//
// Run:  cd sim && npm install && npm start      (port 8001; SIM_PORT overrides)

import http from 'node:http';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import ps from 'pokemon-showdown';

const { BattleStream, getPlayerStreams, Teams, Dex, TeamValidator } = ps;

const PORT = Number(process.env.SIM_PORT || 8001);
const DEFAULT_FORMAT = 'gen9championsvgc2026regmb';
const battles = new Map();

// Regulation M-C (live since 2026-09-08) has no Showdown format in this
// engine build yet. Until it does, expose a provisional one: the M-B doubles
// format with Showdown's "Obtainable" legality checks (species availability,
// learnsets) switched off so the M-C additions can be used: the champions mod
// carries every Gen 9 species, item and move as "Past", which !Obtainable
// unlocks. Species Clause, Item Clause = 1, Level 50, Team Preview and pick-4
// stay in force.
export const SYNTHETIC_FORMATS = {
  gen9championsvgc2026regmc: {
    id: 'gen9championsvgc2026regmc',
    name: '[Gen 9 Champions] VGC 2026 Reg M-C (provisional)',
    gameType: 'doubles', mod: 'champions', provisional: true,
    formatid: 'gen9championsvgc2026regmb@@@!Obtainable',
  },
};
export const resolveFormat = (id) => SYNTHETIC_FORMATS[id]?.formatid || id;

// The toolkit's stone names for the two Z-A megas vs the engine's spellings.
const STONE_ALIASES = { Golisopodite: 'Golisopite', Baxcaliburite: 'Baxcalibrite' };
const aliasStones = (text) => Object.entries(STONE_ALIASES)
  .reduce((t, [ours, theirs]) => t.split(ours).join(theirs), text);

// The toolkit's own ability choices for forms whose Champions ability is not
// announced yet (Team Builder ability editor -> vgc_toolkit/data/ability_overrides.json):
// {"golisopod-mega": ["Battle Armor"], ...} (the file keeps a list per form; the
// first entry is the choice). Read fresh every time it is applied.
const OVERRIDES_FILE = new URL('../vgc_toolkit/data/ability_overrides.json', import.meta.url);
export function loadAbilityOverrides(file = OVERRIDES_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    return {};
  }
}

// Champions data this engine build (July 2026) predates, patched into the
// loaded 'champions' mod at startup and again whenever a battle starts (so a
// Team Builder ability choice applies without restarting the sidecar):
//  - the six Regulation M-C megas' abilities (Mega Absol Z Sharpness, Mega
//    Garchomp Z Levitate, Mega Lucario Z Aura Guard, a new ability that halves
//    damage the holder takes from contact moves, Mega Golisopod Tough Claws,
//    Mega Baxcalibur Thermal Exchange; the engine ships the base forms'
//    abilities), plus the toolkit's overrides for anything still unannounced;
//  - Run Away as an in-battle ability: the holder can always switch out;
//  - the M-C move changes (2026-09-08): Slash 80 BP, Meteor Assault 170,
//    Snipe Shot 85, Double Shock is a punch, Wish and Strength Sap 8 PP,
//    Milk Drink can target the ally.
// Returns "Species = Ability" strings for the log.
export function patchChampionsData(overrides = loadAbilityOverrides()) {
  const dex = Dex.mod('champions');
  dex.data.Abilities.auraguard = {
    name: 'Aura Guard', num: -9001, rating: 3.5,
    onSourceModifyDamage(damage, source, target, move) {
      if (move.flags['contact']) return this.chainModify(0.5);
    },
  };
  // Run Away: the holder ignores trapping (Shadow Tag, Arena Trap, binding moves).
  dex.data.Abilities.runaway = {
    ...dex.data.Abilities.runaway,
    onTrapPokemonPriority: -10,
    onTrapPokemon(pokemon) { pokemon.trapped = pokemon.maybeTrapped = false; },
  };
  dex.abilities.abilityCache?.clear?.();
  // A copy per move: the mod's data table shares entries with its parent generation.
  const moveFix = (id, fix) => {
    const m = dex.data.Moves[id];
    if (!m) return;
    dex.data.Moves[id] = { ...m, ...fix, ...(fix.flags ? { flags: { ...m.flags, ...fix.flags } } : {}) };
  };
  moveFix('slash', { basePower: 80 });
  moveFix('meteorassault', { basePower: 170 });
  moveFix('snipeshot', { basePower: 85 });
  moveFix('doubleshock', { flags: { punch: 1 } });
  moveFix('wish', { pp: 8 });
  moveFix('strengthsap', { pp: 8 });
  moveFix('milkdrink', { target: 'adjacentAllyOrSelf' });
  dex.moves.moveCache?.clear?.();
  const applied = [];
  const setAbility = (id, ability) => {
    const entry = dex.data.Pokedex[id];
    if (!entry) return;
    // A copy: a mod's data table shares entry objects with its parent generation.
    dex.data.Pokedex[id] = { ...entry, abilities: { 0: ability } };
    applied.push(`${entry.name} = ${ability}`);
  };
  const fixes = { absolmegaz: 'Sharpness', garchompmegaz: 'Levitate', lucariomegaz: 'Aura Guard',
    salamencemega: 'Aerilate', golisopodmega: 'Tough Claws', baxcaliburmega: 'Thermal Exchange' };
  for (const [id, ability] of Object.entries(fixes)) setAbility(id, ability);
  for (const [toolkitId, choice] of Object.entries(overrides)) {
    const ability = Array.isArray(choice) ? choice[0] : choice;
    if (toolkitId.startsWith('_') || !ability) continue;
    // Toolkit ids are the engine's ids with dashes ("absol-mega-z" -> absolmegaz);
    // Floette's mega drops the "eternal" the toolkit keeps.
    const id = [toID(toolkitId), toID(toolkitId).replace('eternal', '')].find((x) => dex.data.Pokedex[x]);
    const ab = dex.abilities.get(String(ability));
    if (!id) { console.warn(`[abilities] override for unknown species "${toolkitId}" ignored`); continue; }
    if (!ab.exists) { console.warn(`[abilities] "${ability}" (${toolkitId}) is not an ability this engine knows; ignored`); continue; }
    setAbility(id, ab.name);
  }
  dex.species.speciesCache?.clear?.();
  return applied;
}

import { toID, parsePos, parseHP, speciesFromDetails, newState, applyLine, syncOwnSide } from './protocol.mjs';
import { decide as smartDecide, pressure } from './bot.mjs';
import { runLab, BUDGETS } from './lab.mjs';

// Matchup Lab jobs: {id, status: running|done|stopped|error, progress, results, error}.
const labs = new Map();

function parseTeam(input) {
  // Accepts a Showdown paste, a packed string, or an array of set objects.
  if (Array.isArray(input)) return input;
  const text = aliasStones(String(input || '').trim());
  if (!text) return [];
  if (text.includes('\n') || text.includes('@') || text.includes('Ability:')) {
    return Teams.import(text) || [];
  }
  return Teams.unpack(text) || [];
}

// Champions megas are brought as the base form holding the stone; the toolkit's
// paste exporter names the mega species, so map it back. Returns problems.
export function normalizeTeam(team, formatid) {
  const dex = Dex.forFormat(resolveFormat(formatid));
  const problems = [];
  for (const set of team) {
    const sp = dex.species.get(set.species);
    if (!sp.exists) { problems.push(`Unknown species "${set.species}" in ${formatid}`); continue; }
    if (sp.isMega || /-Mega/.test(sp.name)) {
      if (!set.item && sp.requiredItem) set.item = sp.requiredItem;
      // The stone says which forme it evolves (Floettite: Floette-Eternal -> Floette-Mega);
      // the plain base species is not always the legal one.
      const stone = dex.items.get(set.item);
      const from = stone.exists && stone.megaStone && typeof stone.megaStone === 'object'
        ? Object.keys(stone.megaStone).find((k) => stone.megaStone[k] === sp.name) : null;
      set.species = from || sp.baseSpecies;
      // The toolkit's paste carries the mega's ability. In battle the Pokémon
      // keeps a base-form ability until it Mega Evolves (Intimidate Staraptor ->
      // Contrary Mega Staraptor); the engine applies the mega's ability from
      // species data at that moment, so give the set a base-form one here.
      const base = dex.species.get(set.species);
      const own = Object.values(base.abilities || {});
      if (own.length && !own.some((a) => toID(a) === toID(set.ability))) set.ability = own[0];
    }
    if (!set.level) set.level = 50;
  }
  return problems;
}

export function validateTeam(formatid, team) {
  try {
    const validator = new TeamValidator(resolveFormat(formatid));
    return validator.validateTeam(team);
  } catch (e) {
    return [`validator error: ${e.message}`];
  }
}

// ---------------------------------------------------------------- the bot
// "smart":   bot.mjs — a fair one-turn evaluator: real damage estimates, KO and
//            speed awareness, Protect odds, spread-move partner safety, status
//            move heuristics, Mega Evolution, matchup-based switches and picks.
// "random":  legal random choices, always Mega Evolves when it can.
// "default": Showdown's built-in default choice (first legal option).
export const BOT_MODES = ['smart', 'random', 'default'];
export const normalizeBot = (b) => (b === 'greedy' ? 'smart' : BOT_MODES.includes(b) ? b : 'smart');

function botChoice(req, mode) {
  if (!req || req.wait) return null;
  if (mode === 'default') return 'default';
  if (req.teamPreview) {
    const n = req.maxChosenTeamSize || Math.min(4, req.side.pokemon.length);
    const order = req.side.pokemon.map((_, i) => i + 1).sort(() => Math.random() - 0.5);
    return `team ${order.slice(0, n).join('')}`;
  }
  if (req.forceSwitch) {
    const used = new Set();
    return req.forceSwitch.map((must, i) => {
      if (!must) return 'pass';
      const bench = req.side.pokemon
        .map((p, idx) => ({ p, idx }))
        .filter(({ p, idx }) => !p.active && !p.condition.endsWith(' fnt') && !used.has(idx));
      if (!bench.length) return 'pass';
      const pick = bench[Math.floor(Math.random() * bench.length)];
      used.add(pick.idx);
      return `switch ${pick.idx + 1}`;
    }).join(', ');
  }
  if (req.active) {
    let megaUsed = false;
    return req.active.map((a, i) => {
      const mon = req.side.pokemon[i];
      if (!a || (mon && mon.condition.endsWith(' fnt'))) return 'pass';
      const legal = a.moves.map((m, idx) => ({ m, idx })).filter(({ m }) => !m.disabled);
      if (!legal.length) return 'move 1';
      const { m, idx } = legal[Math.floor(Math.random() * legal.length)];
      let target = '';
      if (['normal', 'any', 'adjacentFoe'].includes(m.target)) target = ` ${1 + Math.floor(Math.random() * 2)}`;
      else if (m.target === 'adjacentAlly') target = ` -${i === 0 ? 2 : 1}`;
      else if (m.target === 'adjacentAllyOrSelf') target = ` -${i + 1}`;
      const mega = a.canMegaEvo && !megaUsed ? (megaUsed = true, ' mega') : '';
      return `move ${idx + 1}${target}${mega}`;
    }).join(', ');
  }
  return 'default';
}

// ---------------------------------------------------------------- battle
export class Battle {
  constructor({ format, p1, p2, bot, seed }) {
    this.id = randomUUID().slice(0, 8);
    this.format = format || DEFAULT_FORMAT;
    this.bot = normalizeBot(bot);
    this.dex = Dex.forFormat(resolveFormat(this.format));
    this.stream = new BattleStream();
    this.streams = getPlayerStreams(this.stream);
    this.waiters = [];
    this.p2req = null;
    this.lastReq = null;   // p1's pending request, restored after an illegal choice
    this.state = newState({ id: this.id, format: this.format, bot: this.bot, p1Name: p1.name, p2Name: p2.name });
    // The bot's own view, reduced from p2's stream: exact for its side, percentages for yours.
    this.botView = newState({ id: this.id, format: this.format, bot: this.bot, p1Name: p1.name, p2Name: p2.name });
    // Open Team Sheets: the real format needs both players to accept a prompt
    // that only exists on the Showdown server; the bot always accepts, so
    // publish both sheets from the known teams (species/item/ability/moves).
    const rules = Dex.formats.getRuleTable(Dex.formats.get(resolveFormat(this.format)));
    if (rules.has('openteamsheets') || rules.has('forceopenteamsheets')) {
      const sheet = (team) => team.map((s) => ({
        species: s.species, item: s.item || '', ability: s.ability || '', moves: s.moves || [],
      }));
      this.state.sides.p1.sheet = sheet(p1.team);
      this.state.sides.p2.sheet = sheet(p2.team);
      this.botView.sides.p1.sheet = sheet(p1.team);
      this.botView.sides.p2.sheet = sheet(p2.team);
    }
    void this.pump(this.streams.omniscient, 'omni');
    void this.pump(this.streams.p1, 'p1');
    void this.pump(this.streams.p2, 'p2');
    const spec = { formatid: resolveFormat(this.format) };
    if (seed) spec.seed = seed;
    this.write(`>start ${JSON.stringify(spec)}`);
    this.write(`>player p1 ${JSON.stringify({ name: p1.name, team: Teams.pack(p1.team) })}`);
    this.write(`>player p2 ${JSON.stringify({ name: p2.name, team: Teams.pack(p2.team) })}`);
  }

  write(cmd) { this.streams.omniscient.write(cmd); }

  botChoice(req) {
    if (this.bot === 'smart') {
      try {
        const choice = smartDecide(req, this.botView, this.dex);
        if (choice) return choice;
      } catch (e) {
        console.warn(`[bot] ${e.stack || e.message}`);
      }
      return botChoice(req, 'random') || 'default';
    }
    return botChoice(req, this.bot) || 'default';
  }

  async pump(stream, who) {
    try {
      for await (const chunk of stream) {
        for (const line of String(chunk).split('\n')) this.onLine(who, line);
      }
    } catch (e) {
      this.state.errors.push(`${who} stream: ${e.message}`);
      this.notify();
    }
  }

  onLine(who, line) {
    if (!line) return;
    if (who === 'p2') {
      if (line.startsWith('|request|')) {
        const req = JSON.parse(line.slice(9) || 'null');
        if (req) syncOwnSide(this.botView, req.side);
        if (req && !req.wait) {
          this.p2req = req;
          this.write(`>p2 ${this.botChoice(req)}`);
        }
      } else if (line.startsWith('|error|')) {
        // Bot made an illegal choice: fall back to the engine's default.
        console.warn(`[bot] illegal choice, using default: ${line.slice(7, 200)}`);
        this.write('>p2 default');
      } else {
        applyLine(this.botView, line);
      }
      return;
    }
    if (who === 'omni') {
      if (line.startsWith('|error|')) { this.state.errors.push(line.slice(7)); this.notify(); }
      return;
    }
    // ---- p1: the human's view ----
    if (line.startsWith('|request|')) {
      const req = JSON.parse(line.slice(9) || 'null');
      if (!req) return;
      this.syncOwnSide(req.side);
      if (req.wait) { this.state.request = null; return; }
      this.lastReq = req;
      this.state.request = req;
      this.state.teamPreview = req.teamPreview ? { pick: req.maxChosenTeamSize || 4 } : null;
      this.notify();
      return;
    }
    if (line.startsWith('|error|')) {
      this.state.errors.push(line.slice(7));
      this.state.request = this.lastReq;   // the engine still expects a choice
      this.notify();
      return;
    }
    this.reduce(line);
    this.state.log.push(line);
  }

  syncOwnSide(side) { syncOwnSide(this.state, side); }

  reduce(line) {
    // Open Team Sheets: the opponent's full six (species/item/ability/moves).
    const sheet = /^\|showteam\|(p[12])\|(.*)$/.exec(line);
    if (sheet && this.state.sides[sheet[1]]) {
      const sets = Teams.unpack(sheet[2]) || [];
      this.state.sides[sheet[1]].sheet = sets.map((s) => ({
        species: s.species, item: s.item || '', ability: s.ability || '', moves: s.moves || [],
      }));
    }
    if (applyLine(this.state, line).ended) this.notify();
  }

  // Resolve everyone waiting for the next p1 request / battle end / error.
  // State plus authoritative timers read from the engine (the UI shows
  // "N turns left" for weather / terrain / Trick Room / Tailwind ...).
  snapshot() {
    const b = this.stream.battle;
    if (b && b.field) {
      const name = (id) => (id ? (this.dex.conditions.get(id).name || String(id)) : null);
      const f = b.field;
      this.state.fieldTimers = {
        turn: b.turn,
        weather: f.weather ? { name: name(f.weather), turns: f.weatherState?.duration ?? null } : null,
        terrain: f.terrain ? { name: name(f.terrain), turns: f.terrainState?.duration ?? null } : null,
        pseudo: Object.values(f.pseudoWeather || {}).map((pw) => ({ name: name(pw.id), turns: pw.duration ?? null })),
        sides: Object.fromEntries(b.sides.map((s) => [s.id, Object.values(s.sideConditions || {})
          .map((sc) => ({ name: name(sc.id), turns: sc.duration ?? null, layers: sc.layers ?? null }))])),
      };
    }
    return this.state;
  }

  notify() {
    const ws = this.waiters; this.waiters = [];
    for (const w of ws) w();
  }

  nextEvent(timeoutMs = 8000) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      this.waiters.push(() => { clearTimeout(t); resolve(); });
    });
  }

  async choose(choice) {
    const before = this.state.errors.length;
    const pendingTurn = this.state.turn;
    this.state.request = null;
    this.write(`>p1 ${choice}`);
    // Wait until the engine hands p1 a new request, ends the battle, or
    // rejects the choice.
    await this.nextEvent();
    return { ok: this.state.errors.length === before, turnBefore: pendingTurn };
  }
}

// ---------------------------------------------------------------- http
function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(data);
}

function readJSON(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 5e6) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function championsFormats() {
  return Dex.formats.all()
    .filter((f) => /Champions/i.test(f.name))
    .map((f) => ({ id: f.id, name: f.name, gameType: f.gameType, mod: f.mod }))
    .concat(Object.values(SYNTHETIC_FORMATS).map(({ formatid, ...rest }) => rest));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (req.method === 'GET' && url.pathname === '/sim/formats') return send(res, 200, championsFormats());
    if (req.method === 'GET' && url.pathname === '/sim/health') {
      // `bots` lets the UI detect a sidecar running older code than it expects.
      return send(res, 200, { ok: true, engine: 'pokemon-showdown', version: 3, bots: BOT_MODES, formats: championsFormats().length, lab: Object.keys(BUDGETS) });
    }
    if (req.method === 'POST' && url.pathname === '/sim/validate') {
      const body = await readJSON(req);
      const team = parseTeam(body.paste ?? body.team);
      if (!team.length) return send(res, 400, { problems: ['Could not parse the team paste.'], team: [] });
      const fmt = body.format || DEFAULT_FORMAT;
      const norm = normalizeTeam(team, fmt);
      if (norm.length) return send(res, 200, { problems: norm, team });
      return send(res, 200, { problems: validateTeam(fmt, team), team });
    }
    if (req.method === 'POST' && url.pathname === '/sim/lab') {
      const body = await readJSON(req);
      const format = body.format || DEFAULT_FORMAT;
      patchChampionsData();
      const p1 = { name: 'You', team: parseTeam(body.p1?.paste ?? body.p1?.team) };
      const p2 = { name: 'Them', team: parseTeam(body.p2?.paste ?? body.p2?.team) };
      for (const [who, p] of [['p1', p1], ['p2', p2]]) {
        if (p.team.length < 4) return send(res, 400, { error: `${who}: the lab needs at least four Pokemon with moves` });
        const problems = normalizeTeam(p.team, format).concat(validateTeam(format, p.team) || []);
        if (problems.length) return send(res, 400, { error: `${who}: team is not legal in ${format}`, problems });
      }
      const budget = BUDGETS[body.budget] ? body.budget : 'standard';
      const job = { id: randomUUID().slice(0, 8), status: 'running', progress: { done: 0, total: 0, phase: 'starting', seconds: 0 }, results: null, error: null, stop: false, started: Date.now() };
      labs.set(job.id, job);
      // Keep the map small: forget finished jobs older than an hour.
      for (const [id, j] of labs) if (j.status !== 'running' && Date.now() - j.started > 3600e3) labs.delete(id);
      runLab({
        formatid: resolveFormat(format), dex: Dex.forFormat(resolveFormat(format)), p1, p2, budget,
        oppLeadPct: Array.isArray(body.oppLeadPct) ? body.oppLeadPct : null,
        seed: Number.isFinite(body.seed) ? body.seed : undefined,
        shouldStop: () => job.stop,
      }, (p) => { job.progress = p; })
        .then((results) => { job.status = results ? 'done' : 'stopped'; job.results = results && { ...results, formatid: format }; })
        .catch((e) => { job.status = 'error'; job.error = e.message; console.warn(`[lab] ${e.stack || e.message}`); });
      return send(res, 200, { id: job.id, status: job.status, budget });
    }
    const lab = /^\/sim\/lab\/([a-z0-9-]+)$/.exec(url.pathname);
    if (lab) {
      const job = labs.get(lab[1]);
      if (!job) return send(res, 404, { error: 'no such lab' });
      if (req.method === 'DELETE') { job.stop = true; return send(res, 200, { ok: true }); }
      return send(res, 200, { id: job.id, status: job.status, progress: job.progress, results: job.results, error: job.error });
    }
    if (req.method === 'POST' && url.pathname === '/sim/battle') {
      const body = await readJSON(req);
      const format = body.format || DEFAULT_FORMAT;
      patchChampionsData();   // ability choices made in the Team Builder since startup
      const p1 = { name: body.p1?.name || 'You', team: parseTeam(body.p1?.paste ?? body.p1?.team) };
      const p2 = { name: body.p2?.name || 'Bot', team: parseTeam(body.p2?.paste ?? body.p2?.team) };
      for (const [who, p] of [['p1', p1], ['p2', p2]]) {
        if (!p.team.length) return send(res, 400, { error: `${who}: could not parse team` });
        const problems = normalizeTeam(p.team, format).concat(validateTeam(format, p.team) || []);
        if (!problems.length) continue;
        if (problems) return send(res, 400, { error: `${who}: team is not legal in ${format}`, problems });
      }
      const battle = new Battle({ format, p1, p2, bot: body.bot, seed: body.seed });
      battles.set(battle.id, battle);
      await battle.nextEvent(5000);            // first request (team preview)
      await new Promise((r) => setTimeout(r, 80));   // let |poke| / |showteam| lines land too
      return send(res, 200, battle.snapshot());
    }
    const m = /^\/sim\/battle\/([a-z0-9-]+)(?:\/(choice|pressure))?$/.exec(url.pathname);
    if (m) {
      const battle = battles.get(m[1]);
      if (!battle) return send(res, 404, { error: 'no such battle' });
      if (req.method === 'GET' && m[2] === 'pressure') {
        // The playbook's three questions for this turn, from the human's point of view.
        try { return send(res, 200, pressure(battle.state, battle.dex, 'p1')); } catch (e) { return send(res, 500, { error: e.message }); }
      }
      if (req.method === 'GET') return send(res, 200, battle.snapshot());
      if (req.method === 'POST' && m[2] === 'choice') {
        const body = await readJSON(req);
        if (!body.choice) return send(res, 400, { error: 'choice required' });
        const r = await battle.choose(String(body.choice));
        return send(res, r.ok ? 200 : 422, battle.snapshot());
      }
      if (req.method === 'DELETE') { battles.delete(m[1]); return send(res, 200, { ok: true }); }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const patched = patchChampionsData();
  server.listen(PORT, '127.0.0.1', () => {
    const n = championsFormats().length;
    console.log(`sim sidecar on http://127.0.0.1:${PORT}  (pokemon-showdown; ${n} Champions formats; default ${DEFAULT_FORMAT})`);
    console.log(`engine abilities patched (confirmed M-C data + ability_overrides.json): ${patched.join(', ')}`);
  });
}
