"""Ingest the Champions item list CSV into canonical JSON with mechanics tags.

Usage:
    python scripts/ingest_items.py --csv path/to/items_list.csv

The CSV only carries flavor text, so mechanically relevant items get
structured tags from the curated maps below (these are stable, well-known
item mechanics). Mega Stones are cross-referenced against pokedex.json so
each stone knows which mega form it enables.
"""

import argparse
import csv
import json
import re
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "vgc_toolkit" / "data"

# Type-boosting held items: x1.2 to moves of the matching type.
TYPE_BOOST_ITEMS = {
    "Black Belt": "Fighting", "Black Glasses": "Dark", "Charcoal": "Fire",
    "Dragon Fang": "Dragon", "Fairy Feather": "Fairy", "Hard Stone": "Rock",
    "Magnet": "Electric", "Metal Coat": "Steel", "Miracle Seed": "Grass",
    "Mystic Water": "Water", "Never-Melt Ice": "Ice", "Poison Barb": "Poison",
    "Sharp Beak": "Flying", "Silk Scarf": "Normal", "Silver Powder": "Bug",
    "Soft Sand": "Ground", "Spell Tag": "Ghost", "Twisted Spoon": "Psychic",
}

# Super-effective-halving berries (Chilan halves Normal unconditionally).
RESIST_BERRIES = {
    "Occa Berry": "Fire", "Passho Berry": "Water", "Wacan Berry": "Electric",
    "Rindo Berry": "Grass", "Yache Berry": "Ice", "Chople Berry": "Fighting",
    "Kebia Berry": "Poison", "Shuca Berry": "Ground", "Coba Berry": "Flying",
    "Payapa Berry": "Psychic", "Tanga Berry": "Bug", "Charti Berry": "Rock",
    "Kasib Berry": "Ghost", "Haban Berry": "Dragon", "Colbur Berry": "Dark",
    "Babiri Berry": "Steel", "Roseli Berry": "Fairy", "Chilan Berry": "Normal",
}

# Speed modifiers consumed by core/speed.py (Iron Ball also grounds its holder,
# see DAMAGE_ITEM_TAGS).
SPEED_ITEMS = {"Choice Scarf": 1.5, "Iron Ball": 0.5}

# Damage-relevant held items consumed by core/damage.py, as flat tags in the
# same style as boost_type above. Multipliers are the Gen 9 values; the engine
# maps them to the reference 4096-based constants.
DAMAGE_ITEM_TAGS = {
    "Life Orb": {"final_multiplier": 1.3, "recoil_fraction": 0.1},
    "Expert Belt": {"se_multiplier": 1.2},
    "Muscle Band": {"category_boost": "Physical", "category_multiplier": 1.1},
    "Wise Glasses": {"category_boost": "Special", "category_multiplier": 1.1},
    "Metronome": {"streak_step": 0.2, "streak_cap": 2.0},
    "Focus Sash": {"focus_sash": True},
    "Iron Ball": {"grounds_holder": True},
    "Light Ball": {"stat_double_for": "pikachu"},   # engine special-cases Pikachu
    # Not in Champions yet (kept for when they arrive). stat_multiplier applies
    # to the staged stat, like the engine's onModifyAtk / onModifySpA / onModifySpD.
    "Choice Band": {"stat_multiplier": {"atk": 1.5}, "choice_lock": True},
    "Choice Specs": {"stat_multiplier": {"spa": 1.5}, "choice_lock": True},
    "Assault Vest": {"stat_multiplier": {"spd": 1.5}, "no_status_moves": True},
    # Regulation M-C (2026-09-08, scripts/add_mc_release.py). Air Balloon: the
    # holder floats (Ground immunity, like Levitate) until it is hit. Normal Gem:
    # the first Normal move is x1.3. Leek: +2 crit stages for Farfetch'd / Sirfetch'd.
    "Air Balloon": {"airborne": True},
    "Normal Gem": {"gem_type": "Normal", "gem_multiplier": 1.3},
    "Leek": {"crit_stage": 2, "crit_users": ["farfetch-d", "sirfetch-d"]},
    # Terrain Seeds: +1 to the stat when the holder is on the matching terrain
    # (single use). The calc applies the stage when the field's terrain matches.
    "Grassy Seed": {"terrain_seed": {"terrain": "grassy", "stat": "def"}},
    "Electric Seed": {"terrain_seed": {"terrain": "electric", "stat": "def"}},
    "Psychic Seed": {"terrain_seed": {"terrain": "psychic", "stat": "spd"}},
    "Misty Seed": {"terrain_seed": {"terrain": "misty", "stat": "spd"}},
}


