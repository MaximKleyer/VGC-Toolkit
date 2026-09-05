"""Migrate the dataset from Regulation M-A to M-B.

Rebuilds pokedex.json and learnsets.json from the M-B sheets (pre-parsed to
/tmp by the inspection step), keeping base stats for existing mons from the old
dex and the megas sheet, hardcoding the few brand-new non-mega mons. Building
the roster purely from the M-B sheets auto-prunes everything not in M-B.

Sources:
  /tmp/mb_learnsets.json  {slug: {name, types, moves}}  -- full base roster
  /tmp/mb_megas.json      {Name: {types, abilities, base, is_mega}}
  /tmp/mb_items.json      [item names]  -- canonical mega-stone names
"""
import json, re
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "vgc_toolkit" / "data"

mb_learn = json.load(open("/tmp/mb_learnsets.json"))
mb_megas = json.load(open("/tmp/mb_megas.json"))
mb_items = json.load(open("/tmp/mb_items.json"))
dex = json.loads((DATA / "pokedex.json").read_text())
old_items = json.loads((DATA / "items.json").read_text())

def slug(n): return re.sub(r"[^a-z0-9]+", "-", n.lower()).strip("-")

# sheet base-name slug -> dex forme id
FORME_MAP = {
    "basculegion": "basculegion-m", "lycanroc": "lycanroc-day",
    "meowstic": "meowstic-m", "palafin": "palafin-zero",
    "tauros-paldea": "tauros-paldea-combat",
}
def resolve(sslug): return FORME_MAP.get(sslug, sslug)

# brand-new non-mega mons (standard stats/abilities; types confirmed vs sheet)
NEW_MONS = {
    "vileplume": (["Grass", "Poison"], dict(hp=75, atk=80, def_=85, spa=110, spd=90, spe=50),
                  ["Chlorophyll", "Effect Spore"]),
    "qwilfish": (["Water", "Poison"], dict(hp=65, atk=95, def_=85, spa=55, spd=55, spe=85),
                 ["Poison Point", "Swift Swim", "Intimidate"]),
    "sceptile": (["Grass"], dict(hp=70, atk=85, def_=65, spa=105, spd=85, spe=120),
                 ["Overgrow", "Unburden"]),
    "mawile": (["Steel", "Fairy"], dict(hp=50, atk=85, def_=85, spa=55, spd=55, spe=50),
               ["Hyper Cutter", "Intimidate", "Sheer Force"]),
    "metagross": (["Steel", "Psychic"], dict(hp=80, atk=135, def_=130, spa=95, spd=90, spe=70),
                  ["Clear Body", "Light Metal"]),
    "musharna": (["Psychic"], dict(hp=116, atk=55, def_=85, spa=107, spd=95, spe=29),
                 ["Forewarn", "Synchronize", "Telepathy"]),
    "lycanroc-midnight": (["Rock"], dict(hp=85, atk=115, def_=75, spa=55, spd=75, spe=82),
                          ["Keen Eye", "Vital Spirit", "No Guard"]),
}
def fix_stats(d):  # def_ -> def
    return {("def" if k == "def_" else k): v for k, v in d.items()}

def base_of_mega(mname):
    return slug(re.sub(r"-Mega(-[XYZ])?$", "", mname))
def mega_display(mname):
    m = re.match(r"(.+?)-Mega(-([XYZ]))?$", mname)
    base = m.group(1).replace("-", " ")
    return f"Mega {base}" + (f" {m.group(3)}" if m.group(3) else "")

# match each mega to its canonical stone from the items sheet
def find_stone(base_name, suffix):
    cands = [s for s in mb_items if s.lower().endswith("ite")
             or re.search(r"ite [xyz]$", s.lower())]
    bl = base_name.lower()
    best, score = None, 0
    for s in cands:
        sl = re.sub(r"(in)?ite( [xyz])?$", "", s.lower())
        n = len(__import__("os").path.commonprefix([bl, sl]))
        if suffix and not s.lower().endswith(suffix.lower()):
            continue
        if not suffix and re.search(r" [xyz]$", s.lower()):
            continue
        if n > score:
            best, score = s, n
    return best

new_dex, missing = {}, []
# ---- base / non-mega forms ----
for sslug, info in mb_learn.items():
    bid = resolve(sslug)
    name, types = info["name"], info["types"]
    if info["name"] in mb_megas:                       # base form is in megas sheet
        src = mb_megas[info["name"]]
        base, abils = src["base"], src["abilities"]
    elif bid in NEW_MONS:
        types, st, abils = NEW_MONS[bid]
        base = fix_stats(st)
    elif bid in dex:
        base, abils = dex[bid]["base"], dex[bid]["abilities"]
    else:
        missing.append(bid); continue
    new_dex[bid] = {"id": bid, "name": name, "types": types, "base": base,
                    "abilities": abils, "regulations": ["M-B"]}

# ---- megas (only those with a defined ability are M-B legal) ----
new_items = {k: v for k, v in old_items.items() if v.get("category") != "mega_stone"}
stone_map = {}
for mname, m in mb_megas.items():
    if not m["is_mega"] or not m["abilities"]:
        continue
    mid = slug(mname)
    bid = resolve(base_of_mega(mname))
    suffix = (re.search(r"-Mega-([XYZ])$", mname) or [None, ""])[1] if re.search(r"-Mega-[XYZ]$", mname) else ""
    if bid not in new_dex:
        missing.append(f"{mid} (base {bid} absent)"); continue
    base_disp = mega_display(mname).replace("Mega ", "").split(" ")[0]
    stone = find_stone(base_disp, suffix) or f"{base_disp}ite"
    new_dex[mid] = {"id": mid, "name": mega_display(mname), "types": m["types"],
                    "base": m["base"], "abilities": [m["abilities"][0]],
                    "mega_of": bid, "mega_stone": stone, "regulations": ["M-B"]}
    new_items[slug(stone)] = {"id": slug(stone), "name": stone,
        "effect": "A Mega Stone. The matching Pokemon can Mega Evolve while holding it.",
        "category": "mega_stone", "mega_form": mid}
    stone_map[mid] = stone

# ---- learnsets keyed by base id ----
new_learn = {resolve(s): {"moves": info["moves"]} for s, info in mb_learn.items()}

(DATA / "pokedex.json").write_text(json.dumps(new_dex, indent=1))
(DATA / "learnsets.json").write_text(json.dumps(new_learn, indent=1))
(DATA / "items.json").write_text(json.dumps(new_items, indent=1))

megas = [p for p, m in new_dex.items() if "mega_of" in m]
print(f"new dex: {len(new_dex)} forms ({len(new_dex)-len(megas)} base + {len(megas)} megas)")
print(f"learnsets: {len(new_learn)} | mega stones: {len(stone_map)}")
if missing:
    print(f"MISSING (skipped): {missing}")
print("\nstone map sample:", dict(list(stone_map.items())[:6]))
