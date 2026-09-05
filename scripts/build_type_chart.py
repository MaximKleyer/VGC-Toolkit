"""Build the 18-type effectiveness chart (Gen 6+ standard, used by Champions).

Usage:
    python scripts/build_type_chart.py

Only non-neutral matchups are listed below; everything else is 1.0.
Output schema: {attacking_type: {defending_type: multiplier, ...}, ...}
with all 18x18 entries materialized for simple lookups.
"""

import json
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "vgc_toolkit" / "data"

TYPES = [
    "Normal", "Fire", "Water", "Electric", "Grass", "Ice", "Fighting",
    "Poison", "Ground", "Flying", "Psychic", "Bug", "Rock", "Ghost",
    "Dragon", "Dark", "Steel", "Fairy",
]

# attacking type -> {defending type: multiplier} (non-1.0 only)
OVERRIDES = {
    "Normal":   {"Rock": 0.5, "Ghost": 0.0, "Steel": 0.5},
    "Fire":     {"Fire": 0.5, "Water": 0.5, "Grass": 2.0, "Ice": 2.0,
                 "Bug": 2.0, "Rock": 0.5, "Dragon": 0.5, "Steel": 2.0},
    "Water":    {"Fire": 2.0, "Water": 0.5, "Grass": 0.5, "Ground": 2.0,
                 "Rock": 2.0, "Dragon": 0.5},
    "Electric": {"Water": 2.0, "Electric": 0.5, "Grass": 0.5, "Ground": 0.0,
                 "Flying": 2.0, "Dragon": 0.5},
    "Grass":    {"Fire": 0.5, "Water": 2.0, "Grass": 0.5, "Poison": 0.5,
                 "Ground": 2.0, "Flying": 0.5, "Bug": 0.5, "Rock": 2.0,
                 "Dragon": 0.5, "Steel": 0.5},
    "Ice":      {"Fire": 0.5, "Water": 0.5, "Grass": 2.0, "Ice": 0.5,
                 "Ground": 2.0, "Flying": 2.0, "Dragon": 2.0, "Steel": 0.5},
    "Fighting": {"Normal": 2.0, "Ice": 2.0, "Poison": 0.5, "Flying": 0.5,
                 "Psychic": 0.5, "Bug": 0.5, "Rock": 2.0, "Ghost": 0.0,
                 "Dark": 2.0, "Steel": 2.0, "Fairy": 0.5},
    "Poison":   {"Grass": 2.0, "Poison": 0.5, "Ground": 0.5, "Rock": 0.5,
                 "Ghost": 0.5, "Steel": 0.0, "Fairy": 2.0},
    "Ground":   {"Fire": 2.0, "Electric": 2.0, "Grass": 0.5, "Poison": 2.0,
                 "Flying": 0.0, "Bug": 0.5, "Rock": 2.0, "Steel": 2.0},
    "Flying":   {"Electric": 0.5, "Grass": 2.0, "Fighting": 2.0, "Bug": 2.0,
                 "Rock": 0.5, "Steel": 0.5},
    "Psychic":  {"Fighting": 2.0, "Poison": 2.0, "Psychic": 0.5, "Dark": 0.0,
                 "Steel": 0.5},
    "Bug":      {"Fire": 0.5, "Grass": 2.0, "Fighting": 0.5, "Poison": 0.5,
                 "Flying": 0.5, "Psychic": 2.0, "Ghost": 0.5, "Dark": 2.0,
                 "Steel": 0.5, "Fairy": 0.5},
    "Rock":     {"Fire": 2.0, "Ice": 2.0, "Fighting": 0.5, "Ground": 0.5,
                 "Flying": 2.0, "Bug": 2.0, "Steel": 0.5},
    "Ghost":    {"Normal": 0.0, "Psychic": 2.0, "Ghost": 2.0, "Dark": 0.5},
    "Dragon":   {"Dragon": 2.0, "Steel": 0.5, "Fairy": 0.0},
    "Dark":     {"Fighting": 0.5, "Psychic": 2.0, "Ghost": 2.0, "Dark": 0.5,
                 "Fairy": 0.5},
    "Steel":    {"Fire": 0.5, "Water": 0.5, "Electric": 0.5, "Ice": 2.0,
                 "Rock": 2.0, "Steel": 0.5, "Fairy": 2.0},
    "Fairy":    {"Fire": 0.5, "Fighting": 2.0, "Poison": 0.5, "Dragon": 2.0,
                 "Dark": 2.0, "Steel": 0.5},
}


def main():
    chart = {
        atk: {dfn: OVERRIDES.get(atk, {}).get(dfn, 1.0) for dfn in TYPES}
        for atk in TYPES
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "type_chart.json").write_text(json.dumps(chart, indent=2))
    non_neutral = sum(1 for a in chart.values() for m in a.values() if m != 1.0)
    print(f"type_chart.json: {len(chart)}x{len(TYPES)} matchups, {non_neutral} non-neutral")


if __name__ == "__main__":
    main()
