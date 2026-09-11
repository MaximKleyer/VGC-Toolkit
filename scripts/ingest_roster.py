"""Ingest the Pokemon Champions roster + alignment/ability data from the
champions-speed-calc JS source files into canonical JSON for the toolkit.

Usage:
    python scripts/ingest_roster.py \
        --pokemon path/to/champions-speed-calc/src/data/pokemon.js \
        --abilities path/to/champions-speed-calc/src/data/abilities.js \
        --regulation M-B

Re-run whenever the speed-calc data changes (e.g. when the next regulation
drops, point --pokemon at the new roster file and pass its --regulation).
Outputs are written to vgc_toolkit/data/.
"""

import argparse
import json
import re
from pathlib import Path

import json5  # parses JS object literals: comments, single quotes, unquoted keys

OUT_DIR = Path(__file__).resolve().parent.parent / "vgc_toolkit" / "data"

STAT_KEYS = ["hp", "atk", "def", "spa", "spd", "spe"]


def extract_js_export(source: str, name: str):
    """Pull `export const <name> = <literal>;` out of a JS file and json5-parse it."""
    pattern = rf"export\s+const\s+{name}\s*=\s*"
    match = re.search(pattern, source)
    if not match:
        raise ValueError(f"Could not find export `{name}` in source file")
    start = match.end()
    # Walk to the matching close bracket of the literal (array or object).
    open_ch = source[start]
    close_ch = {"[": "]", "{": "}"}[open_ch]
    depth, i, in_str, str_ch = 0, start, False, ""
    while i < len(source):
        ch = source[i]
        if in_str:
            if ch == "\\":
                i += 2
                continue
            if ch == str_ch:
                in_str = False
        elif ch in ("'", '"', "`"):
            in_str, str_ch = True, ch
        elif ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return json5.loads(source[start : i + 1])
        i += 1
    raise ValueError(f"Unbalanced brackets while parsing `{name}`")


def build_pokedex(roster: list, regulation: str) -> dict:
    """Convert roster entries to the canonical pokedex schema, keyed by id."""
    pokedex = {}
    skipped = []
    for entry in roster:
        # Dead placeholder rows in the source data: empty name, all-zero stats.
        if not entry.get("name") or not any(entry.get("base", [])):
            skipped.append(entry.get("id", "<no id>"))
            continue
        base = dict(zip(STAT_KEYS, entry["base"]))
        mon = {
            "id": entry["id"],
            "name": entry["name"],
            "types": entry["types"],
            "base": base,
            "abilities": entry.get("abilities", []),
            "regulations": [regulation],
        }
        if "megaOf" in entry:
            mon["mega_of"] = entry["megaOf"]
            mon["mega_stone"] = entry.get("megaStone")
        pokedex[entry["id"]] = mon

    if skipped:
        print(f"Skipped {len(skipped)} placeholder entries: {skipped}")

    # Back-link megas onto their base forms for easy lookup.
    for mon in pokedex.values():
        if "mega_of" in mon:
            base_form = pokedex.get(mon["mega_of"])
            if base_form is not None:
                base_form.setdefault("mega_forms", []).append(mon["id"])
    return pokedex


# Champions has every +10%/-10% pairing of the five non-HP stats plus Serious:
# 21 alignments. The speed-calc source lists only the fifteen its speed tiers
# use, so the grid is completed here (output order groups by boosted stat).
ALL_ALIGNMENTS = {
    "Serious": (None, None),
    "Lonely": ("atk", "def"), "Adamant": ("atk", "spa"), "Naughty": ("atk", "spd"), "Brave": ("atk", "spe"),
    "Bold": ("def", "atk"), "Impish": ("def", "spa"), "Lax": ("def", "spd"), "Relaxed": ("def", "spe"),
    "Modest": ("spa", "atk"), "Mild": ("spa", "def"), "Rash": ("spa", "spd"), "Quiet": ("spa", "spe"),
    "Calm": ("spd", "atk"), "Gentle": ("spd", "def"), "Careful": ("spd", "spa"), "Sassy": ("spd", "spe"),
    "Timid": ("spe", "atk"), "Hasty": ("spe", "def"), "Jolly": ("spe", "spa"), "Naive": ("spe", "spd"),
}


def complete_alignments(raw: dict) -> dict:
    """The source's alignments plus any of the game's 21 it omits, in grid order."""
    out = {}
    for name, (boost, reduce) in ALL_ALIGNMENTS.items():
        out[name] = raw.get(name) or {"boost": boost, "reduce": reduce}
    for name, spec in raw.items():          # anything unexpected the source adds
        out.setdefault(name, spec)
    return out


def build_alignments(raw: dict) -> dict:
    """Alignments: boost/reduce stat keys -> per-stat multiplier table."""
    alignments = {}
    for name, spec in complete_alignments(raw).items():
        mults = {k: 1.0 for k in STAT_KEYS if k != "hp"}
        if spec.get("boost"):
            mults[spec["boost"]] = 1.1
        if spec.get("reduce"):
            mults[spec["reduce"]] = 0.9
        alignments[name] = {
            "boost": spec.get("boost"),
            "reduce": spec.get("reduce"),
            "multipliers": mults,
        }
    return alignments


def merge_pokedex(new: dict, existing_path: Path) -> dict:
    """If a pokedex already exists, union regulation tags instead of clobbering."""
    if not existing_path.exists():
        return new
    existing = json.loads(existing_path.read_text())
    for mon_id, mon in new.items():
        if mon_id in existing:
            regs = sorted(set(existing[mon_id].get("regulations", [])) | set(mon["regulations"]))
            mon["regulations"] = regs
    merged = {**existing, **new}
    return merged


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pokemon", required=True, help="Path to pokemon.js (ROSTER export)")
    parser.add_argument("--abilities", required=True, help="Path to abilities.js")
    parser.add_argument("--regulation", default="M-A", help="Regulation tag for this roster")
    args = parser.parse_args()

    roster = extract_js_export(Path(args.pokemon).read_text(), "ROSTER")
    abilities_src = Path(args.abilities).read_text()
    speed_abilities = extract_js_export(abilities_src, "SPEED_ABILITIES")
    raw_alignments = extract_js_export(abilities_src, "STAT_ALIGNMENTS")

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    pokedex = build_pokedex(roster, args.regulation)
    pokedex = merge_pokedex(pokedex, OUT_DIR / "pokedex.json")
    (OUT_DIR / "pokedex.json").write_text(json.dumps(pokedex, indent=2))

    (OUT_DIR / "alignments.json").write_text(json.dumps(build_alignments(raw_alignments), indent=2))
    (OUT_DIR / "speed_abilities.json").write_text(json.dumps(speed_abilities, indent=2))

    n_megas = sum(1 for m in pokedex.values() if "mega_of" in m)
    print(f"pokedex.json: {len(pokedex)} forms ({n_megas} megas) tagged {args.regulation}")
    print(f"alignments.json: {len(complete_alignments(raw_alignments))} alignments ({len(raw_alignments)} in the source)")
    print(f"speed_abilities.json: {len(speed_abilities)} speed-relevant abilities")


if __name__ == "__main__":
    main()
