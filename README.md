# Champions VGC Toolkit

An all-in-one analysis tool for competitive Pokémon Champions VGC: team
building, damage calculation, speed tiers, SP spread optimization, and
matchup flaw detection. Python (FastAPI) backend with a web UI.

Built both as a practical tool and as a readable reference — every game
formula lives in `vgc_toolkit/core/` as a documented pure function, so the
codebase doubles as an explanation of how Champions' battle math works.

## The SP system in one paragraph

Champions fixes every Pokémon at **Level 50 with 31 IVs** in all stats.
Customization comes from **SP**: 0–32 per stat, **66 total**. Each SP is
worth 8 EVs in the classic stat formula, which works out to exactly
**+1 final stat point per SP** at Level 50. **Alignments** are Champions'
natures: +10% to one stat, −10% to another, never HP (21 exist: every pairing
of the five stats plus the neutral `Serious`).

```
non-HP stat = floor( (floor((2·Base + 31 + 2·SP) · 50/100) + 5) · alignment )
HP          = floor( (2·Base + 31 + 2·SP) · 50/100 ) + 60
```

## Quickstart (using the tool today)

```bash
# from the project root (Windows: py instead of python)
python -m venv .venv
.venv\Scripts\activate            # Windows; macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python -m pytest tests/           # 178 tests, all should pass
python -m uvicorn vgc_toolkit.main:app --reload
```

**Web UI** (two terminals from the project root):

```bash
# terminal 1 — backend
python -m uvicorn vgc_toolkit.main:app --reload
# terminal 2 — frontend dev server
cd frontend
npm install        # first time only
npm run dev
```

