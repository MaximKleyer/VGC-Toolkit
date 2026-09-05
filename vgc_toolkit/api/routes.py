"""API routes for the toolkit.

Thin routers that validate input with Pydantic and call pure functions in
vgc_toolkit.core: pokedex browsing, SP stat calculation, damage, speed
tiers, matchup/threat analysis, and team validation + paste import/export.
"""

from __future__ import annotations


from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, model_validator

from vgc_toolkit.core import (team_preview, damage, dataio,
                               matchup, practice, speed, stats, teams, playbook)

router = APIRouter(prefix="/api")


# ---------- models ----------

class SpreadIn(BaseModel):
    hp: int = Field(0, ge=0, le=stats.MAX_SP_PER_STAT)
    atk: int = Field(0, ge=0, le=stats.MAX_SP_PER_STAT)
    def_: int = Field(0, ge=0, le=stats.MAX_SP_PER_STAT, alias="def")
    spa: int = Field(0, ge=0, le=stats.MAX_SP_PER_STAT)
    spd: int = Field(0, ge=0, le=stats.MAX_SP_PER_STAT)
    spe: int = Field(0, ge=0, le=stats.MAX_SP_PER_STAT)

    model_config = {"populate_by_name": True}

    @model_validator(mode="after")
    def _within_budget(self):
        total = self.hp + self.atk + self.def_ + self.spa + self.spd + self.spe
        if total > stats.MAX_SP_TOTAL:
            # Raised here so an over-budget spread is a clean 422 at request
            # parse time, not an unhandled 500 inside a route handler.
            raise ValueError(
                f"Total SP {total} exceeds budget of {stats.MAX_SP_TOTAL}")
        return self


class StatRequest(BaseModel):
    pokemon_id: str
    spread: SpreadIn = SpreadIn()
    alignment: str = "Serious"


# ---------- pokedex ----------

@router.get("/pokemon")
def list_pokemon(regulation: list[str] | None = Query(
        None, description="e.g. M-B; repeatable, matches any")):
    mons = list(dataio.pokedex().values())
    if regulation:
        wanted = set(regulation)
        mons = [m for m in mons if wanted & set(m.get("regulations", []))]
    return [
        {"id": m["id"], "name": m["name"], "types": m["types"],
         "base": m["base"], "is_mega": "mega_of" in m,
         "regulations": m.get("regulations", []),
         # Champions ability not announced yet (UI offers the override editor)
         "abilities_provisional": bool(m.get("abilities_provisional"))}
        for m in mons
    ]


@router.get("/regulations")
def list_regulations():
    """Regulation tags present in the data (oldest to newest) with form counts,
    plus the backend default — drives the UI's regulation selector."""
    return {"regulations": dataio.regulations(),
            "default": dataio.DEFAULT_REGULATION}


# ---------- provisional abilities ----------

class AbilitiesIn(BaseModel):
    abilities: list[str] = Field(default_factory=list, max_length=3)


@router.get("/abilities")
def list_abilities():
    """Every ability name known to the data set, for the ability picker."""
    return dataio.all_abilities()


