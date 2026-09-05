"""Ingest the Learnset tab of RoiDadadou's "Data Comparative Champions" sheet
(saved as HTML from the published Google Sheet) into learnsets.json.

Usage:
    python scripts/ingest_learnsets.py --html path/to/sheet.html

Source: https://docs.google.com/spreadsheets/d/1DeXjzohTUdKNERu6dsHsnznneva8MDJjglI3lqDLgm4
Credit: RoiDadadou (@lepenseuradimir) — community Champions datamine.

Notes:
- The sheet is filled progressively; coverage gaps against the pokedex are
  reported, not treated as errors.
- All Pokemon in the sheet are ingested even if not currently regulation
  legal; they link up automatically when future rosters include them.
- Megas are NOT stored here: they share their base form's learnset and are
  resolved at lookup time via the pokedex `mega_of` field.
"""

import argparse
import json
import re
from pathlib import Path

import pandas as pd

OUT_DIR = Path(__file__).resolve().parent.parent / "vgc_toolkit" / "data"

# Sheet name -> pokedex id where slug normalization alone isn't enough.
NAME_ALIASES = {
    "lycanroc": "lycanroc-day",
    "lycanroc-midnight": "lycanroc-night",
    "meowstic": "meowstic-m",  # sheet has separate Meowstic / Meowstic-F rows
    "basculegion": "basculegion-m",          # sheet has one row; -f differs slightly in mainline
    "tauros-paldea": "tauros-paldea-combat", # AMBIGUOUS: three Paldean forms; mapped to Combat
}

# One sheet row that should populate multiple pokedex forms (shared learnset).
ID_FANOUT = {
    "palafin": ["palafin-zero", "palafin-hero"],
}


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--html", required=True, help="Saved sheet.html of the Learnset tab")
    args = parser.parse_args()

    df = pd.read_html(args.html)[0]
    # Layout: col 2 = name, cols 4-5 = types, cols 6+ = moves. Row 0 = header band.
    learnsets = {}
    for _, row in df.iloc[1:].iterrows():
        name = row.iloc[2]
        if not isinstance(name, str) or not name.strip():
            continue
        types = [t for t in (row.iloc[4], row.iloc[5])
                 if isinstance(t, str) and t.strip()]
        types = list(dict.fromkeys(types))  # sheet repeats mono-types
        moves = sorted({
            v.strip() for v in row.iloc[6:]
            if isinstance(v, str) and v.strip() and v.strip() != "Learnset"
        })
        slug = slugify(name)
        targets = ID_FANOUT.get(slug) or [NAME_ALIASES.get(slug, slug)]
        for target_id in targets:
            learnsets[target_id] = {
                "id": target_id,
                "source_name": name.strip(),
                "types": types,
                "moves": moves,
            }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "learnsets.json").write_text(json.dumps(learnsets, indent=2))

    all_moves = sorted({m for ls in learnsets.values() for m in ls["moves"]})
    print(f"learnsets.json: {len(learnsets)} pokemon, {len(all_moves)} unique moves")

    # Coverage report against the pokedex, if it exists.
    dex_path = OUT_DIR / "pokedex.json"
    if dex_path.exists():
        dex = json.loads(dex_path.read_text())
        base_forms = [k for k, v in dex.items() if "mega_of" not in v]
        missing = sorted(set(base_forms) - set(learnsets))
        extra = sorted(set(learnsets) - set(base_forms))
        print(f"coverage: {len(base_forms) - len(missing)}/{len(base_forms)} "
              f"pokedex base forms have learnsets")
        if missing:
            print(f"  pokedex forms WITHOUT learnset data ({len(missing)}): {missing}")
        if extra:
            print(f"  learnsets for non-roster pokemon (kept, {len(extra)}): {extra}")


if __name__ == "__main__":
    main()
