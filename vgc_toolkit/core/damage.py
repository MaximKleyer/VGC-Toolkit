"""Damage engine for Pokemon Champions.

Implements the Gen 9 damage formula with exact integer semantics
(4096-based modifier chains, pokeRound half-down rounding, the precise
floor sequence), scoped to Champions' actual item and ability pool.
Held items are data-driven from the mechanics tags in items.json (set by
scripts/ingest_items.py, refreshed by scripts/retag_items.py): type-boost
items (x1.2), Muscle Band / Wise Glasses (x1.1 by category), Metronome
(consecutive-use streak via Combatant.move_streak), Life Orb (x1.3 plus a
10% recoil note), Expert Belt (x1.2 on super-effective hits),
super-effective-resist berries, Focus Sash (no OHKO from full HP), Iron
Ball (grounds the holder; its speed halving lives in speed.py) and Light
Ball. Choice Band / Specs (x1.5 Atk / SpA), Assault Vest (x1.5 SpD) and the
terrain Seeds (+1 stage while the field's terrain matches) exist only in the
Regulation M-C items (terrain_seed / airborne / gem_type tags); Eviolite is
not in Champions. The "-ate" abilities (Aerilate, Pixilate, Refrigerate,
Galvanize and Champions' Dragonize) convert the user's Normal-type moves to
their type at x1.2, with STAB judged on the new type; results carry the
effective ``type``.

Pipeline (mirrors the reference @smogon/calc implementation):
    base power mods -> attack mods -> defense mods -> base damage
    -> spread -> weather -> crit -> 16 random rolls (85..100)
    -> STAB -> type effectiveness -> burn -> chained final mods

The five Champions-new abilities (Mega Sol, Dragonize, Piercing Drill,
Spicy Spray, Aura Guard) are fully modeled (mechanics confirmed 2026-06-10
and 2026-09-03); Aura Guard halves damage the holder takes from contact
moves, and Spicy Spray additionally attaches an informational note about
its burn-on-contact effect so the user is aware of it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field as dc_field

from vgc_toolkit.core import dataio, stats
from vgc_toolkit.core.stats import SPSpread

LEVEL = 50


# ---------- exact rounding primitives ----------

def poke_round(x: float) -> int:
    """Game's rounding: round half DOWN."""
    frac = x - math.floor(x)
    return math.ceil(x) if frac > 0.5 else math.floor(x)


def chain_mods(mods: list[int]) -> int:
    """Chain 4096-based modifiers with the game's per-step rounding."""
    x = 4096
    for m in mods:
        if m != 4096:
            x = (x * m + 2048) >> 12
    return x


def apply_mod(value: int, mod: int) -> int:
    return poke_round(value * mod / 4096)


# Exact 4096-based constants used by the reference implementation for the
# common item multipliers (float rounding would be off by one for x1.3).
_MOD_TABLE = {1.1: 4505, 1.2: 4915, 1.3: 5324, 1.5: 6144, 2.0: 8192,
              0.5: 2048, 0.75: 3072}


def _to_mod(mult: float) -> int:
    return _MOD_TABLE.get(mult, round(mult * 4096))


# Metronome (item): x1.2 per consecutive use of the same move, capped at x2.
METRONOME_MODS = [4096, 4915, 5734, 6554, 7373, 8192]


# ---------- inputs ----------

@dataclass
class Combatant:
    pokemon_id: str
    spread: SPSpread = dc_field(default_factory=SPSpread)
    alignment: str = "Serious"
    ability: str | None = None      # defaults to first listed ability
    item: str | None = None
    stages: dict = dc_field(default_factory=dict)  # atk/def/spa/spd
    status: str | None = None       # 'burn' | 'paralysis' | ...
    current_hp_fraction: float = 1.0
    ability_active: bool = True     # e.g. pinch abilities, Flash Fire boost
    move_streak: int = 0            # prior consecutive uses of this move (Metronome item)

    def resolve(self):
        mon = dataio.get_pokemon(self.pokemon_id)
        ability = self.ability or (mon["abilities"][0] if mon["abilities"] else None)
        final = stats.calc_all_stats(mon["base"], self.spread, self.alignment)
        return mon, ability, final


