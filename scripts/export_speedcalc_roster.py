"""Export the corrected pokedex back to champions-speed-calc's pokemon.js.

Generates the roster file in the app's existing format: M-A-legal forms only,
learnset-sheet (dex) order, each base form followed by its mega forms.

Usage:
    python scripts/export_speedcalc_roster.py \
        --out ../champions-speed-calc/src/data/pokemon.js

After replacing the file, the speed calc's tables reflect the actual game
roster — no code changes needed (speedCalc.js reads the same shape).
"""

import argparse
import json
from datetime import date
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "vgc_toolkit" / "data"
STAT_KEYS = ["hp", "atk", "def", "spa", "spd", "spe"]


def js_str(s: str) -> str:
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"


def js_entry(mon: dict) -> str:
    parts = [
        f"id: {js_str(mon['id'])}",
        f"name: {js_str(mon['name'])}",
        "types: [" + ",".join(js_str(t) for t in mon["types"]) + "]",
        "base: [" + ",".join(str(mon["base"][k]) for k in STAT_KEYS) + "]",
        "abilities: [" + ",".join(js_str(a) for a in mon["abilities"]) + "]",
    ]
    if mon.get("mega_of"):
        parts.append(f"megaOf: {js_str(mon['mega_of'])}")
        if mon.get("mega_stone"):
            parts.append(f"megaStone: {js_str(mon['mega_stone'])}")
    return "  { " + ", ".join(parts) + " },"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, help="Path to write pokemon.js")
    parser.add_argument("--regulation", default="M-A")
    args = parser.parse_args()

    pokedex = json.loads((DATA_DIR / "pokedex.json").read_text())
    learnsets = json.loads((DATA_DIR / "learnsets.json").read_text())

    def legal(mon):
        return args.regulation in mon.get("regulations", [])

    lines = [
        f"// Pokemon Champions Regulation {args.regulation} Roster",
        "// Base stats: HP / Atk / Def / SpA / SpD / Spe",
        "// Legal abilities listed per Pokemon; Megas list their forced ability.",
        "// Speed-affecting abilities are tagged in abilities.js",
        "//",
        f"// GENERATED {date.today().isoformat()} by vgc-toolkit "
        "scripts/export_speedcalc_roster.py — do not hand-edit.",
        "// Sources: Learnset + Megas tabs of RoiDadadou's Data Comparative",
        "// Champions doc (roster membership + datamined mega stats), with",
        "// the @pkmn/dex Gen 9 baseline for base-form stats.",
        "",
        "export const ROSTER = [",
    ]

    count = 0
    for base_id in learnsets:  # learnset order == sheet (dex) order
        mon = pokedex.get(base_id)
        if not mon or not legal(mon):
            continue
        lines.append(js_entry(mon))
        count += 1
        for mega_id in sorted(mon.get("mega_forms", [])):
            mega = pokedex[mega_id]
            if legal(mega):
                lines.append(js_entry(mega))
                count += 1
    lines.append("];")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n")
    print(f"{out}: {count} {args.regulation}-legal forms written")


if __name__ == "__main__":
    main()
