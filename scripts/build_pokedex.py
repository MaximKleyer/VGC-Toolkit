"""Build pokedex.json with the Learnset sheet as the roster source of truth.

This replaces ingest_roster.py as the pokedex authority (ingest_roster.py
still produces alignments.json and speed_abilities.json).

Layering:
  MEMBERSHIP — learnsets.json defines which Pokemon are in the game and
      therefore M-B legal. Megas are legal iff their base form is legal and
      their stone exists in items.json.
  BASELINE   — stats/types/abilities from the @pkmn/dex Gen 9 species dump
      (node scripts/dump_gen9_species.mjs > gen9_species.json).
  CHAMPIONS  — the champions-speed-calc pokemon.js supplies Champions-new
      megas absent from mainline (Mega Golurk, Mega Skarmory, ...) and its
      hand-curated ability lists are kept for forms it covers. Its stats are
      cross-checked against the baseline and every disagreement is reported:
      each is either a Champions stat change to confirm (-> overrides file)
      or a data entry error to fix at the source.
  OVERRIDES  — champions_stat_overrides.json (optional) patches the baseline
      once the sheet's "Pokemon Ch." tab is sourced.

Forms in pokemon.js that are NOT in the learnset roster are kept with an
empty regulations list (they may enter the game later).

Usage:
    python scripts/build_pokedex.py \
        --species gen9_species.json \
        --pokemon ../champions-speed-calc/src/data/pokemon.js \
        [--overrides champions_stat_overrides.json] \
        --regulation M-B
"""

import argparse
import json
from pathlib import Path

from ingest_roster import STAT_KEYS, extract_js_export

OUT_DIR = Path(__file__).resolve().parent.parent / "vgc_toolkit" / "data"

# our id -> @pkmn/dex slug, where they differ
DEX_ALIASES = {
    "lycanroc-day": "lycanroc",
    "lycanroc-night": "lycanroc-midnight",
    "meowstic-m": "meowstic",
    "basculegion-m": "basculegion",
    "palafin-zero": "palafin",
    "mausholds-family4": "maushold-four",
    "sirfetchd": "sirfetch-d",
}

REGIONAL_PREFIX = {"alola": "Alolan", "hisui": "Hisuian", "galar": "Galarian"}


