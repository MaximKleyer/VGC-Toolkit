"""Regulation M-C additions (scripts/add_mc_forms.py) and the provisional
ability override feature (PUT /api/pokemon/{id}/abilities)."""

import re

import pytest
from fastapi.testclient import TestClient

from vgc_toolkit.core import damage, dataio, stats, teams
from vgc_toolkit.main import app

MC_NEW = ["rillaboom", "salamence", "golisopod", "baxcalibur", "salamence-mega",
          "golisopod-mega", "baxcalibur-mega", "absol-mega-z", "garchomp-mega-z",
          "lucario-mega-z"]
# Champions has not announced these abilities: blank until the user sets one
# in the UI. The other four new megas were confirmed on 2026-09-03.
PROVISIONAL = ["golisopod-mega", "baxcalibur-mega"]
CONFIRMED = {"salamence-mega": ["Aerilate"], "absol-mega-z": ["Sharpness"],
             "garchomp-mega-z": ["Levitate"], "lucario-mega-z": ["Aura Guard"]}
NEW_SPECIES = ["rillaboom", "salamence", "golisopod", "baxcalibur"]


@pytest.fixture()
def client():
    return TestClient(app)


class TestMCRoster:
    def test_default_is_mc_and_mb_roster_is_unchanged(self, client):
        assert dataio.DEFAULT_REGULATION == "M-C"
        assert len(client.get("/api/pokemon", params={"regulation": "M-B"}).json()) == 310
        assert len(client.get("/api/pokemon", params={"regulation": "M-C"}).json()) == 320

    def test_every_mb_form_carries_over_to_mc(self):
        for mon in dataio.pokedex().values():
            if "M-B" in mon["regulations"]:
                assert "M-C" in mon["regulations"], mon["id"]

    def test_new_forms_are_mc_only_with_complete_stats(self):
        chart = dataio.type_chart()
        for pid in MC_NEW:
            mon = dataio.get_pokemon(pid)
            assert mon["regulations"] == ["M-C"], pid
            assert set(mon["base"]) == set(stats.STAT_KEYS), pid
            assert all(isinstance(v, int) and v > 0 for v in mon["base"].values()), pid
            assert mon["types"] and all(t in chart for t in mon["types"]), pid

    def test_stats_spot_check(self):
        assert dataio.get_pokemon("rillaboom")["base"] == {
            "hp": 100, "atk": 125, "def": 90, "spa": 60, "spd": 70, "spe": 85}
        assert dataio.get_pokemon("salamence-mega")["base"]["spe"] == 120
        # datamine-sourced forms keep their datamine typing
        assert dataio.get_pokemon("absol-mega-z")["types"] == ["Dark", "Ghost"]
        assert dataio.get_pokemon("golisopod-mega")["types"] == ["Bug", "Steel"]

    def test_new_megas_link_both_ways_with_stones(self):
        items = dataio.items()
        for pid in MC_NEW:
            mon = dataio.get_pokemon(pid)
            if "mega_of" not in mon:
                continue
            assert pid in dataio.get_pokemon(mon["mega_of"])["mega_forms"], pid
            key = re.sub(r"[^a-z0-9]+", "-", mon["mega_stone"].lower()).strip("-")
            assert items[key]["mega_form"] == pid, pid
        assert items["absolite-z"]["name"] == "Absolite Z"

    def test_unannounced_abilities_are_flagged_not_guessed(self, client):
        for pid in PROVISIONAL:
            mon = dataio.get_pokemon(pid)
            assert mon.get("abilities_provisional") is True, pid
            assert mon["abilities"] == [], pid
        for pid, abilities in CONFIRMED.items():
            mon = dataio.get_pokemon(pid)
            assert mon["abilities"] == abilities, pid
            assert not mon.get("abilities_provisional"), pid
        listed = {m["id"]: m for m in
                  client.get("/api/pokemon", params={"regulation": "M-C"}).json()}
        assert listed["golisopod-mega"]["abilities_provisional"] is True
        assert listed["absol-mega-z"]["abilities_provisional"] is False
        assert listed["garchomp"]["abilities_provisional"] is False

    def test_blank_ability_forms_still_scan(self, client):
        # An empty ability list must flow through the analysis paths as "no
        # ability", not crash them.
        assert client.get("/api/matchup/absol-mega-z/profile").status_code == 200
        body = {"attacker": {"pokemon_id": "garchomp-mega-z",
                             "spread": {"spa": 32}, "alignment": "Modest"},
                "defender": {"pokemon_id": "rillaboom", "spread": {"hp": 32}},
                "top_n": 3}
        r = client.post("/api/damage/best-moves", json=body)
        assert r.status_code == 200 and r.json()["moves"]


