"""Matchup analyzer: automated structural-flaw detection.

Three layers, each grounded in real damage calcs rather than type math alone:

  defensive_profile  - type-chart matchups for one Pokemon, ability-adjusted
  threat_scan        - every regulation-legal attacker throws its best
                       learnset move (max offensive SP, boosting alignment)
                       at YOUR actual build; threats ranked by damage with
                       OHKO/2HKO and speed-relation flags
  team_analysis      - shared weaknesses and attackers threatening multiple
                       team members at once (the structural flags that decide
                       team-preview decisions)

Scan assumptions (reported in output): attackers run 32 SP + boosting
alignment in the move's attacking stat, no item, first-listed-best ability;
your defender is exactly the Combatant you pass (spread, item, ability).
"""

from __future__ import annotations

import math

from vgc_toolkit.core import dataio, stats
from dataclasses import replace

from vgc_toolkit.core.damage import Combatant, Field, calculate
from vgc_toolkit.core.stats import SPSpread

ALL_TYPES = ["Normal", "Fire", "Water", "Electric", "Grass", "Ice", "Fighting",
             "Poison", "Ground", "Flying", "Psychic", "Bug", "Rock", "Ghost",
             "Dragon", "Dark", "Steel", "Fairy"]

WEATHER_SETTERS = {"Drought": "sun", "Drizzle": "rain",
                   "Sand Stream": "sand", "Snow Warning": "snow"}

ABILITY_TYPE_IMMUNITY = {
    "Levitate": "Ground", "Eelevate": "Ground", "Flash Fire": "Fire",
    "Water Absorb": "Water", "Storm Drain": "Water", "Dry Skin": "Water",
    "Volt Absorb": "Electric", "Lightning Rod": "Electric",
    "Motor Drive": "Electric", "Sap Sipper": "Grass", "Well-Baked Body": "Fire",
}


def defensive_profile(pokemon_id: str, ability: str | None = None) -> dict:
    mon = dataio.get_pokemon(pokemon_id)
    ability = ability or (mon["abilities"][0] if mon["abilities"] else None)
    matchups = {}
    for t in ALL_TYPES:
        mult = dataio.type_effectiveness(t, mon["types"])
        if ABILITY_TYPE_IMMUNITY.get(ability) == t:
            mult = 0.0
        if ability == "Thick Fat" and t in ("Fire", "Ice"):
            mult *= 0.5
        matchups[t] = mult
    return {
        "pokemon": {"id": mon["id"], "name": mon["name"], "types": mon["types"]},
        "ability": ability,
        "matchups": matchups,
        "quad_weak": [t for t, m in matchups.items() if m >= 4],
        "weak": [t for t, m in matchups.items() if m == 2],
        "resists": [t for t, m in matchups.items() if 0 < m < 1],
        "immune": [t for t, m in matchups.items() if m == 0],
    }


def _speed_relation(defender: Combatant, attacker_mon: dict) -> str:
    d_mon = dataio.get_pokemon(defender.pokemon_id)
    d_spe = stats.calc_all_stats(d_mon["base"], defender.spread,
                                 defender.alignment)["spe"]
    if defender.item == "Choice Scarf":
        d_spe = math.floor(d_spe * 1.5)
    a_max = stats.calc_stat(attacker_mon["base"]["spe"], 32, 1.1)
    a_zero = stats.calc_stat(attacker_mon["base"]["spe"], 0, 1.0)
    if a_zero > d_spe:
        return "outspeeds_even_uninvested"
    if a_max > d_spe:
        return "outspeeds_at_max_speed"
    if a_max == d_spe:
        return "speed_tie_at_max"
    return "you_outspeed"