@dataclass
class Field:
    weather: str = "none"           # none|sun|rain|sand|snow
    terrain: str = "none"           # none|electric|grassy|psychic|misty
    is_doubles: bool = True         # Champions VGC is doubles
    is_spread: bool | None = None   # None = auto from move targeting
    is_crit: bool = False
    reflect: bool = False           # on defender's side
    light_screen: bool = False
    aurora_veil: bool = False
    friend_guard: bool = False
    helping_hand: bool = False
    defender_protected: bool = False
    fairy_aura: bool = False     # x1.33 Fairy-type moves
    dark_aura: bool = False      # x1.33 Dark-type moves
    gravity: bool = False        # grounds everyone: Ground hits Flying/Levitate


# ---------- mechanics tables (Champions pool) ----------

# Champions-new abilities, mechanics confirmed by Maxim 2026-06-10:
#   Mega Sol       - user's moves behave as if harsh sunlight were active
#   Dragonize      - user's Normal moves become Dragon-type, x1.2 power
#   Piercing Drill - user's contact moves hit through protection at 1/4 damage
#   Spicy Spray    - burns any attacker that damages this Pokemon (no calc mod)
#   Aura Guard     - halves damage taken from contact moves (Mega Lucario Z; 2026-09-03)
UNKNOWN_ABILITIES: set[str] = set()

# "-ate" abilities: the user's Normal-type moves become this type (x1.2 power,
# STAB then applies to the new type). Dragonize is Champions' own version.
ATE_ABILITIES = {"Dragonize": "Dragon", "Aerilate": "Flying", "Pixilate": "Fairy",
                 "Refrigerate": "Ice", "Galvanize": "Electric"}
# Normal-typed moves whose type is decided by other rules and are not converted.
ATE_EXEMPT = {"Hidden Power", "Judgment", "Multi-Attack", "Natural Gift",
              "Revelation Dance", "Struggle", "Terrain Pulse", "Tera Blast"}

TERRAIN_PULSE_TYPES = {"electric": "Electric", "grassy": "Grass",
                       "psychic": "Psychic", "misty": "Fairy"}

IMMUNITY_ABILITIES = {  # ability -> move type nullified
    "Levitate": "Ground", "Eelevate": "Ground", "Flash Fire": "Fire", "Water Absorb": "Water",
    "Storm Drain": "Water", "Dry Skin": "Water", "Volt Absorb": "Electric",
    "Lightning Rod": "Electric", "Motor Drive": "Electric",
    "Sap Sipper": "Grass", "Well-Baked Body": "Fire",
}
FLAG_IMMUNITY_ABILITIES = {"Bulletproof": "bullet", "Soundproof": "sound",
                           "Wind Rider": "wind"}
# Holders cannot be burned, so a 'burn' status on them is ignored by the calc.
BURN_IMMUNE_ABILITIES = {"Water Bubble", "Water Veil", "Thermal Exchange"}

USES_DEFENDER_DEF = {"Psyshock", "Psystrike", "Secret Sword"}
USES_ATTACKER_DEF = {"Body Press"}
USES_DEFENDER_ATK = {"Foul Play"}
IGNORES_DEF_STAGES = {"Sacred Sword", "Darkest Lariat", "Chip Away"}

VARIABLE_BP_MOVES = {
    "Gyro Ball", "Electro Ball", "Stored Power", "Power Trip", "Reversal", "Flail",
    "Eruption", "Water Spout", "Dragon Energy", "Hard Press", "Crush Grip",
    "Last Respects", "Rage Fist",
}

# Weight-based base power (Gen 9 rules, which Champions keeps). Low Kick and
# Grass Knot scale with the target's weight; Heavy Slam and Heat Crash with the
# user-to-target ratio. Heavy Metal doubles and Light Metal halves a Pokemon's
# weight (Champions has no Float Stone). Weights live in pokedex.json
# (scripts/fill_weights.py); without one the listed 0 BP stands and a note says so.
WEIGHT_TARGET_MOVES = {"Low Kick", "Grass Knot"}
WEIGHT_RATIO_MOVES = {"Heavy Slam", "Heat Crash"}
WEIGHT_MOVES = WEIGHT_TARGET_MOVES | WEIGHT_RATIO_MOVES
WEIGHT_ABILITY_MULT = {"Heavy Metal": 2.0, "Light Metal": 0.5}


def effective_weight(mon: dict, ability: str | None) -> float | None:
    """A Pokemon's weight in kg after Heavy Metal / Light Metal, or None if unknown."""
    kg = mon.get("weight_kg")
    if not kg:
        return None
    return kg * WEIGHT_ABILITY_MULT.get(ability or "", 1.0)