Open **http://localhost:5173** — Team Builder, Damage Calc, Threat Scan, and
Team Preview tabs. The Team Builder keeps a **team library** in the browser:
"My teams" saves named copies of your team, and **"Opponent team"** imports the
team you are calcing against from a paste (nicknames such as
`Kids (Kingambit) @ Black Glasses`, gender markers and Shiny lines are fine)
and shows it with icons; both kinds can be saved and reloaded. The opponent
team feeds the Damage Calc (a strip above Pokémon 2 loads each set), the Team
Preview tab ("Load a team…" lists it and every saved team, analysed with their
real sets instead of ladder guesses) and the Battle tab's opponent picker. The **regulation selector** in the header (M-B or M-C;
defaults to the newest) drives the roster, team validation, and every
threat/speed scan. Forms tagged `ability?` in the Pokémon picker have no
announced Champions ability yet — open them in the Team Builder to set one. (For a single-process deployment,
`npm run build` in frontend/ makes the backend serve the UI itself at
http://127.0.0.1:8000.)

`npm run build` first runs `npm run lint` (`frontend/scripts/check-undef.cjs`),
which fails on any identifier that is used but never declared. Vite bundles
those silently and React only reveals them as a blank tab at runtime, so run
`npm run lint` after editing components even when you are only using the dev
server.

The Swagger page at **http://127.0.0.1:8000/docs** remains available for raw
API access. Or use it straight from Python:

```python
from vgc_toolkit.core.damage import Combatant, Field, calculate, describe
from vgc_toolkit.core.matchup import threat_scan
from vgc_toolkit.core.stats import SPSpread

me = Combatant("skarmory-mega", spread=SPSpread(hp=32, def_=16),
               alignment="Impish", ability="Stalwart")
print(threat_scan(me)["top_threats"][:5])     # who beats my actual build?
```

## Fresh machine / moving the project

The repo is everything except the installed dependencies and your browser state.
On a new PC:

1. Install [Git](https://git-scm.com), **Python 3.12+** and **Node.js LTS** (Node 18+; the
   project was developed on Node 24).
2. `git clone https://github.com/<you>/VGC-Toolkit.git` and `cd VGC-Toolkit`.
3. Windows: run `.\setup.ps1` once (creates `.venv`, installs the Python requirements, runs
   `npm install` in `frontend/` and `sim/`, then the tests), then `.\dev.ps1` every time you
   want to work — it opens three windows: backend on 8000, Showdown sidecar on 8001,
   Vite on 5173 — and open http://localhost:5173. If PowerShell refuses to run scripts:
   `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
   macOS / Linux: the same three commands by hand (`python3 -m venv .venv && source
   .venv/bin/activate && pip install -r requirements.txt`, `npm install` in `frontend/` and
   `sim/`, then `python -m uvicorn vgc_toolkit.main:app --reload`, `npm start` in `sim/`,
   `npm run dev` in `frontend/`).

What does **not** travel with the repo: teams saved in the Team Builder, the Battle tab's
setup and the active battle live in the browser's local storage. Export teams as pastes
(Team Builder → "Import / export paste") or keep them in `teams/`; the sidecar's
`node_modules` (pokemon-showdown, ~180 MB) is reinstalled by `npm install` from the pinned
`package-lock.json`. `vgc_toolkit/data/ability_overrides.json` (your provisional-ability
choices) is data and is committed.

## Project structure

```
vgc-toolkit/
├── scripts/                  # data pipeline (re-runnable)
│   ├── ingest_roster.py      # champions-speed-calc JS roster -> pokedex.json
│   ├── ingest_items.py       # items_list.csv -> items.json (+ mechanics tags)
│   └── build_type_chart.py   # canonical 18-type chart -> type_chart.json
├── vgc_toolkit/
│   ├── data/                 # generated canonical JSON (committed)
│   ├── core/                 # pure game logic — no I/O, fully tested
│   │   ├── stats.py          # SP system: spreads, alignments, stat stages
│   │   └── dataio.py         # cached data loaders, type effectiveness
│   ├── api/routes.py         # FastAPI endpoints
│   └── main.py               # app entrypoint (serves frontend/dist if built)
└── tests/
```

## Meta sets (ladder usage data)

`vgc_toolkit/data/meta_sets.json` carries real Showdown ladder sets
(spreads arrive in native SP). Smogon publishes each month's stats a few
days into the next month. To refresh, download the chaos files from
`https://www.smogon.com/stats/<YYYY-MM>/chaos/` for the current
`gen9championsvgc2026reg<XX>` and `...reg<XX>bo3` formats at the 1760
cutoff (they ship gzipped — decompress first), then:

```bash
python scripts/ingest_meta_sets.py regmb-1760.json regmbbo3-1760.json \
    --regulation M-B --label "2026-08 ladder 1760+"
```

`--regulation` defaults to the newest tag in `pokedex.json`, and the script
refuses to write a file with zero Pokemon, so a mistyped tag can't wipe the
data. The UI shows the snapshot's regulation beside its label and flags it
(⚠) only when it is two or more regulations behind the selected one; one
behind, e.g. M-B data while M-C's ladder has not run yet, is simply labelled.
Current snapshot: 2026-08 M-B (regmb + regmbbo3, 1760 cutoff, 1.45M battles),
66 Pokemon / 198 sets. Powers the Threat Scan "Meta sets"
mode, the Damage Calc meta-set dropdown, and Team Preview set resolution.

## Wolfe's playbook in the toolkit

`docs`-free version of the notes in *Wolfe's VGC Playbook* (Wolfe Glick's course,
compiled for Champions) is wired into three places:

- **Team Builder → "Wolfe's playbook check"** (`POST /api/team/playbook`,
  `vgc_toolkit/core/playbook.py`): the Appendix C worksheet as live checks with
  pass / warn / fail and the reasoning: composition (4 damage dealers, 1-2
  support, 1-2 Megas), the speed-control plan and its backups (Trick Room,
  Tailwind, priority, Scarf, speed drops, paralysis, natural speed) with the
  Hard Trick Room recipe (two setters, Fake Out blocker, redirection, Taunt
  answer, what plays without the room) and the Tailwind recipe (a Trick Room
  answer), offensive synergy (80+/90+ BP STAB, 165+ attacking stat with
  Huge Power / Adaptability style modifiers, physical/special mix, what resists
  every attacking type), defensive synergy (at most two of a type, a resistance
  to every type, two to the top threats' attacking types, stacked weaknesses,
  paper and Levitate-only resistances), items (item clause, 1-3 offensive
  items, Sash/Sitrus placement, berries that never activate, format tech),
  role-first movesets, spreads (SP budget, neutral natures, nature bumps,
  HP ~ Def + SpD) and a matchup pass against the ladder sets in
  `meta_sets.json` (two answers to every popular set, instant-loss detection,
  Trick Room / Fake Out / Prankster / weather awareness). "Copy worksheet"
  puts the filled-in Appendix C worksheet on the clipboard as Markdown.