def _best_hit(attacker_id: str, defender: Combatant, field: Field,
              practical: bool = True) -> dict | None:
    """Best damaging learnset move for one attacker vs this defender."""
    mon = dataio.get_pokemon(attacker_id)
    try:
        moves = dataio.get_learnset(attacker_id)["moves"]
    except KeyError:
        return None
    move_db = dataio.moves()
    abilities = mon["abilities"] or [None]
    variants = {
        "Physical": {ab: Combatant(attacker_id, spread=SPSpread(atk=32),
                                   alignment="Adamant", ability=ab)
                     for ab in abilities},
        "Special": {ab: Combatant(attacker_id, spread=SPSpread(spa=32),
                                  alignment="Modest", ability=ab)
                    for ab in abilities},
    }
    fields = {ab: (replace(field, weather=WEATHER_SETTERS[ab])
                   if ab in WEATHER_SETTERS and field.weather == "none"
                   else field)
              for ab in abilities}
    best = None
    for name in moves:
        m = move_db.get(name)
        if not m or m["category"] == "Status" or m["base_power"] < 1:
            continue
        if practical:
            # Skip moves nobody actually clicks for damage: recharge nukes
            # (Blast Burn / Hyper Beam class) and sub-70% accuracy gambles.
            if m.get("flags", {}).get("recharge"):
                continue
            acc = m.get("accuracy")
            if acc is not None and acc < 70:
                continue
        for ab in abilities:
            r = calculate(variants[m["category"]][ab], defender, name, fields[ab],
                          max_ko_hits=1)
            score = max(r["rolls"])
            if best is None or score > best["_score"]:
                hp = r["defender_hp"]
                best = {
                    "_score": score,
                    "move": name,
                    "accuracy": m.get("accuracy"),
                    "ability": ab,
                    "pct_range": r["pct_range"],
                    "ohko_chance": round(
                        sum(1 for x in r["rolls"] if x >= hp)
                        / len(r["rolls"]) * 100, 1),
                    "guaranteed_2hko": 2 * min(r["rolls"]) >= hp,
                    "notes": r["notes"],
                }
    return best


def rank_moves(attacker: Combatant, defender: Combatant,
               field: Field | None = None, top_n: int = 6) -> list[dict]:
    """Rank the attacker's damaging learnset moves vs a specific defender.

    Unlike _best_hit (which synthesizes idealized attackers for a pool scan),
    this uses the attacker EXACTLY as given — its real spread, alignment,
    ability, item, stages, status — and the supplied field, so each entry
    matches what the Damage Calc would show for that move. Strongest first.
    """
    move_db = dataio.moves()
    try:
        learnset = dataio.get_learnset(attacker.pokemon_id)["moves"]
    except KeyError:
        return []
    ranked = []
    for name in learnset:
        m = move_db.get(name)
        # Skip status moves and 0-BP variable-power moves (Low Kick, Grass Knot,
        # Electro Ball...): the engine can't rank those without an override and
        # they'd otherwise leak in as meaningless ~1% rows.
        if not m or m["category"] == "Status" or m["base_power"] < 1:
            continue
        try:
            r = calculate(attacker, defender, name, field, max_ko_hits=2)
        except KeyError:
            continue
        if r["damage_range"][1] <= 0:        # immune or non-damaging
            continue
        ranked.append({
            "move": name,
            "type": r.get("type", m["type"]),   # effective type (-ate abilities, Weather Ball)
            "category": m["category"],
            "base_power": m["base_power"],
            "accuracy": m.get("accuracy"),
            "recharge": bool(m.get("flags", {}).get("recharge")),
            "type_effectiveness": r["type_effectiveness"],
            "pct_range": r["pct_range"],
            "ohko_chance": r["ko_chances"].get("1hko", 0.0),
            "guaranteed_2hko": r["ko_chances"].get("2hko", 0.0) == 100.0,
            "notes": r["notes"],
        })
    ranked.sort(key=lambda x: (x["pct_range"][1], x["pct_range"][0]),
                reverse=True)
    return ranked[:top_n]


# ---------- signature spikes (field-conditional move boosts) ----------

# Pure-Water benchmark: no type immunities, so a move's damage / type-eff is a
# clean target-independent "power" whose RATIO across fields isolates the boost.
SIGNATURE_BENCHMARK = "milotic"

# Abilities that let a Pokemon set its own field condition.
SELF_WEATHER_ABILITIES = {**WEATHER_SETTERS, "Orichalcum Pulse": "sun"}
SELF_TERRAIN_ABILITIES = {"Electric Surge": "electric", "Grassy Surge": "grassy",
                          "Psychic Surge": "psychic", "Misty Surge": "misty",
                          "Hadron Engine": "electric"}

_SPIKE_CONDITIONS = [   # (field key, kind, label)
    ("sun", "weather", "Sun"), ("rain", "weather", "Rain"),
    ("sand", "weather", "Sand"), ("snow", "weather", "Snow"),
    ("electric", "terrain", "Electric Terrain"),
    ("grassy", "terrain", "Grassy Terrain"),
    ("psychic", "terrain", "Psychic Terrain"),
]
_WEATHER_BALL_TYPES = {"sun": "Fire", "rain": "Water", "sand": "Rock", "snow": "Ice"}


