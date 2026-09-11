"""Wolfe's VGC Playbook applied to a team.

Turns the teambuilding recipes, rules of thumb and the Appendix C worksheet of
"Wolfe's VGC Playbook" (notes on Wolfe Glick's competitive Pokemon course,
compiled 2026-09-05 for Pokemon Champions) into checks a team builder can run:

* composition (4 damage dealers, at most 2 support, 1-2 Megas)
* the speed-control plan (Trick Room, Tailwind, priority, natural speed,
  Choice Scarf, speed drops, paralysis) and what plays without it
* offensive synergy (80+/90+ base power STAB, 165+ attacking stat, physical /
  special mix, coverage, 2HKOs on the ladder's common sets)
* defensive synergy (at most 2 of a type, a resistance to every type, two to
  the top threats, stacked weaknesses, paper and Levitate-only resistances)
* items (item clause, 1-3 offensive items, Sash on frail / Sitrus on bulky,
  format tech) and role-first movesets
* spreads (SP budget, max-max default, HP ~ Def + SpD, nature bumps, neutral
  natures) and an archetype-aware matchup pass against meta_sets.json

Every rule can be broken for a good reason, so every check carries a status
(pass / warn / fail / info) and the reasoning behind it.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field as dc_field

from vgc_toolkit.core import dataio, matchup, stats
from vgc_toolkit.core.damage import Combatant, Field, calculate
from vgc_toolkit.core.teams import TeamMember, species_root

ALL_TYPES = ["Normal", "Fire", "Water", "Electric", "Grass", "Ice", "Fighting",
             "Poison", "Ground", "Flying", "Psychic", "Bug", "Rock", "Ghost",
             "Dragon", "Dark", "Steel", "Fairy"]

PROTECT_MOVES = {"Protect", "Detect", "Spiky Shield", "Baneful Bunker",
                 "King's Shield", "Silk Trap", "Burning Bulwark", "Obstruct"}
SETUP_MOVES = {"Swords Dance", "Nasty Plot", "Dragon Dance", "Calm Mind", "Bulk Up",
               "Iron Defense", "Shell Smash", "Quiver Dance", "Agility", "Coil",
               "Shift Gear", "Belly Drum", "Curse", "Work Up", "Growth", "Tidy Up",
               "Victory Dance", "Howl", "Amnesia", "Acid Armor", "Cosmic Power",
               "Geomancy", "Clangorous Soul", "Fillet Away", "No Retreat", "Hone Claws",
               "Meditate", "Autotomize", "Rock Polish", "Barrier", "Cotton Guard",
               "Stockpile", "Charge", "Focus Energy", "Defense Curl", "Harden", "Withdraw"}
RECOVERY_MOVES = {"Recover", "Roost", "Slack Off", "Soft-Boiled", "Milk Drink",
                  "Moonlight", "Morning Sun", "Synthesis", "Shore Up", "Rest",
                  "Strength Sap", "Wish", "Heal Order", "Substitute", "Endure"}
SPEED_DROP_MOVES = {"Icy Wind", "Electroweb", "Bulldoze", "Rock Tomb", "Mud Shot",
                    "Low Sweep", "Cotton Spore", "String Shot", "Scary Face",
                    "Drum Beating", "Pounce", "Glaciate", "Tar Shot", "Sticky Web"}
PARALYSIS_MOVES = {"Thunder Wave", "Glare", "Stun Spore", "Nuzzle", "Zap Cannon"}
REDIRECTION_MOVES = {"Follow Me", "Rage Powder"}
FAKE_OUT_BLOCKERS = {"Armor Tail", "Dazzling", "Queenly Majesty", "Psychic Surge"}
TAUNT_ANSWER_ABILITIES = {"Magic Bounce", "Oblivious", "Aroma Veil"}
TAUNT_ANSWER_ITEMS = {"Mental Herb"}
TRICK_ROOM_ANSWERS = {"Taunt", "Imprison", "Trick Room"}
SPEED_ABILITIES = {"Swift Swim": "rain", "Chlorophyll": "sun", "Sand Rush": "sand",
                   "Slush Rush": "snow", "Surge Surfer": "electric"}
WEATHER_SETTERS = {"Drizzle": "rain", "Drought": "sun", "Sand Stream": "sand",
                   "Snow Warning": "snow", "Orichalcum Pulse": "sun"}
WEATHER_MOVES = {"Rain Dance": "rain", "Sunny Day": "sun", "Sandstorm": "sand",
                 "Snowscape": "snow", "Chilly Reception": "snow"}
TERRAIN_SETTERS = {"Electric Surge": "electric", "Grassy Surge": "grassy",
                   "Psychic Surge": "psychic", "Misty Surge": "misty"}
# Abilities that multiply damage enough to excuse an attacking stat under 165.
DAMAGE_ABILITIES = {"Huge Power", "Pure Power", "Adaptability", "Sheer Force",
                    "Tough Claws", "Technician", "Strong Jaw", "Sharpness", "Iron Fist",
                    "Reckless", "Mega Launcher", "Guts", "Hustle", "Gorilla Tactics",
                    "Steelworker", "Dragon's Maw", "Transistor", "Rocky Payload",
                    "Water Bubble", "Sand Force", "Fairy Aura", "Dark Aura", "Aerilate",
                    "Pixilate", "Refrigerate", "Galvanize", "Solar Power", "Flash Fire",
                    "Supreme Overlord", "Protosynthesis", "Quark Drive", "Punk Rock",
                    "Stakeout", "Analytic"}
OFFENSIVE_ITEMS = {"Life Orb", "Choice Band", "Choice Specs", "Expert Belt",
                   "Muscle Band", "Wise Glasses", "Metronome", "Punching Glove",
                   "Throat Spray", "Weakness Policy", "Loaded Dice", "Light Ball",
                   "Thick Club"}
CHOICE_ITEMS = {"Choice Band", "Choice Specs", "Choice Scarf"}
FORMAT_TECH_ITEMS = {"Safety Goggles", "Rocky Helmet", "Covert Cloak", "Clear Amulet",
                     "Mental Herb", "Lum Berry", "Eject Button", "Red Card"}
FORMAT_TECH_MOVES = {"Haze", "Clear Smog", "Wide Guard", "Quick Guard", "Feint",
                     "Encore", "Taunt", "Imprison", "Ally Switch", "Snarl", "Struggle Bug"}
# Defensive multipliers the shared defensive_profile does not know about.
EXTRA_DEFENSE = {"Heatproof": {"Fire": 0.5}, "Water Bubble": {"Fire": 0.5},
                 "Purifying Salt": {"Ghost": 0.5}, "Fluffy": {"Fire": 2.0}}
ATE_ABILITIES = {"Pixilate": "Fairy", "Aerilate": "Flying", "Refrigerate": "Ice", "Galvanize": "Electric"}
STAT_DOUBLERS = {"Huge Power", "Pure Power"}
LEVITATE = "Levitate"
BULK_PAPER = 340       # HP + Def + SpD below this: a resistance on paper only
ATTACK_STAT_FLOOR = 165
BP_FLOOR, BP_GOOD = 80, 90


@dataclass
class Check:
    section: str
    id: str
    status: str          # pass | warn | fail | info
    title: str
    detail: str = ""
    source: str = ""     # playbook section, e.g. "1.4"


@dataclass
class Member:
    id: str
    name: str
    types: list[str]
    ability: str
    item: str
    alignment: str
    spread: dict
    stats: dict
    moves: list[str]
    combatant: Combatant
    damaging: list[dict] = dc_field(default_factory=list)
    support: list[str] = dc_field(default_factory=list)
    role: str = "offense"
    side: str | None = None
    attack_stat: int = 0
    is_mega: bool = False

    @property
    def bulk(self) -> int:
        return self.stats["hp"] + self.stats["def"] + self.stats["spd"]


# ---------------------------------------------------------------- members
def _resolve(member: TeamMember) -> Member:
    c = member.combatant
    mon, ability, final = c.resolve()
    move_db = dataio.moves()
    moves = [m for m in member.moves if m]
    damaging, support = [], []
    for name in moves:
        mv = move_db.get(name)
        if not mv:
            continue
        if mv["category"] != "Status" and name != "Fake Out":
            eff_type = mv["type"]
            if ability in ATE_ABILITIES and mv["type"] == "Normal":
                eff_type = ATE_ABILITIES[ability]
            elif ability == "Liquid Voice" and mv.get("flags", {}).get("sound"):
                eff_type = "Water"
            damaging.append({"name": name, **mv, "type": eff_type, "listed_type": mv["type"]})
        elif name not in PROTECT_MOVES and name not in SETUP_MOVES and name not in RECOVERY_MOVES:
            support.append(name)
    phys = [d for d in damaging if d["category"] == "Physical"]
    spec = [d for d in damaging if d["category"] == "Special"]
    side = "Physical" if phys and not spec else "Special" if spec and not phys else "Mixed" if damaging else None
    attack_stat = max(final["atk"] if phys else 0, final["spa"] if spec else 0) if damaging else 0
    n = len(damaging)
    if n <= 1 or (n == 2 and len(support) >= 2 and attack_stat < 150):
        role = "support"
    elif n >= 3 and not support:
        role = "offense"
    else:
        role = "hybrid"
    return Member(id=mon["id"], name=mon["name"], types=list(mon["types"]), ability=ability or "",
                  item=c.item or "", alignment=c.alignment, spread=c.spread.as_dict(), stats=final,
                  moves=moves, combatant=c, damaging=damaging, support=support, role=role, side=side,
                  attack_stat=attack_stat, is_mega=bool(mon.get("mega_of")))


def _names(ms) -> str:
    return ", ".join(m.name for m in ms) if ms else "none"


from vgc_toolkit.core.damage import WEIGHT_MOVES


def _listed_bp(mv: dict) -> int:
    """Base power for the composition questions. Weight-based moves list 0; count
    them as the 100 BP they deal to the 100-200 kg targets that dominate the
    format (the matchup pass uses the real weights through the damage engine)."""
    return mv["base_power"] or (100 if mv["name"] in WEIGHT_MOVES else 0)


def _stab_bp(m: Member) -> tuple[int, str] | None:
    best = None
    for d in m.damaging:
        if d["type"] in m.types and _listed_bp(d):
            if best is None or _listed_bp(d) > best[0]:
                best = (_listed_bp(d), d["name"])
    return best


def _pool_speeds(regulation: str) -> list[int]:
    """Max-speed benchmark of every legal Pokemon (32 SP, +Speed nature)."""
    out = []
    for pid, mon in dataio.pokedex().items():
        if regulation in mon.get("regulations", []):
            out.append(stats.calc_stat(mon["base"]["spe"], 32, 1.1))
    return out


# ---------------------------------------------------------------- sections
def _composition(ms: list[Member]) -> list[Check]:
    checks = []
    dealers = [m for m in ms if m.role in ("offense", "hybrid")]
    support = [m for m in ms if m.role == "support"]
    megas = [m for m in ms if m.is_mega]
    n = len(ms)
    if n < 6:
        checks.append(Check("composition", "team-size", "info", f"{n} of 6 slots filled",
                            "Checks are run on the members present.", "C"))
    needed = min(4, max(1, n - 2))          # partial teams: leave room for two support
    status = "pass" if len(dealers) >= needed else "warn"
    checks.append(Check("composition", "damage-dealers", status,
                        f"{len(dealers)} damage dealer{'s' if len(dealers) != 1 else ''} (target 4)",
                        f"Offense: {_names([m for m in ms if m.role == 'offense'])}. Hybrid: "
                        f"{_names([m for m in ms if m.role == 'hybrid'])}. Wolfe: four Pokemon that deal "
                        "meaningful damage; if two attackers are bad in a matchup you still bring two.", "1.4, 2.5"))
    checks.append(Check("composition", "support-count", "pass" if 1 <= len(support) <= 2 else "warn",
                        f"{len(support)} support Pokemon (1 to 2)",
                        f"Support: {_names(support)}. A team of only support cannot secure knockouts; "
                        "more than two leaves you one attacker when it matters.", "1.4"))
    if megas:
        checks.append(Check("composition", "megas", "pass" if len(megas) <= 2 else "warn",
                            f"{len(megas)} Mega ({_names(megas)})",
                            "At least one and at most two Megas per team; one evolves per battle.", "1.6"))
    else:
        checks.append(Check("composition", "megas", "warn", "No Mega on the team",
                            "In a Mega format use at least one: Megas are stronger than their peers.", "1.6"))
    return checks


def _speed_plan(ms: list[Member], regulation: str) -> tuple[dict, list[Check]]:
    checks = []
    pool = _pool_speeds(regulation)
    tr = [m for m in ms if "Trick Room" in m.moves]
    tw = [m for m in ms if "Tailwind" in m.moves]
    prio = [(m, [d["name"] for d in m.damaging if d.get("priority", 0) > 0]) for m in ms]
    prio = [(m, mv) for m, mv in prio if mv]
    fake_out = [m for m in ms if "Fake Out" in m.moves]
    scarf = [m for m in ms if m.item == "Choice Scarf"]
    drops = [(m, [mv for mv in m.moves if mv in SPEED_DROP_MOVES]) for m in ms]
    drops = [(m, mv) for m, mv in drops if mv]
    para = [(m, [mv for mv in m.moves if mv in PARALYSIS_MOVES]) for m in ms]
    para = [(m, mv) for m, mv in para if mv]
    weathers = {WEATHER_SETTERS[m.ability] for m in ms if m.ability in WEATHER_SETTERS}
    weathers |= {WEATHER_MOVES[mv] for m in ms for mv in m.moves if mv in WEATHER_MOVES}
    terrains = {TERRAIN_SETTERS[m.ability] for m in ms if m.ability in TERRAIN_SETTERS}
    doublers = [(m, m.ability) for m in ms if m.ability in SPEED_ABILITIES
                and (SPEED_ABILITIES[m.ability] in weathers or SPEED_ABILITIES[m.ability] in terrains)]
    fast = [m for m in ms if sum(1 for s in pool if s > m.stats["spe"]) <= len(pool) * 0.1]
    slow = [m for m in ms if m.stats["spe"] <= 85]

    methods = []
    if tr:
        methods.append(("Trick Room", tr, "hard" if len(slow) >= 4 else "flexible"))
    if tw:
        methods.append(("Tailwind", tw, None))
    if fast:
        methods.append(("natural speed", fast, None))
    if len(prio) >= 1:
        methods.append(("priority", [m for m, _ in prio], None))
    if scarf:
        methods.append(("Choice Scarf", scarf, None))
    if drops:
        methods.append(("speed drops", [m for m, _ in drops], None))
    if para:
        methods.append(("paralysis", [m for m, _ in para], None))
    if doublers:
        methods.append(("weather / terrain speed", [m for m, _ in doublers], None))

    primary = None
    if tr and len(slow) >= 3:
        primary = "Trick Room"
    elif tw:
        primary = "Tailwind"
    elif doublers:
        primary = "weather / terrain speed"
    elif len(fast) >= 3:
        primary = "natural speed"
    elif len(prio) >= 2:
        primary = "priority"
    elif scarf:
        primary = "Choice Scarf"
    elif tr:
        primary = "Trick Room"
    elif drops or para:
        primary = "speed drops" if drops else "paralysis"
    backups = [name for name, _, _ in methods if name != primary]

    plan = {
        "primary": primary,
        "backups": backups,
        "methods": [{"method": name, "members": [m.name for m in mem], "note": note} for name, mem, note in methods],
        "priority_moves": {m.name: mv for m, mv in prio},
        "speed_drops": {m.name: mv for m, mv in drops},
        "slow": [m.name for m in slow],
        "fast": [m.name for m in fast],
    }
    if not primary:
        checks.append(Check("speed", "plan", "fail", "No speed-control plan",
                            "Wolfe starts every build here: Tailwind, Trick Room, priority, Scarf, speed "
                            "drops, paralysis or natural speed. Fixate on the outcome: moving first more "
                            "often than the opponent.", "1.3, 2.12"))
    else:
        detail = "; ".join(f"{name}: {_names(mem)}" for name, mem, _ in methods)
        checks.append(Check("speed", "plan", "pass", f"Primary speed control: {primary}",
                            detail + ". Backups: " + (", ".join(backups) if backups else "none") + ".", "1.3"))
    if tr and primary == "Trick Room":
        hard = len(slow) >= 4
        fast_in_tr = [m for m in ms if m.stats["spe"] > 100 and m not in tr]
        if fast_in_tr:
            checks.append(Check("speed", "tr-fast-members", "warn",
                                f"Moves last under your own Trick Room: {_names(fast_in_tr)}",
                                "Attackers on a Trick Room team must be extremely slow; if the opponent can "
                                "act first inside your Trick Room the plan fails.", "1.5"))
        if hard and len(tr) < 2:
            checks.append(Check("speed", "tr-setters", "warn", f"Only one Trick Room setter ({_names(tr)})",
                                "Hard Trick Room wants two setters (the bulkier one usually performs better) "
                                "so a second room can go up after the first setter falls.", "1.5"))
        elif tr:
            checks.append(Check("speed", "tr-setters", "pass", f"{len(tr)} Trick Room setter{'s' if len(tr) > 1 else ''}: {_names(tr)}",
                                "Two bulky setters is Wolfe's recommendation when hard committing.", "1.5"))
        blockers = [m for m in ms if m.ability in FAKE_OUT_BLOCKERS]
        checks.append(Check("speed", "tr-fake-out", "pass" if blockers else "warn",
                            "Fake Out blocker: " + (_names(blockers) if blockers else "none"),
                            "Fake Out is the standard way opponents burn Trick Room turns; Armor Tail, "
                            "Dazzling, Queenly Majesty or Psychic Terrain stop it.", "1.5"))
        taunt = [m for m in ms if m.ability in TAUNT_ANSWER_ABILITIES or m.item in TAUNT_ANSWER_ITEMS]
        checks.append(Check("speed", "tr-taunt", "pass" if taunt else "warn",
                            "Taunt answer on a setter: " + (_names(taunt) if taunt else "none"),
                            "Magic Bounce, Aroma Veil, Oblivious or a Mental Herb keeps the setter usable "
                            "when Taunted.", "1.5"))
        redirect = [m for m in ms if any(mv in REDIRECTION_MOVES for mv in m.moves)] + fake_out
        checks.append(Check("speed", "tr-support", "pass" if redirect else "warn",
                            "Setup support (Follow Me / Rage Powder / Fake Out): " + (_names(redirect) if redirect else "none"),
                            "Trick Room resolves last, so the opponent gets two attacks first; redirection "
                            "or Fake Out keeps the setter alive.", "1.5"))
        outside = [m for m, _ in prio] + fast
        checks.append(Check("speed", "tr-outside", "pass" if outside else "info",
                            "Plays without Trick Room: " + (_names(outside) if outside else "nobody in particular"),
                            "Trick Room teams are built slow, so know what works when the room is down: "
                            "priority moves, bulk, or a Scarf user.", "1.5"))
    if tw and primary == "Tailwind":
        answers = [m for m in ms if any(mv in TRICK_ROOM_ANSWERS for mv in m.moves) or m.ability == "Prankster"]
        checks.append(Check("speed", "tw-trick-room", "pass" if answers else "warn",
                            "Trick Room answer: " + (_names(answers) if answers else "none"),
                            "Trick Room is a Tailwind team's biggest weakness: carry Taunt, Imprison, your own "
                            "Trick Room or a Prankster setter.", "1.5"))
        if len(tw) > 1:
            checks.append(Check("speed", "tw-setters", "info", f"{len(tw)} Tailwind setters",
                                "Usually one Tailwind user per team; two is unusual.", "1.5"))
        dead = [m for m in tw if not m.damaging and not [mv for mv in m.moves if mv in ("Helping Hand", "Fake Out", "Encore")]]
        if dead:
            checks.append(Check("speed", "tw-setter-role", "warn", f"Setter with nothing to do after Tailwind: {_names(dead)}",
                                "The setter cannot be a dead slot: Helping Hand, Fake Out or disruption.", "1.5"))
    return plan, checks


def _offense(ms: list[Member], regulation: str) -> list[Check]:
    checks = []
    attackers = [m for m in ms if m.role != "support"]
    for m in attackers:
        stab = _stab_bp(m)
        if stab is None:
            if m.damaging:
                checks.append(Check("offense", f"stab-{m.id}", "warn", f"{m.name}: no STAB move",
                                    "Run at least one STAB move per type unless purely support; the 1.5x is too "
                                    "big to skip without a strong reason.", "1.9"))
        else:
            bp, name = stab
            status = "pass" if bp >= BP_GOOD else "warn" if bp >= BP_FLOOR else "fail"
            checks.append(Check("offense", f"stab-{m.id}", status, f"{m.name}: best STAB {name} ({bp} BP)",
                                "Attacking moves: 80 base power minimum, 90 or higher strongly preferred.", "2.5"))
        if m.damaging:
            boosted = m.ability in DAMAGE_ABILITIES
            shown = m.attack_stat * 2 if m.ability in STAT_DOUBLERS else m.attack_stat
            status = "pass" if shown >= ATTACK_STAT_FLOOR or boosted else "warn"
            label = f"{m.name}: {m.side or 'no'} attacker, stat {m.attack_stat}"
            if m.ability in STAT_DOUBLERS:
                label += f" x2 = {shown} ({m.ability})"
            elif shown < ATTACK_STAT_FLOOR:
                label += " (below 165)" + (f", but {m.ability} compensates" if boosted else "")
            checks.append(Check("offense", f"stat-{m.id}", status, label,
                                "Wolfe's floor is an actual attacking stat of 165 unless a modifier such as "
                                "Adaptability or Huge Power compensates.", "2.5"))
        types = [d["type"] for d in m.damaging]
        dup = {t for t in types if types.count(t) > 1}
        if dup and m.item not in CHOICE_ITEMS and m.item != "Assault Vest":
            checks.append(Check("offense", f"dup-type-{m.id}", "info",
                                f"{m.name}: two attacks of the same type ({', '.join(sorted(dup))})",
                                "Usually only worth it with a Choice item or Assault Vest, or when the Pokemon "
                                "is strong enough to justify it.", "1.9"))
    sides = {m.side for m in attackers if m.side}
    if attackers:
        mixed = ("Physical" in sides or "Mixed" in sides) and ("Special" in sides or "Mixed" in sides)
        checks.append(Check("offense", "mix", "pass" if mixed else "warn",
                            "Physical / special mix: " + ", ".join(f"{m.name} ({m.side})" for m in attackers if m.side),
                            "All-special teams lose to Light Screen and Snarl; all-physical teams lose to "
                            "Intimidate, Will-O-Wisp and Reflect.", "2.5"))
    # Type coverage: which popular Pokemon resist every attacking type on the team?
    atk_types = sorted({d["type"] for m in ms for d in m.damaging})
    if atk_types:
        walls = []
        usage = {pid: v["usage"] for pid, v in dataio.meta_sets()["pokemon"].items()}
        for pid, mon in dataio.pokedex().items():
            if regulation not in mon.get("regulations", []):
                continue
            if all(dataio.type_effectiveness(t, mon["types"]) < 1 for t in atk_types):
                walls.append((usage.get(pid, 0.0), mon["name"]))
        walls.sort(reverse=True)
        popular = [n for u, n in walls if u >= 1.0]
        status = "pass" if not popular else "warn"
        checks.append(Check("offense", "coverage", status,
                            f"Attacking types: {', '.join(atk_types)}" + (f"; resisted by {len(walls)} legal Pokemon" if walls else "; nothing resists all of them"),
                            ("Popular Pokemon that resist every one of them: " + ", ".join(popular[:8]) + ". " if popular else "")
                            + "Ghost, Dragon and Fairy are efficient attacking types; Bug is not.", "2.5"))
    return checks


def _defense(ms: list[Member], threats: list[dict]) -> list[Check]:
    checks = []
    # Type counts (species root avoids double counting a Mega and its base).
    counts: dict[str, list[str]] = {}
    for m in ms:
        for t in m.types:
            counts.setdefault(t, []).append(m.name)
    over = {t: n for t, n in counts.items() if len(n) > 2}
    checks.append(Check("defense", "type-count", "fail" if over else "pass",
                        "More than two of one type: " + (", ".join(f"{t} ({', '.join(n)})" for t, n in over.items()) if over else "none"),
                        "Stacking a type stacks its weaknesses and narrows coverage; usually one of each type.", "2.6"))
    # Effective matchups with the extra abilities the shared profile misses.
    profiles = {}
    for m in ms:
        prof = matchup.defensive_profile(m.id, m.ability)["matchups"]
        for t, mult in EXTRA_DEFENSE.get(m.ability, {}).items():
            prof[t] = prof[t] * mult
        profiles[m.id] = prof
    resist = {t: [m for m in ms if profiles[m.id][t] < 1] for t in ALL_TYPES}
    weak = {t: [m for m in ms if profiles[m.id][t] > 1] for t in ALL_TYPES}
    missing = [t for t in ALL_TYPES if not resist[t]]
    checks.append(Check("defense", "resist-all", "pass" if not missing else "warn",
                        "No resistance to: " + (", ".join(missing) if missing else "nothing (every type resisted)"),
                        "Ideally at least one resistance to every type; you will never be upset to have it.", "2.6"))
    stacked = {t: w for t, w in weak.items() if len(w) >= 3}
    if stacked:
        checks.append(Check("defense", "stacked-weak", "fail",
                            "Three or more weak to: " + ", ".join(f"{t} ({_names(w)})" for t, w in stacked.items()),
                            "An opponent should not be able to load one type and blow through the team.", "2.6"))
    pairs = {t: w for t, w in weak.items() if len(w) == 2}
    if pairs:
        checks.append(Check("defense", "paired-weak", "info",
                            "Two weak to: " + ", ".join(f"{t} ({_names(w)})" for t, w in pairs.items()),
                            "Acceptable, but keep the two apart and know which threats exploit it.", "2.6"))
    # Two resistances to the top threats' attacking types.
    top_types: dict[str, list[str]] = {}
    for th in threats[:8]:
        for mv in th["moves"]:
            mvd = dataio.moves().get(mv)
            if mvd and mvd["category"] != "Status" and _listed_bp(mvd) >= 60:
                top_types.setdefault(mvd["type"], []).append(th["name"])
    thin = [(t, sorted(set(who))) for t, who in top_types.items() if len(resist[t]) < 2]
    if thin:
        checks.append(Check("defense", "top-threat-resists", "warn",
                            "Fewer than two resistances to top-threat types: " + "; ".join(f"{t} ({', '.join(w[:3])})" for t, w in thin),
                            "Against the strongest attackers, want two or more resistances to their type; with "
                            "one Fire resist a Heat Wave still removes two Pokemon.", "2.6"))
    else:
        checks.append(Check("defense", "top-threat-resists", "pass", "Two or more resistances to each top-threat attacking type", "", "2.6"))
    paper = []
    for t in ALL_TYPES:
        real = [m for m in resist[t] if m.bulk >= BULK_PAPER and m.item != "Focus Sash" and not (m.ability == LEVITATE and t == "Ground" and dataio.type_effectiveness(t, m.types) >= 1)]
        if resist[t] and not real:
            paper.append(f"{t} ({_names(resist[t])})")
    if paper:
        checks.append(Check("defense", "paper", "info", "Resistances that may be paper: " + ", ".join(paper),
                            "A resistance on a frail or Focus Sash Pokemon does not stop a spammed attack; "
                            "Levitate is not a true resistance (Mold Breaker, Skill Swap).", "2.6"))
    return checks


def _items(ms: list[Member]) -> list[Check]:
    checks = []
    held = [m.item for m in ms if m.item]
    dups = sorted({i for i in held if held.count(i) > 1})
    checks.append(Check("items", "item-clause", "fail" if dups else "pass",
                        "Item clause: " + ("duplicate " + ", ".join(dups) if dups else "satisfied"),
                        "No two Pokemon may hold the same item, berries and Choice items included.", "1.11"))
    items_db = {i["name"]: i for i in dataio.items().values()} if isinstance(dataio.items(), dict) else {i["name"]: i for i in dataio.items()}
    offensive = [m for m in ms if m.item in OFFENSIVE_ITEMS or items_db.get(m.item, {}).get("boost_type")
                 or items_db.get(m.item, {}).get("category_boost")]
    status = "pass" if 1 <= len(offensive) <= 3 else "warn"
    checks.append(Check("items", "offensive-items", status,
                        f"{len(offensive)} offensive item{'s' if len(offensive) != 1 else ''}: " + (", ".join(f"{m.name} ({m.item})" for m in offensive) or "none"),
                        "Most teams run 1 to 3 offensive items; Mega Stones take slots, so fewer is normal in a "
                        "Mega format. Type items are drawback-free for one-type spammers; Life Orb keeps all four moves.", "2.5"))
    for m in ms:
        if m.item == "Focus Sash" and m.bulk >= 380:
            checks.append(Check("items", f"sash-{m.id}", "warn", f"{m.name}: Focus Sash on a bulky Pokemon",
                                "Sash is best on a fast, frail attacker so it gets to act; it is wasted on one that survives hits anyway.", "1.11"))
        if m.item == "Sitrus Berry" and m.bulk < BULK_PAPER:
            checks.append(Check("items", f"sitrus-{m.id}", "info", f"{m.name}: Sitrus Berry on a frail Pokemon",
                                "Sitrus turns 2HKOs into 3HKOs on Pokemon that are already fairly bulky.", "2.6"))
        if m.item in CHOICE_ITEMS and any(mv in PROTECT_MOVES for mv in m.moves):
            checks.append(Check("items", f"choice-protect-{m.id}", "warn", f"{m.name}: Protect with a Choice item",
                                "A Choice-locked Pokemon cannot Protect; the slot is better spent on coverage.", "2.5"))
        berry = items_db.get(m.item, {})
        if berry.get("resist_type"):
            t = berry["resist_type"]
            mult = dataio.type_effectiveness(t, m.types)
            if mult < 2:
                checks.append(Check("items", f"berry-{m.id}", "warn", f"{m.name}: {m.item} never activates",
                                    f"Type-resist berries only halve super effective hits and {m.name} is not weak to {t}.", "2.6"))
    tech = [f"{m.name} ({m.item})" for m in ms if m.item in FORMAT_TECH_ITEMS] + \
           [f"{m.name} ({mv})" for m in ms for mv in m.moves if mv in FORMAT_TECH_MOVES]
    checks.append(Check("items", "format-tech", "info", "Format tech: " + (", ".join(tech) if tech else "none"),
                        "Budget a slot, item or move for the format's dominant tools (Amoonguss: Safety Goggles; "
                        "Kangaskhan: Rocky Helmet; Dondozo: Haze).", "2.7"))
    return checks


def _movesets(ms: list[Member]) -> list[Check]:
    checks = []
    for m in ms:
        if not m.moves:
            continue
        if not m.damaging:
            checks.append(Check("moves", f"no-attack-{m.id}", "fail", f"{m.name} has no damaging move",
                                "Every Pokemon needs at least one attack: under Taunt it is forced into Struggle.", "1.9"))
        has_protect = any(mv in PROTECT_MOVES for mv in m.moves)
        if m.role == "offense" and not has_protect and m.item not in CHOICE_ITEMS:
            checks.append(Check("moves", f"protect-{m.id}", "info", f"{m.name}: offensive set without Protect",
                                "Wolfe's offensive template is Protect, STAB, STAB or coverage, flex. Four attacks is "
                                "a deliberate choice: bulky Trick Room sweepers and priority users get away with it.", "1.9, 4.1"))
        if m.role == "support" and has_protect and m.bulk >= 480:
            checks.append(Check("moves", f"support-protect-{m.id}", "info", f"{m.name}: very bulky support running Protect",
                                "Very bulky support often drops Protect for a third support move; its job is to keep teammates alive.", "1.9"))
        stab_types = {d["type"] for d in m.damaging if d["type"] in m.types}
        missing_stab = [t for t in m.types if t not in stab_types]
        if m.role != "support" and missing_stab and len(m.damaging) >= 2:
            checks.append(Check("moves", f"stab-types-{m.id}", "info", f"{m.name}: no {'/'.join(missing_stab)} STAB",
                                "Run at least one STAB per type unless the Pokemon is purely support (a Scizor without Bug STAB wastes it).", "1.9"))
        if len(m.moves) < 4:
            checks.append(Check("moves", f"count-{m.id}", "warn", f"{m.name}: only {len(m.moves)} move{'s' if len(m.moves) != 1 else ''}", "", "1.9"))
    return checks


def _spreads(ms: list[Member]) -> list[Check]:
    checks = []
    alignments = dataio.alignments()
    for m in ms:
        sp = m.spread
        total = sum(sp.values())
        maxed = [k for k, v in sp.items() if v == 32]
        if total < stats.MAX_SP_TOTAL:
            checks.append(Check("spreads", f"budget-{m.id}", "warn", f"{m.name}: {stats.MAX_SP_TOTAL - total} SP unspent",
                                "66 points total, 32 per stat. Max-max plus two leftovers is the fine default.", "1.10"))
        al = alignments.get(m.alignment, {})
        boost, reduce = al.get("boost"), al.get("reduce")
        if not boost:
            checks.append(Check("spreads", f"nature-{m.id}", "warn", f"{m.name}: neutral nature ({m.alignment})",
                                "The five neutral natures change nothing and are almost never optimal.", "1.10"))
        else:
            base = dataio.get_pokemon(m.id)["base"]
            if boost in ("atk", "spa") and reduce and m.side and ((boost == "atk") != (m.side == "Physical")) and m.side != "Mixed":
                checks.append(Check("spreads", f"nature-side-{m.id}", "warn",
                                    f"{m.name}: {m.alignment} boosts {boost} but it attacks with {m.side} moves",
                                    "Boost the most important stat and lower the unused attacking stat.", "1.10"))
            # Nature bump: one more SP would gain two points instead of one.
            cur = stats.calc_stat(base[boost], sp[boost], 1.1)
            if sp[boost] < 32 and total < stats.MAX_SP_TOTAL:
                nxt = stats.calc_stat(base[boost], sp[boost] + 1, 1.1)
                if nxt - cur >= 2:
                    checks.append(Check("spreads", f"bump-{m.id}", "info",
                                        f"{m.name}: 1 more SP in {boost} gains {nxt - cur} points (nature bump)", "", "1.10"))
        if m.role != "offense":
            hp, dsum = m.stats["hp"], m.stats["def"] + m.stats["spd"]
            if abs(hp - dsum) > max(40, dsum * 0.25) and not (hp < dsum and sp["hp"] >= stats.MAX_SP_PER_STAT):
                tip = "add HP" if hp < dsum else "add defenses"
                checks.append(Check("spreads", f"bulk-{m.id}", "info",
                                    f"{m.name}: HP {hp} vs Def+SpD {dsum} — for generic bulk, {tip}",
                                    "Balanced bulk rule: HP roughly equal to Defense plus Special Defense (not for surviving one specific attack).", "1.10, 2.10"))
        if maxed and len(maxed) >= 2:
            pass  # max-max is the default Wolfe recommends; nothing to say
    return checks


# ---------------------------------------------------------------- matchups
def _threat_sets(regulation: str, top_n: int) -> list[dict]:
    meta = dataio.meta_sets()["pokemon"]
    dex = dataio.pokedex()
    out = []
    for pid, entry in sorted(meta.items(), key=lambda kv: -kv[1]["usage"]):
        if pid not in dex or regulation not in dex[pid].get("regulations", []) or not entry.get("sets"):
            continue
        s = entry["sets"][0]
        out.append({"id": pid, "name": entry["name"], "usage": entry["usage"], "set": s,
                    "is_mega": bool(dex[pid].get("mega_of"))})
        if len(out) >= top_n:
            break
    return out


def _combatant_from_set(pid: str, s: dict) -> Combatant:
    return Combatant(pid, spread=stats.SPSpread.from_dict(s["spread"]), alignment=s["alignment"],
                     ability=s["ability"] or None, item=s["item"] or None)


def _best_move(attacker: Combatant, moves: list[str], defender: Combatant, field: Field) -> dict | None:
    best = None
    move_db = dataio.moves()
    for name in moves:
        mv = move_db.get(name)
        if not mv or mv["category"] == "Status" or not _listed_bp(mv):
            continue
        try:
            r = calculate(attacker, defender, name, field, max_ko_hits=2)
        except KeyError:
            continue
        if best is None or r["pct_range"][1] > best["pct_range"][1]:
            best = {"move": name, "pct_range": r["pct_range"], "ohko_chance": r.get("ohko_chance", 0.0)}
    return best


def _matchups(ms: list[Member], plan: dict, regulation: str, top_n: int) -> tuple[list[dict], list[Check]]:
    checks = []
    threats = _threat_sets(regulation, top_n)
    rows = []
    for th in threats:
        foe = _combatant_from_set(th["id"], th["set"])
        field = Field(weather=WEATHER_SETTERS[th["set"]["ability"]]) if th["set"]["ability"] in WEATHER_SETTERS else Field()
        ours, theirs = [], []
        for m in ms:
            hit = _best_move(m.combatant, [d["name"] for d in m.damaging], foe, field)
            ours.append({"member": m.name, **(hit or {"move": None, "pct_range": [0, 0], "ohko_chance": 0.0})})
            taken = _best_move(foe, th["set"]["moves"], m.combatant, field)
            theirs.append({"member": m.name, **(taken or {"move": None, "pct_range": [0, 0], "ohko_chance": 0.0})})
        answers = [o["member"] for o in ours if o["pct_range"][1] >= 50]
        ohkos = [t["member"] for t in theirs if t["ohko_chance"] > 0]
        rows.append({**{k: th[k] for k in ("id", "name", "usage", "is_mega")}, "item": th["set"]["item"],
                     "ability": th["set"]["ability"], "moves": th["set"]["moves"],
                     "answers": answers, "ohkos": ohkos, "ours": ours, "theirs": theirs})
    weak_rows = [r for r in rows if len(r["answers"]) < 2]
    for r in rows:
        if len(r["ohkos"]) >= 3 and len(r["answers"]) <= 1:
            checks.append(Check("matchups", f"instant-loss-{r['id']}", "fail",
                                f"{r['name']} ({r['usage']:.0f}% usage) OHKOs {', '.join(r['ohkos'])} and has {len(r['answers'])} answer{'s' if len(r['answers']) != 1 else ''}",
                                "Wolfe's finished team has no matchup where seeing the six is an instant loss. Add a "
                                "resist or a faster / priority answer, or a plan to keep those Pokemon off the field.", "2.1, 2.8"))
    for r in weak_rows:
        if any(c.id == f"instant-loss-{r['id']}" for c in checks):
            continue
        status = "fail" if not r["answers"] else "warn"
        what = "popular Mega" if r["is_mega"] else "top threat"
        checks.append(Check("matchups", f"answers-{r['id']}", status,
                            f"{r['name']} ({r['usage']:.0f}%): {len(r['answers'])} answer{'s' if len(r['answers']) != 1 else ''} ({', '.join(r['answers']) or 'none'})",
                            f"Bring at least two answers to a {what} (a 2HKO with a move you actually run). "
                            + (f"Its best hits: " + ", ".join(f"{t['move']} {t['pct_range'][1]:.0f}% on {t['member']}" for t in sorted(r['theirs'], key=lambda x: -x['pct_range'][1])[:2]) + "."),
                            "2.8, 3.2"))
    good = [r for r in rows if len(r["answers"]) >= 2]
    checks.append(Check("matchups", "coverage-summary", "pass" if len(weak_rows) <= 2 else "warn",
                        f"{len(good)} of the top {len(rows)} ladder sets have two or more answers",
                        "Weight threats by usage, not by what is merely legal; usage stats are the list of Pokemon you will definitely see.", "2.8, 2.9"))
    # Susceptibility to widely distributed tools.
    tr_users = [r["name"] for r in rows if "Trick Room" in r["moves"]]
    fake_out = [r["name"] for r in rows if "Fake Out" in r["moves"]]
    redirect = [r["name"] for r in rows if any(mv in REDIRECTION_MOVES for mv in r["moves"])]
    prank = [r["name"] for r in rows if r["ability"] == "Prankster"]
    tools = []
    if tr_users:
        tools.append(f"Trick Room ({', '.join(tr_users)})")
    if fake_out:
        tools.append(f"Fake Out ({', '.join(fake_out)})")
    if redirect:
        tools.append(f"redirection ({', '.join(redirect)})")
    if prank:
        tools.append(f"Prankster ({', '.join(prank)})")
    if plan.get("primary") == "Tailwind" and tr_users:
        status = "warn" if not any(any(mv in TRICK_ROOM_ANSWERS for mv in m.moves) for m in ms) else "info"
    else:
        status = "info"
    checks.append(Check("matchups", "tools", status, "High-impact tools among the top sets: " + ("; ".join(tools) if tools else "none"),
                        "Know how susceptible your team is to Trick Room, Fake Out, Follow Me / Rage Powder, Prankster and Wide Guard.", "2.7"))
    weathers = {WEATHER_SETTERS[m.ability] for m in ms if m.ability in WEATHER_SETTERS}
    if weathers:
        others = [f"{r['name']} ({WEATHER_SETTERS[r['ability']]})" for r in rows if r["ability"] in WEATHER_SETTERS and WEATHER_SETTERS[r["ability"]] not in weathers]
        checks.append(Check("matchups", "weather-war", "info" if others else "pass",
                            "Opposing weather setters among the top sets: " + (", ".join(others) if others else "none"),
                            "Have an explicit plan for every other weather setter: overwriting your weather removes your synergies.", "1.5"))
    return rows, checks


# ---------------------------------------------------------------- worksheet
def _worksheet(ms: list[Member], plan: dict, rows: list[dict], checks: list[Check], regulation: str) -> dict:
    by_id = {c.id: c for c in checks}
    atk_types = sorted({d["type"] for m in ms for d in m.damaging})
    megas = [m.name for m in ms if m.is_mega]
    top3 = rows[:3]
    ws = {
        "regulation": regulation,
        "starting_point": (f"Mega: {', '.join(megas)}" if megas else "") + (f"; strategy: {plan['primary']}" if plan.get("primary") else ""),
        "speed_primary": plan.get("primary") or "none",
        "speed_backups": ", ".join(plan.get("backups", [])) or "none",
        "outside_plan": ", ".join(plan.get("priority_moves", {}).keys()) or "-",
        "roster": [{"pokemon": m.name, "role": m.role, "side": m.side or "-", "item": m.item or "-",
                    "why": ", ".join(m.support[:2] + [d["name"] for d in m.damaging[:2]])} for m in ms],
        "damage_dealers": sum(1 for m in ms if m.role != "support"),
        "support": sum(1 for m in ms if m.role == "support"),
        "megas": len(megas),
        "attacking_types": ", ".join(atk_types),
        "physical": sum(1 for m in ms if m.side in ("Physical", "Mixed")),
        "special": sum(1 for m in ms if m.side in ("Special", "Mixed")),
        "benchmarks_ok": all(c.status == "pass" for c in checks if c.section == "offense" and (c.id.startswith("stab-") or c.id.startswith("stat-"))),
        "two_hko": {r["name"]: r["answers"] for r in rows[:8]},
        "type_counts_over": by_id["type-count"].title if "type-count" in by_id else "",
        "no_resist": by_id["resist-all"].title if "resist-all" in by_id else "",
        "top_threats": [{"threat": r["name"], "answers": r["answers"]} for r in top3],
        "paper": by_id["paper"].title if "paper" in by_id else "none",
        "offensive_items": by_id["offensive-items"].title if "offensive-items" in by_id else "",
        "sash_on": ", ".join(m.name for m in ms if m.item == "Focus Sash") or "-",
        "sitrus_on": ", ".join(m.name for m in ms if m.item == "Sitrus Berry") or "-",
        "format_tech": by_id["format-tech"].title if "format-tech" in by_id else "",
        "item_clause": by_id["item-clause"].status == "pass" if "item-clause" in by_id else None,
        "instant_loss": [c.title for c in checks if c.id.startswith("instant-loss-")],
        "vs_trick_room": by_id["tools"].title if "tools" in by_id else "",
    }
    lines = [f"# Teambuilding worksheet ({regulation})", "",
             "## 1. Starting point", f"- {ws['starting_point'] or '_fill in_'}", "",
             "## 2. Speed control plan", f"- Primary: {ws['speed_primary']}", f"- Backup: {ws['speed_backups']}",
             f"- Without it: {ws['outside_plan']}", "",
             "## 3. Roster", "| Slot | Pokemon | Role | Side | Item | Why it is here |", "|---|---|---|---|---|---|"]
    for i, r in enumerate(ws["roster"], 1):
        lines.append(f"| {i} | {r['pokemon']} | {r['role']} | {r['side']} | {r['item']} | {r['why']} |")
    lines += ["", f"- Damage dealers: {ws['damage_dealers']} · Support: {ws['support']} · Megas: {ws['megas']}", "",
              "## 4. Offensive check", f"- Attacking types: {ws['attacking_types']}",
              f"- Physical attackers: {ws['physical']} · Special attackers: {ws['special']}",
              f"- 80+ BP STAB and 165+ attacking stat on every attacker: {'yes' if ws['benchmarks_ok'] else 'no (see checks)'}",
              "- 2HKOs on common threats: " + "; ".join(f"{k}: {', '.join(v) or 'none'}" for k, v in ws["two_hko"].items()), "",
              "## 5. Defensive check", f"- {ws['type_counts_over']}", f"- {ws['no_resist']}",
              "- Top threats and answers: " + "; ".join(f"{t['threat']}: {', '.join(t['answers']) or 'none'}" for t in ws["top_threats"]),
              f"- Paper resistances: {ws['paper']}", "",
              "## 6. Items and format tech", f"- {ws['offensive_items']}", f"- Focus Sash on: {ws['sash_on']} · Sitrus on: {ws['sitrus_on']}",
              f"- {ws['format_tech']}", f"- Item clause satisfied: {'yes' if ws['item_clause'] else 'no'}", "",
              "## 7. Matchup pass", "- Instant-loss matchups: " + ("; ".join(ws["instant_loss"]) if ws["instant_loss"] else "none found"),
              f"- {ws['vs_trick_room']}", "",
              "## 8. Testing log", "| Game | Result | Luck, play or team? | Change |", "|---|---|---|---|", "| 1 | | | |", "| 2 | | | |", "| 3 | | | |"]
    ws["markdown"] = "\n".join(lines)
    return ws


# ---------------------------------------------------------------- entry point
def analyze(team: list[TeamMember], regulation: str = dataio.DEFAULT_REGULATION, top_n: int = 16) -> dict:
    ms = [_resolve(m) for m in team]
    checks: list[Check] = []
    checks += _composition(ms)
    plan, speed_checks = _speed_plan(ms, regulation)
    checks += speed_checks
    checks += _offense(ms, regulation)
    rows, matchup_checks = _matchups(ms, plan, regulation, top_n)
    checks += _defense(ms, rows)
    checks += _items(ms)
    checks += _movesets(ms)
    checks += _spreads(ms)
    checks += matchup_checks
    taunters = [r["name"] for r in rows if "Taunt" in r["moves"]]
    for c in checks:
        if c.id == "tr-taunt" and c.status == "warn" and not taunters:
            c.status = "info"
            c.detail += f" None of the top {len(rows)} ladder sets carries Taunt right now, so this is low priority."
        elif c.id == "tr-taunt" and taunters:
            c.detail += f" Taunt users among the top sets: {', '.join(taunters)}."
    summary = {s: sum(1 for c in checks if c.status == s) for s in ("pass", "warn", "fail", "info")}
    return {
        "regulation": regulation,
        "members": [{"id": m.id, "name": m.name, "role": m.role, "side": m.side, "attack_stat": m.attack_stat,
                     "stats": m.stats, "bulk": m.bulk, "item": m.item, "ability": m.ability, "is_mega": m.is_mega}
                    for m in ms],
        "speed": plan,
        "checks": [asdict(c) for c in checks],
        "summary": summary,
        "threats": rows,
        "worksheet": _worksheet(ms, plan, rows, checks, regulation),
    }
