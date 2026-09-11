"""Apply the Regulation M-C release (2026-09-08) to the canonical data files.

Regulation M-C dropped with the Pokemon, items and changes listed below, which
replaces the toolkit's "Reg M-C Experimental" predictions (tag M-C-EXP):

1. Retires M-C-EXP. Predictions that came true (Indeedee M/F, Pincurchin,
   Cinderace, Inteleon, the four terrain Seeds) become plain M-C forms/items;
   the rest (Weezing, Galarian Weezing, Dondozo, Tatsugiri, Mega Tatsugiri,
   Assault Vest, Choice Band, Choice Specs, Tatsugirite) are removed along
   with the moves only they used. vgc_toolkit/data/regulations.json loses the
   tag.
2. Adds the other new species from scripts/mc_species.json (Gen 8 + 9
   mainline data dumped from the sim's engine by scripts/dump_mc_species.mjs):
   Wigglytuff, Persian, Alolan Persian, Farfetch'd, Mr. Mime, Swalot, Gogoat,
   Thievul, Toxtricity (Amped, Low Key), Grapploct, Perrserker, Sirfetch'd,
   Arboliva, Pawmot, Squawkabilly (Green / Yellow plumage: the two ability
   sets), Mabosstiff. Learnsets are provisional: the mainline learnset
   intersected with the Champions move pool plus the signature moves added
   in step 3.
3. Adds the moves the pool lacked: Slash (usable again), Milk Drink, Meteor
   Assault, Double Shock, Overdrive, Shift Gear, Octolock, Revival Blessing,
   Jaw Lock. Slash is added to every roster species whose mainline learnset
   has it.
4. Applies the M-C move changes: Slash 70 -> 80 BP, Meteor Assault 150 -> 170,
   Snipe Shot 80 -> 85, Wish and Strength Sap 12 -> 8 PP, Double Shock is a
   punching move, Milk Drink can target the ally. Learnset changes: Politoed
   loses Pound, Archaludon loses Mirror Coat and Metal Burst.
5. Confirms the six new Megas' abilities (Mega Absol Z Sharpness, Mega
   Garchomp Z Levitate, Mega Lucario Z Aura Guard, Mega Salamence Aerilate,
   Mega Golisopod Tough Claws, Mega Baxcalibur Thermal Exchange) and drops the
   now-stale ability overrides.
6. Adds the new held items (Leek, Rocky Helmet, Air Balloon, Red Card,
   Binding Band, Eject Button, Normal Gem, Terrain Extender), scoped to M-C
   like the Seeds, with the calc's mechanics tags from scripts/ingest_items.py.

Additive and idempotent: re-running after it has been applied changes nothing.

Usage:  python scripts/add_mc_release.py [--dry-run] [--force-learnsets]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ingest_items import categorize  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "vgc_toolkit" / "data"
DUMP = ROOT / "scripts" / "mc_species.json"

REG = "M-C"
OLD_EXP = "M-C-EXP"
LEARNSET_SOURCE = ("provisional: Gen 8 + Gen 9 mainline learnset (pokemon-showdown engine; "
                   "Champions keeps the Gen 8 TR moves SV dropped) intersected with the "
                   "Champions move pool; replace when the Champions M-C learnsets are published")
MOVE_SOURCE = "mc_2026-09: gen9 mainline definition (move added to the pool with Regulation M-C)"
MC_PATCH = "+mc_2026-09"

# Predictions confirmed by the release: they keep their entries and become M-C.
CONFIRMED_PREDICTIONS = ["indeedee-m", "indeedee-f", "pincurchin", "cinderace", "inteleon"]
CONFIRMED_ITEMS = ["grassy-seed", "electric-seed", "psychic-seed", "misty-seed"]
# Predictions the release did not include: removed.
RETIRED_FORMS = ["weezing", "weezing-galar", "dondozo", "tatsugiri", "tatsugiri-mega"]
RETIRED_ITEMS = ["assault-vest", "choice-band", "choice-specs", "tatsugirite"]

# engine id -> (toolkit id, display name). Ids are the pokedex convention:
# the slug of the display name (Mr. Mime -> mr-mime, Farfetch'd -> farfetch-d),
# regional forms "Name-Region", the plain name for a species' default forme.
NEW_SPECIES: dict[str, tuple[str, str]] = {
    "wigglytuff": ("wigglytuff", "Wigglytuff"),
    "persian": ("persian", "Persian"),
    "persianalola": ("persian-alola", "Persian-Alola"),
    "farfetchd": ("farfetch-d", "Farfetch'd"),
    "mrmime": ("mr-mime", "Mr. Mime"),
    "swalot": ("swalot", "Swalot"),
    "gogoat": ("gogoat", "Gogoat"),
    "thievul": ("thievul", "Thievul"),
    "toxtricity": ("toxtricity", "Toxtricity"),
    "toxtricitylowkey": ("toxtricity-low-key", "Toxtricity-Low-Key"),
    "grapploct": ("grapploct", "Grapploct"),
    "perrserker": ("perrserker", "Perrserker"),
    "sirfetchd": ("sirfetch-d", "Sirfetch'd"),
    "arboliva": ("arboliva", "Arboliva"),
    "pawmot": ("pawmot", "Pawmot"),
    "squawkabilly": ("squawkabilly", "Squawkabilly"),
    "squawkabillyyellow": ("squawkabilly-yellow", "Squawkabilly-Yellow"),
    "mabosstiff": ("mabosstiff", "Mabosstiff"),
}
# The confirmed predictions were added from the same kind of dump; refresh
# their learnsets too when --force-learnsets is given.
DUMPED_EXISTING = {"cinderace": "cinderace", "inteleon": "inteleon", "pincurchin": "pincurchin",
                   "indeedee": "indeedee-m", "indeedeef": "indeedee-f"}

# Moves the Champions pool lacked that the new species (or the release notes)
# bring: definitions from the engine dump, M-C values applied in MOVE_CHANGES.
NEW_MOVES = ["Slash", "Milk Drink", "Meteor Assault", "Double Shock", "Overdrive",
             "Shift Gear", "Octolock", "Revival Blessing", "Jaw Lock"]

# The M-C move changes (release notes, 2026-09-08). accuracy None == never misses.
MOVE_CHANGES: dict[str, dict] = {
    "Slash": {"base_power": 80},
    "Meteor Assault": {"base_power": 170},
    "Snipe Shot": {"base_power": 85},
    "Wish": {"pp": 8},
    "Strength Sap": {"pp": 8},
    "Double Shock": {"flags": {"punch": 1}},          # merged into the flags
    "Milk Drink": {"target": "adjacentAllyOrSelf"},   # can be used on the ally
}
LEARNSET_REMOVALS = {"politoed": ["Pound"], "archaludon": ["Mirror Coat", "Metal Burst"]}

# Abilities confirmed with the release (Maxim, 2026-09-09).
CONFIRMED_ABILITIES = {
    "absol-mega-z": ["Sharpness"],
    "garchomp-mega-z": ["Levitate"],
    "lucario-mega-z": ["Aura Guard"],
    "salamence-mega": ["Aerilate"],
    "golisopod-mega": ["Tough Claws"],
    "baxcalibur-mega": ["Thermal Exchange"],
}

# name -> flavour text. Mechanics tags come from ingest_items.categorize.
NEW_ITEMS = {
    "Leek": "An item to be held by Farfetch'd or Sirfetch'd. This long, stiff stalk of leek boosts the critical-hit ratio of the holder's moves.",
    "Rocky Helmet": "An item to be held by a Pokemon. If the holder is hit, the attacker will also be damaged upon contact.",
    "Air Balloon": "An item to be held by a Pokemon. The holder will float in the air until hit. Once hit, this item will burst.",
    "Red Card": "An item to be held by a Pokemon. When the holder is hit by an attack, the attacker is removed from battle.",
    "Binding Band": "An item to be held by a Pokemon. A band that increases the power of binding moves when held.",
    "Eject Button": "An item to be held by a Pokemon. If the holder is hit by an attack, it will be switched out of battle.",
    "Normal Gem": "A gem with an ordinary essence. When held, it strengthens the power of a Normal-type move one time.",
    "Terrain Extender": "An item to be held by a Pokemon. It extends the duration of the terrain caused by the holder's Ability or a move.",
}


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def load(name: str) -> dict:
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def dump(name: str, obj: dict, dry: bool) -> None:
    if dry:
        return
    (DATA / name).write_text(json.dumps(obj, indent=1) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="report, write nothing")
    ap.add_argument("--force-learnsets", action="store_true",
                    help="rewrite the provisional learnsets of the dumped species")
    args = ap.parse_args()
    dry = args.dry_run

    if not DUMP.exists():
        sys.exit(f"ERROR: {DUMP} missing; run: node scripts/dump_mc_species.mjs > scripts/mc_species.json")
    dumped = json.loads(DUMP.read_text(encoding="utf-8"))
    dex = load("pokedex.json")
    items = load("items.json")
    learnsets = load("learnsets.json")
    moves = load("moves.json")

    # ---- 1. retire M-C-EXP
    retagged, promoted = 0, []
    for pid, mon in dex.items():
        regs = mon.get("regulations", [])
        if OLD_EXP in regs:
            regs.remove(OLD_EXP)
            retagged += 1
        if mon.pop("experimental", None) is not None and pid in CONFIRMED_PREDICTIONS:
            promoted.append(pid)
        if pid in CONFIRMED_PREDICTIONS and REG not in regs:
            regs.append(REG)
            regs.sort()
    removed_forms = [pid for pid in RETIRED_FORMS if dex.pop(pid, None) is not None]
    for pid in RETIRED_FORMS:
        learnsets.pop(pid, None)
    for mon in dex.values():
        if mon.get("mega_forms"):
            mon["mega_forms"] = [f for f in mon["mega_forms"] if f in dex]
    removed_items = [k for k in RETIRED_ITEMS if items.pop(k, None) is not None]
    for key in CONFIRMED_ITEMS:
        if key in items:
            items[key]["regulations"] = [REG]
            items[key].pop("experimental", None)
    for v in items.values():
        if v.get("regulations") == [OLD_EXP]:
            v["regulations"] = [REG]
        v.pop("experimental", None)
    print(f"retired {OLD_EXP}: untagged {retagged} forms, promoted {', '.join(promoted) or '(none)'}, "
          f"removed forms {', '.join(removed_forms) or '(none)'}, removed items {', '.join(removed_items) or '(none)'}")

    # ---- 2. new species
    added = []
    for engine_id, (pid, name) in NEW_SPECIES.items():
        src = dumped["species"].get(engine_id)
        if src is None:
            sys.exit(f"ERROR: {engine_id} not in {DUMP.name}")
        if pid in dex:
            regs = dex[pid].setdefault("regulations", [])
            if REG not in regs:
                regs.append(REG)
                regs.sort()
            continue
        dex[pid] = {"id": pid, "name": name, "types": list(src["types"]), "base": dict(src["base"]),
                    "abilities": list(src["abilities"]), "regulations": [REG], "weight_kg": src["weight_kg"]}
        added.append(pid)
    print(f"added {len(added)} forms: {', '.join(added) or '(none, already present)'}")

    # ---- 3. moves the pool lacked
    new_moves = []
    for name in NEW_MOVES:
        if name in moves:
            continue
        if name not in dumped["moves"]:
            sys.exit(f"ERROR: move {name} not in {DUMP.name}")
        moves[name] = {**dumped["moves"][name], "source": MOVE_SOURCE}
        new_moves.append(name)
    for mv in moves.values():
        if str(mv.get("source", "")).startswith("experimental:"):
            mv["source"] = MOVE_SOURCE
    orphaned = [m for m in ("Order Up", "Strange Steam") if m in moves
                and not any(m in ls["moves"] for ls in learnsets.values())]
    for m in orphaned:
        moves.pop(m)
    print(f"added {len(new_moves)} moves: {', '.join(new_moves) or '(none)'}; "
          f"dropped {', '.join(orphaned) or '(none)'}")

    # ---- 4. move changes and learnset changes
    changed = []
    for name, fields in MOVE_CHANGES.items():
        mv = moves.get(name)
        if mv is None:
            print(f"WARNING: {name} not in the move pool; change skipped")
            continue
        for field, value in fields.items():
            if field == "flags":
                if all(mv.get("flags", {}).get(k) == v for k, v in value.items()):
                    continue
                mv["flags"] = {**mv.get("flags", {}), **value}
            elif mv.get(field) == value:
                continue
            else:
                mv[field] = value
            changed.append(f"{name} {field}")
            if MC_PATCH not in str(mv.get("source", "")):
                mv["source"] = str(mv.get("source", "")) + MC_PATCH
    print(f"move changes applied: {', '.join(changed) or '(none, already applied)'}")

    ls_changed = []
    for pid, names in LEARNSET_REMOVALS.items():
        ls = learnsets.get(pid)
        if not ls:
            continue
        before = len(ls["moves"])
        ls["moves"] = [m for m in ls["moves"] if m not in names]
        if len(ls["moves"]) != before:
            ls_changed.append(f"{pid} -{', -'.join(names)}")
    slash_learners = [x for x in dumped["learners"].get("Slash", []) if not x.startswith("engine:")]
    slash_added = []
    for pid in slash_learners:
        ls = learnsets.get(pid)
        if ls and "Slash" not in ls["moves"]:
            ls["moves"] = sorted(ls["moves"] + ["Slash"])
            slash_added.append(pid)
    print(f"learnset changes: {', '.join(ls_changed) or '(none)'}; Slash added to {len(slash_added)} species")

    # ---- provisional learnsets for the dumped species
    written, kept = [], []
    targets = {**{e: pid for e, (pid, _) in NEW_SPECIES.items()}, **DUMPED_EXISTING}
    for engine_id, pid in targets.items():
        src = dumped["species"].get(engine_id)
        if src is None:
            continue
        if pid in learnsets and not args.force_learnsets and pid not in added:
            kept.append(pid)
            continue
        legal = sorted(m for m in src["learnset"] if m in moves)
        learnsets[pid] = {"moves": legal, "source": LEARNSET_SOURCE}
        written.append(f"{pid} ({len(legal)}/{len(src['learnset'])})")
    for ls in learnsets.values():
        if str(ls.get("source", "")).startswith("experimental:"):
            ls["source"] = LEARNSET_SOURCE
    print(f"learnsets written: {', '.join(written) or '(none)'}"
          + (f"; kept existing: {', '.join(kept)}" if kept else ""))

    # ---- 5. mega abilities
    confirmed = []
    for pid, abilities in CONFIRMED_ABILITIES.items():
        mon = dex.get(pid)
        if mon is None:
            print(f"WARNING: {pid} missing from the pokedex")
            continue
        if mon.get("abilities") != abilities or mon.get("abilities_provisional"):
            mon["abilities"] = list(abilities)
            mon.pop("abilities_provisional", None)
            confirmed.append(pid)
    ov_path = DATA / "ability_overrides.json"
    stale = []
    if ov_path.exists():
        ov = json.loads(ov_path.read_text(encoding="utf-8"))
        stale = [pid for pid in CONFIRMED_ABILITIES if pid in ov]
        for pid in stale:
            ov.pop(pid)
        if stale and not dry:
            ov_path.write_text(json.dumps(ov, indent=1) + "\n", encoding="utf-8")
    print(f"mega abilities confirmed: {', '.join(confirmed) or '(none, already set)'}"
          + (f"; stale overrides removed: {', '.join(stale)}" if stale else ""))

    # ---- 6. items
    mega_stones = {m["mega_stone"]: m["id"] for m in dex.values() if m.get("mega_stone")}
    new_items = []
    for name, effect in NEW_ITEMS.items():
        key = slug(name)
        if key in items:
            continue
        items[key] = {"id": key, "name": name, "effect": effect, **categorize(name, mega_stones),
                      "regulations": [REG]}
        new_items.append(name)
    print(f"added {len(new_items)} items: {', '.join(new_items) or '(none)'}")

    # ---- regulations.json: the experimental tag is gone
    reg_path = DATA / "regulations.json"
    if reg_path.exists():
        raw = json.loads(reg_path.read_text(encoding="utf-8"))
        if OLD_EXP in raw:
            raw.pop(OLD_EXP)
            raw["_comment"] = ("Metadata for regulation tags that need more than a name (label, "
                               "experimental, based_on). Tags absent here are ordinary published "
                               "regulations. Empty since Regulation M-C shipped on 2026-09-08 and "
                               "replaced the toolkit's M-C-EXP predictions.")
            if not dry:
                reg_path.write_text(json.dumps(raw, indent=1) + "\n", encoding="utf-8")
            print(f"regulations.json: removed {OLD_EXP}")

    dump("pokedex.json", dex, dry)
    dump("items.json", items, dry)
    dump("moves.json", moves, dry)
    dump("learnsets.json", learnsets, dry)
    megas = sum(1 for m in dex.values() if "mega_of" in m)
    mc = sum(1 for m in dex.values() if REG in m.get("regulations", []))
    print(f"{'DRY RUN - nothing written' if dry else 'written'}: {len(dex)} forms ({megas} megas, {mc} legal in {REG}), "
          f"{len(moves)} moves, {len(learnsets)} learnsets, {len(items)} items")
    return 0


if __name__ == "__main__":
    sys.exit(main())
