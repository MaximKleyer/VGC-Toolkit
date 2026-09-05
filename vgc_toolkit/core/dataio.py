"""Cached loaders for the canonical JSON data files.

All toolkit modules read game data through here so there is exactly one
source of truth and one place to invalidate if data is regenerated.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


@lru_cache(maxsize=None)
def _load(filename: str) -> dict:
    path = DATA_DIR / filename
    if not path.exists():
        raise FileNotFoundError(
            f"Missing data file {path}. Run the scripts/ ingestion scripts first "
            "(see README: Data pipeline)."
        )
    return json.loads(path.read_text())


@lru_cache(maxsize=1)
def pokedex() -> dict:
    """The canonical pokedex with any user ability overrides applied (see
    ability_overrides()). The raw file's cached dict is never mutated."""
    dex = _load("pokedex.json")
    overrides = ability_overrides()
    if not overrides:
        return dex
    merged = dict(dex)
    for pid, abilities in overrides.items():
        mon = merged.get(pid)
        if mon is None or not abilities:
            continue
        merged[pid] = {**mon, "abilities": list(abilities), "ability_override": True}
    return merged


def alignments() -> dict:
    return _load("alignments.json")


def speed_abilities() -> dict:
    return _load("speed_abilities.json")


def items() -> dict:
    return _load("items.json")


def type_chart() -> dict:
    return _load("type_chart.json")


def get_pokemon(pokemon_id: str) -> dict:
    mon = pokedex().get(pokemon_id)
    if mon is None:
        raise KeyError(f"Unknown pokemon id: {pokemon_id!r}")
    return mon


def type_effectiveness(move_type: str, defender_types: list[str]) -> float:
    """Combined effectiveness of one attacking type into a defender's typing."""
    chart = type_chart()
    mult = 1.0
    for t in defender_types:
        mult *= chart[move_type][t]
    return mult


def clear_cache() -> None:
    """Invalidate loaded data (call after re-running ingestion scripts)."""
    _load.cache_clear()
    pokedex.cache_clear()
    meta_sets.cache_clear()


# ---------- user ability overrides ----------

# Module-level so tests can point it at a temp file.
ABILITY_OVERRIDES_PATH = DATA_DIR / "ability_overrides.json"


def ability_overrides() -> dict[str, list[str]]:
    """User-set ability lists keyed by pokemon id, from the optional
    ability_overrides.json. Lets a form whose Champions ability has not been
    announced yet (``abilities_provisional`` in pokedex.json) be given a
    working ability until the real one is known. Keys starting with "_" are
    comments."""
    if not ABILITY_OVERRIDES_PATH.exists():
        return {}
    raw = json.loads(ABILITY_OVERRIDES_PATH.read_text())
    return {k: [str(a) for a in v] for k, v in raw.items()
            if not k.startswith("_") and isinstance(v, list)}


def save_ability_overrides(overrides: dict[str, list[str]]) -> None:
    """Persist overrides (dropping empty lists) and invalidate the caches so
    the next pokedex() call reflects them."""
    body: dict = {"_comment": (
        "User-set abilities for forms whose Champions ability is not announced "
        "yet. Edited via PUT /api/pokemon/{id}/abilities in the UI; an empty "
        "list (or removing the key) restores what pokedex.json ships.")}
    body.update({k: list(v) for k, v in sorted(overrides.items()) if v})
    ABILITY_OVERRIDES_PATH.write_text(json.dumps(body, indent=1) + "\n")
    clear_cache()


def all_abilities() -> list[str]:
    """Every ability name known to the data set (shipped abilities, speed
    abilities, and user overrides), for the provisional-ability picker."""
    names: set[str] = set()
    for mon in _load("pokedex.json").values():
        names.update(mon.get("abilities", []))
    names.update(speed_abilities().keys())
    for abilities in ability_overrides().values():
        names.update(abilities)
    return sorted(names)


def learnsets() -> dict:
    return _load("learnsets.json")


def moves() -> dict:
    return _load("moves.json")


def get_move(name: str) -> dict:
    move = moves().get(name)
    if move is None:
        raise KeyError(f"Unknown move: {name!r}")
    return move


def get_learnset(pokemon_id: str) -> dict:
    """Learnset for a pokemon. Megas resolve to their base form's learnset."""
    mon = get_pokemon(pokemon_id)
    lookup_id = mon.get("mega_of") or mon.get("forme_of") or pokemon_id
    ls = learnsets().get(lookup_id)
    if ls is None:
        raise KeyError(f"No learnset data for {lookup_id!r}")
    return ls


@lru_cache(maxsize=1)
def meta_sets() -> dict:
    """Ladder meta sets (optional data file; empty dict when absent)."""
    path = DATA_DIR / "meta_sets.json"
    if not path.exists():
        return {"info": {}, "pokemon": {}}
    return json.loads(path.read_text())


# ---------- regulations ----------

def regulations() -> list[dict]:
    """Every regulation tag present in the pokedex, oldest to newest, with the
    number of forms legal in each. Drives the UI's regulation selector."""
    counts: dict[str, int] = {}
    for mon in pokedex().values():
        for r in mon.get("regulations", []):
            counts[r] = counts.get(r, 0) + 1
    return [{"regulation": r, "forms": n} for r, n in sorted(counts.items())]


def default_regulation() -> str:
    """The newest regulation in the data (lexical: M-A < M-B < M-C)."""
    regs = regulations()
    return regs[-1]["regulation"] if regs else "M-B"


# Single source of truth for every backend default. Because it is derived from
# the data, tagging a new regulation's forms in pokedex.json flips it without
# code changes.
DEFAULT_REGULATION = default_regulation()
