"""Ingest the Megas tab of RoiDadadou's comparative doc (saved sheet.html).

This tab is the authoritative datamine for Z-A/Champions megas and their base
forms: stats, types, and abilities. An entry with NO abilities listed is not
in Pokemon Champions yet (per the doc's convention) and gets in_game=false.

Usage:
    python scripts/ingest_megas_tab.py --html path/to/sheet.html

Output: vgc_toolkit/data/megas_tab.json, consumed by build_pokedex.py --megas.
"""

import argparse
import json
import re
from pathlib import Path

import pandas as pd

OUT_DIR = Path(__file__).resolve().parent.parent / "vgc_toolkit" / "data"

STAT_KEYS = ["hp", "atk", "def", "spa", "spd", "spe"]

# Known data-entry typos in the source sheet, normalized at ingestion.
# (Meowstic-M is the Prankster form; "Prankster Competitive" is a merged
# cell spanning both genders' hidden abilities.)
TYPO_FIXES = {
    "Lighning Rod": "Lightning Rod",
    "Infiltrato": "Infiltrator",
    "Prankster Competitive": "Prankster",
}

# tab naming -> existing pokedex ids where slugs differ
SLUG_ALIASES = {
    "meowstic": "meowstic-m",
}

# One tab row -> multiple gendered forms (datamine: M/F megas are identical).
MEGA_FANOUT = {
    "meowstic-mega": [
        ("meowstic-m-mega", "meowstic-m", "Mega Meowstic"),
        ("meowstic-f-mega", "meowstic-f", "Mega Meowstic-F"),
    ],
}


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def display_name(tab_name: str) -> str:
    """'Golurk-Mega' -> 'Mega Golurk'; 'Raichu-Mega-X' -> 'Mega Raichu X'."""
    m = re.match(r"^(.*?)-Mega(?:-([A-Z]))?$", tab_name)
    if not m:
        return tab_name
    base, suffix = m.group(1), m.group(2) or ""
    return f"Mega {base} {suffix}".strip()


def mega_base_slug(slug: str) -> str:
    """'golurk-mega' / 'raichu-mega-x' -> base form slug."""
    return re.sub(r"-mega(-[a-z])?$", "", slug)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--html", required=True, help="Saved sheet.html of the Megas tab")
    args = parser.parse_args()

    df = pd.read_html(args.html)[0]
    entries = {}
    for _, r in df.iloc[2:].iterrows():
        name = r.iloc[2]
        if not isinstance(name, str) or not name.strip():
            continue
        name = name.strip()
        types = list(dict.fromkeys(
            t.strip() for t in (r.iloc[3], r.iloc[4]) if isinstance(t, str)))
        abilities = []
        for c in (5, 6, 7):
            v = r.iloc[c]
            if isinstance(v, str) and v.strip():
                ability = TYPO_FIXES.get(v.strip(), v.strip())
                if ability not in abilities:
                    abilities.append(ability)
        try:
            base = {k: int(r.iloc[8 + i]) for i, k in enumerate(STAT_KEYS)}
        except (ValueError, TypeError):
            continue  # malformed row

        raw_slug = slugify(name)
        is_mega = bool(re.search(r"-Mega(-[A-Z])?$", name))
        if raw_slug in MEGA_FANOUT:
            fanout = MEGA_FANOUT[raw_slug]
        else:
            slug = SLUG_ALIASES.get(raw_slug, raw_slug)
            mega_of = SLUG_ALIASES.get(mega_base_slug(raw_slug), mega_base_slug(raw_slug))
            fanout = [(slug, mega_of, display_name(name) if is_mega else name)]
        for slug, mega_of, disp in fanout:
            entries[slug] = {
                "id": slug,
                "name": disp,
                "types": types,
                "base": base,
                "abilities": abilities,
                "is_mega": is_mega,
                "in_game": bool(abilities),
                **({"mega_of": mega_of} if is_mega else {}),
            }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "megas_tab.json").write_text(json.dumps(entries, indent=2))

    megas = [e for e in entries.values() if e["is_mega"]]
    in_game = [e for e in megas if e["in_game"]]
    print(f"megas_tab.json: {len(entries)} entries "
          f"({len(megas)} megas, {len(in_game)} in-game)")
    not_in_game = sorted(e["id"] for e in megas if not e["in_game"])
    print(f"  megas not in Champions yet: {not_in_game}")


if __name__ == "__main__":
    main()