@router.put("/pokemon/{pokemon_id}/abilities")
def set_abilities(pokemon_id: str, req: AbilitiesIn):
    """Override a form's ability list, persisted in data/ability_overrides.json
    and applied everywhere (roster, validation, threat/speed scans). Meant for
    forms whose Champions ability is not announced yet; an empty list removes
    the override and restores the shipped data. Returns the updated form."""
    try:
        dataio.get_pokemon(pokemon_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown pokemon: {pokemon_id}")
    abilities: list[str] = []
    for a in req.abilities:
        a = a.strip()
        if a and a not in abilities:
            abilities.append(a)
    overrides = dataio.ability_overrides()
    if abilities:
        overrides[pokemon_id] = abilities
    else:
        overrides.pop(pokemon_id, None)
    dataio.save_ability_overrides(overrides)
    return dataio.get_pokemon(pokemon_id)


@router.get("/pokemon/{pokemon_id}")
def get_pokemon(pokemon_id: str):
    try:
        return dataio.get_pokemon(pokemon_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown pokemon: {pokemon_id}")


@router.get("/typechart")
def get_typechart():
    return dataio.type_chart()


@router.get("/alignments")
def list_alignments():
    return dataio.alignments()


@router.get("/items")
def list_items(category: str | None = Query(None, description="held | berry | mega_stone")):
    items = list(dataio.items().values())
    if category:
        items = [i for i in items if i["category"] == category]
    return items


# ---------- stat engine ----------

@router.post("/stats")
def calculate_stats(req: StatRequest):
    try:
        mon = dataio.get_pokemon(req.pokemon_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown pokemon: {req.pokemon_id}")
    try:
        spread = stats.SPSpread.from_dict(req.spread.model_dump(by_alias=True))
        block = stats.calc_all_stats(mon["base"], spread, req.alignment)
    except stats.InvalidSpreadError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except KeyError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {
        "pokemon": {"id": mon["id"], "name": mon["name"], "types": mon["types"]},
        "alignment": req.alignment,
        "spread": spread.as_dict(),
        "sp_used": spread.total,
        "sp_remaining": spread.remaining,
        "stats": block,
    }


# ---------- moves & learnsets ----------

@router.get("/moves")
def list_moves():
    return list(dataio.moves().values())


@router.get("/moves/{move_name}")
def get_move(move_name: str):
    try:
        return dataio.get_move(move_name)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown move: {move_name}")


@router.get("/pokemon/{pokemon_id}/learnset")
def get_learnset(pokemon_id: str):
    try:
        ls = dataio.get_learnset(pokemon_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    move_db = dataio.moves()
    return {
        "pokemon_id": pokemon_id,
        "moves": [move_db.get(m, {"name": m, "needs_definition": True})
                  for m in ls["moves"]],
    }


# ---------- damage ----------

class CombatantIn(BaseModel):
    pokemon_id: str
    spread: SpreadIn = SpreadIn()
    alignment: str = "Serious"
    ability: str | None = None
    item: str | None = None
    stages: dict[str, int] = {}
    status: str | None = None
    current_hp_fraction: float = Field(1.0, gt=0, le=1.0)
    # Prior consecutive uses of the move (Metronome item: x1.2 each, max x2).
    move_streak: int = Field(0, ge=0, le=10)

    def to_combatant(self) -> damage.Combatant:
        return damage.Combatant(
            pokemon_id=self.pokemon_id,
            spread=stats.SPSpread.from_dict(self.spread.model_dump(by_alias=True)),
            alignment=self.alignment, ability=self.ability, item=self.item,
            stages=self.stages, status=self.status,
            current_hp_fraction=self.current_hp_fraction,
            move_streak=self.move_streak,
        )


class DamageFieldIn(BaseModel):
    weather: str = "none"
    terrain: str = "none"
    is_doubles: bool = True
    is_spread: bool | None = None
    is_crit: bool = False
    reflect: bool = False
    light_screen: bool = False
    aurora_veil: bool = False
    friend_guard: bool = False
    helping_hand: bool = False
    defender_protected: bool = False
    fairy_aura: bool = False
    dark_aura: bool = False
    gravity: bool = False

    def to_field(self) -> damage.Field:
        return damage.Field(**self.model_dump())


class DamageRequest(BaseModel):
    attacker: CombatantIn
    defender: CombatantIn
    move: str
    field: DamageFieldIn = DamageFieldIn()
    bp_override: int | None = None
    hits: int = Field(1, ge=1, le=10)


@router.post("/damage")
def calculate_damage(req: DamageRequest):
    try:
        atk = req.attacker.to_combatant()
        dfn = req.defender.to_combatant()
        result = damage.calculate(
            atk, dfn, req.move,
            damage.Field(**req.field.model_dump()),
            bp_override=req.bp_override, hits=req.hits,
        )
        result["description"] = damage.describe(atk, dfn, result)
        return result
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except (stats.InvalidSpreadError, ValueError) as e:
        raise HTTPException(status_code=422, detail=str(e))


class BestMovesRequest(BaseModel):
    attacker: CombatantIn
    defender: CombatantIn
    field: DamageFieldIn = DamageFieldIn()
    top_n: int = Field(6, ge=1, le=20)


@router.post("/damage/best-moves")
def best_moves(req: BestMovesRequest):
    """Rank the attacker's damaging learnset moves vs the defender, under the
    given field — powers the Damage Calc's 'best move here' suggestions."""
    try:
        return {"moves": matchup.rank_moves(
            req.attacker.to_combatant(), req.defender.to_combatant(),
            req.field.to_field(), req.top_n)}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except (stats.InvalidSpreadError, ValueError) as e:
        raise HTTPException(status_code=422, detail=str(e))


class SignatureSpikesRequest(BaseModel):
    pokemon: CombatantIn
    top_n: int = Field(6, ge=1, le=20)


@router.post("/matchup/signature-spikes")
def signature_spikes(req: SignatureSpikesRequest):
    """A Pokemon's field-conditional move boosts (Weather Ball in sun, etc.),
    flagging whether it sets the field itself — powers the Signature Spikes panel."""
    try:
        return matchup.signature_spikes(req.pokemon.to_combatant(), top_n=req.top_n)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except (stats.InvalidSpreadError, ValueError) as e:
        raise HTTPException(status_code=422, detail=str(e))


# ---------- matchup analysis ----------

class ThreatScanRequest(BaseModel):
    defender: CombatantIn
    top_n: int = Field(15, ge=1, le=100)
    practical: bool = True
    use_meta_sets: bool = False
    meta_only: bool = False
    regulation: str = dataio.DEFAULT_REGULATION



class TeamAnalysisRequest(BaseModel):
    team: list[CombatantIn] = Field(..., min_length=2, max_length=6)
    top_n: int = Field(10, ge=1, le=50)
    regulation: str = dataio.DEFAULT_REGULATION


@router.get("/matchup/{pokemon_id}/profile")
def matchup_profile(pokemon_id: str, ability: str | None = None):
    try:
        return matchup.defensive_profile(pokemon_id, ability)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/matchup/threats")
def matchup_threats(req: ThreatScanRequest):
    try:
        return matchup.threat_scan(req.defender.to_combatant(),
                                   regulation=req.regulation,
                                   top_n=req.top_n, practical=req.practical,
                                   use_meta_sets=req.use_meta_sets,
                                   meta_only=req.meta_only)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/matchup/team")
def matchup_team(req: TeamAnalysisRequest):
    try:
        return matchup.team_analysis([c.to_combatant() for c in req.team],
                                     regulation=req.regulation, top_n=req.top_n)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


class SuggestRequest(BaseModel):
    team: list[str] = Field(..., min_length=1, max_length=6)
    top_n: int = Field(8, ge=1, le=20)
    regulation: str = dataio.DEFAULT_REGULATION


class TeamThreatScanRequest(BaseModel):
    team: list[CombatantIn]
    top_n: int = Field(20, ge=1, le=60)
    practical: bool = True
    use_meta_sets: bool = False
    meta_only: bool = False
    regulation: str = dataio.DEFAULT_REGULATION


@router.post("/matchup/threats/team")
def matchup_threats_team(req: TeamThreatScanRequest):
    if not (2 <= len(req.team) <= 6):
        raise HTTPException(status_code=422,
                            detail="team scan needs 2-6 members")
    try:
        return matchup.team_threat_scan(
            [c.to_combatant() for c in req.team],
            regulation=req.regulation, top_n=req.top_n,
            practical=req.practical, use_meta_sets=req.use_meta_sets,
            meta_only=req.meta_only)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


class PreviewMon(BaseModel):
    pokemon_id: str
    spread: SpreadIn = SpreadIn()
    alignment: str = "Serious"
    ability: str | None = None
    item: str | None = None
    moves: list[str] = []


class OppMon(BaseModel):
    pokemon_id: str
    spread: SpreadIn | None = None
    alignment: str | None = None
    ability: str | None = None
    item: str | None = None
    moves: list[str] = []


class FieldIn(BaseModel):
    weather: str = "none"
    terrain: str = "none"
    source: str | None = None


class TeamPreviewRequest(BaseModel):
    my_team: list[PreviewMon]
    opp_team: list[OppMon]
    field: FieldIn | None = None
    regulation: str = dataio.DEFAULT_REGULATION


@router.post("/matchup/team-preview")
def matchup_team_preview(req: TeamPreviewRequest):
    if not (1 <= len(req.my_team) <= 6) or not (1 <= len(req.opp_team) <= 6):
        raise HTTPException(status_code=422,
                            detail="each team needs 1-6 members")
    my_team = [{
        "pokemon_id": m.pokemon_id,
        "spread": m.spread.model_dump(by_alias=True),
        "alignment": m.alignment, "ability": m.ability, "item": m.item,
        "moves": m.moves,
    } for m in req.my_team]
    opp_team = [{
        "pokemon_id": o.pokemon_id,
        "spread": o.spread.model_dump(by_alias=True) if o.spread else None,
        "alignment": o.alignment, "ability": o.ability, "item": o.item,
        "moves": o.moves,
    } for o in req.opp_team]
    try:
        return team_preview.team_preview(
            my_team, opp_team, regulation=req.regulation,
            field=req.field.model_dump() if req.field else None)
    except (KeyError, ValueError) as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/meta/random-team")
def meta_random_team(regulation: str = dataio.DEFAULT_REGULATION,
                     size: int = Query(6, ge=1, le=6), seed: int | None = None):
    """A ladder-realistic opponent team for the Battle tab's practice bot: usage-
    weighted species from meta_sets.json with their recorded sets, species and
    item clauses respected, exported as a Showdown paste."""
    members = practice.random_meta_team(regulation, size=size, seed=seed)
    if not members:
        raise HTTPException(status_code=404, detail="no ladder sets available for this regulation")
    return {"paste": teams.export_paste(members), "members": practice.describe_team(members)}


@router.get("/meta/sets")
def get_meta_sets():
    return dataio.meta_sets()


@router.post("/matchup/suggest")
def matchup_suggest(req: SuggestRequest):
    try:
        return matchup.suggest_teammates(req.team, regulation=req.regulation,
                                         top_n=req.top_n)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


class OffenseScanRequest(BaseModel):
    attacker: CombatantIn
    moves: list[str] = Field(..., min_length=1, max_length=4)
    pool_hp_sp: int = Field(0, ge=0, le=32)
    pool_def_sp: int = Field(0, ge=0, le=32)
    pool_alignment: str = Field("neutral", pattern="^(boost|neutral|reduce)$")
    top_n: int = Field(25, ge=1, le=100)
    regulation: str = dataio.DEFAULT_REGULATION


@router.post("/matchup/offense")
def matchup_offense(req: OffenseScanRequest):
    try:
        return matchup.offensive_scan(
            req.attacker.to_combatant(), req.moves,
            regulation=req.regulation, pool_hp_sp=req.pool_hp_sp,
            pool_def_sp=req.pool_def_sp, pool_alignment=req.pool_alignment,
            top_n=req.top_n)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


class SurviveRequest(BaseModel):
    defender_id: str
    alignment: str = "Serious"
    ability: str | None = None
    item: str | None = None
    moves: list[str] = []          # carried into the exported paste
    attacker: CombatantIn
    move: str
    field: DamageFieldIn = DamageFieldIn()
    mode: str = Field("guaranteed", pattern="^(guaranteed|avoid_ohko|two_hits)$")
    top_n: int = Field(5, ge=1, le=10)


@router.post("/matchup/survive")
def matchup_survive(req: SurviveRequest):
    try:
        out = matchup.survival_solve(
            req.defender_id, req.alignment, req.attacker.to_combatant(),
            req.move, field=req.field.to_field() if hasattr(req.field, "to_field")
            else None, defender_ability=req.ability, defender_item=req.item,
            mode=req.mode, top_n=req.top_n)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    # render each solution as an importable paste
    from vgc_toolkit.core.damage import Combatant
    from vgc_toolkit.core.stats import SPSpread
    for sol in out["solutions"]:
        spread = SPSpread.from_dict({"hp": sol["hp_sp"],
                                     sol["def_stat"]: sol["def_sp"]})
        member = teams.TeamMember(
            combatant=Combatant(req.defender_id, spread=spread,
                                alignment=req.alignment, ability=req.ability,
                                item=req.item),
            moves=[m for m in req.moves if m])
        sol["paste"] = teams.export_paste([member])
    return out


# ---------- team builder ----------

class TeamMemberIn(BaseModel):
    pokemon: CombatantIn
    moves: list[str] = Field(..., min_length=1, max_length=4)

    def to_member(self) -> teams.TeamMember:
        return teams.TeamMember(combatant=self.pokemon.to_combatant(),
                                moves=self.moves)


class TeamValidateRequest(BaseModel):
    team: list[TeamMemberIn] = Field(..., min_length=1, max_length=6)
    regulation: str = dataio.DEFAULT_REGULATION


class PasteRequest(BaseModel):
    paste: str
    regulation: str = dataio.DEFAULT_REGULATION


@router.post("/team/validate")
def team_validate(req: TeamValidateRequest):
    return teams.validate_team([m.to_member() for m in req.team],
                               req.regulation)


@router.post("/team/import")
def team_import(req: PasteRequest):
    try:
        team = teams.import_paste(req.paste)
    except (KeyError, stats.InvalidSpreadError) as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {
        "team": [{
            "pokemon": {
                "pokemon_id": m.combatant.pokemon_id,
                "spread": m.combatant.spread.as_dict(),
                "alignment": m.combatant.alignment,
                "ability": m.combatant.ability,
                "item": m.combatant.item,
            },
            "moves": m.moves,
        } for m in team],
        # validate against the regulation the client is building for
        "validation": teams.validate_team(team, req.regulation),
    }


@router.post("/team/export")
def team_export(req: TeamValidateRequest):
    try:
        return {"paste": teams.export_paste([m.to_member() for m in req.team])}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


class PlaybookRequest(TeamValidateRequest):
    top_n: int = Field(16, ge=4, le=40)


@router.post("/team/playbook")
def team_playbook(req: PlaybookRequest):
    """Wolfe's VGC Playbook checks (composition, speed control, offense, defense,
    items, movesets, spreads, matchup pass) plus the filled-in worksheet."""
    try:
        return playbook.analyze([m.to_member() for m in req.team], req.regulation, top_n=req.top_n)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ---------- speed tiers ----------

class SpeedFieldIn(BaseModel):
    weather: str = "none"
    terrain: str = "none"
    tailwind: bool = False
    opposing_tailwind: bool = False
    trick_room: bool = False


class PoolBenchmarkIn(BaseModel):
    sp: int = Field(32, ge=0, le=32)
    alignment: str = Field("boost", pattern="^(boost|neutral|reduce)$")


class SpeedTiersRequest(BaseModel):
    team: list[CombatantIn] = []
    field: SpeedFieldIn = SpeedFieldIn()
    pool: PoolBenchmarkIn = PoolBenchmarkIn()
    regulation: str = dataio.DEFAULT_REGULATION


@router.post("/speed/tiers")
def speed_tiers(req: SpeedTiersRequest):
    try:
        return speed.speed_tiers(
            [c.to_combatant() for c in req.team],
            speed.SpeedField(**req.field.model_dump()),
            regulation=req.regulation,
            pool=speed.PoolBenchmark(**req.pool.model_dump()),
        )
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
