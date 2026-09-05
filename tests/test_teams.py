"""Team builder tests: validation clauses and paste round-trip."""

import pytest

from vgc_toolkit.core import teams
from vgc_toolkit.core.damage import Combatant
from vgc_toolkit.core.stats import SPSpread
from vgc_toolkit.core.teams import TeamMember, import_paste, export_paste, validate_member, validate_team

RAIN_PASTE = """\
Politoed @ Wacan Berry
Ability: Drizzle
Level: 50
EVs: 32 HP / 16 Def / 18 SpD
Calm Nature
- Surf
- Ice Beam
- Helping Hand
- Protect

Skarmory-Mega
Ability: Stalwart
EVs: 32 HP / 32 Def / 2 Spe
Impish Nature
- Body Press
- Iron Head
- Tailwind
- Roost
"""


def member(pid, item=None, moves=None, ability=None, spread=None):
    return TeamMember(
        combatant=Combatant(pid, spread=spread or SPSpread(),
                            ability=ability, item=item),
        moves=moves or ["Protect"])


class TestValidation:
    def test_valid_team(self):
        team = import_paste(RAIN_PASTE)
        result = validate_team(team)
        assert result["valid"], result

    def test_illegal_pokemon(self):
        r = validate_team([member("amoonguss")])  # pruned from the M-B roster
        assert not r["valid"]
        assert any("unknown pokemon" in e for e in r["member_errors"][0])

    def test_z_mega_is_mc_only(self):
        # Mega Garchomp Z arrived with Regulation M-C (ability blank until the
        # game announces it): buildable there, still illegal in M-B.
        team = [member("garchomp-mega-z", moves=["Earthquake"])]
        assert validate_team(team, "M-C")["valid"]
        assert not validate_team(team, "M-B")["valid"]

    def test_unlearnable_move(self):
        r = validate_team([member("kingambit", moves=["Surf"])])
        assert any("cannot learn" in e for e in r["member_errors"][0])

    def test_species_clause_collapses_megas(self):
        r = validate_team([
            member("dragonite", moves=["Dragon Claw"]),
            member("dragonite-mega", moves=["Dragon Claw"]),
        ])
        assert any("species clause" in e for e in r["team_errors"])

    def test_item_clause(self):
        r = validate_team([
            member("kingambit", item="Occa Berry", moves=["Iron Head"]),
            member("clefable", item="Occa Berry", moves=["Moonblast"]),
        ])
        assert any("item clause" in e for e in r["team_errors"])

    def test_wrong_mega_stone(self):
        r = validate_team([member("kingambit", item="Garchompite",
                                  moves=["Iron Head"])])
        assert any("belongs to" in e for e in r["member_errors"][0])

    def test_wrong_ability(self):
        r = validate_team([member("kingambit", ability="Drizzle",
                                  moves=["Iron Head"])])
        assert any("ability" in e for e in r["member_errors"][0])


class TestPaste:
    def test_round_trip(self):
        team = import_paste(RAIN_PASTE)
        assert team[0].combatant.pokemon_id == "politoed"
        assert team[0].combatant.spread.as_dict()["spd"] == 18
        assert team[1].combatant.pokemon_id == "skarmory-mega"
        exported = export_paste(team)
        assert "Skarmory-Mega" in exported          # showdown-style names
        assert "Calm Nature" in exported and "Level: 50" in exported
        again = import_paste(exported)
        assert [m.moves for m in again] == [m.moves for m in team]
        assert [m.combatant.spread for m in again] == \
            [m.combatant.spread for m in team]

    def test_overbudget_spread_rejected(self):
        bad = "Kingambit\nSP: 32 HP / 32 Atk / 32 Spe\n- Iron Head"
        with pytest.raises(Exception, match="Kingambit"):
            import_paste(bad)


class TestTeamAPI:
    @pytest.fixture()
    def client(self):
        from fastapi.testclient import TestClient
        from vgc_toolkit.main import app
        return TestClient(app)

    def test_import_endpoint(self, client):
        resp = client.post("/api/team/import", json={"paste": RAIN_PASTE})
        assert resp.status_code == 200
        body = resp.json()
        assert body["validation"]["valid"]
        assert body["team"][1]["pokemon"]["pokemon_id"] == "skarmory-mega"