- **Battle tab → turn read** (`GET /sim/battle/:id/pressure`): Wolfe's three
  questions for the turn from your point of view only — speed order (Trick
  Room, Tailwind, paralysis, Scarf aware), what each of yours threatens on each
  of theirs and what each of theirs threatens on yours (best move, damage
  range, KO chance). At team preview it ranks their six by the damage they
  threaten and lists your answers (aim for two). A **Turn read on/off** button
  in the battle header (also a checkbox on the setup screen) hides all of it,
  for practising the read yourself; the choice is remembered.
- **Team Preview tab** (`POST /api/matchup/team-preview`): your six against
  their six. Both sides load from the team library ("Load a team…" on the
  opponent side lists the Team Builder's imported opponent and every saved
  team; a select on your side swaps in a saved team of yours), and a
  Pokémon picked by hand is read from its ladder set. Their likely leads,
  your three best lead pairs and three fours to bring each come with the
  reasons: who outspeeds the projected leads, which move OHKOs whom, whose
  Fake Out lands first, how many of their six you hold two answers to, where
  the speed control comes from, stacked weaknesses, and why each benched
  Pokémon stays home. Only one Pokémon Mega Evolves per game, so a team
  carrying two Megas (a Mega form or a base form holding its stone) never
  gets both in a lead or a four; the card says which one evolves (✦).
- **Simulation lab** (bottom of the Team Preview tab; `POST /sim/lab` on the
  sidecar, `sim/lab.mjs`): real engine games, the sidecar bot playing both
  sides, between your six and theirs. Every legal lead + four of yours (one
  Mega at most) is played against the ways they are likely to pick (the bot's
  own matchup pick and picks sampled from their lead propensities), the
  contenders get more games as the weaker ones drop out, and the best are
  swept against each of their lead pairs. Every KO and every point of damage
  is attributed from the omniscient stream. The panel shows the certified
  lead with its record against each of their leads, the leads and fours
  ranked by the low end of a 95% interval, a simulated matchup grid (how
  often yours KOs theirs and the reverse), their Pokemon in threat order with
  your answers to each, your Pokemon's win rate brought versus benched (from
  the first round only, where every lead and four played the same number of
  times), and every lead pair of theirs ranked by how well it does for them. The ranking counts only games against
  their likely picks; the sweep (every lead pair of theirs equally) feeds the
  "if they lead" tables and is reported separately. Depth quick / standard /
  deep is roughly 400 / 750 / 1500 games; a game takes a few hundredths of a
  second. From a
  terminal, `node lab.cli.mjs my.txt their.txt standard` in `sim/` prints
  the same report for two pastes. Bot play is not human play: the numbers
  are evidence about the matchup, not its truth.
- **`teams/`**: `golisopod_hard_trick_room.txt` (paste) and `.md` (rationale,
  game plan, filled worksheet) — a Mega Golisopod Hard Trick Room team built
  with the procedure. `golisopod_swords_dance_room.txt` (Swords Dance Mega
  Golisopod behind Indeedee-F and Farigiraf, Araquanid rain) and
  `salamence_tailwind_mc.txt` (Mega Salamence Tailwind offense with Pawmot)
  and `salamence_grassy_mc.txt` (Salamence with Rillaboom, Grassy Seed
  Sneasler and a Raichu Y second mode) are the Regulation M-C playtest teams; import either in the Team
  Builder and save it to the library.

The calc also learned Heatproof, Water Bubble (both halves: Fire into the holder
halved and its own Water moves doubled, applied to the attacking stat as the
engine does, plus burn immunity; rolls checked against the engine), Purifying
Salt and Liquid Voice along the way.

## Themes

The header's **Theme** selector switches the whole UI between six palettes:
Navy (the original), Ember, Arena, Volt, Crimson and Daylight (light). The
choice is saved in the browser. Every surface colour in `frontend/src/styles.css`
is a token on `:root`, and each theme is a `:root[data-theme="name"]` block that
redefines them; type colours, the physical / special icons, weather and terrain
tints and the p1 / p2 side colours stay fixed because they carry meaning. To add
a theme, copy a block, change the values, and add the name to `THEMES` in
`App.jsx`.

## Battle tab (Showdown simulator + practice bot)

The **Battle** tab runs real battles on the actual Pokémon Showdown engine
(`pokemon-showdown` npm package, which ships the `champions` mod and the
"[Gen 9 Champions] VGC 2026 Reg M-B" doubles format) through a small Node
sidecar in `sim/`. You are always p1; p2 is a built-in bot. Third terminal:

