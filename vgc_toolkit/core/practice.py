"""Practice-bot opponents for the Battle tab.

Builds a plausible ladder team from the usage data in meta_sets.json. The seed
Pokemon is drawn weighted by usage; every further slot is chosen by how often
the candidate actually appears alongside the members picked so far (the chaos
"Teammates" co-occurrence data the ingest keeps), so the result resembles a
real ladder core rather than six independent popular picks. Each member gets
one of its recorded sets (weighted by set frequency). Flat Rules constraints
are kept: species clause via the species root, Item Clause = 1. The result is
exported as a Showdown paste that the simulator sidecar accepts.
"""

from __future__ import annotations

import math
import random

from vgc_toolkit.core import damage, dataio, stats, teams


def _pool(regulation: str, top_n: int) -> list[tuple[str, dict]]:
    dex = dataio.pokedex()
    meta = dataio.meta_sets().get("pokemon", {})
    pool = [(pid, m) for pid, m in meta.items()
            if pid in dex and regulation in dex[pid].get("regulations", []) and m.get("sets")]
    pool.sort(key=lambda kv: -kv[1].get("usage", 0))
    return pool[:top_n]


def _member(pid: str, m: dict, items_seen: set[str], rng: random.Random) -> teams.TeamMember | None:
    sets = [s for s in m["sets"] if s.get("moves")]
    free = [s for s in sets if not s.get("item") or s["item"] not in items_seen]   # Item Clause
    if not free:
        return None
    s = rng.choices(free, weights=[max(x.get("weight", 1.0), 0.01) for x in free])[0]
    try:
        spread = stats.SPSpread.from_dict(s.get("spread") or {})
    except Exception:
        spread = stats.SPSpread()
    return teams.TeamMember(
        combatant=damage.Combatant(pid, spread=spread, alignment=s.get("alignment") or "Serious",
                                   ability=s.get("ability") or None, item=s.get("item") or None),
        moves=[mv for mv in s["moves"] if mv][:4])


def random_meta_team(regulation: str | None = None, size: int = 6, top_n: int = 40,
                     seed: int | None = None, coherent: bool = True) -> list[teams.TeamMember]:
    rng = random.Random(seed)
    regulation = regulation or dataio.DEFAULT_REGULATION
    pool = _pool(regulation, top_n)
    if not pool:
        return []
    by_id = dict(pool)

    chosen: list[teams.TeamMember] = []
    species_seen: set[str] = set()
    items_seen: set[str] = set()

    def take(pid: str) -> bool:
        root = teams.species_root(pid)
        if root in species_seen:
            return False
        member = _member(pid, by_id[pid], items_seen, rng)
        if member is None:
            return False
        chosen.append(member)
        species_seen.add(root)
        if member.combatant.item:
            items_seen.add(member.combatant.item)
        return True

    # Seed: usage-weighted.
    for _ in range(50):
        pid, m = rng.choices(pool, weights=[max(m.get("usage", 1.0), 0.1) for _, m in pool])[0]
        if take(pid):
            break

    # Fill: candidates scored by co-occurrence with every member picked so far
    # (falls back to usage when no teammate data exists), sampled from the top.
    while len(chosen) < size:
        scores = []
        for pid, m in pool:
            if teams.species_root(pid) in species_seen:
                continue
            if coherent and any(mm.get("teammates") for mm in by_id.values()):
                affinity = 0.0
                for mem in chosen:
                    mates = by_id[mem.combatant.pokemon_id].get("teammates", [])
                    affinity += next((t["share"] for t in mates if t["pokemon_id"] == pid), 0.0)
                score = (affinity + 0.002) * math.sqrt(max(m.get("usage", 1.0), 0.1))
            else:
                score = max(m.get("usage", 1.0), 0.1)
            scores.append((pid, score))
        if not scores:
            break
        scores.sort(key=lambda x: -x[1])
        top = scores[:6]
        pid = rng.choices([p for p, _ in top], weights=[s for _, s in top])[0]
        if not take(pid):
            # Item clash or duplicate species root: drop it from consideration.
            pool = [(p, m) for p, m in pool if p != pid]
            by_id.pop(pid, None)
    return chosen


def describe_team(members: list[teams.TeamMember]) -> list[dict]:
    out = []
    for mem in members:
        c = mem.combatant
        mon = dataio.get_pokemon(c.pokemon_id)
        out.append({"pokemon_id": c.pokemon_id, "name": mon["name"], "item": c.item,
                    "ability": c.ability, "alignment": c.alignment,
                    "spread": c.spread.as_dict(), "moves": list(mem.moves)})
    return out
