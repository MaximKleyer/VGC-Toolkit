"""Team building: model, legality validation, and paste import/export.

A team is 1-6 members; each member is a Combatant plus up to 4 moves.

Validation covers: regulation legality, species clause (megas and battle
formes count as their base species), item clause, move legality against
learnsets, move count/duplicates, ability legality, alignment validity.
SP budget rules are enforced by SPSpread itself.

The paste format is standard Showdown format (EV numbers carry SP values):

    Tyranitar-Mega @ Tyranitarite
    Ability: Sand Stream
    Level: 50
    EVs: 17 HP / 26 Atk / 1 Def / 1 SpD / 21 Spe
    Adamant Nature
    - Rock Slide
    - Protect
    - Knock Off
    - Dragon Dance

Import also accepts the older "Alignment:" / "SP:" labels and display names
like "Mega Tyranitar".
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field as dc_field

from vgc_toolkit.core import dataio
from vgc_toolkit.core.damage import Combatant
from vgc_toolkit.core.stats import SPSpread, InvalidSpreadError

SP_KEYS = {"hp": "HP", "atk": "Atk", "def": "Def",
           "spa": "SpA", "spd": "SpD", "spe": "Spe"}
SP_PARSE = {v.lower(): k for k, v in SP_KEYS.items()}


@dataclass
class TeamMember:
    combatant: Combatant
    moves: list[str] = dc_field(default_factory=list)
    nickname: str | None = None     # "Kids (Kingambit) @ Black Glasses" keeps "Kids"


def species_root(pokemon_id: str) -> str:
    """Megas and battle formes collapse to their base species for clauses."""
    mon = dataio.get_pokemon(pokemon_id)
    return mon.get("mega_of") or mon.get("forme_of") or pokemon_id


def clause_species(pokemon_id: str) -> str:
    """Species identity for Species Clause: the species root with a trailing
    gender marker (-m/-f) stripped. Indeedee-F and Indeedee are one species,
    as are the Meowstic and Basculegion pairs."""
    return re.sub(r"-(m|f)$", "", species_root(pokemon_id))


def _stone_family(pokemon_id: str) -> str:
    """Stone-ownership family: the same gender-agnostic species, so a single
    gendered Mega Stone (e.g. Meowsticite, which ships only as the -f variant)
    validates on either gender of the species."""
    return clause_species(pokemon_id)


def validate_member(member: TeamMember, regulation: str = dataio.DEFAULT_REGULATION) -> list[str]:
    errors = []
    c = member.combatant
    try:
        mon = dataio.get_pokemon(c.pokemon_id)
    except KeyError:
        return [f"unknown pokemon: {c.pokemon_id!r}"]

    if regulation not in (None, "All") \
            and regulation not in mon.get("regulations", []):
        errors.append(f"{mon['name']} is not legal in Regulation {regulation}")

    if c.alignment not in dataio.alignments():
        errors.append(f"{mon['name']}: unknown alignment {c.alignment!r}")

    if c.ability and mon["abilities"] and c.ability not in mon["abilities"]:
        errors.append(f"{mon['name']}: ability {c.ability!r} not available "
                      f"(has {mon['abilities']})")

    item = dataio.items().get(_slug(c.item)) if c.item is not None else None
    if c.item is not None:
        if item is None:
            errors.append(f"{mon['name']}: unknown item {c.item!r}")
        elif regulation not in (None, "All") and not dataio.item_legal(item, regulation):
            errors.append(f"{mon['name']}: {item['name']} is not in the Regulation "
                          f"{regulation} item pool")
        elif item["category"] == "mega_stone":
            # A stone is only sensible on the matching base species. Gendered
            # megas (Meowstic-M/F) share one stone, so compare gender-agnostic.
            if item.get("mega_form"):
                if _stone_family(c.pokemon_id) != _stone_family(item["mega_form"]):
                    errors.append(f"{mon['name']}: {item['name']} belongs to "
                                  f"{species_root(item['mega_form'])}, "
                                  f"not this Pokemon")

    if not 1 <= len(member.moves) <= 4:
        errors.append(f"{mon['name']}: must have 1-4 moves "
                      f"(has {len(member.moves)})")
    if len(set(member.moves)) != len(member.moves):
        errors.append(f"{mon['name']}: duplicate moves")
    try:
        learnset = set(dataio.get_learnset(c.pokemon_id)["moves"])
        for mv in member.moves:
            if mv not in learnset:
                close = mv if mv in dataio.moves() else None
                errors.append(
                    f"{mon['name']} cannot learn {mv!r}"
                    + ("" if close else " (move not in the move database)"))
    except KeyError:
        errors.append(f"{mon['name']}: no learnset data available")
    if item and item.get("no_status_moves"):
        blocked = [mv for mv in member.moves
                   if dataio.moves().get(mv, {}).get("category") == "Status"]
        if blocked:
            errors.append(f"{mon['name']}: {item['name']} blocks status moves "
                          f"({', '.join(blocked)})")
    return errors


def validate_team(team: list[TeamMember], regulation: str = dataio.DEFAULT_REGULATION) -> dict:
    errors, member_errors = [], {}
    if not 1 <= len(team) <= 6:
        errors.append(f"team must have 1-6 members (has {len(team)})")

    for i, member in enumerate(team):
        errs = validate_member(member, regulation)
        if errs:
            member_errors[i] = errs

    # Species clause (mega/base/forme/gender collapse together)
    seen = {}
    for i, member in enumerate(team):
        try:
            root = clause_species(member.combatant.pokemon_id)
        except KeyError:
            continue
        if root in seen:
            errors.append(f"species clause: slots {seen[root] + 1} and {i + 1} "
                          f"are both {root}")
        seen[root] = i

    # Item clause
    items_seen = {}
    for i, member in enumerate(team):
        item = member.combatant.item
        if item is None:
            continue
        key = _slug(item)
        if key in items_seen:
            errors.append(f"item clause: slots {items_seen[key] + 1} and "
                          f"{i + 1} both hold {item}")
        items_seen[key] = i

    return {
        "valid": not errors and not member_errors,
        "team_errors": errors,
        "member_errors": member_errors,
    }


# ---------- paste import / export ----------

def showdown_name(pokemon_id: str) -> str:
    """'tyranitar-mega' -> 'Tyranitar-Mega'; 'charizard-mega-y' -> 'Charizard-Mega-Y'.
    The male gendered base forms (basculegion-m, meowstic-m) are plain
    'Basculegion' / 'Meowstic' in Showdown; their megas keep the letter."""
    parts = pokemon_id.split("-")
    if len(parts) == 2 and parts[1] == "m":
        parts = parts[:1]
    return "-".join(p.upper() if len(p) == 1 else p.capitalize() for p in parts)


# "Kids (Kingambit) (M)" -> nickname, species, gender; "Kingambit (F)" -> species, gender.
_HEAD_RE = re.compile(r"^(?:(?P<nick>.+?)\s+\((?P<species>(?![MF]\))[^()]+)\)|(?P<species2>[^()]+?))"
                      r"(?:\s+\((?P<gender>[MF])\))?\s*$")


def _parse_head(text: str) -> tuple[str | None, str, str | None]:
    m = _HEAD_RE.match(text)
    if not m:
        return None, text, None
    return m.group("nick"), (m.group("species") or m.group("species2")).strip(), m.group("gender")


def _resolve_species(species: str, gender: str | None) -> str:
    """Species text plus an optional gender marker -> pokedex id. Gendered forms
    (Basculegion, Meowstic) pick the '-f' / '-m' entry; without a marker the
    male form, which is what the plain name resolves to."""
    candidates = ([species + "-" + gender.lower()] if gender else []) + [species]
    for cand in candidates:
        try:
            return _resolve_name(cand)
        except KeyError:
            continue
    raise KeyError(f"unknown pokemon: {species!r}")


def export_paste(team: list[TeamMember]) -> str:
    blocks = []
    for member in team:
        c = member.combatant
        mon = dataio.get_pokemon(c.pokemon_id)
        species = showdown_name(c.pokemon_id)
        head = (f"{member.nickname} ({species})" if member.nickname else species)
        head += f" @ {c.item}" if c.item else ""
        lines = [head]
        ability = c.ability or (mon["abilities"][0] if mon["abilities"] else None)
        if ability:
            lines.append(f"Ability: {ability}")
        lines.append("Level: 50")
        sp = c.spread.as_dict()
        sp_parts = [f"{v} {SP_KEYS[k]}" for k, v in sp.items() if v]
        if sp_parts:
            lines.append("EVs: " + " / ".join(sp_parts))
        lines.append(f"{c.alignment} Nature")
        lines += [f"- {m}" for m in member.moves]
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks) + "\n"


def _resolve_name(name: str) -> str:
    """Display name or id -> pokedex id."""
    slug = _slug(name)
    dex = dataio.pokedex()
    if slug in dex:
        return slug
    for pid, mon in dex.items():
        if _slug(mon["name"]) == slug:
            return pid
    raise KeyError(f"unknown pokemon: {name!r}")


def import_paste(text: str) -> list[TeamMember]:
    team = []
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = [ln.strip() for ln in block.strip().splitlines() if ln.strip()]
        if not lines:
            continue
        head = lines[0]
        name, item = (head.split("@", 1) + [None])[:2] if "@" in head \
            else (head, None)
        nickname, species, gender = _parse_head(name.strip())
        pokemon_id = _resolve_species(species, gender)
        ability, alignment, spread, moves = None, "Serious", {}, []
        for ln in lines[1:]:
            if ln.startswith("- "):
                moves.append(ln[2:].strip())
            elif ln.lower().startswith("ability:"):
                ability = ln.split(":", 1)[1].strip()
            elif ln.lower().startswith("alignment:") or ln.lower().startswith("nature:"):
                alignment = ln.split(":", 1)[1].strip()
            elif re.match(r"^\w+ Nature$", ln, re.I):
                alignment = ln.split()[0].capitalize()
            elif ln.lower().startswith("level:") or ln.lower().startswith("shiny:"):
                pass  # Champions is always level 50; shininess is cosmetic
            elif ln.lower().startswith("sp:") or ln.lower().startswith("evs:"):
                for part in ln.split(":", 1)[1].split("/"):
                    m = re.match(r"\s*(\d+)\s+(\w+)", part)
                    if m and m.group(2).lower() in SP_PARSE:
                        spread[SP_PARSE[m.group(2).lower()]] = int(m.group(1))
        try:
            sp = SPSpread.from_dict(spread)
        except InvalidSpreadError as e:
            raise InvalidSpreadError(f"{name.strip()}: {e}")
        team.append(TeamMember(
            combatant=Combatant(pokemon_id=pokemon_id, spread=sp,
                                alignment=alignment, ability=ability,
                                item=item.strip() if item else None),
            moves=moves, nickname=nickname,
        ))
    return team


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