```bash
cd sim
npm install      # first time only (pokemon-showdown, ~140 MB unpacked)
npm start        # http://127.0.0.1:8001 — the Vite dev server proxies /sim to it
```

Flow: your team comes from the Team Builder, a saved team or a paste; the opponent is a
**coherent ladder team** from `meta_sets.json` (`GET /api/meta/random-team`:
a usage-weighted seed, then partners chosen by how often they actually appear
alongside the members so far, from the chaos "Teammates" data the ingest now
keeps; species and item clauses respected), a paste, the Team Builder's opponent
team or a saved team (any opponent paste can be saved to the library from here); the
sidecar normalises megas to base form + stone and runs Showdown's team
validator for the chosen format, so illegal sets are reported before the
battle starts. Team preview (the opponent's six with their open team sheets, since the
format runs Open Team Sheets; pick your 4 in lead order), then a stage laid out
like the games: your two Pokémon bottom-left as back sprites, the opponent's
top-right, each under a status plate with its HP bar (exact for your side, %
for theirs), status, colour-coded stat stages (green up, red down) and revealed
item / ability; weather/terrain/side conditions; per-slot move buttons tinted
by the move's live type (Aerilate, Pixilate, Liquid Voice, Weather Ball) with
PP; doubles targeting by clicking the target on the field (spread moves need
no aim; the small target buttons remain as a fallback), Mega Evolution,
switches and forced replacements, and a plain-English battle log. Each turn
replays action by action (attack / hit animations, an ordered banner: 1st, 2nd,
…, with a Skip button) using the sidecar's own protocol reducer client-side, so
the replay always lands on the server's state; the log is grouped per turn:
actions (moves, switches, faints) are larger with the acting side's colour on
the left edge, their consequences (damage, effectiveness, status, boosts) are
indented and quieter, your Pokémon are blue and the opponent's red, and every
HP line reads number + coloured percentage + change since that slot's last
line (`Golisopod 149/182 82% −33`, `Garchomp 72% −28%`); a side strip
shows weather, terrain, Trick Room and Tailwind with turns left (read from the
engine) and tints the field; Weather Ball and Normal moves under an -ate ability
display their live type; selected moves fill their button and a plan card
summarises both actions before Confirm. The running
battle, the setup screen and the active tab survive a page refresh (the battle
itself lives in the sidecar, so restarting the sidecar ends it). Tab render
errors are caught by an error boundary instead of blanking the page. Bots:
`smart` (default, `sim/bot.mjs`) is a fair one-turn evaluator that only uses
what a player sees under Open Team Sheets. It estimates every move with a
compact Gen 9 damage formula (stats, items, abilities, weather, terrain,
screens, spread), values KOs and speed order, scores both of its actions
jointly (no overkill on one target, no Earthquake into its own non-immune
partner, Helping Hand / Follow Me / Fake Out synergy), predicts the damage it
takes back this turn and uses Protect with the real consecutive-use odds
(1/3, then 1/9, ...), plus hand-written values for Trick Room, Tailwind,
screens, status, setup and healing moves; it Mega Evolves (the permanent stat
gain is credited with a bonus the one-turn evaluator would otherwise miss, so
it evolves unless doing so walks into a KO that turn; Contrary is understood),
switches out of bad matchups and picks its four at Team Preview by matchup,
always bringing its Mega Stone holder (with two on the team, the one the
matchup favours; the other usually stays home). `random` (legal random
choices) and `default` (Showdown's first legal option) remain. Your own move
buttons warn when a Protect-family move is on a streak ("33% chance") or when
Fake Out / First Impression would fail. The setup screen warns when the sidecar
is running older code than the UI (`/sim/health` lists the bot ids it knows);
an old sidecar plays random moves for a bot id it does not recognise. `npm test` in `sim/` unit-tests the
protocol reducer and the bot's decisions (the bot and engine tests need
`npm install`); `npm run smoke` (both servers up) plays a bot-vs-bot battle
through the HTTP API end to end. State is reduced from p1's protocol stream,
so the UI never sees more than a real player would.