def weight_base_power(move_name: str, atk_mon: dict, atk_ability: str | None,
                      def_mon: dict, def_ability: str | None) -> tuple[int | None, str]:
    """(base power, note) for a weight-based move; (None, why) without weight data."""
    dw = effective_weight(def_mon, def_ability)
    if dw is None:
        return None, f"{move_name}: no weight on record for {def_mon['name']}"
    if move_name in WEIGHT_TARGET_MOVES:
        bp = (120 if dw >= 200 else 100 if dw >= 100 else 80 if dw >= 50
              else 60 if dw >= 25 else 40 if dw >= 10 else 20)
        return bp, f"{move_name}: {bp} BP ({def_mon['name']} {dw:g} kg)"
    aw = effective_weight(atk_mon, atk_ability)
    if aw is None:
        return None, f"{move_name}: no weight on record for {atk_mon['name']}"
    ratio = aw / dw
    bp = 120 if ratio >= 5 else 100 if ratio >= 4 else 80 if ratio >= 3 else 60 if ratio >= 2 else 40
    return bp, f"{move_name}: {bp} BP ({atk_mon['name']} {aw:g} kg vs {def_mon['name']} {dw:g} kg)"

MULTIHIT_HINT = {
    "Bullet Seed": 5, "Rock Blast": 5, "Icicle Spear": 5, "Pin Missile": 5,
    "Scale Shot": 5, "Water Shuriken": 3, "Icicle Crash": 1,  # not multihit
    "Surging Strikes": 3, "Triple Axel": 3, "Dual Wingbeat": 2, "Tachyon Cutter": 2,
}
MULTIHIT_HINT.pop("Icicle Crash")


def stage_mult_num_den(stage: int) -> tuple[int, int]:
    if stage >= 0:
        return 2 + stage, 2
    return 2, 2 - stage


def staged(stat: int, stage: int) -> int:
    n, d = stage_mult_num_den(stage)
    return math.floor(stat * n / d)


# ---------- the engine ----------