def _spike_power(attacker: Combatant, benchmark: Combatant,
                 move: str, field: Field) -> float:
    """Type-neutralized power of a move vs the benchmark (max roll / type-eff),
    so the ratio across fields is independent of the benchmark's typing."""
    try:
        r = calculate(attacker, benchmark, move, field, max_ko_hits=1)
    except KeyError:
        return 0.0
    eff = r["type_effectiveness"] or 0.001
    return max(r["rolls"]) / eff


def signature_spikes(attacker: Combatant, min_ratio: float = 1.25,
                     top_n: int = 6) -> dict:
    """The attacker's moves that gain meaningful damage under a specific
    weather/terrain, flagging whether the Pokemon sets that field itself.

    Empirical and honest: every spike is computed by the real damage engine,
    so it only surfaces boosts the engine actually models (weather damage mods,
    Weather Ball's type/BP swap, the grounded x1.3 terrain boost). Move quirks
    the engine doesn't model (e.g. Rising Voltage's doubling) won't be claimed.
    """
    move_db = dataio.moves()
    mon, ability, _ = attacker.resolve()
    try:
        learnset = dataio.get_learnset(attacker.pokemon_id)["moves"]
    except KeyError:
        learnset = []
    # -6/-6 defenses inflate the benchmark's damage so the game's integer floor
    # steps stop dominating the ratio (an uninvested Milotic took rolls of only
    # ~17-34, reporting a true x4.5 as x4.2 and dropping real x1.3 boosts).
    # The stages cancel between the neutral and boosted calcs, so the ratio
    # is unchanged in principle — just far less noisy.
    bench = Combatant(SIGNATURE_BENCHMARK, ability="Pressure",
                      stages={"def": -6, "spd": -6})
    self_weather = SELF_WEATHER_ABILITIES.get(ability)
    self_terrain = SELF_TERRAIN_ABILITIES.get(ability)

    def _self_sets(key: str, kind: str) -> bool:
        return ((kind == "weather" and self_weather == key)
                or (kind == "terrain" and self_terrain == key))

    spikes = []
    for name in learnset:
        m = move_db.get(name)
        if not m or m["category"] == "Status":
            continue
        base = _spike_power(attacker, bench, name, Field())
        if base <= 0:
            continue
        cands = []
        for key, kind, label in _SPIKE_CONDITIONS:
            field = Field(weather=key) if kind == "weather" else Field(terrain=key)
            ratio = _spike_power(attacker, bench, name, field) / base
            if ratio >= min_ratio:
                cands.append((key, kind, label, ratio))
        if not cands:
            continue
        # Among near-equal boosts (Weather Ball is identical under every weather)
        # prefer the condition this Pokemon sets itself, so a Snow Warning user
        # reads "self · Snow Warning" rather than "needs Sun setter".
        top = max(c[3] for c in cands)
        near = [c for c in cands if c[3] >= top - 0.05]
        key, kind, label, ratio = max(near, key=lambda c: (_self_sets(c[0], c[1]), c[3]))
        best = {"key": key, "kind": kind, "label": label, "ratio": round(ratio, 1)}
        # Effective type under the winning condition (Weather Ball's weather
        # type, an -ate ability's conversion), straight from the engine.
        best_field = (Field(weather=best["key"]) if best["kind"] == "weather"
                      else Field(terrain=best["key"]))
        boosted_type = calculate(attacker, bench, name, best_field).get("type", m["type"])
        self_set = ((best["kind"] == "weather" and self_weather == best["key"])
                    or (best["kind"] == "terrain" and self_terrain == best["key"]))
        spikes.append({
            "move": name,
            "type": boosted_type,
            "category": m["category"],
            "condition": best["label"],
            "condition_key": best["key"],
            "condition_kind": best["kind"],
            "multiplier": best["ratio"],
            "self_enabled": self_set,
            "setter_ability": ability if self_set else None,
        })
    spikes.sort(key=lambda s: s["multiplier"], reverse=True)
    return {
        "pokemon_id": attacker.pokemon_id,
        "name": mon["name"],
        "ability": ability,
        "spikes": spikes[:top_n],
    }