def display_name(our_id: str, dex_name: str) -> str:
    """Match the project's existing naming style (e.g. 'Hisuian Arcanine')."""
    parts = our_id.rsplit("-", 1)
    if len(parts) == 2 and parts[1] in REGIONAL_PREFIX:
        return f"{REGIONAL_PREFIX[parts[1]]} {dex_name.split('-')[0]}"
    return dex_name


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--species", required=True, help="gen9_species.json dump")
    parser.add_argument("--pokemon", required=True, help="champions-speed-calc pokemon.js")
    parser.add_argument("--megas", help="megas_tab.json from ingest_megas_tab.py (optional)")
    parser.add_argument("--overrides", help="champions_stat_overrides.json (optional)")
    parser.add_argument("--regulation", required=True,
                        help="regulation tag to add (e.g. M-C); UNIONED onto each "
                             "form's existing tags so earlier regulations survive")
    args = parser.parse_args()

    species = json.loads(Path(args.species).read_text())
    learnsets = json.loads((OUT_DIR / "learnsets.json").read_text())
    items = json.loads((OUT_DIR / "items.json").read_text())
    overrides = json.loads(Path(args.overrides).read_text()) if args.overrides else {}
    megas_tab = json.loads(Path(args.megas).read_text()) if args.megas else {}

    roster_js = extract_js_export(Path(args.pokemon).read_text(), "ROSTER")
    champ = {}
    for e in roster_js:
        if not e.get("name") or not any(e.get("base", [])):
            continue  # dead placeholder rows
        champ[e["id"]] = e

    # The committed dex: its regulation tags are unioned with --regulation so a
    # rebuild for M-C keeps every form's M-B legality instead of erasing it.
    existing_path = OUT_DIR / "pokedex.json"
    existing = json.loads(existing_path.read_text()) if existing_path.exists() else {}

    def tags_for(form_id, legal=True):
        # Champions regulations carry over ("Pokemon eligible in previous sets
        # remain eligible"), so a form legal in an earlier regulation is also
        # legal in this one even if a stale source flag (e.g. megas_tab.json's
        # in_game) says otherwise. Only brand-new forms depend on `legal`.
        prior = set(existing.get(form_id, {}).get("regulations", []))
        return sorted(prior | ({args.regulation} if (legal or prior) else set()))

    pokedex = {}
    stat_diffs = []
    no_baseline = []

    def dex_lookup(our_id):
        return species.get(DEX_ALIASES.get(our_id, our_id))

    # --- 1. Base forms: roster = learnset sheet ---
    for our_id, ls in learnsets.items():
        dex = dex_lookup(our_id)
        cj = champ.get(our_id)
        if dex:
            base = dict(dex["base"])
            name = display_name(our_id, dex["name"])
            # sheet types win when the row carries them; committed learnset rows
            # are plain {"moves": [...]} so this must not KeyError on "types".
            types = ls.get("types") or dex["types"]
            abilities = cj["abilities"] if cj else dex["abilities"]
            ability_source = "champions_curated" if cj else "gen9_baseline"
        elif cj:
            base = dict(zip(STAT_KEYS, cj["base"]))
            name, types, abilities = cj["name"], cj["types"], cj["abilities"]
            ability_source = "champions_curated"
            no_baseline.append(our_id)
        else:
            no_baseline.append(our_id)
            continue

        if cj:
            cj_base = dict(zip(STAT_KEYS, cj["base"]))
            if dex and cj_base != base:
                diff = {k: (base[k], cj_base[k]) for k in STAT_KEYS if base[k] != cj_base[k]}
                stat_diffs.append((our_id, diff))
        if our_id in overrides:
            base.update(overrides[our_id])

        pokedex[our_id] = {
            "id": our_id, "name": name, "types": types, "base": base,
            "abilities": abilities, "ability_source": ability_source,
            "regulations": tags_for(our_id),
        }

    # --- 2. Megas: from pokemon.js + mainline megas for orphan stones ---
    stones = {i["name"]: i for i in items.values() if i["category"] == "mega_stone"}

    def add_mega(mega_id, name, types, base, abilities, mega_of, stone_name):
        legal = mega_of in pokedex and args.regulation in pokedex[mega_of]["regulations"]
        pokedex[mega_id] = {
            "id": mega_id, "name": name, "types": types, "base": base,
            "abilities": abilities, "mega_of": mega_of, "mega_stone": stone_name,
            "regulations": tags_for(mega_id, legal),
        }

    SUPERSEDED_IDS = {"meowstic-mega"}  # replaced by gendered meowstic-{m,f}-mega

    for our_id, cj in champ.items():
        if "megaOf" not in cj or our_id in SUPERSEDED_IDS:
            continue
        dex = dex_lookup(our_id)
        base = dict(zip(STAT_KEYS, cj["base"]))
        if dex and dict(dex["base"]) != base:
            stat_diffs.append((our_id, {k: (dex["base"][k], base[k])
                                        for k in STAT_KEYS if dex["base"][k] != base[k]}))
            base = dict(dex["base"])  # baseline wins; report shows the conflict
        if our_id in overrides:
            base.update(overrides[our_id])
        add_mega(our_id, cj["name"], cj["types"], base, cj["abilities"],
                 cj["megaOf"], cj.get("megaStone"))

    # --- 2.5 Megas tab (datamined, authoritative for everything it covers) ---
    NEW_MEGA_STONES = {  # stones for tab megas absent from pokemon.js
        "emboar-mega": "Emboarite", "absol-mega": "Absolite",
        "meowstic-m-mega": "Meowsticite", "meowstic-f-mega": "Meowsticite", "audino-mega": "Audinite",
        "garchomp-mega": "Garchompite", "lopunny-mega": "Lopunnite",
    }
    # Megas that are datamined but not yet released. Mega Raichu X/Y left this
    # set when Regulation M-B shipped them; add an id here only while a mega is
    # genuinely unreleased (previously-legal forms carry over via tags_for).
    KNOWN_NOT_IN_GAME: set[str] = set()

    tab_changes, tab_anomalies = [], []

    # Base forms first: patch stats/types/abilities on existing entries.
    for slug, e in megas_tab.items():
        if e["is_mega"]:
            continue
        if slug in pokedex:
            mon = pokedex[slug]
            changes = {}
            if mon["base"] != e["base"]:
                changes["base"] = (mon["base"], e["base"])
                mon["base"] = e["base"]
            if e["abilities"] and mon["abilities"] != e["abilities"]:
                changes["abilities"] = (mon["abilities"], e["abilities"])
                mon["abilities"] = e["abilities"]
                mon["ability_source"] = "megas_tab_datamine"
            if e["types"] and mon["types"] != e["types"]:
                changes["types"] = (mon["types"], e["types"])
                mon["types"] = e["types"]
            if changes:
                tab_changes.append((slug, changes))
        else:
            # Base form not in the learnset roster -> not in game; keep untagged.
            pokedex[slug] = {
                "id": slug, "name": e["name"], "types": e["types"],
                "base": e["base"], "abilities": e["abilities"],
                "ability_source": "megas_tab_datamine", "regulations": [],
            }
            if e["abilities"]:
                tab_anomalies.append(
                    f"{slug}: has datamined abilities but no learnset row")

    # Megas: tab wins over pokemon.js / mainline baseline.
    for slug, e in megas_tab.items():
        if not e["is_mega"]:
            continue
        base_id = e["mega_of"]
        base_legal = (base_id in pokedex
                      and args.regulation in pokedex[base_id]["regulations"])
        legal = e["in_game"] and base_legal and slug not in KNOWN_NOT_IN_GAME
        if e["in_game"] and not base_legal:
            tab_anomalies.append(
                f"{slug}: mega is in-game but base form {base_id!r} is not in roster")
        prev = pokedex.get(slug)
        stone = (prev or {}).get("mega_stone") or NEW_MEGA_STONES.get(slug)
        if prev:
            changes = {}
            for field in ("base", "types"):
                if prev[field] != e[field]:
                    changes[field] = (prev[field], e[field])
            if e["abilities"] and prev["abilities"] != e["abilities"]:
                changes["abilities"] = (prev["abilities"], e["abilities"])
            if changes:
                tab_changes.append((slug, changes))
        pokedex[slug] = {
            "id": slug, "name": (prev or {}).get("name") or e["name"],
            "types": e["types"], "base": e["base"],
            "abilities": e["abilities"] or (prev or {}).get("abilities", []),
            "mega_of": base_id, "mega_stone": stone,
            "regulations": tags_for(slug, legal),
        }
        if slug in overrides:
            pokedex[slug]["base"].update(overrides[slug])
        if stone is None:
            tab_anomalies.append(f"{slug}: no known mega stone item")

    # Mainline megas implied by stones with no pokemon.js entry. Explicit map
    # because stone names elide letters ("Audinite" -> audino); Emboarite has
    # no mainline mega, so Mega Emboar stats must come from the Megas tab.
    ORPHAN_STONE_MEGAS = {
        "Audinite": "audino-mega",
        "Garchompite": "garchomp-mega",
        "Lopunnite": "lopunny-mega",
    }
    added_megas, missing_megas = [], []
    linked = {m["mega_stone"] for m in pokedex.values() if m.get("mega_stone")}
    for stone_name, stone in stones.items():
        if stone_name in linked or stone.get("mega_form") in pokedex:
            continue
        mega_slug = ORPHAN_STONE_MEGAS.get(stone_name)
        if mega_slug and mega_slug in species:
            dex = species[mega_slug]
            base_id = (dex["base_species"] or mega_slug).lower()
            add_mega(mega_slug, f"Mega {dex['base_species']}",
                     dex["types"], dict(dex["base"]), dex["abilities"],
                     base_id, stone_name)
            if base_id in pokedex and pokedex[base_id].get("regulations"):
                added_megas.append(mega_slug)
            else:
                missing_megas.append((stone_name, "base form not in roster"))
        else:
            missing_megas.append((stone_name, "no stats source — needs Megas tab"))

    # --- 2.7 Battle formes (same roster slot, different calc stats) ---
    BATTLE_FORMES = {"aegislash": "aegislash-blade"}
    for base_id, forme_slug in BATTLE_FORMES.items():
        if base_id not in pokedex or forme_slug not in species:
            continue
        dex = species[forme_slug]
        base_stats = dict(dex["base"])
        if forme_slug in overrides:
            base_stats.update(overrides[forme_slug])
        pokedex[forme_slug] = {
            "id": forme_slug, "name": dex["name"], "types": dex["types"],
            "base": base_stats, "abilities": pokedex[base_id]["abilities"],
            "forme_of": base_id,
            "regulations": list(pokedex[base_id]["regulations"]),
        }

    # Back-link mega forms onto base forms.
    for mon in pokedex.values():
        mon.pop("mega_forms", None)
    for mon in list(pokedex.values()):
        if mon.get("mega_of") and mon["mega_of"] in pokedex:
            pokedex[mon["mega_of"]].setdefault("mega_forms", []).append(mon["id"])

    # --- 3. Not-in-game forms from pokemon.js: keep, untagged ---
    ghosts = []
    for our_id, cj in champ.items():
        if our_id in pokedex or "megaOf" in cj:
            continue
        pokedex[our_id] = {
            "id": our_id, "name": cj["name"], "types": cj["types"],
            "base": dict(zip(STAT_KEYS, cj["base"])), "abilities": cj["abilities"],
            "ability_source": "champions_curated",
            # not in this roster, but keep any regulation it was legal in before
            "regulations": tags_for(our_id, legal=False),
        }
        ghosts.append(our_id)

    # --- 4. Carry forward committed forms absent from this run's inputs ---
    # A rebuild from a newer roster must never silently drop a form an earlier
    # regulation shipped; keep it exactly as committed, tags included.
    carried = [fid for fid in existing if fid not in pokedex]
    for fid in carried:
        pokedex[fid] = existing[fid]

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    # indent=1 matches the committed file so rebuild diffs stay minimal
    (OUT_DIR / "pokedex.json").write_text(json.dumps(pokedex, indent=1))
    if carried:
        print(f"  carried forward from the committed dex (absent from inputs): "
              f"{len(carried)}")

    legal = [m for m in pokedex.values() if args.regulation in m["regulations"]]
    megas = [m for m in pokedex.values() if "mega_of" in m]
    print(f"pokedex.json: {len(pokedex)} forms total")
    print(f"  {args.regulation}-legal: {len(legal)} "
          f"({len([m for m in legal if 'mega_of' not in m])} base + "
          f"{len([m for m in legal if 'mega_of' in m])} megas)")
    print(f"  megas: {len(megas)} | not-in-game forms kept untagged: {len(ghosts)}")
    if added_megas:
        print(f"  megas added from mainline baseline (orphan stones): {added_megas}")
    if missing_megas:
        print(f"  WARNING stones still unresolved: {missing_megas}")
    if no_baseline:
        print(f"  forms with no @pkmn/dex baseline: {no_baseline}")
    if megas_tab:
        in_game_megas = [s for s, e in megas_tab.items() if e["is_mega"] and e["in_game"]]
        print(f"  megas tab applied: {len(in_game_megas)} in-game megas, "
              f"{len([s for s, e in megas_tab.items() if e['is_mega'] and not e['in_game']])} "
              "kept untagged (not in Champions yet)")
        if tab_changes:
            print(f"  megas tab corrections applied ({len(tab_changes)}):")
            for slug, changes in tab_changes:
                for field, (old, new) in changes.items():
                    print(f"    {slug}.{field}: {old} -> {new}")
        if tab_anomalies:
            print("  megas tab anomalies:")
            for a in tab_anomalies:
                print(f"    {a}")
    if stat_diffs:
        print(f"\n  STAT DIFFS pokemon.js vs gen9 baseline ({len(stat_diffs)}) "
              "— confirm as Champions changes (-> overrides) or fix at source:")
        for mon_id, diff in stat_diffs:
            pretty = ", ".join(f"{k}: dex {a} vs yours {b}" for k, (a, b) in diff.items())
            print(f"    {mon_id}: {pretty}")


if __name__ == "__main__":
    main()