class TestProvisionalLearnsets:
    def test_new_species_have_flagged_learnsets_inside_the_move_pool(self):
        move_db = dataio.moves()
        for sid in NEW_SPECIES:
            ls = dataio.get_learnset(sid)
            assert len(ls["moves"]) >= 25, sid
            assert "provisional" in ls["source"], sid
            assert all(m in move_db for m in ls["moves"]), sid
            assert "Protect" in ls["moves"], sid

    def test_new_megas_inherit_base_learnsets(self):
        assert dataio.get_learnset("salamence-mega") == dataio.get_learnset("salamence")
        assert dataio.get_learnset("absol-mega-z") == dataio.get_learnset("absol")


class TestAbilityOverride:
    # Override-file isolation is suite-wide: see tests/conftest.py.

    def test_abilities_endpoint_lists_known_names(self, client):
        names = client.get("/api/abilities").json()
        assert names == sorted(names)
        assert {"Intimidate", "Grassy Surge", "Aerilate"} <= set(names)

    def test_put_override_applies_everywhere_then_resets(self, client):
        r = client.put("/api/pokemon/golisopod-mega/abilities",
                       json={"abilities": [" Magic Bounce ", "Magic Bounce", ""]})
        assert r.status_code == 200
        body = r.json()
        assert body["abilities"] == ["Magic Bounce"]      # trimmed, de-duplicated
        assert body["ability_override"] is True
        assert body["abilities_provisional"] is True      # still unconfirmed by the game

        # Visible through the data layer every scan reads, and in the picker list.
        assert dataio.get_pokemon("golisopod-mega")["abilities"] == ["Magic Bounce"]
        assert dataio.ability_overrides() == {"golisopod-mega": ["Magic Bounce"]}
        assert "Magic Bounce" in client.get("/api/abilities").json()

        # Team validation now enforces the chosen ability like a shipped one.
        moves = list(dataio.get_learnset("golisopod-mega")["moves"])[:2]
        def member(ability):
            return teams.TeamMember(
                combatant=damage.Combatant("golisopod-mega", spread=stats.SPSpread(atk=32),
                                           alignment="Adamant", ability=ability,
                                           item="Golisopodite"),
                moves=moves)
        assert teams.validate_member(member("Magic Bounce"), "M-C") == []
        assert teams.validate_member(member("Pressure"), "M-C") != []

        # Empty list removes the override and restores the shipped (blank) data.
        r = client.put("/api/pokemon/golisopod-mega/abilities", json={"abilities": []})
        assert r.status_code == 200
        assert r.json()["abilities"] == [] and "ability_override" not in r.json()
        assert dataio.ability_overrides() == {}
        assert dataio.get_pokemon("golisopod-mega")["abilities"] == []

    def test_put_rejects_unknown_form_and_too_many_abilities(self, client):
        r = client.put("/api/pokemon/not-a-mon/abilities", json={"abilities": ["Levitate"]})
        assert r.status_code == 404
        r = client.put("/api/pokemon/golisopod-mega/abilities",
                       json={"abilities": ["A", "B", "C", "D"]})
        assert r.status_code == 422