**Regulation M-C in the simulator.** The engine build (July 2026) has no
M-C format, so the sidecar exposes a provisional one,
`gen9championsvgc2026regmc` = the M-B doubles format with Showdown's
"Obtainable" legality checks (species availability, learnsets) switched off;
Species Clause, Item Clause, Level 50, Team Preview and pick-4 stay in force.
The `champions` mod carries every Gen 9 species, item and move as "Past",
which the switched-off checks unlock, so all 33 M-C additions and the new
items (Leek, Rocky Helmet, Air Balloon, Red Card, Binding Band, Eject Button,
Normal Gem, Terrain Extender, the four terrain Seeds) work as in the game. The
Battle tab picks the format automatically when the header's regulation
selector says M-C. The build predates the release itself, so the sidecar
patches the loaded mod at startup and again whenever a battle starts: the six
new megas' abilities (Mega Absol Z Sharpness, Mega Garchomp Z Levitate, Mega
Lucario Z Aura Guard, implemented as "halve damage taken from contact moves",
Mega Salamence Aerilate, Mega Golisopod Tough Claws, Mega Baxcalibur Thermal
Exchange), Run Away as an in-battle ability (the holder can always switch
out), and the M-C move changes (Slash 80 BP, Meteor Assault 170, Snipe Shot
85, Double Shock a punch, Wish and Strength Sap 8 PP, Milk Drink usable on the
ally), plus any `ability_overrides.json` choice for a still-unannounced form.
`sim/engine.test.mjs` validates a release team in the provisional format,
checks every patched value, and plays a doubles turn with Psychic Surge, a
Psychic Seed and an Air Balloon. A mega set's paste names the mega's ability;
the sidecar gives the base form one of its own abilities until it Mega
Evolves (Intimidate Staraptor → Contrary Mega Staraptor), as in the game. The
champions mod also tags the opponent's HP with a bar-colour letter at exactly
50% and 20% (`50/100g`); the reducer and the log strip it. Two stone names
differ upstream and are aliased on import (Golisopodite -> Golisopite,
Baxcaliburite -> Baxcalibrite). Bot teams come from the M-B ladder sets until
M-C usage stats exist; ingest those with `ingest_meta_sets.py --regulation
M-C` and the bot follows. When Showdown ships a real M-C format, drop the
synthetic entry in `sim/server.mjs`.

## Data pipeline

Game data originates in the `champions-speed-calc` repo (roster, alignments,
speed abilities) and an items CSV. Scripts convert those sources to canonical
JSON — never edit `vgc_toolkit/data/*.json` by hand; fix the source and re-run:

```bash
python scripts/ingest_roster.py \
    --pokemon ../champions-speed-calc/src/data/pokemon.js \
    --abilities ../champions-speed-calc/src/data/abilities.js   # alignments + speed abilities
python scripts/build_type_chart.py
python scripts/ingest_learnsets.py --html sheet.html             # roster source of truth
npm install @pkmn/dex
node scripts/dump_gen9_species.mjs > gen9_species.json   # NOTE: this dumper is not yet committed — restore it before re-running the pipeline
python scripts/ingest_megas_tab.py --html megas_sheet.html       # datamined megas
python scripts/build_pokedex.py --species gen9_species.json \
    --pokemon ../champions-speed-calc/src/data/pokemon.js \
    --megas vgc_toolkit/data/megas_tab.json --regulation M-B
python scripts/ingest_items.py --csv items_list.csv              # after pokedex (stone links)
python scripts/export_speedcalc_roster.py \
    --out ../champions-speed-calc/src/data/pokemon.js            # sync the speed calc app
node scripts/dump_gen9_moves.mjs > gen9_moves.json
python scripts/build_moves.py --baseline gen9_moves.json
python scripts/fill_weights.py                                   # weight_kg for every form (Low Kick, Grass Knot,
                                                                 # Heavy Slam, Heat Crash), from the engine in sim/
```

**Roster membership comes from the Learnset sheet** — a Pokemon is M-B legal
iff it has a learnset row; megas are legal iff their base form is and their
stone exists. Stats/types/abilities baseline comes from `@pkmn/dex`, with the
speed-calc `pokemon.js` as a cross-check layer (every stat disagreement is
reported by `build_pokedex.py`) and the source for Champions-new mega entries.
A `--overrides` slot patches stats once the sheet's "Pokemon Ch." tab is
sourced. Forms not currently in the game are kept with an empty regulations
list.

