"""Team-preview analysis: the strategic layer before a doubles match.

You see the opponent's six species at preview, not their spreads — so the
opponent side is resolved from the ladder meta sets (their most likely
build), while your side uses your exact builds. From a speed-aware 1v1
matchup matrix we derive: how likely each opposing Pokemon is to lead, what
you should lead, and which four you should bring.

Everything here is a doubles *approximation* built on 1v1 cells (real games
have double-targeting, Protect, switching, and positioning). It is meant to
frame the read, not replace it.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from itertools import combinations

from vgc_toolkit.core import dataio
from vgc_toolkit.core.damage import Combatant, Field, calculate, _slug
from vgc_toolkit.core.stats import SPSpread, calc_stat
from vgc_toolkit.core.matchup import (
    _alignment_mult, defensive_profile, WEATHER_SETTERS,
)
from vgc_toolkit.core.teams import _stone_family

TERRAIN_SETTERS = {"Electric Surge": "electric", "Grassy Surge": "grassy",
                   "Misty Surge": "misty", "Psychic Surge": "psychic"}
FAKE_OUT = "Fake Out"
REDIRECTION = {"Follow Me", "Rage Powder"}
PIVOTS = {"U-turn", "Volt Switch", "Flip Turn", "Parting Shot"}
SPEED_CONTROL = {"Tailwind", "Trick Room", "Icy Wind", "Electroweb",
                 "Bleakwind Storm", "Thunder Wave", "Glare", "Nuzzle"}
TAILWIND_TR = {"Tailwind", "Trick Room"}
# Abilities that stop a Fake Out aimed at your side (Psychic Surge via the terrain).
FAKE_OUT_BLOCKERS = {"Armor Tail", "Dazzling", "Queenly Majesty", "Psychic Surge"}
ANSWER_SCORE = 30        # a matrix cell at or above this counts as an answer


def _is_mega_slot(pokemon_id: str, item: str | None) -> bool:
    """A slot that will Mega Evolve: a Mega form, or a base form holding its
    own stone. Only one Pokemon can Mega Evolve per game, so a four may carry
    at most one of these."""
    mon = dataio.get_pokemon(pokemon_id)
    if mon.get("mega_of"):
        return True
    if not item:
        return False
    it = dataio.items().get(_slug(item))
    if not it or it.get("category") != "mega_stone" or not it.get("mega_form"):
        return False
    return _stone_family(pokemon_id) == _stone_family(it["mega_form"])


# ----------------------------------------------------------------------------
# small helpers

@lru_cache(maxsize=None)
def _learnset_damaging(pid: str) -> tuple[str, ...]:
    move_db = dataio.moves()
    try:
        moves = dataio.get_learnset(pid)["moves"]
    except KeyError:
        return ()
    return tuple(m for m in moves
                 if move_db.get(m, {}).get("category") != "Status")


def _spe(combatant: Combatant) -> int:
    mon = dataio.get_pokemon(combatant.pokemon_id)
    s = calc_stat(mon["base"]["spe"], combatant.spread.as_dict()["spe"],
                  _alignment_mult(combatant.alignment, "spe"))
    if combatant.item == "Choice Scarf":
        s = int(s * 1.5)
    return s


def _ko_turns(pct_max: float) -> int:
    if pct_max >= 100:
        return 1
    if pct_max >= 50:
        return 2
    if pct_max >= 33.4:
        return 3
    if pct_max > 0:
        return 4
    return 99


def _best_attack(attacker: Combatant, moves, defender: Combatant,
                 field: Field) -> tuple:
    """Best damaging move (by max roll) of `attacker` into `defender`.

    `moves` = the real set's moves; None means assume full coverage (use any
    damaging learnset move) — used for opponents with no known ladder set.
    """
    move_db = dataio.moves()
    candidates = list(moves) if moves else list(_learnset_damaging(
        attacker.pokemon_id))
    best = (None, 0.0, 0.0)
    for name in candidates:
        mv = move_db.get(name)
        if not mv or mv["category"] == "Status":
            continue
        try:
            r = calculate(attacker, defender, name, field)
        except KeyError:
            continue
        pct = r["pct_range"][1]
        if pct > best[1]:
            best = (name, pct, r["ko_chances"].get("1hko", 0.0))
    return best


def _top_moves(pid: str, phys: bool) -> list[str]:
    """Representative coverage for an opponent with no ladder set (display)."""
    move_db = dataio.moves()
    cat = "Physical" if phys else "Special"
    damaging = [(m, move_db[m]) for m in _learnset_damaging(pid)]
    same = sorted((m for m in damaging if m[1]["category"] == cat),
                  key=lambda m: -(m[1].get("base_power") or 0))
    chosen = [m[0] for m in same[:4]]
    if len(chosen) < 4:
        rest = sorted((m for m in damaging if m[1]["category"] != cat),
                      key=lambda m: -(m[1].get("base_power") or 0))
        chosen += [m[0] for m in rest if m[0] not in chosen]
    return chosen[:4]


# ----------------------------------------------------------------------------
# opponent set resolution + field

def _resolve_opp(species: str) -> dict:
    meta = dataio.meta_sets()["pokemon"]
    if species in meta and meta[species]["sets"]:
        s = meta[species]["sets"][0]
        return {"spread": s["spread"], "alignment": s["alignment"],
                "ability": s["ability"], "item": s["item"],
                "moves": s["moves"], "usage": meta[species]["usage"],
                "meta": True, "set_name": s["name"]}
    mon = dataio.get_pokemon(species)
    base = mon["base"]
    phys = base["atk"] >= base["spa"]
    spread = {"hp": 0, "atk": 32 if phys else 0, "def": 0,
              "spa": 0 if phys else 32, "spd": 0, "spe": 32}
    ability = mon["abilities"][0] if mon.get("abilities") else None
    return {"spread": spread, "alignment": "Jolly" if phys else "Timid",
            "ability": ability, "item": None,
            "moves": _top_moves(species, phys), "usage": None,
            "meta": False, "set_name": "assumed max-offense"}


def _opp_combatant(species: str, resolved: dict) -> Combatant:
    return Combatant(species, spread=SPSpread.from_dict(resolved["spread"]),
                     alignment=resolved["alignment"],
                     ability=resolved["ability"], item=resolved["item"])


def detect_field(my_team: list[dict]) -> dict:
    """The weather/terrain your team is built to set (first setter found)."""
    weather = terrain = "none"
    source = None
    for m in my_team:
        ab = m.get("ability") or ""
        if weather == "none" and ab in WEATHER_SETTERS:
            weather = WEATHER_SETTERS[ab]
            source = f"{dataio.get_pokemon(m['pokemon_id'])['name']} ({ab})"
        if terrain == "none" and ab in TERRAIN_SETTERS:
            terrain = TERRAIN_SETTERS[ab]
            source = source or (
                f"{dataio.get_pokemon(m['pokemon_id'])['name']} ({ab})")
    return {"weather": weather, "terrain": terrain, "source": source}


# ----------------------------------------------------------------------------
# matchup matrix

def _cell_score(my_kt: int, their_kt: int, i_out: bool, tie: bool) -> int:
    if my_kt >= 99 and their_kt >= 99:
        return 0
    if my_kt >= 99:
        return -60
    if their_kt >= 99:
        return 60
    diff = their_kt - my_kt          # +ve: you KO in fewer turns
    score = diff * 25
    if diff == 0:                    # same KO race — speed is the whole story
        score += 0 if tie else (45 if i_out else -45)
    else:
        score += 0 if tie else (8 if i_out else -8)
    return max(-100, min(100, score))


@dataclass
class _Side:
    combatant: Combatant
    moves: list           # None => assume coverage (opponents w/o a set)
    spe: int


def _cell(mine: _Side, theirs: _Side, field: Field) -> dict:
    m_move, m_pct, m_ko1 = _best_attack(mine.combatant, mine.moves,
                                        theirs.combatant, field)
    t_move, t_pct, t_ko1 = _best_attack(theirs.combatant, theirs.moves,
                                        mine.combatant, field)
    my_kt, their_kt = _ko_turns(m_pct), _ko_turns(t_pct)
    i_out = mine.spe > theirs.spe
    tie = mine.spe == theirs.spe
    return {
        "score": _cell_score(my_kt, their_kt, i_out, tie),
        "my_move": m_move, "my_pct": round(m_pct, 1), "my_ko_turns": my_kt,
        "their_move": t_move, "their_pct": round(t_pct, 1),
        "their_ko_turns": their_kt,
        "i_outspeed": i_out, "speed_tie": tie,
    }


# ----------------------------------------------------------------------------
# opponent lead reads

def _lead_propensity(species: str, resolved: dict, pressure: float) -> tuple:
    moves = set(resolved["moves"])
    ability = resolved.get("ability") or ""
    item = resolved.get("item")
    base = dataio.get_pokemon(species)["base"]
    score, reasons = 0.0, []
    if FAKE_OUT in moves:
        score += 30; reasons.append("Fake Out")
    if ability == "Intimidate":
        score += 20; reasons.append("Intimidate on entry")
    if ability in WEATHER_SETTERS:
        score += 30; reasons.append(f"sets {WEATHER_SETTERS[ability]}")
    if ability in TERRAIN_SETTERS:
        score += 22; reasons.append(f"sets {TERRAIN_SETTERS[ability]} terrain")
    if "Trick Room" in moves:
        score += 25; reasons.append("Trick Room")
    if "Tailwind" in moves:
        score += 25; reasons.append("Tailwind")
    if moves & REDIRECTION:
        score += 20; reasons.append("redirection")
    if "Helping Hand" in moves:
        score += 8; reasons.append("Helping Hand")
    if item == "Choice Scarf":
        score += 12; reasons.append("Choice Scarf")
    if "Taunt" in moves:
        score += 6; reasons.append("Taunt")
    if moves & PIVOTS:
        score += 6; reasons.append("momentum pivot")
    if max(base["atk"], base["spa"]) >= 120 and base["spe"] >= 90:
        score += 10; reasons.append("fast offensive presence")
    score += pressure                          # 0..25, matchup into your team
    if pressure >= 18:
        reasons.append("pressures your team")
    return max(score, 1.0), reasons


# ----------------------------------------------------------------------------
# main entry

def team_preview(my_team: list[dict], opp_team: list[dict],
                 regulation: str = dataio.DEFAULT_REGULATION, field: dict | None = None) -> dict:
    """my_team: list of {pokemon_id, spread, alignment, ability, item, moves}.
       opp_team: list of {pokemon_id, ...optional}. Species-only is fine."""
    if not (1 <= len(my_team) <= 6) or not (1 <= len(opp_team) <= 6):
        raise ValueError("each team needs 1-6 members")

    field = field or detect_field(my_team)
    fld = Field(weather=field.get("weather", "none"),
                terrain=field.get("terrain", "none"))

    # build sides
    my_sides = []
    for m in my_team:
        c = Combatant(m["pokemon_id"],
                      spread=SPSpread.from_dict(m.get("spread", {})),
                      alignment=m.get("alignment", "Serious"),
                      ability=m.get("ability"), item=m.get("item"))
        moves = [mv for mv in (m.get("moves") or []) if mv] or None
        my_sides.append(_Side(c, moves, _spe(c)))

    my_mega_idx = [i for i, m in enumerate(my_team)
                   if _is_mega_slot(m["pokemon_id"], m.get("item"))]
    my_names = [dataio.get_pokemon(m["pokemon_id"])["name"] for m in my_team]

    opp_sides, opp_meta = [], []
    for o in opp_team:
        sp = o["pokemon_id"]
        if o.get("moves"):                      # caller supplied a real set
            resolved = {"spread": o.get("spread", {}),
                        "alignment": o.get("alignment", "Serious"),
                        "ability": o.get("ability"), "item": o.get("item"),
                        "moves": o["moves"], "usage": None, "meta": False,
                        "set_name": "your scouted set"}
        else:
            resolved = _resolve_opp(sp)
        c = _opp_combatant(sp, resolved)
        opp_sides.append(_Side(c, resolved["moves"], _spe(c)))
        opp_meta.append(resolved)

    # matrix: rows = your mons, cols = their mons
    cells = [[_cell(mine, theirs, fld) for theirs in opp_sides]
             for mine in my_sides]

    # opponent pressure per column -> lead propensity
    opp_out = []
    for j, (theirs, resolved) in enumerate(zip(opp_sides, opp_meta)):
        col = [cells[i][j]["score"] for i in range(len(my_sides))]
        pressure = max(0.0, min(50.0, -sum(col) / len(col))) * 0.5
        prop, reasons = _lead_propensity(theirs.combatant.pokemon_id,
                                         resolved, pressure)
        mon = dataio.get_pokemon(theirs.combatant.pokemon_id)
        opp_out.append({
            "id": mon["id"], "name": mon["name"], "types": mon["types"],
            "meta": resolved["meta"], "usage": resolved["usage"],
            "set_name": resolved["set_name"],
            "set": {"spread": resolved["spread"],
                    "alignment": resolved["alignment"],
                    "ability": resolved["ability"], "item": resolved["item"],
                    "moves": resolved["moves"]},
            "_prop": prop, "lead_reasons": reasons,
            "pressure": round(pressure, 1),
        })
    total_prop = sum(o["_prop"] for o in opp_out) or 1.0
    for o in opp_out:
        o["lead_pct"] = round(100 * o["_prop"] / total_prop, 1)
        o["lead_tier"] = ("high" if o["lead_pct"] >= 20 else
                          "med" if o["lead_pct"] >= 12 else "low")
    order = sorted(range(len(opp_out)), key=lambda j: -opp_out[j]["_prop"])
    projected = [opp_out[j] for j in order[:2]]
    proj_reason = "; ".join(
        f"{p['name']} ({', '.join(p['lead_reasons'][:2]) or 'offensive presence'})"
        for p in projected)

    # your lead recommendations (pairs)
    my_has_setter = any((m.get("ability") or "") in WEATHER_SETTERS
                        or (m.get("ability") or "") in TERRAIN_SETTERS
                        for m in my_team)
    prop_w = [o["_prop"] / total_prop for o in opp_out]

    def lead_score(i, k):
        # expected matchup of your pair (i,k) into the likely opposing front
        s = 0.0
        for j in range(len(opp_sides)):
            best = max(cells[i][j]["score"], cells[k][j]["score"])
            s += prop_w[j] * best
        tempo, notes = 0.0, []
        pair_moves = set((my_team[i].get("moves") or [])
                         + (my_team[k].get("moves") or []))
        pair_abils = {my_team[i].get("ability"), my_team[k].get("ability")}
        if FAKE_OUT in pair_moves:
            tempo += 12; notes.append("Fake Out tempo")
        if pair_abils & set(WEATHER_SETTERS) and my_has_setter:
            w = WEATHER_SETTERS[next(a for a in pair_abils
                                     if a in WEATHER_SETTERS)]
            tempo += 15; notes.append(f"{w} up turn 1")
        if pair_abils & set(TERRAIN_SETTERS):
            tempo += 10; notes.append("terrain up turn 1")
        if pair_moves & TAILWIND_TR:
            tempo += 12; notes.append("turn-1 speed control")
        elif pair_moves & SPEED_CONTROL:
            tempo += 7; notes.append("speed control")
        if pair_moves & REDIRECTION:
            tempo += 6; notes.append("redirection")
        # The read against their projected front: who moves first, who
        # one-shots whom, and whether their Fake Out gets through.
        why, risk = [], 0.0
        front = order[:2]
        for i_ in (i, k):
            faster = [j for j in front if my_sides[i_].spe > opp_sides[j].spe]
            slower = [j for j in front if my_sides[i_].spe < opp_sides[j].spe]
            if front and len(faster) == len(front):
                why.append(f"{my_names[i_]} outspeeds both projected leads "
                           f"({my_sides[i_].spe} vs "
                           f"{' / '.join(str(opp_sides[j].spe) for j in front)})")
            elif slower:
                why.append(f"{my_names[i_]} is slower than "
                           + " and ".join(opp_out[j]["name"] for j in slower))
            for j in front:
                c = cells[i_][j]
                if c["my_pct"] >= 100:
                    why.append(f"{my_names[i_]} OHKOs {opp_out[j]['name']} "
                               f"({c['my_move']} {c['my_pct']:.0f}%)")
                if c["their_pct"] >= 100 and not c["i_outspeed"]:
                    why.append(f"watch: {opp_out[j]['name']}'s {c['their_move']} "
                               f"OHKOs {my_names[i_]} first")
                    risk += 12
        their_fake_out = [opp_out[j]["name"] for j in front
                          if FAKE_OUT in set(opp_meta[j]["moves"])]
        if their_fake_out:
            if pair_abils & FAKE_OUT_BLOCKERS:
                why.append("their Fake Out is blocked ("
                           + next(a for a in pair_abils if a in FAKE_OUT_BLOCKERS) + ")")
            else:
                why.append(f"their Fake Out lands on turn one ({their_fake_out[0]})")
                risk += 6
        return 0.7 * s + tempo - risk, notes, why

    lead_options = []
    for i, k in combinations(range(len(my_sides)), 2):
        if i in my_mega_idx and k in my_mega_idx:
            continue                       # only one Pokemon Mega Evolves per game
        sc, notes, why = lead_score(i, k)
        wins, fears = [], []
        for j in range(len(opp_sides)):
            best = max(cells[i][j]["score"], cells[k][j]["score"])
            if best >= 30:
                wins.append(opp_out[j]["name"])
            elif best <= -25:
                fears.append(opp_out[j]["name"])
        lead_options.append({
            "pair": [my_sides[i].combatant.pokemon_id,
                     my_sides[k].combatant.pokemon_id],
            "pair_names": [dataio.get_pokemon(my_sides[i].combatant.pokemon_id)["name"],
                           dataio.get_pokemon(my_sides[k].combatant.pokemon_id)["name"]],
            "score": round(sc, 1), "notes": notes, "why": why,
            "beats": wins[:4], "loses_to": fears[:4],
        })
    lead_options.sort(key=lambda x: -x["score"])

    # bring-4
    base_off = [max(dataio.get_pokemon(s.combatant.pokemon_id)["base"]["atk"],
                    dataio.get_pokemon(s.combatant.pokemon_id)["base"]["spa"])
                for s in my_sides]
    wincon = base_off.index(max(base_off)) if base_off else None

    def combo_eval(combo):
        sc, notes, why = 0.0, [], []
        # Coverage, weighted towards the Pokemon they are likely to bring, and
        # Wolfe's rule: two answers to each of their Pokemon, an answer being a
        # matchup cell at or above ANSWER_SCORE (a KO race you win).
        cov, wsum, gaps, answers, thin, twice = 0.0, 0.0, [], {}, [], 0
        for j in range(len(opp_sides)):
            w = 1.0 + 2.0 * prop_w[j]
            best = max(cells[i][j]["score"] for i in combo)
            cov += w * best; wsum += w
            ans = [(i, cells[i][j]) for i in combo if cells[i][j]["score"] >= ANSWER_SCORE]
            ans.sort(key=lambda x: -x[1]["my_pct"])
            answers[opp_out[j]["name"]] = [
                {"mon": my_names[i], "move": c["my_move"], "pct": c["my_pct"]} for i, c in ans]
            if len(ans) >= 2:
                twice += 1; sc += 4
            elif len(ans) == 1:
                thin.append(f"{opp_out[j]['name']} ({my_names[ans[0][0]]})")
            else:
                sc -= 10
            if best <= -25:
                gaps.append(opp_out[j]["name"])
        sc += cov / wsum
        moves = set()
        for i in combo:
            moves |= set(my_team[i].get("moves") or [])
        has_scarf = any(my_team[i].get("item") == "Choice Scarf" for i in combo)
        sc_src = [my_names[i] for i in combo
                  if set(my_team[i].get("moves") or []) & SPEED_CONTROL
                  or my_team[i].get("item") == "Choice Scarf"]
        if (moves & SPEED_CONTROL) or has_scarf:
            sc += 10; notes.append("has speed control")
            why.append("Speed control: " + ", ".join(
                f"{my_names[i]} ({', '.join(sorted(set(my_team[i].get('moves') or []) & SPEED_CONTROL) or ['Choice Scarf'])})"
                for i in combo if my_names[i] in sc_src))
        else:
            notes.append("no speed control")
            why.append("No speed control in this four")
        if wincon in combo:
            sc += 6
        if my_has_setter and any(
                (my_team[i].get("ability") or "") in WEATHER_SETTERS
                or (my_team[i].get("ability") or "") in TERRAIN_SETTERS
                for i in combo):
            sc += 6; notes.append("keeps your field up")
        # shared defensive weaknesses
        weak_counts = {}
        for i in combo:
            prof = defensive_profile(my_sides[i].combatant.pokemon_id,
                                     my_team[i].get("ability"))
            for t in set(prof["weak"] + prof["quad_weak"]):
                weak_counts[t] = weak_counts.get(t, 0) + 1
        stacked = [t for t, n in weak_counts.items() if n >= 3]
        if stacked:
            sc -= 8 * len(stacked)
            notes.append("shared weakness: " + ", ".join(stacked))
            why.append("Three of the four are weak to " + ", ".join(stacked))
        if gaps:
            notes.append("struggles vs " + ", ".join(gaps[:3]))
        why.insert(0, f"Two answers to {twice} of their {len(opp_sides)}"
                   + ("" if twice == len(opp_sides) else
                      "; one answer to " + ", ".join(thin) if thin else "")
                   + ("; no answer to " + ", ".join(
                       n for n, a in answers.items() if not a) if any(not a for a in answers.values()) else ""))
        mega = [i for i in combo if i in my_mega_idx]
        if mega:
            why.append(f"Mega: {my_names[mega[0]]}"
                       + ("; " + ", ".join(my_names[i] for i in my_mega_idx if i not in combo)
                          + " stays home, only one Pokemon Mega Evolves per game"
                          if len(my_mega_idx) > 1 else ""))
        bench = [i for i in range(len(my_sides)) if i not in combo]
        for i in bench:
            row = sorted(range(len(opp_sides)), key=lambda j: cells[i][j]["score"])
            worst = [opp_out[j]["name"] for j in row[:2] if cells[i][j]["score"] < 0]
            if worst:
                why.append(f"{my_names[i]} stays home: weakest into " + ", ".join(worst))
        return sc, notes, gaps, why, answers, (my_names[mega[0]] if mega else None)

    bring = []
    if len(my_sides) > 4:
        combos = [c for c in combinations(range(len(my_sides)), 4)
                  if sum(1 for i in c if i in my_mega_idx) <= 1]
    else:
        combos = [tuple(range(len(my_sides)))]
    for combo in combos:
        sc, notes, gaps, why, answers, mega_name = combo_eval(combo)
        # restrict lead pairs to this combo
        combo_ids = {my_sides[i].combatant.pokemon_id for i in combo}
        inner = [lo for lo in lead_options
                 if set(lo["pair"]) <= combo_ids]
        lead = inner[0] if inner else None
        bench = [my_sides[i].combatant.pokemon_id for i in range(len(my_sides))
                 if i not in combo]
        bring.append({
            "mons": [my_sides[i].combatant.pokemon_id for i in combo],
            "mon_names": [dataio.get_pokemon(my_sides[i].combatant.pokemon_id)["name"]
                          for i in combo],
            "bench": bench,
            "bench_names": [dataio.get_pokemon(b)["name"] for b in bench],
            "lead": lead["pair"] if lead else None,
            "lead_names": lead["pair_names"] if lead else None,
            "score": round(sc, 1), "notes": notes, "why": why,
            "answers": answers, "mega": mega_name,
        })
    bring.sort(key=lambda x: -x["score"])

    # natural-language summary
    plan_bits = []
    if field.get("source"):
        fw = field.get("weather") if field.get("weather") != "none" else \
            field.get("terrain")
        plan_bits.append(f"Your game plan runs on {fw} from "
                         f"{field['source']}.")
    if projected:
        plan_bits.append(
            f"Expect them to lead {projected[0]['name']}"
            + (f" + {projected[1]['name']}" if len(projected) > 1 else "")
            + ".")
    if lead_options:
        top = lead_options[0]
        plan_bits.append(
            f"Your strongest lead is {top['pair_names'][0]} + "
            f"{top['pair_names'][1]}"
            + (f", {top['notes'][0]}" if top["notes"] else "")
            + (f"; it beats {', '.join(top['beats'][:2])}"
               if top["beats"] else "")
            + ".")
    if bring:
        plan_bits.append(
            "Recommended four: "
            + ", ".join(bring[0]["mon_names"])
            + (f", Mega Evolving {bring[0]['mega']}" if bring[0].get("mega") else "")
            + ".")

    return {
        "field": field,
        "matrix": {
            "rows": [s.combatant.pokemon_id for s in my_sides],
            "row_names": [dataio.get_pokemon(s.combatant.pokemon_id)["name"]
                          for s in my_sides],
            "cols": [s.combatant.pokemon_id for s in opp_sides],
            "col_names": [dataio.get_pokemon(s.combatant.pokemon_id)["name"]
                          for s in opp_sides],
            "cells": cells,
        },
        "opponent": {
            "mons": [{k: v for k, v in o.items() if k != "_prop"}
                     for o in opp_out],
            "projected_lead": {
                "pair": [p["id"] for p in projected],
                "pair_names": [p["name"] for p in projected],
                "reason": proj_reason,
            },
        },
        "your_leads": lead_options[:3],
        "bring_four": bring[:3],
        "my_megas": [my_names[i] for i in my_mega_idx],
        "summary": " ".join(plan_bits),
    }