class TestProtectAPIRegression:
    """defender_protected must survive the API layer (was silently dropped)."""

    def test_protect_through_api(self):
        from fastapi.testclient import TestClient
        from vgc_toolkit.main import app
        client = TestClient(app)
        body = {
            "attacker": {"pokemon_id": "feraligatr-mega",
                         "spread": {"atk": 32}, "alignment": "Adamant",
                         "ability": "Dragonize"},
            "defender": {"pokemon_id": "dragapult", "spread": {"hp": 4}},
            "move": "Double-Edge",
            "field": {"defender_protected": True},
        }
        r = client.post("/api/damage", json=body).json()
        assert r["rolls"] == [0] * 16
        assert any("protected" in n for n in r["notes"])

    def test_piercing_drill_through_api(self):
        from fastapi.testclient import TestClient
        from vgc_toolkit.main import app
        client = TestClient(app)
        body = {
            "attacker": {"pokemon_id": "excadrill-mega",
                         "spread": {"atk": 32}, "alignment": "Adamant",
                         "ability": "Piercing Drill"},
            "defender": {"pokemon_id": "dragapult", "spread": {"hp": 4}},
            "move": "Drill Run",
            "field": {"defender_protected": True},
        }
        full = client.post("/api/damage", json={**body, "field": {}}).json()
        pierced = client.post("/api/damage", json=body).json()
        assert 0 < max(pierced["rolls"]) < max(full["rolls"]) * 0.3


class TestSuggest:
    def test_suggest_endpoint(self):
        from fastapi.testclient import TestClient
        from vgc_toolkit.main import app
        client = TestClient(app)
        r = client.post("/api/matchup/suggest",
                        json={"team": ["kingambit", "tyranitar"]})
        assert r.status_code == 200
        sugg = r.json()["suggestions"]
        assert len(sugg) == 8
        # No species-clause violations in suggestions
        assert all(s["pokemon_id"] not in ("kingambit", "tyranitar")
                   for s in sugg)
        # Top picks should resist the shared Fighting weakness
        from vgc_toolkit.core.matchup import defensive_profile
        assert defensive_profile(sugg[0]["pokemon_id"])["matchups"]["Fighting"] <= 1


class TestMBMegas:
    """M-B megas carry a single fixed ability, a matching stone, and inherit
    their base form's real learnset (no full-movepool widening anymore)."""

    MB_MEGAS = ["clefable-mega", "starmie-mega", "dragonite-mega", "eelektross-mega",
                "pyroar-mega", "falinks-mega", "garchomp-mega", "hawlucha-mega"]
    # Stub megas (no ability in the sheet) + legendary/Z variants: pruned entirely.
    EXCLUDED = ["garchomp-mega-z", "absol-mega-z", "lucario-mega-z", "golisopod-mega",
                "darkrai-mega", "heatran-mega", "magearna-mega", "zeraora-mega",
                "baxcalibur-mega", "tatsugiri-mega", "zygarde-complete-mega"]

    def test_mb_megas_have_single_ability_stone_and_real_learnset(self):
        import re
        from vgc_toolkit.core import dataio
        for pid in self.MB_MEGAS:
            mon = dataio.get_pokemon(pid)
            # membership, not equality: a form may also be legal in later regs
            assert "M-B" in mon["regulations"], pid
            assert len(mon["abilities"]) == 1, pid          # one fixed mega ability
            assert mon.get("mega_stone"), pid
            key = re.sub(r"[^a-z0-9]+", "-", mon["mega_stone"].lower()).strip("-")
            stone = dataio.items().get(key)
            assert stone and stone["mega_form"] == pid, pid
            # inherits the base form's real learnset (not a sandbox full pool)
            ls = dataio.get_learnset(pid)
            assert "sandbox" not in ls.get("source", ""), pid
            assert ls["moves"] == dataio.get_learnset(mon["mega_of"])["moves"], pid

    def test_mb_mega_validates_with_its_ability_and_stone(self):
        from vgc_toolkit.core import dataio
        mon = dataio.get_pokemon("falinks-mega")
        member = TeamMember(
            combatant=Combatant("falinks-mega", spread=SPSpread(atk=32),
                                alignment="Adamant", ability=mon["abilities"][0],
                                item=mon["mega_stone"]),
            moves=list(dataio.get_learnset("falinks-mega")["moves"])[:3])
        assert validate_member(member, "M-B") == []

    def test_excluded_megas_are_not_mb_legal(self):
        # Stub/legendary/Z megas are either absent from the dex or, once M-C
        # data lands, present but not tagged M-B — never M-B legal either way.
        from vgc_toolkit.core import dataio
        for pid in self.EXCLUDED:
            mon = dataio.pokedex().get(pid)
            assert mon is None or "M-B" not in mon.get("regulations", []), pid
