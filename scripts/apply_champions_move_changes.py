"""Apply Pokemon Champions move changes to moves.json.

Covers the calc-relevant deltas from the Champions move-change sheet: base
power, type, and accuracy. Secondary-effect changes (flinch/status chances,
Salt Cure residual, Knock Off item removal, slicing/Sharpness flags, etc.) are
listed for reference but not encoded — they don't change the damage number the
calculator produces.

Moves whose only users are restricted legendaries / non-Champions Pokemon
aren't in the dataset (Bolt Beak, Fishious Rend, Astral Barrage, Blood Moon,
Make It Rain, Hyper Drill, Gear Grind, Anchor Shot, Snipe Shot, Triple Dive,
Dragon Hammer, Revelation Dance); they're reported as skipped.

Re-running is idempotent. The Regulation M-C changes of 2026-09-08 (Slash,
Meteor Assault, Snipe Shot, Wish, Strength Sap, Double Shock, Milk Drink) live
in scripts/add_mc_release.py, which also adds the moves that were new to the pool.
"""

import json
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "vgc_toolkit" / "data"

# move name -> {field: new value}.  accuracy None == never misses.
POWER = {
    "First Impression": 100, "Bone Rush": 30, "Trop Kick": 85,
    "Beak Blast": 120, "Mountain Gale": 120, "Night Daze": 90,
    "Fire Lash": 90, "Spirit Shackle": 90, "Psyshield Bash": 90,
    "Infernal Parade": 65, "Grav Apple": 90, "Apple Acid": 90,
}
TYPE = {"Snap Trap": "Steel", "Growth": "Grass"}
ACCURACY = {"Syrup Bomb": 90, "Crabhammer": 95, "Clangorous Soul": None}

# changed in Champions but their users aren't in the dataset
ABSENT_USERS = [
    "Bolt Beak", "Fishious Rend", "Astral Barrage", "Blood Moon",
    "Make It Rain", "Hyper Drill", "Gear Grind", "Anchor Shot",
    "Snipe Shot", "Triple Dive", "Dragon Hammer", "Revelation Dance",
]


def main() -> int:
    moves = json.loads((DATA / "moves.json").read_text())
    applied, missing = [], []

    def set_field(name, field, value):
        mv = moves.get(name)
        if mv is None:
            missing.append(name)
            return
        if mv.get(field) != value:
            applied.append(f"{name}: {field} {mv.get(field)} -> {value}")
        mv[field] = value

    for name, bp in POWER.items():
        set_field(name, "base_power", bp)
    for name, t in TYPE.items():
        set_field(name, "type", t)
    for name, acc in ACCURACY.items():
        set_field(name, "accuracy", acc)

    (DATA / "moves.json").write_text(json.dumps(moves, indent=1))

    print(f"applied {len(applied)} change(s):")
    for a in applied:
        print("  " + a)
    miss = sorted(set(missing) | set(ABSENT_USERS))
    print(f"\nnot in dataset ({len(miss)}) — users not in Champions roster:")
    print("  " + ", ".join(miss))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