def threat_scan(defender: Combatant, regulation: str = dataio.DEFAULT_REGULATION,
                top_n: int = 15, include: list[str] | None = None,
                field: Field | None = None, practical: bool = True,
                use_meta_sets: bool = False, meta_only: bool = False) -> dict:
    field = field or Field()
    pool = include or [
        pid for pid, m in dataio.pokedex().items()
        if regulation in m.get("regulations", [])
    ]
    meta = dataio.meta_sets()["pokemon"] if use_meta_sets else {}
    if use_meta_sets and meta_only:
        pool = [pid for pid in pool if pid in meta]
    threats = []
    for attacker_id in pool:
        a_mon = dataio.get_pokemon(attacker_id)
        if use_meta_sets and attacker_id in meta:
            for entry in _meta_threat_entries(attacker_id, a_mon,
                                              meta[attacker_id], defender):
                entry["_score"] = (entry["pct_range"][1]
                                   + entry["ohko_chance"] * 2)
                threats.append(entry)
            continue
        best = _best_hit(attacker_id, defender, field, practical)
        if best is None:
            continue
        threats.append({
            "attacker": attacker_id,
            "attacker_name": a_mon["name"],
            "meta": False,
            "speed": _speed_relation(defender, a_mon),
            **{k: v for k, v in best.items() if k != "_score"},
            "_score": best["_score"],
        })
    threats.sort(key=lambda t: t["_score"], reverse=True)
    for t in threats:
        del t["_score"]
    d_mon = dataio.get_pokemon(defender.pokemon_id)
    return {
        "defender": {"id": d_mon["id"], "name": d_mon["name"],
                     "spread": defender.spread.as_dict(),
                     "alignment": defender.alignment,
                     "ability": defender.ability, "item": defender.item},
        "assumptions": ("known ladder sets use their real spread/item/"
                        "ability; others at " if use_meta_sets else
                        "attackers at ")
                       + "32 SP + boosting alignment, no item, "
                       "best listed ability per move"
                       + ("; recharge and <70% accuracy moves excluded"
                          if practical else ""),
        "meta_label": dataio.meta_sets()["info"].get("label")
                      if use_meta_sets else None,
        "scanned": len(pool),
        "ohko_threats": [t for t in threats if t["ohko_chance"] > 0][:top_n],
        "top_threats": threats[:top_n],
    }


def team_analysis(team: list[Combatant], regulation: str = dataio.DEFAULT_REGULATION,
                  top_n: int = 10) -> dict:
    """Shared weaknesses + attackers that threaten multiple members."""
    profiles = [defensive_profile(c.pokemon_id, c.ability) for c in team]
    shared = {}
    for t in ALL_TYPES:
        hit = [p["pokemon"]["id"] for p in profiles if p["matchups"][t] > 1]
        if len(hit) >= 2:
            shared[t] = hit

    # Aggregate per-attacker pressure across the team.
    pressure: dict[str, dict] = {}
    for member in team:
        scan = threat_scan(member, regulation, top_n=10_000)
        for t in scan["top_threats"]:
            if t["ohko_chance"] == 0 and not t["guaranteed_2hko"]:
                continue
            entry = pressure.setdefault(t["attacker"], {
                "attacker": t["attacker"], "attacker_name": t["attacker_name"],
                "threatens": []})
            entry["threatens"].append({
                "member": member.pokemon_id, "move": t["move"],
                "ability": t["ability"], "pct_range": t["pct_range"],
                "ohko_chance": t["ohko_chance"],
                "guaranteed_2hko": t["guaranteed_2hko"], "speed": t["speed"],
            })
    multi = [p for p in pressure.values() if len(p["threatens"]) >= 2]
    multi.sort(key=lambda p: (-len(p["threatens"]),
                              -max(x["ohko_chance"] for x in p["threatens"])))
    return {
        "team": [c.pokemon_id for c in team],
        "shared_weaknesses": shared,
        "multi_member_threats": multi[:top_n],
    }