def _norm(name: str) -> str:
    """Spelling-insensitive key: the sheet writes 'SilverPowder'/'TwistedSpoon'
    where the curated maps say 'Silver Powder'/'Twisted Spoon'."""
    return re.sub(r"[^a-z0-9]", "", name.lower())


_TYPE_BOOST = {_norm(k): v for k, v in TYPE_BOOST_ITEMS.items()}
_RESIST = {_norm(k): v for k, v in RESIST_BERRIES.items()}
_SPEED = {_norm(k): v for k, v in SPEED_ITEMS.items()}
_DAMAGE_TAGS = {_norm(k): v for k, v in DAMAGE_ITEM_TAGS.items()}

# CSV stone spelling -> old roster megaStone spelling. pokedex.json now uses the
# CSV spellings, so lookups try the CSV name FIRST and only fall back to the
# alias (a plain alias lookup inverted this and nulled 8 stones' mega_form).
STONE_NAME_ALIASES = {
    "Dragoninite": "Dragonitite",
    "Drampanite": "Drampite",
    "Excadrite": "Excadrillite",
    "Feraligite": "Feraligatrite",
    "Floettite": "Floettenite",
    "Hawluchanite": "Hawluchite",
    "Starminite": "Starmite",
    "Victreebelite": "Victreebite",
}


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def categorize(name: str, mega_stones: dict) -> dict:
    tags = {}
    key = _norm(name)
    # ' Z' covers Regulation M-C's Z Mega stones (e.g. "Absolite Z").
    is_stone = name in mega_stones or re.search(r"ite( [XYZ])?$", name)
    if is_stone:
        tags["category"] = "mega_stone"
        # CSV spelling first (what pokedex.json uses), alias only as a fallback.
        tags["mega_form"] = (mega_stones.get(name)
                             or mega_stones.get(STONE_NAME_ALIASES.get(name, name)))
    elif name.endswith("Berry"):
        tags["category"] = "berry"
        if key in _RESIST:
            tags["resist_type"] = _RESIST[key]
    else:
        tags["category"] = "held"
    if key in _TYPE_BOOST:
        tags["boost_type"] = _TYPE_BOOST[key]
        tags["boost_multiplier"] = 1.2
    if key in _SPEED:
        tags["speed_multiplier"] = _SPEED[key]
    tags.update(_DAMAGE_TAGS.get(key, {}))
    return tags


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", required=True, help="Path to items_list.csv")
    args = parser.parse_args()

    # Map mega stone name -> mega form id from the already-ingested pokedex.
    pokedex_path = OUT_DIR / "pokedex.json"
    mega_stones = {}
    if pokedex_path.exists():
        pokedex = json.loads(pokedex_path.read_text())
        for mon in pokedex.values():
            if mon.get("mega_stone"):
                mega_stones[mon["mega_stone"]] = mon["id"]

    items = {}
    with open(args.csv, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            name = row["Name"].strip()
            slug = slugify(name)
            items[slug] = {
                "id": slug,
                "name": name,
                "effect": row["Effect"].strip(),
                **categorize(name, mega_stones),
            }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "items.json").write_text(json.dumps(items, indent=2))

    counts = {}
    unmatched = [i["name"] for i in items.values()
                 if i["category"] == "mega_stone" and not i.get("mega_form")]
    for item in items.values():
        counts[item["category"]] = counts.get(item["category"], 0) + 1
    print(f"items.json: {len(items)} items -> {counts}")
    if unmatched:
        print(f"WARNING: mega stones with no matching form in pokedex: {unmatched}")


if __name__ == "__main__":
    main()
