"""Re-apply the curated item mechanics tags to the existing items.json.

Unlike ingest_items.py this needs no CSV: it keeps every item currently in
items.json (names, flavor text, the hand-added Regulation M-C stones) and
recomputes only the mechanics tags (category, mega_form, boost_type,
resist_type, speed_multiplier, and the damage tags) from the curated maps in
ingest_items.py. Run it after editing those maps. Idempotent.

Usage:  python scripts/retag_items.py [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ingest_items import OUT_DIR, categorize  # noqa: E402

BASE_KEYS = ("id", "name", "effect", "category")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="report, write nothing")
    args = ap.parse_args()

    items_path = OUT_DIR / "items.json"
    items = json.loads(items_path.read_text())
    pokedex = json.loads((OUT_DIR / "pokedex.json").read_text())
    mega_stones = {m["mega_stone"]: m["id"] for m in pokedex.values() if m.get("mega_stone")}

    changed = []
    for slug, it in items.items():
        new = {"id": it["id"], "name": it["name"], "effect": it.get("effect", ""),
               **categorize(it["name"], mega_stones)}
        # A stone whose form is missing from the pokedex keeps its previous link.
        if new.get("category") == "mega_stone" and not new.get("mega_form") and it.get("mega_form"):
            new["mega_form"] = it["mega_form"]
        if new != it:
            changed.append(it["name"])
            items[slug] = new

    if not args.dry_run:
        items_path.write_text(json.dumps(items, indent=1) + "\n")

    tagged = sorted(i["name"] for i in items.values()
                    if i["category"] != "mega_stone" and any(k not in BASE_KEYS for k in i))
    print(f"{'DRY RUN: would retag' if args.dry_run else 'retagged'} {len(changed)} item(s)"
          + (f": {', '.join(changed)}" if changed else ""))
    print(f"{len(items)} items; mechanics-tagged held items/berries: {len(tagged)}")
    unmatched = [i["name"] for i in items.values()
                 if i["category"] == "mega_stone" and not i.get("mega_form")]
    if unmatched:
        print(f"WARNING: mega stones with no matching form in pokedex: {unmatched}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