def suggest_teammates(team_ids: list[str], regulation: str = dataio.DEFAULT_REGULATION,
                      top_n: int = 8) -> dict:
    """Rank legal Pokemon by defensive synergy with the current team:
    covering its weaknesses without stacking new shared ones."""
    from vgc_toolkit.core.teams import species_root

    profiles = [defensive_profile(pid) for pid in team_ids]
    weak_counts = {t: sum(1 for p in profiles if p["matchups"][t] > 1)
                   for t in ALL_TYPES}
    taken_roots = {species_root(pid) for pid in team_ids}

    scored = []
    for pid, mon in dataio.pokedex().items():
        if regulation not in mon.get("regulations", []):
            continue
        if species_root(pid) in taken_roots:
            continue
        prof = defensive_profile(pid)
        score, covers = 50.0, []
        for t, cnt in weak_counts.items():
            m = prof["matchups"][t]
            if cnt > 0:
                if m == 0:
                    score += 9 * cnt; covers.append(t)
                elif m < 1:
                    score += 5 * cnt; covers.append(t)
                elif m > 1:
                    score -= 5 * cnt
        # light penalty for fresh quad weaknesses
        score -= 2 * len(prof["quad_weak"])
        scored.append({
            "pokemon_id": pid,
            "name": mon["name"],
            "types": mon["types"],
            "score": max(0, min(100, round(score))),
            "reason": (f"Covers your {', '.join(covers[:3])} weakness"
                       + ("es" if len(covers[:3]) > 1 else "")
                       if covers else "Solid neutral defensive fit"),
        })
    scored.sort(key=lambda s: s["score"], reverse=True)
    return {"team": team_ids, "suggestions": scored[:top_n]}


def offensive_scan(attacker, moves: list[str], regulation: str = dataio.DEFAULT_REGULATION,
                   pool_hp_sp: int = 0, pool_def_sp: int = 0,
                   pool_alignment: str = "neutral", top_n: int = 25,
                   field=None) -> dict:
    """Your actual build and moves thrown at every legal Pokemon.

    Pool targets use a configurable bulk benchmark and their default ability.
    """
    from vgc_toolkit.core.damage import Combatant, Field, calculate
    from vgc_toolkit.core.stats import SPSpread, calc_stat

    field = field or Field()
    atk_mon = dataio.get_pokemon(attacker.pokemon_id)
    atk_speed_stat = calc_stat(
        atk_mon["base"]["spe"], attacker.spread.as_dict()["spe"],
        _alignment_mult(attacker.alignment, "spe"))
    damaging = [m for m in moves
                if m and dataio.moves().get(m, {}).get("category") != "Status"]
    results = []
    for pid, mon in dataio.pokedex().items():
        if regulation not in mon.get("regulations", []):
            continue
        best = None
        for move_name in damaging:
            mv = dataio.moves().get(move_name)
            if not mv:
                continue
            def_key = "def" if mv["category"] == "Physical" else "spd"
            mult = {"boost": 1.1, "neutral": 1.0, "reduce": 0.9}[pool_alignment]
            spread = SPSpread.from_dict({"hp": pool_hp_sp,
                                         def_key: pool_def_sp})
            target = Combatant(pid, spread=spread, alignment="Serious")
            # benchmark alignment multiplier applied via stages-free recalc:
            # easiest correct route is a custom alignment; emulate by scaling
            # through an explicit defensive stage is wrong, so we instead pick
            # a real alignment that boosts/reduces that defense.
            if mult != 1.0:
                target = Combatant(pid, spread=spread,
                                   alignment=_defensive_alignment(def_key, mult))
            try:
                r = calculate(attacker, target, move_name, field)
            except KeyError:
                continue
            if best is None or r["pct_range"][1] > best["pct_range"][1]:
                best = {**r, "move": move_name}
        if best is None:
            continue
        target_max_speed = calc_stat(mon["base"]["spe"], 32, 1.1)
        if atk_speed_stat > target_max_speed:
            speed = "you_outspeed_even_their_max"
        elif atk_speed_stat == target_max_speed:
            speed = "speed_tie_at_their_max"
        elif atk_speed_stat > calc_stat(mon["base"]["spe"], 0, 1.0):
            speed = "you_outspeed_uninvested"
        else:
            speed = "they_outspeed"
        results.append({
            "target": pid, "target_name": mon["name"], "types": mon["types"],
            "move": best["move"], "pct_range": best["pct_range"],
            "ohko_chance": best["ko_chances"].get("1hko", 0.0),
            "guaranteed_2hko": best["ko_chances"].get("2hko", 0.0) == 100.0,
            "speed": speed,
        })
    results.sort(key=lambda r: (r["pct_range"][1], r["pct_range"][0]),
                 reverse=True)
    return {
        "attacker": {"id": attacker.pokemon_id, "name": atk_mon["name"]},
        "moves_used": damaging,
        "pool": {"hp_sp": pool_hp_sp, "def_sp": pool_def_sp,
                 "alignment": pool_alignment},
        "scanned": len(results),
        "targets": results[:top_n],
    }