Learnsets come from RoiDadadou's community datamine doc
["Data Comparative Champions"](https://docs.google.com/spreadsheets/d/1DeXjzohTUdKNERu6dsHsnznneva8MDJjglI3lqDLgm4)
(credit: [@lepenseuradimir](https://x.com/lepenseuradimir)). The move database
is a two-layer build: full Gen 9 definitions from `@pkmn/dex` as the baseline,
scoped to the 496 moves appearing in Champions learnsets, with a Champions
override file (`--overrides`) slot for the doc's New Moves / Move Ch. /
Moves Deleted tabs once those are sourced.

When a new regulation drops, re-run `build_pokedex.py --regulation <tag>`
(the flag is required). Tags are UNIONED per form against the committed
`pokedex.json`, and because Champions regulations carry over, every form
legal in an earlier set is also tagged with the new one — so the dex stays
regulation-aware (a form can be `["M-B", "M-C"]`) rather than overwritten.
The header's regulation selector and every backend default are derived from
the tags present in the data, so surfacing a new regulation needs no code
change.

**Regulation M-C (live since 2026-09-08).** Two additive, idempotent scripts
carry the regulation. `scripts/add_mc_forms.py` (run first, August 2026)
tagged every M-B form with M-C and added the publicly confirmed core:
Rillaboom, Salamence (+Mega), Golisopod (+Mega), Baxcalibur (+Mega), Mega
Absol Z, Mega Garchomp Z, Mega Lucario Z, their six Mega Stones and the two
signature moves no M-B Pokémon learned (Drum Beating, Glaive Rush).
`scripts/add_mc_release.py` applies the release itself and retired the
toolkit's "Reg M-C Experimental" predictions (tag `M-C-EXP`): the ones that
came true (Indeedee M/F, Pincurchin, Cinderace, Inteleon, the four terrain
Seeds) became plain M-C forms and items, the rest (Weezing, Galarian Weezing,
Dondozo, Tatsugiri, Mega Tatsugiri, Assault Vest, Choice Band, Choice Specs)
were removed with the moves only they used. It then added the other new
species from `scripts/mc_species.json` (Gen 8 + 9 mainline data dumped from
the sim's engine by `node scripts/dump_mc_species.mjs`; Gen 8 because
Champions keeps the Gen 8 TR moves SV dropped): Wigglytuff, Persian, Alolan
Persian, Farfetch'd, Mr. Mime, Swalot, Gogoat, Thievul, Toxtricity (Amped and
Low Key), Grapploct, Perrserker, Sirfetch'd, Arboliva, Pawmot, Squawkabilly
(Green and Yellow plumage, the two ability sets) and Mabosstiff; the moves the
pool lacked (Slash, usable again, Milk Drink, Meteor Assault, Double Shock,
Overdrive, Shift Gear, Octolock, Revival Blessing, Jaw Lock; Slash also
joined the learnset of every roster species that learns it); the M-C move
changes (Slash 70 → 80 BP, Meteor Assault 150 → 170, Snipe Shot 80 → 85,
Wish and Strength Sap 12 → 8 PP, Double Shock is a punching move, Milk Drink
can target the ally; Politoed lost Pound, Archaludon lost Mirror Coat and
Metal Burst); the confirmed abilities of all six new megas (Mega Golisopod
Tough Claws and Mega Baxcalibur Thermal Exchange joined the four known
before; `ability_overrides.json` is cleared of them); and the new held items,
scoped to M-C like the Seeds (`regulations: ["M-C"]`, so `/api/items?
regulation=` and the Team Builder offer them only there and validation
rejects them in M-B). The calc models Air Balloon (a Ground immunity that
Gravity or an Iron Ball removes, and no terrain effects on the holder),
Normal Gem (x1.3 on the first Normal move) and the Seeds (+1 Def / SpD while
the field's terrain matches); Leek carries a `crit_stage` tag for a later
crit option. Learnsets of the M-C species are **provisional**: their mainline
learnset intersected with the Champions move pool; re-run with
`--force-learnsets` once the Champions M-C learnsets are published. The
Team Builder's ability editor (`PUT /api/pokemon/{id}/abilities`,
`data/ability_overrides.json`) stays for any form Champions has not announced
an ability for. (`ingest_items.py` regenerates items.json from the doc and
would drop the hand-added stones and M-C items; re-run both scripts
afterwards to restore them.)

Current data: **343 forms (261 base + 82 megas)** — 310 legal in M-B, all
343 in M-C (the 33 additions carry only the M-C tag) — 21 alignments, 166
items (57 held, 81 mega stones — all linked, 28 berries; the 12 M-C items are
scoped to M-C), full 18×18 type chart, a weight for every form (Low Kick,
Grass Knot, Heavy Slam and Heat Crash compute their power from it; Heavy
Metal and Light Metal apply), **511 moves (all defined)**, learnsets for
every base species (megas share their base form's learnset; the 27 species
M-C added are provisional). The Megas tab of the comparative doc is the
authoritative layer for mega stats/types/abilities, including Champions-new
abilities (Mega Sol, Dragonize, Piercing Drill, Spicy Spray, ...).

## API

```
GET  /api/pokemon?regulation=M-C     # roster list (any tag; repeatable)
GET  /api/regulations                # tags present in the data (label, based_on) + default
GET  /api/pokemon/{id}               # full pokedex entry
GET  /api/abilities                  # every ability name in the data (override picker)
PUT  /api/pokemon/{id}/abilities     # set / clear a provisional ability override
GET  /api/typechart                  # full 18×18 type chart
GET  /api/alignments
GET  /api/items?category=mega_stone&regulation=M-C   # regulation scopes the pool (the items M-C added)
GET  /api/moves                      # full move database
GET  /api/moves/{name}
GET  /api/pokemon/{id}/learnset      # megas resolve to base form
GET  /api/meta/sets                  # ladder usage sets (meta data)
POST /api/stats                      # SP spread -> final stat block
POST /api/damage                     # full damage calc: 16 rolls, %, KO chances
POST /api/damage/best-moves          # rank attacker's learnset moves vs a defender
GET  /api/matchup/{id}/profile       # type matchups, ability-adjusted
POST /api/matchup/threats            # full-pool threat scan vs YOUR build
POST /api/matchup/threats/team       # full-pool threats vs your whole team (UI)
POST /api/matchup/team               # shared weaknesses, multi-member threats
POST /api/matchup/team-preview       # opponent team-preview analysis
POST /api/matchup/suggest            # suggested teammates
POST /api/matchup/signature-spikes   # a mon's field-boosted moves (weather/terrain)
POST /api/matchup/offense            # your build's offensive coverage vs the pool
POST /api/matchup/survive            # survival SP solve vs an attacker
POST /api/speed/tiers                # team-vs-pool speed ladder w/ field conditions
POST /api/team/validate              # full legality check (all clauses)
POST /api/team/import                # SP-format paste -> structured team
POST /api/team/export                # structured team -> shareable paste
```

Example stat calculation:

```bash
curl -X POST http://127.0.0.1:8000/api/stats \
  -H "Content-Type: application/json" \
  -d '{"pokemon_id": "charizard-mega-y",
       "spread": {"hp": 2, "spa": 32, "spe": 32},
       "alignment": "Timid"}'
```

## Verification

The stat engine mirrors the JS engine in `champions-speed-calc` with
identical floor semantics, and its outputs are cross-checked in tests
against independently published Champions speed tables (base 142 → 213
max speed, base 150 → 222).

## Roadmap

- [x] **Phase 1** — data pipeline, SP stat engine, pokedex API
- [x] **Phase 2a** — move database (Gen 9 baseline + learnsets, Champions overlay hooks)
- [x] **Phase 2a.1** — roster rebuild (Learnset sheet = legality source of truth)
- [x] **Phase 2a.2** — Megas tab layer + speed-calc roster export
- [x] **Phase 2b** — damage engine (exact Gen 9 integer math, Champions item
  pool, verified roll-for-roll against @smogon/calc on 18 reference matchups
  regenerable via `scripts/gen_damage_fixtures.mjs`)
- [x] **Phase 3** — speed tier engine: field-conditional ability multipliers,
  Choice Scarf, Tailwind, Trick Room ordering, and a team-vs-pool ladder
  merged into the Team Builder as a toggleable view
- [x] **Phase 4** — matchup analyzer (real-calc threat scans of the full
  legal pool in <1s, weather-setter awareness, practical move filtering,
  team-level shared weaknesses and multi-member threat flags)
- [x] **Phase 5** — team builder: validation (regulation legality, species
  clause with mega/forme collapse, item clause, learnset-checked moves,
  ability legality, stone-ownership checks) and Showdown-style SP paste
  import/export with exact round-tripping
- [x] **Phase 6** — React/Vite web UI: Team Builder (live validation, paste
  import/export, team analysis), Damage Calc (roll strip, KO chances, full
  field controls), Threat Scan (ranked full-pool table with speed flags)

## Damage engine notes

- Mechanics verified by exact 16-roll parity with @smogon/calc on real
  Champions matchups (spread, weather, crit, burn, screens at the doubles
  x2/3 value, stat stages, Body Press / Psyshock / Foul Play, type items,
  resist berries, Huge Power, Multiscale, Thick Fat, Filter, Friend Guard,
  snow/sand stat boosts, Adaptability).
- Terrain follows the Gen 8+ rules and is checked roll-for-roll against the
  engine (`tests/test_damage.py::TestTerrainMechanics`): x1.3 on a grounded
  user's Electric / Grass / Psychic moves, Misty halving Dragon into grounded
  targets, Grassy halving Earthquake / Bulldoze / Magnitude, Expanding Force
  (x1.5 and spread), Rising Voltage (x2 into grounded targets), Misty
  Explosion (x1.5), Terrain Pulse (type and 100 BP), Steel Roller failing
  without terrain, and Psychic Terrain blocking priority moves into grounded
  targets (the result is 0 with a note, so the Threat Scan stops listing Fake
  Out and Sucker Punch as threats while it is up). Grounding: Flying types and
  Levitate / Eelevate float; Gravity and Iron Ball ground. The Damage Calc's
  field panel and the Battle tab's field strip list each weather's and
  terrain's effects.
- Held items are data-driven from mechanics tags in `items.json` (curated
  maps in `scripts/ingest_items.py`; refresh with `python scripts/retag_items.py`
  after editing them, no CSV needed): type items (x1.2), Muscle Band / Wise
  Glasses (x1.1 by category), Metronome (pass `move_streak=N` for the Nth
  consecutive use), Life Orb (x1.3 plus a 10% recoil note), Expert Belt (x1.2
  on super-effective hits), resist berries, Focus Sash (no OHKO from full HP,
  single hits), Iron Ball (grounds the holder and halves Speed), Light Ball,
  Choice Scarf (Speed). Choice Band/Specs, Assault Vest and Eviolite are not in
  the Champions item pool.
- "-ate" abilities (Aerilate, Pixilate, Refrigerate, Galvanize) are modeled like
  Dragonize: the user's Normal moves take the ability's type at x1.2 and STAB is
  judged on the new type. Results carry the effective `type`, which the ranked
  move lists display.
- All five Champions-new abilities are modeled (mechanics confirmed
  2026-06-10 and 2026-09-03): Mega Sol (user's moves act under sun), Dragonize
  (Normal -> Dragon, x1.2, with STAB), Piercing Drill (1/4 damage through
  protection on contact), Spicy Spray (burns attackers; informational note),
  Aura Guard (halves damage taken from contact moves).
- Variable-BP moves (Gyro Ball, Low Kick, ...) accept `bp_override`;
  multi-hit moves accept `hits`. Results flag both when relevant.

## Known data questions

- The 18 mega stat disagreements were all adjudicated by the Megas tab in
  favor of the datamined baseline. Aegislash is resolved: Champions Shield
  forme has 150/150 defenses (first entry in champions_stat_overrides.json)
  and Blade forme (140/140 offenses) is a separate M-B entry for calcs.
- Mega Raichu X/Y entered the roster in Regulation M-B and are now M-B-legal
  (they were held back as untagged datamines under M-A).
- Three base-form ability typos were corrected directly in `pokedex.json`:
  Raichu's "Lighning Rod" → "Lightning Rod", and male Meowstic's "Infiltrato"
  → "Infiltrator" with the merged "Prankster Competitive" cell split to the
  male hidden ability "Prankster" (female Meowstic keeps "Competitive").
- The old combined `meowstic-mega` id is retired in favor of the datamined
  gendered pair `meowstic-m-mega` / `meowstic-f-mega` (identical stats).
- Eight mega stone names differ between the roster and items CSV (e.g.
  `Dragonitite` vs `Dragoninite`); bridged via an alias map in
  `scripts/ingest_items.py` pending canonical in-game spellings.
- The sheet's single `Tauros-Paldea` row is mapped to the Combat form;
  Blaze/Aqua learnsets differ in mainline and need confirmation.
- Three placeholder entries in the source roster are skipped during
  ingestion (`gardevoir-fem`, `mabosstiff-2`, `hydreigon-2`).