def calculate(attacker: Combatant, defender: Combatant, move_name: str,
              field: Field | None = None, bp_override: int | None = None,
              hits: int = 1, max_ko_hits: int = 4) -> dict:
    field = field or Field()
    notes: list[str] = []

    atk_mon, atk_ability, atk_stats = attacker.resolve()
    def_mon, def_ability, def_stats = defender.resolve()
    move = dict(dataio.get_move(move_name))

    for who, ab in (("attacker", atk_ability), ("defender", def_ability)):
        if ab in UNKNOWN_ABILITIES:
            notes.append(f"{who} ability {ab!r} has unknown Champions mechanics "
                         "and is NOT modeled")

    if move["category"] == "Status":
        return _result(move, [0] * 16, def_stats, defender, hits, notes + ["status move"], max_ko_hits=max_ko_hits)

    move_type = move["type"]
    flags = move.get("flags", {})

    # Mega Sol: the user's moves act under harsh sunlight.
    effective_weather = field.weather
    if atk_ability == "Mega Sol":
        if field.weather not in ("none", "sun"):
            notes.append("Mega Sol vs active weather interaction unverified; "
                         "treating the user's move as sun-boosted")
        effective_weather = "sun"

    # Weather Ball: 100 BP and takes the weather's type (before STAB,
    # effectiveness, and immunity checks, since it IS that type now).
    weather_ball = False
    WEATHER_BALL_TYPES = {"sun": "Fire", "rain": "Water",
                          "sand": "Rock", "snow": "Ice"}
    if move_name == "Weather Ball" and effective_weather in WEATHER_BALL_TYPES:
        move_type = WEATHER_BALL_TYPES[effective_weather]
        weather_ball = True
        notes.append(f"Weather Ball: {move_type}-type, 100 BP in "
                     f"{effective_weather}")

    # "-ate" abilities (Dragonize, Aerilate, Pixilate, Refrigerate, Galvanize):
    # the user's Normal-type moves take the ability's type. The x1.2 joins the
    # base-power mods and STAB is judged on the new type. A Weather Ball that
    # already took a weather type is left alone.
    ate_type = ATE_ABILITIES.get(atk_ability)
    ate_converted = (bool(ate_type) and move_type == "Normal" and not weather_ball
                     and move_name not in ATE_EXEMPT)
    if ate_converted:
        move_type = ate_type
        notes.append(f"{atk_ability}: {move_name} becomes {ate_type}-type (x1.2)")
    # Liquid Voice: the user's sound moves become Water-type (STAB judged on Water).
    if atk_ability == "Liquid Voice" and flags.get("sound") and not weather_ball:
        move_type = "Water"
        notes.append(f"Liquid Voice: {move_name} becomes Water-type")

    # Piercing Drill: contact moves pierce protection at 1/4 damage.
    piercing = False
    if field.defender_protected:
        if atk_ability == "Piercing Drill" and flags.get("contact"):
            piercing = True
            notes.append("Piercing Drill: hitting through protection at 1/4 damage")
        else:
            return _result(move, [0] * 16, def_stats, defender, hits,
                           notes + ["target is protected"], max_ko_hits=max_ko_hits)

    if def_ability == "Spicy Spray":
        notes.append("Spicy Spray: the attacker will be burned by this hit")

    # --- held items (mechanics tags from items.json) ---
    a_item = dataio.items().get(_slug(attacker.item)) if attacker.item else None
    d_item = dataio.items().get(_slug(defender.item)) if defender.item else None
    # Iron Ball grounds its holder: Ground hits Flying / Levitate targets.
    ground_all = field.gravity or bool(d_item and d_item.get("grounds_holder"))
    # Terrain only touches grounded Pokemon: Flying types and Levitate / Eelevate
    # holders float unless Gravity or an Iron Ball grounds them.
    # An Air Balloon holder floats (until it is hit) like a Levitate user.
    a_airborne = bool(a_item and a_item.get("airborne")) and not field.gravity
    d_airborne = bool(d_item and d_item.get("airborne")) and not ground_all
    grounded_atk = field.gravity or bool(a_item and a_item.get("grounds_holder")) or (
        "Flying" not in atk_mon["types"] and atk_ability not in ("Levitate", "Eelevate")
        and not a_airborne)
    grounded_def = ground_all or (
        "Flying" not in def_mon["types"] and def_ability not in ("Levitate", "Eelevate")
        and not d_airborne)

    # Terrain Pulse: 100 BP and the terrain's type while the user is grounded
    # (the type decides STAB, effectiveness and immunities below).
    terrain_pulse = False
    if move_name == "Terrain Pulse" and grounded_atk and field.terrain in TERRAIN_PULSE_TYPES:
        move_type = TERRAIN_PULSE_TYPES[field.terrain]
        terrain_pulse = True
        notes.append(f"Terrain Pulse: {move_type}-type, 100 BP on "
                     f"{field.terrain.capitalize()} Terrain")

    # --- immunities ---
    if ground_all and move_type == "Ground":
        eff = 1.0
        for t in def_mon["types"]:
            eff *= 1.0 if t == "Flying" else dataio.type_chart()[move_type][t]
    else:
        eff = dataio.type_effectiveness(move_type, def_mon["types"])
    if atk_ability == "Scrappy" and move_type in ("Normal", "Fighting") \
            and "Ghost" in def_mon["types"]:
        eff = dataio.type_effectiveness(
            move_type, [t for t in def_mon["types"] if t != "Ghost"])
    if eff == 0:
        return _result(move, [0] * 16, def_stats, defender, hits,
                       notes + ["immune (type)"], max_ko_hits=max_ko_hits)
    if IMMUNITY_ABILITIES.get(def_ability) == move_type \
            and not (ground_all and def_ability in ("Levitate", "Eelevate")):
        return _result(move, [0] * 16, def_stats, defender, hits,
                       notes + [f"immune ({def_ability})"], max_ko_hits=max_ko_hits)
    if move_type == "Ground" and d_airborne:
        return _result(move, [0] * 16, def_stats, defender, hits,
                       notes + ["immune (Air Balloon)"], max_ko_hits=max_ko_hits)
    immune_flag = FLAG_IMMUNITY_ABILITIES.get(def_ability)
    if immune_flag and flags.get(immune_flag):
        return _result(move, [0] * 16, def_stats, defender, hits,
                       notes + [f"immune ({def_ability})"], max_ko_hits=max_ko_hits)
    # Psychic Terrain: a grounded Pokemon cannot be hit by a priority move aimed
    # at it (Fake Out, Sucker Punch, Aqua Jet, Extreme Speed, Grassy Glide ...).
    # Moves aimed at an ally are exempt; the calc only models hits on a foe.
    if field.terrain == "psychic" and (move.get("priority") or 0) > 0 and grounded_def:
        return _result(move, [0] * 16, def_stats, defender, hits,
                       notes + ["Psychic Terrain: priority move blocked (grounded target)"],
                       max_ko_hits=max_ko_hits, move_type=move_type)
    if move_name == "Steel Roller" and field.terrain == "none":
        return _result(move, [0] * 16, def_stats, defender, hits,
                       notes + ["Steel Roller fails when no terrain is active"],
                       max_ko_hits=max_ko_hits)

    # --- base power ---
    bp = bp_override or (100 if (weather_ball or terrain_pulse) else move["base_power"])
    if move_name in WEIGHT_MOVES and bp_override is None:
        weight_bp, why = weight_base_power(move_name, atk_mon, atk_ability, def_mon, def_ability)
        notes.append(why)
        if weight_bp is not None:
            bp = weight_bp
    if move_name in VARIABLE_BP_MOVES and bp_override is None:
        notes.append(f"{move_name} has variable base power; pass bp_override "
                     f"for accuracy (using listed {bp})")
    if move_name in MULTIHIT_HINT and hits == 1:
        notes.append(f"{move_name} is a multi-hit move; pass hits= "
                     f"(commonly {MULTIHIT_HINT[move_name]})")

    if move_name == "Facade" and attacker.status:
        bp *= 2
    if move_name == "Acrobatics" and attacker.item is None:
        bp *= 2
    if move_name == "Knock Off" and defender.item is not None:
        bp = math.floor(bp * 1.5)
    move["base_power_used"] = bp          # what the result reports (weight moves, Facade, Knock Off ...)

    bp_mods = []
    item = a_item
    if item and item.get("boost_type") == move_type:
        bp_mods.append(4915)                                   # type item x1.2
    if item and item.get("gem_type") == move_type:             # Normal Gem x1.3, single use
        bp_mods.append(_to_mod(item.get("gem_multiplier", 1.3)))
        notes.append(f"{item['name']}: x{item.get('gem_multiplier', 1.3)} (consumed)")
    if item and item.get("category_boost") == move["category"]:
        bp_mods.append(_to_mod(item.get("category_multiplier", 1.1)))  # Muscle Band / Wise Glasses
    if item and item.get("streak_step"):                       # Metronome
        n = min(max(int(attacker.move_streak or 0), 0), len(METRONOME_MODS) - 1)
        if n > 0:
            bp_mods.append(METRONOME_MODS[n])
        else:
            notes.append(f"{item['name']}: boosts consecutive uses of the same move "
                         "(pass move_streak=N for the Nth repeat, x1.2 each, max x2)")
    if ate_converted:
        bp_mods.append(4915)                                   # -ate ability x1.2
    if atk_ability == "Technician" and bp <= 60:
        bp_mods.append(6144)
    if atk_ability == "Tough Claws" and flags.get("contact"):
        bp_mods.append(5325)
    if atk_ability == "Strong Jaw" and flags.get("bite"):
        bp_mods.append(6144)
    if atk_ability == "Mega Launcher" and flags.get("pulse"):
        bp_mods.append(6144)
    if atk_ability == "Iron Fist" and flags.get("punch"):
        bp_mods.append(4915)
    if atk_ability == "Sharpness" and flags.get("slicing"):
        bp_mods.append(6144)
    if field.helping_hand:
        bp_mods.append(6144)
    if field.fairy_aura and move_type == "Fairy":
        bp_mods.append(5448)
    if field.dark_aura and move_type == "Dark":
        bp_mods.append(5448)
    # --- terrain (Gen 8+ values: x1.3 for a grounded user's matching type) ---
    terrain_boost = {"electric": "Electric", "grassy": "Grass", "psychic": "Psychic"}
    if grounded_atk and terrain_boost.get(field.terrain) == move_type:
        bp_mods.append(5325)
    if field.terrain == "misty" and grounded_def and move_type == "Dragon":
        bp_mods.append(2048)
    # Grassy Terrain halves the three quake moves against grounded targets.
    if (field.terrain == "grassy" and grounded_def
            and move_name in ("Earthquake", "Bulldoze", "Magnitude")):
        bp_mods.append(2048)
    # Moves powered by a terrain.
    if move_name == "Expanding Force" and field.terrain == "psychic" and grounded_atk:
        bp_mods.append(6144)
        move["target"] = "allAdjacentFoes"          # it hits both opponents (spread)
        notes.append("Expanding Force: x1.5 and hits both opponents on Psychic Terrain")
    if move_name == "Rising Voltage" and field.terrain == "electric" and grounded_def:
        bp_mods.append(8192)
        notes.append("Rising Voltage: doubled into a grounded target on Electric Terrain")
    if move_name == "Misty Explosion" and field.terrain == "misty" and grounded_atk:
        bp_mods.append(6144)
        notes.append("Misty Explosion: x1.5 on Misty Terrain")
    bp = max(1, apply_mod(bp, chain_mods(bp_mods)))

    # --- attack stat ---
    physical = move["category"] == "Physical"
    if move_name in USES_ATTACKER_DEF:
        atk_source, atk_key = atk_stats, "def"
    elif move_name in USES_DEFENDER_ATK:
        atk_source, atk_key = def_stats, "atk"
    else:
        atk_key = "atk" if physical else "spa"
        atk_source = atk_stats
    atk_stage = (defender.stages if move_name in USES_DEFENDER_ATK
                 else attacker.stages).get(atk_key, 0)
    if field.is_crit and atk_stage < 0:
        atk_stage = 0
    if def_ability == "Unaware":
        atk_stage = 0
    attack = staged(atk_source[atk_key], atk_stage)

    atk_mods = []
    if atk_ability in ("Huge Power", "Pure Power") and atk_key == "atk":
        atk_mods.append(8192)
    if atk_ability == "Guts" and attacker.status and physical:
        atk_mods.append(6144)
    pinch = {"Overgrow": "Grass", "Blaze": "Fire", "Torrent": "Water", "Swarm": "Bug"}
    if pinch.get(atk_ability) == move_type and attacker.current_hp_fraction <= 1 / 3:
        atk_mods.append(6144)
    if atk_ability == "Solar Power" and effective_weather == "sun" and not physical:
        atk_mods.append(6144)
    if atk_ability == "Fire Mane" and move_type == "Fire":
        atk_mods.append(6144)
    if def_ability == "Thick Fat" and move_type in ("Fire", "Ice"):
        atk_mods.append(2048)
    # Water Bubble is an attack-stat modifier both ways (engine: onModifyAtk/SpA
    # x2 for the holder's Water moves, onSourceModifyAtk/SpA x0.5 for Fire
    # moves aimed at it), not a final damage modifier.
    if atk_ability == "Water Bubble" and move_type == "Water":
        atk_mods.append(8192)
        notes.append("Water Bubble: Water-type attack doubled")
    if def_ability == "Water Bubble" and move_type == "Fire":
        atk_mods.append(2048)
        notes.append("Water Bubble: Fire damage halved")
    if attacker.item == "Light Ball" and atk_mon["id"] == "pikachu":
        atk_mods.append(8192)
    a_stat_mult = (a_item or {}).get("stat_multiplier") or {}
    if a_stat_mult.get(atk_key):                               # Choice Band / Choice Specs
        atk_mods.append(_to_mod(a_stat_mult[atk_key]))
    attack = max(1, apply_mod(attack, chain_mods(atk_mods)))

    # --- defense stat ---
    if move_name in USES_DEFENDER_DEF or physical:
        def_key = "def"
    else:
        def_key = "spd"
    def_stage = defender.stages.get(def_key, 0)
    # A terrain Seed raises the stat by one stage the moment its terrain is up
    # (single use); the calc grants it whenever the field's terrain matches.
    seed = (d_item or {}).get("terrain_seed")
    if seed and seed.get("terrain") == field.terrain and seed.get("stat") == def_key:
        def_stage = min(6, def_stage + 1)
        notes.append(f"{d_item['name']}: +1 {'Def' if def_key == 'def' else 'SpD'} "
                     f"on {field.terrain.capitalize()} Terrain (single use)")
    if field.is_crit and def_stage > 0:
        def_stage = 0
    if atk_ability == "Unaware" or move_name in IGNORES_DEF_STAGES:
        def_stage = 0
    defense = staged(def_stats[def_key], def_stage)
    if field.weather == "sand" and "Rock" in def_mon["types"] and def_key == "spd":
        defense = apply_mod(defense, 6144)
    if field.weather == "snow" and "Ice" in def_mon["types"] and def_key == "def":
        defense = apply_mod(defense, 6144)

    def_mods = []
    if def_ability == "Fur Coat" and def_key == "def":
        def_mods.append(8192)
    if def_ability == "Marvel Scale" and defender.status and def_key == "def":
        def_mods.append(6144)
    d_stat_mult = (d_item or {}).get("stat_multiplier") or {}
    if d_stat_mult.get(def_key):                               # Assault Vest
        def_mods.append(_to_mod(d_stat_mult[def_key]))
    defense = max(1, apply_mod(defense, chain_mods(def_mods)))

    # --- base damage ---
    base = math.floor(math.floor(math.floor(2 * LEVEL / 5 + 2) * bp * attack / defense) / 50) + 2
    spread = field.is_spread
    if spread is None:  # auto: spread-target moves in doubles
        spread = field.is_doubles and move.get("target") in (
            "allAdjacentFoes", "allAdjacent")
    if spread:
        base = apply_mod(base, 3072)
    weather_mod = 4096
    if effective_weather == "rain":
        weather_mod = 6144 if move_type == "Water" else (2048 if move_type == "Fire" else 4096)
    elif effective_weather == "sun":
        weather_mod = 6144 if move_type == "Fire" else (2048 if move_type == "Water" else 4096)
    base = apply_mod(base, weather_mod)
    if field.is_crit:
        base = math.floor(base * 1.5)

    # --- STAB / final mods ---
    stab_mod = 4096
    if move_type in atk_mon["types"]:
        stab_mod = 8192 if atk_ability == "Adaptability" else 6144

    final_mods = []
    screened = ((field.reflect and physical) or
                (field.light_screen and not physical) or field.aurora_veil)
    if screened and not field.is_crit and atk_ability != "Infiltrator":
        final_mods.append(2732 if field.is_doubles else 2048)  # doubles: x2/3
    if def_ability in ("Multiscale", "Shadow Shield") and defender.current_hp_fraction >= 1.0:
        final_mods.append(2048)
    if def_ability == "Fluffy" and flags.get("contact") and move_type != "Fire":
        final_mods.append(2048)
    if def_ability == "Aura Guard" and flags.get("contact"):
        final_mods.append(2048)
        notes.append("Aura Guard: contact move halved")
    if def_ability == "Punk Rock" and flags.get("sound"):
        final_mods.append(2048)
    if def_ability == "Ice Scales" and not physical:
        final_mods.append(2048)
    if def_ability == "Heatproof" and move_type == "Fire":
        final_mods.append(2048)
        notes.append("Heatproof: Fire damage halved")
    if def_ability == "Purifying Salt" and move_type == "Ghost":
        final_mods.append(2048)
    if field.friend_guard:
        final_mods.append(3072)
    if def_ability in ("Filter", "Solid Rock", "Prism Armor") and eff > 1:
        final_mods.append(3072)
    if atk_ability == "Neuroforce" and eff > 1:
        final_mods.append(5120)
    if atk_ability == "Sniper" and field.is_crit:
        final_mods.append(6144)
    if atk_ability == "Tinted Lens" and eff < 1:
        final_mods.append(8192)
    if def_ability == "Fluffy" and move_type == "Fire":
        final_mods.append(8192)
    # Reference order: Expert Belt -> Life Orb -> resist berry -> Protect.
    if a_item and a_item.get("se_multiplier") and eff > 1:      # Expert Belt x1.2
        final_mods.append(_to_mod(a_item["se_multiplier"]))
    if a_item and a_item.get("final_multiplier"):               # Life Orb x1.3
        final_mods.append(_to_mod(a_item["final_multiplier"]))
        if a_item.get("recoil_fraction"):
            notes.append(f"{a_item['name']}: attacker loses "
                         f"{round(a_item['recoil_fraction'] * 100)}% of its max HP per hit")
    if d_item and d_item.get("resist_type") == move_type and             (eff > 1 or d_item["name"] == "Chilan Berry"):
        final_mods.append(2048)
        notes.append(f"{d_item['name']} halves this hit (single use)")
    if piercing:
        final_mods.append(1024)                                # x0.25 through Protect
    final_mod = chain_mods(final_mods)

    burned = (attacker.status == "burn" and atk_ability != "Guts"
              and physical and move_name != "Facade")
    if attacker.status == "burn" and atk_ability in BURN_IMMUNE_ABILITIES:
        burned = False
        notes.append(f"{atk_ability}: cannot be burned; burn status ignored")

    rolls = []
    for r in range(85, 101):
        d = math.floor(base * r / 100)
        d = poke_round(d * stab_mod / 4096)
        d = math.floor(d * eff)
        if burned:
            d = math.floor(d / 2)
        d = max(1, poke_round(d * final_mod / 4096))
        rolls.append(d)

    return _result(move, rolls, def_stats, defender, hits, notes, eff, max_ko_hits,
                   move_type=move_type)