def _alignment_mult(alignment: str, stat: str) -> float:
    a = dataio.alignments().get(alignment, {})
    if a.get("boost") == stat:
        return 1.1
    if a.get("reduce") == stat:
        return 0.9
    return 1.0


def _defensive_alignment(def_key: str, mult: float) -> str:
    """A real alignment that boosts/reduces the given defense without
    touching the other defense (offense drop is irrelevant to incoming damage)."""
    table = {
        ("def", 1.1): "Impish",   # +Def -SpA
        ("def", 0.9): "Lonely",   # +Atk -Def
        ("spd", 1.1): "Calm",     # +SpD -Atk
        ("spd", 0.9): "Naughty",  # +Atk -SpD
    }
    return table[(def_key, mult)]


def survival_solve(defender_id: str, alignment: str, attacker, move: str,
                   field=None, defender_ability: str | None = None,
                   defender_item: str | None = None,
                   mode: str = "guaranteed", top_n: int = 5) -> dict:
    """Cheapest HP/defense SP allocations that survive the given attack.

    modes: guaranteed (max roll < HP) | avoid_ohko (min roll < HP)
           | two_hits (2x max roll < HP)
    """
    from vgc_toolkit.core.damage import Combatant, Field, calculate
    from vgc_toolkit.core.stats import SPSpread, calc_hp

    field = field or Field()
    mon = dataio.get_pokemon(defender_id)
    mv = dataio.moves()[move]
    def_key = "def" if mv["category"] == "Physical" else "spd"

    # damage depends on the defense SP only; HP SP only moves the bar.
    rolls_by_def = {}
    for d in range(33):
        c = Combatant(defender_id, spread=SPSpread.from_dict({def_key: d}),
                      alignment=alignment, ability=defender_ability,
                      item=defender_item)
        rolls_by_def[d] = calculate(attacker, c, move, field)["rolls"]

    def survives(rolls, hp):
        if mode == "avoid_ohko":
            return min(rolls) < hp
        if mode == "two_hits":
            return 2 * max(rolls) < hp
        return max(rolls) < hp

    solutions = []
    for h in range(33):
        hp = calc_hp(mon["base"]["hp"], h)
        for d in range(33):
            rolls = rolls_by_def[d]
            if survives(rolls, hp):
                pct = [round(min(rolls) / hp * 100, 1),
                       round(max(rolls) / hp * 100, 1)]
                solutions.append({
                    "hp_sp": h, "def_sp": d, "def_stat": def_key,
                    "total": h + d, "leftover": 66 - h - d,
                    "hp": hp, "pct_range": pct,
                })
                break  # cheapest def for this hp; larger d only costs more
    solutions.sort(key=lambda s: (s["total"], abs(s["hp_sp"] - s["def_sp"])))

    out = {
        "defender": {"id": defender_id, "name": mon["name"],
                     "alignment": alignment, "ability": defender_ability,
                     "item": defender_item},
        "attack": {"attacker": attacker.pokemon_id, "move": move,
                   "defense_stat": def_key, "mode": mode},
        "solvable": bool(solutions),
        "solutions": solutions[:top_n],
    }
    if not solutions:
        rolls = rolls_by_def[32]
        hp = calc_hp(mon["base"]["hp"], 32)
        out["best_attempt"] = {
            "hp_sp": 32, "def_sp": 32, "def_stat": def_key,
            "pct_range": [round(min(rolls) / hp * 100, 1),
                          round(max(rolls) / hp * 100, 1)],
        }
    return out


