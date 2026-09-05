"""Add the confirmed Regulation M-C forms to the canonical data files.

Additive and idempotent: re-running after it has been applied changes nothing.

1. Tags every existing form with M-C (carry-over: M-C is M-B plus additions,
   nothing legal in M-B is removed).
2. Adds the confirmed M-C forms: Rillaboom, Salamence (+Mega), Golisopod
   (+Mega), Baxcalibur (+Mega), Mega Absol Z, Mega Garchomp Z, Mega Lucario Z.
   Types/stats/abilities come from megas_tab.json (the Champions datamine)
   where that file has the form, otherwise from the Gen 9 mainline values
   hard-coded below.
3. Adds the six new Mega Stones to items.json.
4. Adds provisional learnsets for the four new species: their Gen 9 mainline
   learnset (scripts/mc_provisional_learnsets.json) intersected with the
   Champions move pool (moves.json). Champions' own M-C learnsets are not
   published yet; re-run with --force-learnsets once real data replaces the
   provisional file.

Forms whose Champions ability is not announced get ``abilities_provisional``
so the UI offers the ability override editor (PUT /api/pokemon/{id}/abilities).

Usage:  python scripts/add_mc_forms.py [--dry-run] [--force-learnsets]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "vgc_toolkit" / "data"
DEFAULT_LEARNSETS = ROOT / "scripts" / "mc_provisional_learnsets.json"

REG = "M-C"
STONE_EFFECT = "A Mega Stone. The matching Pokemon can Mega Evolve while holding it."
LEARNSET_SOURCE = ("provisional: Gen 9 mainline learnset intersected with the "
                   "Champions move pool; replace when the Champions M-C "
                   "learnsets are published")

# Gen 9 mainline data for species absent from every Champions datamine file.
MAINLINE = {
    "rillaboom": {
        "name": "Rillaboom", "types": ["Grass"],
        "base": {"hp": 100, "atk": 125, "def": 90, "spa": 60, "spd": 70, "spe": 85},
        "abilities": ["Overgrow", "Grassy Surge"],
    },
    "salamence": {
        "name": "Salamence", "types": ["Dragon", "Flying"],
        "base": {"hp": 95, "atk": 135, "def": 80, "spa": 110, "spd": 80, "spe": 100},
        "abilities": ["Intimidate", "Moxie"],
    },
    "salamence-mega": {
        "name": "Mega Salamence", "types": ["Dragon", "Flying"],
        "base": {"hp": 95, "atk": 145, "def": 130, "spa": 120, "spd": 90, "spe": 120},
        # Mainline ability; Champions has not confirmed it, so flagged provisional.
        "abilities": ["Aerilate"],
    },
}

# (form id, spec). from_tab: read types/base/abilities/name from megas_tab.json.
NEW_FORMS: list[tuple[str, dict]] = [
    ("rillaboom", {}),
    ("salamence", {"mega_forms": ["salamence-mega"]}),
    ("golisopod", {"from_tab": True, "mega_forms": ["golisopod-mega"]}),
    ("baxcalibur", {"from_tab": True, "mega_forms": ["baxcalibur-mega"]}),
    ("salamence-mega", {"mega_of": "salamence", "mega_stone": "Salamencite",
                        "abilities_provisional": True}),
    ("golisopod-mega", {"from_tab": True, "mega_of": "golisopod",
                        "mega_stone": "Golisopodite"}),
    ("baxcalibur-mega", {"from_tab": True, "mega_of": "baxcalibur",
                         "mega_stone": "Baxcaliburite"}),
    ("absol-mega-z", {"from_tab": True, "mega_of": "absol", "mega_stone": "Absolite Z"}),
    ("garchomp-mega-z", {"from_tab": True, "mega_of": "garchomp",
                         "mega_stone": "Garchompite Z"}),
    ("lucario-mega-z", {"from_tab": True, "mega_of": "lucario",
                        "mega_stone": "Lucarionite Z"}),
]
NEW_SPECIES = ["rillaboom", "salamence", "golisopod", "baxcalibur"]

# Abilities Champions has since confirmed for the new megas (Maxim, 2026-09-03).
# They override the datamine/mainline value and clear abilities_provisional;
# forms not listed here stay provisional until announced. Aura Guard is a
# Champions-new ability: halves damage taken from contact moves.
CONFIRMED_ABILITIES = {
    "salamence-mega": ["Aerilate"],
    "absol-mega-z": ["Sharpness"],
    "garchomp-mega-z": ["Levitate"],
    "lucario-mega-z": ["Aura Guard"],
}

# Signature moves of the new species that no M-B Pokémon learned, so they are
# absent from moves.json (which was scoped to moves seen in Champions
# learnsets). Gen 9 mainline definitions in the moves.json schema; provisional
# until the Champions M-C move data is published.
NEW_MOVES = {
    "Drum Beating": {
        "name": "Drum Beating", "type": "Grass", "category": "Physical",
        "base_power": 80, "accuracy": 100, "pp": 10, "priority": 0, "target": "normal",
        "flags": {"protect": 1, "mirror": 1, "metronome": 1},
        "short_desc": "100% chance to lower the target's Speed by 1.",
        "source": "provisional_mc: gen9 mainline (no M-B Pokemon learned it)",
    },
    "Glaive Rush": {
        "name": "Glaive Rush", "type": "Dragon", "category": "Physical",
        "base_power": 120, "accuracy": 100, "pp": 5, "priority": 0, "target": "normal",
        "flags": {"contact": 1, "protect": 1, "mirror": 1, "metronome": 1},
        "short_desc": "User takes double damage and can't avoid attacks until its next move.",
        "source": "provisional_mc: gen9 mainline (no M-B Pokemon learned it)",
    },
}


def add_new_moves(moves: dict) -> list[str]:
    """Insert NEW_MOVES that are missing from the move pool; returns names added."""
    added = []
    for name, spec in NEW_MOVES.items():
        if name not in moves:
            moves[name] = dict(spec)
            added.append(name)
    return added


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def load(name: str) -> dict:
    return json.loads((DATA / name).read_text())


def dump(name: str, obj: dict, dry: bool) -> None:
    if dry:
        return
    (DATA / name).write_text(json.dumps(obj, indent=1) + "\n")


def build_entry(pid: str, spec: dict, tab: dict) -> dict:
    if spec.get("from_tab"):
        if pid not in tab:
            sys.exit(f"ERROR: {pid} not in megas_tab.json")
        src = tab[pid]
    else:
        src = MAINLINE[pid]
    abilities = list(src.get("abilities", []))
    entry = {"id": pid, "name": src["name"], "types": list(src["types"]),
             "base": dict(src["base"]), "abilities": abilities}
    if "mega_of" in spec:
        entry["mega_of"] = spec["mega_of"]
        entry["mega_stone"] = spec["mega_stone"]
    entry["regulations"] = [REG]
    if spec.get("mega_forms"):
        entry["mega_forms"] = list(spec["mega_forms"])
    if pid in CONFIRMED_ABILITIES:
        entry["abilities"] = list(CONFIRMED_ABILITIES[pid])
    elif not abilities or spec.get("abilities_provisional"):
        entry["abilities_provisional"] = True
    return entry


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="report, write nothing")
    ap.add_argument("--learnsets", type=Path, default=DEFAULT_LEARNSETS,
                    help="JSON {species_id: [mainline move names]}")
    ap.add_argument("--force-learnsets", action="store_true",
                    help="overwrite existing learnsets for the new species")
    args = ap.parse_args()
    dry = args.dry_run

    dex = load("pokedex.json")
    tab = load("megas_tab.json")
    items = load("items.json")
    learnsets = load("learnsets.json")
    moves = load("moves.json")

    # 1. carry-over tag
    tagged = 0
    for mon in dex.values():
        regs = mon.setdefault("regulations", [])
        if REG not in regs:
            regs.append(REG)
            regs.sort()
            tagged += 1
    print(f"tagged {tagged} existing forms with {REG}")

    # 2. new forms
    added, confirmed = [], []
    for pid, spec in NEW_FORMS:
        if pid in dex:
            regs = dex[pid].setdefault("regulations", [])
            if REG not in regs:
                regs.append(REG)
                regs.sort()
            # Apply abilities confirmed after the form was first added.
            if pid in CONFIRMED_ABILITIES:
                mon = dex[pid]
                if (mon.get("abilities") != CONFIRMED_ABILITIES[pid]
                        or mon.get("abilities_provisional")):
                    mon["abilities"] = list(CONFIRMED_ABILITIES[pid])
                    mon.pop("abilities_provisional", None)
                    confirmed.append(pid)
            continue
        dex[pid] = build_entry(pid, spec, tab)
        added.append(pid)
    for pid, spec in NEW_FORMS:
        base_id = spec.get("mega_of")
        if base_id:
            if base_id not in dex:
                sys.exit(f"ERROR: base {base_id} for {pid} missing from pokedex")
            forms = dex[base_id].setdefault("mega_forms", [])
            if pid not in forms:
                forms.append(pid)
    print(f"added {len(added)} forms: {', '.join(added) or '(none, already present)'}")
    prov = [pid for pid, _ in NEW_FORMS if dex[pid].get("abilities_provisional")]
    print(f"abilities provisional (set them in the UI): {', '.join(prov)}")

    if confirmed:
        print(f"applied confirmed abilities to: {', '.join(confirmed)}")
    # A confirmed ability makes any user override for that form stale.
    ov_path = DATA / "ability_overrides.json"
    if ov_path.exists():
        ov = json.loads(ov_path.read_text())
        stale = [pid for pid in CONFIRMED_ABILITIES if pid in ov]
        for pid in stale:
            ov.pop(pid)
        if stale and not dry:
            ov_path.write_text(json.dumps(ov, indent=1) + "\n")
        if stale:
            print(f"removed stale ability override(s): {', '.join(stale)}")

    # 3. stones
    new_stones = []
    for pid, spec in NEW_FORMS:
        stone = spec.get("mega_stone")
        if not stone:
            continue
        key = slug(stone)
        if key in items:
            continue
        items[key] = {"id": key, "name": stone, "effect": STONE_EFFECT,
                      "category": "mega_stone", "mega_form": pid}
        new_stones.append(stone)
    print(f"added {len(new_stones)} stones: {', '.join(new_stones) or '(none)'}")

    # 3b. signature moves absent from the Champions move pool
    new_moves = add_new_moves(moves)
    print(f"added {len(new_moves)} moves: {', '.join(new_moves) or '(none)'}")

    # 4. provisional learnsets
    if args.learnsets.exists():
        raw = json.loads(args.learnsets.read_text())
        by_lower = {name.lower(): name for name in moves}
        for sid in NEW_SPECIES:
            if sid in learnsets and not args.force_learnsets:
                print(f"learnset {sid}: already present, kept ({len(learnsets[sid]['moves'])} moves)")
                continue
            if sid not in raw:
                print(f"WARNING: no mainline learnset for {sid} in {args.learnsets.name}")
                continue
            keep, dropped = set(), set()
            for mv in raw[sid]:
                canon = by_lower.get(mv.strip().lower())
                (keep.add(canon) if canon else dropped.add(mv))
            learnsets[sid] = {"moves": sorted(keep), "source": LEARNSET_SOURCE}
            print(f"learnset {sid}: {len(keep)} moves kept, "
                  f"{len(dropped)} not in the Champions move pool"
                  + (f" ({', '.join(sorted(dropped))})" if dropped else ""))
    else:
        print(f"WARNING: {args.learnsets} missing; learnsets not written")

    missing_ls = [sid for sid in NEW_SPECIES if sid not in learnsets]
    if missing_ls:
        print(f"WARNING: species without a learnset: {', '.join(missing_ls)}")

    dump("pokedex.json", dex, dry)
    dump("items.json", items, dry)
    dump("moves.json", moves, dry)
    dump("learnsets.json", learnsets, dry)
    megas = sum(1 for m in dex.values() if "mega_of" in m)
    print(f"{'DRY RUN - nothing written' if dry else 'written'}: "
          f"{len(dex)} forms ({megas} megas), {len(moves)} moves, "
          f"{len(learnsets)} learnsets, "
          f"{sum(1 for i in items.values() if i['category'] == 'mega_stone')} stones")
    return 0


if __name__ == "__main__":
    sys.exit(main())