# ---------- output ----------

def _slug(name):
    import re
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-") or None


def _ko_chance(rolls: list[int], hp: int, max_hits: int = 4) -> dict:
    """Exact n-hit KO chances by convolving the 16-roll distribution."""
    out = {}
    dist = {0: 1.0}
    n_rolls = len(rolls)
    for n in range(1, max_hits + 1):
        new = {}
        for total, p in dist.items():
            for r in rolls:
                t = min(total + r, hp)  # cap to avoid blowup
                new[t] = new.get(t, 0.0) + p / n_rolls
        dist = new
        out[f"{n}hko"] = round(sum(p for t, p in dist.items() if t >= hp) * 100, 1)
        if out[f"{n}hko"] == 100.0:
            break
    return out


def _result(move, rolls, def_stats, defender, hits, notes, eff=1.0, max_ko_hits=4,
            move_type=None):
    hp = def_stats["hp"]
    effective_hp = math.floor(hp * defender.current_hp_fraction)
    total_rolls = [r * hits for r in rolls]
    lo, hi = min(total_rolls), max(total_rolls)
    out = {
        "move": move["name"],
        "category": move["category"],
        "type": move_type or move["type"],   # effective type (Weather Ball, -ate abilities)
        "type_effectiveness": eff,
        "base_power": move.get("base_power_used", move["base_power"]),
        "rolls": total_rolls,
        "damage_range": [lo, hi],
        "defender_hp": hp,
        "defender_current_hp": effective_hp,
        "pct_range": [round(lo / hp * 100, 1), round(hi / hp * 100, 1)],
        "ko_chances": _ko_chance(total_rolls, effective_hp, max_ko_hits) if hi > 0 else {},
        "notes": notes,
    }
    # Focus Sash: a single hit from full HP leaves the holder at 1 HP. The
    # 2HKO chance is unchanged (the sash only works at full HP, so a first hit
    # that fails to KO leaves the second one unblocked); 1HKO becomes 0.
    d_item = dataio.items().get(_slug(defender.item)) if defender.item else None
    ko = out["ko_chances"]
    if (d_item and d_item.get("focus_sash") and hits == 1
            and defender.current_hp_fraction >= 1.0 and ko.get("1hko")):
        ko["1hko"] = 0.0
        ko.setdefault("2hko", 100.0)      # 1HKO was guaranteed: any second hit finishes
        notes.append(f"{d_item['name']}: survives this hit at 1 HP from full (single use)")
    return out


def describe(attacker: Combatant, defender: Combatant, result: dict) -> str:
    """Showdown-style one-liner, in SP terms."""
    a_mon = dataio.get_pokemon(attacker.pokemon_id)
    d_mon = dataio.get_pokemon(defender.pokemon_id)
    a_sp = attacker.spread.as_dict()
    d_sp = defender.spread.as_dict()
    physical = result["category"] == "Physical"
    atk_key, atk_label = ("atk", "Atk") if physical else ("spa", "SpA")
    def_key, def_label = ("def", "Def") if physical else ("spd", "SpD")
    lo, hi = result["pct_range"]
    ko = ""
    for n in (1, 2, 3, 4):
        c = result["ko_chances"].get(f"{n}hko")
        if c:
            label = "OHKO" if n == 1 else f"{n}HKO"
            ko = f" -- {'guaranteed ' + label if c == 100 else f'{c}% chance to {label}'}"
            break
    return (f"{a_sp[atk_key]} SP {atk_label} {a_mon['name']} {result['move']} vs "
            f"{d_sp['hp']} HP / {d_sp[def_key]} SP {def_label} {d_mon['name']}: "
            f"{result['damage_range'][0]}-{result['damage_range'][1]} "
            f"({lo} - {hi}%){ko}")
