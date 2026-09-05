"""Speed tier engine.

Mirrors the champions-speed-calc semantics: Level 50, 31 IVs, SP spreads,
with field-conditional ability multipliers (Swift Swim in rain, etc.),
Choice Scarf, stat stages, Tailwind, paralysis, and Trick Room ordering.

Multiplier order (each step floored):
    staged stat -> ability -> item -> tailwind (x2) -> paralysis (x0.5)

The tier ladder merges two kinds of rows:
  POOL rows    - every regulation-legal form at standard benchmarks
                 (max: 32 SP + speed alignment; uninvested: 0 SP neutral),
                 with conditional speed abilities applied when the field
                 activates them (a rain ladder shows Swift Swim doubled).
  TEAM rows    - your actual builds: exact spread/alignment/ability/item,
                 plus your side's Tailwind and per-member stages/status.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from vgc_toolkit.core import dataio, stats
from vgc_toolkit.core.damage import Combatant


@dataclass
class SpeedField:
    weather: str = "none"        # none|sun|rain|sand|snow
    terrain: str = "none"
    tailwind: bool = False       # your side (applied to team rows)
    opposing_tailwind: bool = False  # their side (applied to pool rows)
    trick_room: bool = False     # reverses the ladder order


@dataclass
class PoolBenchmark:
    """How the non-team pool is benchmarked on the ladder."""
    sp: int = 32                 # 0-32 SP in Speed for every pool Pokemon
    alignment: str = "boost"     # boost (+10%) | neutral | reduce (-10%)

    @property
    def multiplier(self) -> float:
        return {"boost": 1.1, "neutral": 1.0, "reduce": 0.9}[self.alignment]

    @property
    def label(self) -> str:
        suffix = {"boost": "+Spe", "neutral": "neutral", "reduce": "-Spe"}[self.alignment]
        return f"{self.sp} SP {suffix}"


def _ability_multiplier(ability: str | None, field: SpeedField,
                        status: str | None) -> tuple[float, str | None]:
    spec = dataio.speed_abilities().get(ability or "")
    if not spec or not spec.get("multiplier"):
        return 1.0, None
    cond, value = spec["condition"], spec.get("value")
    active = (
        (cond == "weather" and field.weather == value)
        or (cond == "terrain" and field.terrain == value)
        or (cond == "status" and status is not None)
    )
    return (spec["multiplier"], ability) if active else (1.0, None)


def effective_speed(combatant: Combatant, field: SpeedField,
                    tailwind_applies: bool = False) -> dict:
    mon = dataio.get_pokemon(combatant.pokemon_id)
    ability = combatant.ability or (mon["abilities"][0] if mon["abilities"] else None)
    base_stat = stats.calc_stat(
        mon["base"]["spe"], combatant.spread.as_dict()["spe"],
        stats.alignment_multiplier(combatant.alignment, "spe"))
    speed = stats.apply_stage(base_stat, combatant.stages.get("spe", 0))
    applied = []

    mult, src = _ability_multiplier(ability, field, combatant.status)
    if src:
        speed = math.floor(speed * mult)
        applied.append(f"{src} x{mult:g}")
    item = dataio.items().get(_slug(combatant.item)) if combatant.item else None
    if item and item.get("speed_multiplier"):
        speed = math.floor(speed * item["speed_multiplier"])
        applied.append(f"{item['name']} x{item['speed_multiplier']:g}")
    if tailwind_applies and field.tailwind:
        speed = math.floor(speed * 2)
        applied.append("Tailwind x2")
    if combatant.status == "paralysis":
        speed = math.floor(speed * 0.5)
        applied.append("Paralysis x0.5")
    return {"speed": speed, "stat": base_stat, "applied": applied}


def speed_tiers(team: list[Combatant], field: SpeedField | None = None,
                regulation: str = dataio.DEFAULT_REGULATION,
                pool: PoolBenchmark | None = None) -> dict:
    field = field or SpeedField()
    pool = pool or PoolBenchmark()
    rows = []
    team_roots = set()

    for c in team:
        mon = dataio.get_pokemon(c.pokemon_id)
        team_roots.add(c.pokemon_id)
        eff = effective_speed(c, field, tailwind_applies=True)
        rows.append({
            "id": mon["id"], "name": mon["name"], "types": mon["types"],
            "is_team": True,
            "speed": eff["speed"],
            "detail": f"{c.spread.as_dict()['spe']} SP {c.alignment}",
            "applied": eff["applied"],
        })

    for pid, mon in dataio.pokedex().items():
        if regulation not in mon.get("regulations", []) or pid in team_roots:
            continue
        base = mon["base"]["spe"]
        pool_speed = stats.calc_stat(base, pool.sp, pool.multiplier)
        applied = []
        # Conditional speed ability active under this field? Show it boosted.
        for ab in mon["abilities"]:
            mult, src = _ability_multiplier(ab, field, None)
            if src:
                pool_speed = math.floor(pool_speed * mult)
                applied.append(f"{src} x{mult:g}")
                break
        if field.opposing_tailwind:
            pool_speed = math.floor(pool_speed * 2)
            applied.append("Opp Tailwind x2")
        rows.append({
            "id": pid, "name": mon["name"], "types": mon["types"],
            "is_team": False,
            "speed": pool_speed,
            "detail": pool.label,
            "applied": applied,
        })

    rows.sort(key=lambda r: r["speed"], reverse=not field.trick_room)
    return {
        "field": {"weather": field.weather, "terrain": field.terrain,
                  "tailwind": field.tailwind,
                  "opposing_tailwind": field.opposing_tailwind,
                  "trick_room": field.trick_room},
        "pool": {"sp": pool.sp, "alignment": pool.alignment},
        "order": "slowest first (Trick Room)" if field.trick_room else "fastest first",
        "rows": rows,
    }


def _slug(name):
    import re
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-") or None