def _meta_threat_entries(pid, mon, meta_entry, defender) -> list[dict]:
    """One threat entry per known ladder set, with its real item/spread."""
    from vgc_toolkit.core.damage import Combatant, Field, calculate
    from vgc_toolkit.core.stats import SPSpread, calc_stat

    entries = []
    for s in meta_entry["sets"]:
        attacker = Combatant(pid, spread=SPSpread.from_dict(s["spread"]),
                             alignment=s["alignment"], ability=s["ability"],
                             item=s["item"])
        field = Field()
        ab = s["ability"] or ""
        if ab in WEATHER_SETTERS:
            field = Field(weather=WEATHER_SETTERS[ab])
        best = None
        for move_name in s["moves"]:
            mv = dataio.moves().get(move_name)
            if not mv or mv["category"] == "Status":
                continue
            try:
                r = calculate(attacker, defender, move_name, field)
            except KeyError:
                continue
            if best is None or r["pct_range"][1] > best["pct_range"][1]:
                best = {**r, "move": move_name}
        if best is None:
            continue
        d_mon = dataio.get_pokemon(defender.pokemon_id)
        def_spe = calc_stat(d_mon["base"]["spe"],
                            defender.spread.as_dict()["spe"],
                            _alignment_mult(defender.alignment, "spe"))
        if defender.item == "Choice Scarf":
            def_spe = int(def_spe * 1.5)
        spe = calc_stat(mon["base"]["spe"], s["spread"]["spe"],
                        _alignment_mult(s["alignment"], "spe"))
        if s["item"] == "Choice Scarf":
            spe = int(spe * 1.5)
        if spe > def_spe:
            speed = "outspeeds_you"
        elif spe == def_spe:
            speed = "speed_tie"
        else:
            speed = "you_outspeed"
        entries.append({
            "attacker": pid, "attacker_name": mon["name"],
            "move": best["move"], "ability": s["ability"],
            "item": s["item"],
            "set_name": s["name"], "set_weight": s["weight"],
            "usage": meta_entry["usage"], "meta": True,
            "pct_range": best["pct_range"],
            "ohko_chance": best["ko_chances"].get("1hko", 0.0),
            "guaranteed_2hko": best["ko_chances"].get("2hko", 0.0) == 100.0,
            "accuracy": dataio.moves()[best["move"]].get("accuracy"),
            "speed": speed,
            "set": s,
        })
    return entries


def team_threat_scan(team: list[Combatant], regulation: str = dataio.DEFAULT_REGULATION,
                     top_n: int = 20, practical: bool = True,
                     use_meta_sets: bool = False,
                     meta_only: bool = False) -> dict:
    """Threats vs the whole team: each attacker (or ladder set) is scored
    by how many members it OHKOs and how hard it hits across the board."""
    member_ids = [c.pokemon_id for c in team]
    rows: dict = {}
    for c in team:
        scan = threat_scan(c, regulation, top_n=10_000, practical=practical,
                           use_meta_sets=use_meta_sets, meta_only=meta_only)
        for t in scan["top_threats"]:
            key = (t["attacker"], t.get("set_name") or "")
            r = rows.setdefault(key, {
                "attacker": t["attacker"],
                "attacker_name": t["attacker_name"],
                "meta": t.get("meta", False),
                "set_name": t.get("set_name"),
                "usage": t.get("usage"),
                "item": t.get("item"), "ability": t.get("ability"),
                "set": t.get("set"),
                "members": {},
            })
            r["members"][c.pokemon_id] = {
                "move": t["move"], "pct_range": t["pct_range"],
                "ohko_chance": t["ohko_chance"], "speed": t["speed"],
            }
    out = []
    for r in rows.values():
        per_member = [
            {"id": pid, **r["members"][pid]} if pid in r["members"] else
            {"id": pid, "move": None, "pct_range": [0, 0],
             "ohko_chance": 0.0, "speed": None}
            for pid in member_ids
        ]
        ohkos = sum(1 for m in per_member if m["ohko_chance"] > 0)
        avg_max = sum(m["pct_range"][1] for m in per_member) / len(per_member)
        out.append({**{k: v for k, v in r.items() if k != "members"},
                    "per_member": per_member,
                    "ohko_count": ohkos,
                    "avg_max_pct": round(avg_max, 1)})
    out.sort(key=lambda r: (r["ohko_count"], r["avg_max_pct"]), reverse=True)
    d = dataio.meta_sets()["info"] if use_meta_sets else {}
    return {
        "members": [{"id": pid,
                     "name": dataio.get_pokemon(pid)["name"]}
                    for pid in member_ids],
        "meta_label": d.get("label") if use_meta_sets else None,
        "rows": out[:top_n],
    }
