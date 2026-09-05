"""Ingest Smogon/Showdown 'chaos' usage stats into meta_sets.json.

Source: https://www.smogon.com/stats/<YYYY-MM>/chaos/<format>-1760.json
(saved manually; the Champions ladders are gen9championsvgc2026regma and
gen9championsvgc2026regmabo3). Spreads arrive in NATIVE SP form
("Adamant:32/32/0/0/2/0", totals <= 66) because Showdown implements the
Champions stat system directly — no EV conversion is needed.

Set construction: ladder stats are per-slot distributions, not coherent
sets, so we build representative sets: the top spreads each paired with a
ranked item, the top ability, and the four most-used learnset-legal moves.
Every constructed set is run through the team validator before being kept.

Usage:
    python scripts/ingest_meta_sets.py FILE [FILE ...] \
        [--min-usage 1.0] [--max-sets 3] [--label 2026-05]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vgc_toolkit.core import dataio, teams
from vgc_toolkit.core.damage import Combatant
from vgc_toolkit.core.stats import SPSpread, InvalidSpreadError

DATA = Path(__file__).resolve().parent.parent / "vgc_toolkit" / "data"

NAME_FIXES = {
    "floette-mega": ["floette-eternal-mega", "floette-mega"],
    "floette": ["floette-eternal", "floette"],
    "basculegion": ["basculegion-m", "basculegion"],
    "palafin": ["palafin-zero", "palafin"],
    "meowstic": ["meowstic-m"],
    "lycanroc": ["lycanroc-day"],
    "lycanroc-midnight": ["lycanroc-night"],
}


def to_id(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def map_pokemon(showdown_name: str, dex: dict) -> str | None:
    slug = slugify(showdown_name)
    for candidate in NAME_FIXES.get(slug, [slug]):
        if candidate in dex:
            return candidate
    # last resort: punctuation-free match (Kommo-o etc. already hyphenate fine)
    flat = to_id(showdown_name)
    for pid in dex:
        if to_id(pid) == flat:
            return pid
    return None


def normalised(dist: dict) -> list[tuple[str, float]]:
    total = sum(dist.values()) or 1.0
    return sorted(((k, v / total) for k, v in dist.items()),
                  key=lambda x: -x[1])


def parse_spread(s: str) -> tuple[str, dict] | None:
    nature, _, nums = s.partition(":")
    parts = nums.split("/")
    if len(parts) != 6:
        return None
    keys = ["hp", "atk", "def", "spa", "spd", "spe"]
    try:
        spread = {k: int(v) for k, v in zip(keys, parts)}
        SPSpread.from_dict(spread)  # validates 0-32 each, <=66 total
    except (ValueError, InvalidSpreadError):
        return None
    return nature, spread


def merge_sources(files: list[Path]) -> tuple[dict, list[dict]]:
    """Merge multiple ladders, weighting every distribution by battle count."""
    merged: dict[str, dict] = {}
    infos = []
    for path in files:
        raw = json.loads(path.read_text())
        info, data = raw["info"], raw["data"]
        battles = info["number of battles"]
        infos.append(info)
        for name, stats in data.items():
            m = merged.setdefault(name, {
                "usage_num": 0.0, "battles": 0.0,
                "Abilities": {}, "Items": {}, "Spreads": {}, "Moves": {},
                "Teammates": {},
            })
            m["usage_num"] += stats.get("usage", 0.0) * battles
            m["battles"] += battles
            for cat in ("Abilities", "Items", "Spreads", "Moves", "Teammates"):
                for k, share in normalised(stats.get(cat, {})):
                    m[cat][k] = m[cat].get(k, 0.0) + share * battles
    return merged, infos


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--min-usage", type=float, default=1.0,
                    help="minimum merged usage %% to ingest")
    ap.add_argument("--max-sets", type=int, default=3)
    ap.add_argument("--label", default="ladder")
    ap.add_argument("--regulation", default=dataio.DEFAULT_REGULATION,
                    help="regulation to filter/label (default: newest in pokedex)")
    args = ap.parse_args()

    dex = dataio.pokedex()
    move_by_id = {to_id(name): name for name in dataio.moves()}
    item_by_id = {to_id(i["name"]): i["name"] for i in dataio.items().values()}

    merged, infos = merge_sources(args.files)
    out, unmapped, dropped_sets = {}, [], 0

    for showdown_name, m in sorted(merged.items(),
                                   key=lambda kv: -kv[1]["usage_num"]):
        usage = 100.0 * m["usage_num"] / m["battles"]
        if usage < args.min_usage:
            continue
        pid = map_pokemon(showdown_name, dex)
        if pid is None:
            unmapped.append(showdown_name)
            continue
        mon = dex[pid]
        if args.regulation not in mon.get("regulations", []):
            continue

        # ability: top share, mapped to the mon's real ability names
        ability = None
        for ab_id, _ in normalised(m["Abilities"]):
            match = next((a for a in mon["abilities"] if to_id(a) == ab_id), None)
            if match:
                ability = match
                break

        # moves: top 4 learnset-legal
        try:
            learnset = set(dataio.get_learnset(pid)["moves"])
        except KeyError:
            learnset = set()
        moves = []
        for mv_id, _ in normalised(m["Moves"]):
            name = move_by_id.get(mv_id)
            if name and name in learnset and name not in moves:
                moves.append(name)
            if len(moves) == 4:
                break
        if not moves:
            continue

        # ranked usable items (empty/'nothing' allowed as None)
        items = []
        for it_id, share in normalised(m["Items"]):
            if share < 0.05:
                break
            if it_id in ("", "nothing"):
                items.append(None)
            elif it_id in item_by_id:
                items.append(item_by_id[it_id])

        # top spreads -> sets
        spreads = []
        for s, share in normalised(m["Spreads"]):
            parsed = parse_spread(s)
            if parsed:
                spreads.append((parsed[0], parsed[1], share))
            if len(spreads) == args.max_sets:
                break
        sets, total_share = [], sum(s[2] for s in spreads) or 1.0
        for i, (nature, spread, share) in enumerate(spreads):
            item = items[i] if i < len(items) else (items[0] if items else None)
            member = teams.TeamMember(
                combatant=Combatant(pid, spread=SPSpread.from_dict(spread),
                                    alignment=nature, ability=ability,
                                    item=item),
                moves=moves)
            errs = teams.validate_member(member, args.regulation)
            if errs:
                dropped_sets += 1
                continue
            label = f"{item or 'No item'} {nature}"
            if any(s["name"] == label for s in sets):
                label += f" #{i + 1}"
            sets.append({
                "name": label,
                "alignment": nature,
                "spread": spread,
                "item": item,
                "ability": ability,
                "moves": moves,
                "weight": round(share / total_share, 3),
            })
        if sets:
            out[pid] = {"name": mon["name"], "usage": round(usage, 2),
                        "sets": sets, "_teammates_raw": m["Teammates"]}

    # Teammates: top partners by co-occurrence share, restricted to Pokemon that
    # made the cut above (so the practice bot can build coherent ladder cores).
    for pid, entry in out.items():
        mates = []
        for mate_name, share in normalised(entry.pop("_teammates_raw")):
            mate = map_pokemon(mate_name, dex)
            if mate and mate in out and mate != pid:
                mates.append({"pokemon_id": mate, "share": round(share, 4)})
            if len(mates) == 12:
                break
        entry["teammates"] = mates

    if not out:
        tags = sorted({r for m in dex.values() for r in m.get("regulations", [])})
        print(f"ERROR: no Pokemon survived the --regulation {args.regulation!r} "
              f"filter (tags present in pokedex: {tags}). Refusing to overwrite "
              "meta_sets.json with an empty file.", file=sys.stderr)
        return 1

    payload = {
        "info": {
            "label": args.label,
            "regulation": args.regulation,
            "sources": [{"metagame": i["metagame"], "cutoff": i["cutoff"],
                         "battles": i["number of battles"]} for i in infos],
        },
        "pokemon": out,
    }
    (DATA / "meta_sets.json").write_text(json.dumps(payload, indent=1))

    total_sets = sum(len(v["sets"]) for v in out.values())
    print(f"meta_sets.json: {len(out)} Pokemon, {total_sets} sets "
          f"(dropped {dropped_sets} invalid)")
    if unmapped:
        print(f"unmapped names ({len(unmapped)}): {unmapped[:15]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
