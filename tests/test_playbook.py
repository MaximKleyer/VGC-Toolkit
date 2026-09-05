"""Wolfe's playbook checks on a Trick Room team and on a deliberately bad team."""

from vgc_toolkit.core import playbook, teams

GOLISOPOD_TR = """\
Golisopod-Mega @ Golisopodite
Ability: Battle Armor
Level: 50
EVs: 32 HP / 32 Atk / 2 SpD
Brave Nature
- First Impression
- Iron Head
- Close Combat
- Rock Slide

Farigiraf @ Sitrus Berry
Ability: Armor Tail
Level: 50
EVs: 29 HP / 21 Def / 16 SpD
Sassy Nature
- Trick Room
- Psychic
- Helping Hand
- Protect

Sinistcha @ Colbur Berry
Ability: Heatproof
Level: 50
EVs: 32 HP / 14 Def / 20 SpD
Relaxed Nature
- Matcha Gotcha
- Rage Powder
- Trick Room
- Protect

Tyranitar @ Life Orb
Ability: Sand Stream
Level: 50
EVs: 32 HP / 32 Atk / 2 SpD
Brave Nature
- Rock Slide
- Crunch
- Low Kick
- Protect

Primarina @ Expert Belt
Ability: Liquid Voice
Level: 50
EVs: 32 HP / 32 SpA / 2 SpD
Quiet Nature
- Hyper Voice
- Moonblast
- Icy Wind
- Protect

Azumarill @ Mystic Water
Ability: Huge Power
Level: 50
EVs: 32 HP / 32 Atk / 2 SpD
Brave Nature
- Aqua Jet
- Play Rough
- Liquidation
- Protect
"""

FIRE_STACK = """\
Charizard-Mega-Y @ Charizardite Y
Ability: Drought
Level: 50
EVs: 32 HP / 32 SpA / 2 Spe
Modest Nature
- Heat Wave
- Solar Beam
- Weather Ball
- Protect

Incineroar @ Sitrus Berry
Ability: Intimidate
Level: 50
EVs: 32 HP / 20 Def / 14 SpD
Impish Nature
- Fake Out
- Flare Blitz
- Parting Shot
- Protect

Torkoal @ Sitrus Berry
Ability: Drought
Level: 50
EVs: 32 HP / 32 SpA / 2 Def
Quiet Nature
- Eruption
- Heat Wave
- Protect
- Helping Hand

Arcanine-Hisui @ Focus Sash
Ability: Rock Head
Level: 50
EVs: 32 Atk / 32 Spe / 2 HP
Jolly Nature
- Flare Blitz
- Head Smash
- Extreme Speed
- Protect
"""


def _checks(result):
    return {c["id"]: c for c in result["checks"]}


def test_golisopod_trick_room_team_passes_the_hard_trick_room_recipe():
    team = teams.import_paste(GOLISOPOD_TR)
    result = playbook.analyze(team, "M-C", top_n=12)
    checks = _checks(result)
    assert result["speed"]["primary"] == "Trick Room"
    assert "priority" in result["speed"]["backups"]
    roles = {m["name"]: m["role"] for m in result["members"]}
    assert roles["Farigiraf"] == "support" and roles["Sinistcha"] == "support"
    assert sum(1 for r in roles.values() if r != "support") == 4
    assert checks["damage-dealers"]["status"] == "pass"
    assert checks["support-count"]["status"] == "pass"
    assert checks["megas"]["status"] == "pass"
    assert checks["tr-setters"]["status"] == "pass"          # two setters
    assert checks["tr-fake-out"]["status"] == "pass"         # Armor Tail
    assert checks["tr-support"]["status"] == "pass"          # Rage Powder
    assert checks["item-clause"]["status"] == "pass"
    assert checks["offensive-items"]["status"] == "pass"     # Life Orb, Expert Belt, Mystic Water
    assert checks["type-count"]["status"] == "pass"
    assert checks["mix"]["status"] == "pass"
    # Every attacker meets Wolfe's floors with these sets.
    assert all(c["status"] == "pass" for cid, c in checks.items() if cid.startswith("stat-"))
    # Kingambit is the top threat and the team has answers for it.
    kingambit = next(r for r in result["threats"] if r["id"] == "kingambit")
    assert len(kingambit["answers"]) >= 2
    ws = result["worksheet"]["markdown"]
    assert "Speed control plan" in ws and "Trick Room" in ws and "| 1 | Mega Golisopod" in ws


def test_stacked_fire_team_fails_the_defensive_rules():
    team = teams.import_paste(FIRE_STACK)
    result = playbook.analyze(team, "M-B", top_n=8)
    checks = _checks(result)
    assert checks["type-count"]["status"] == "fail"          # four Fire types
    assert checks["item-clause"]["status"] == "fail"         # two Sitrus Berries
    assert checks["resist-all"]["status"] == "warn"          # something is unresisted
    assert result["summary"]["fail"] >= 2
    assert checks["team-size"]["status"] == "info"


def test_no_attack_and_neutral_nature_are_flagged():
    paste = """\
Farigiraf @ Sitrus Berry
Ability: Armor Tail
Level: 50
EVs: 32 HP / 32 Def / 2 SpD
Serious Nature
- Trick Room
- Helping Hand
- Protect
- Ally Switch

Sinistcha @ Colbur Berry
Ability: Hospitality
Level: 50
EVs: 32 HP / 32 SpD / 2 Def
Bold Nature
- Matcha Gotcha
- Rage Powder
- Trick Room
- Protect
"""
    result = playbook.analyze(teams.import_paste(paste), "M-C", top_n=6)
    checks = _checks(result)
    assert checks["no-attack-farigiraf"]["status"] == "fail"
    assert checks["nature-farigiraf"]["status"] == "warn"
    assert checks["damage-dealers"]["status"] == "warn"
