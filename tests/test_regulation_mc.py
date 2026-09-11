"""Regulation M-C as released (2026-09-08, scripts/add_mc_release.py): the
experimental tag is gone, the new Pokemon, items, moves and changes are in,
and the calc models the new items."""

import pytest
from fastapi.testclient import TestClient

from vgc_toolkit.core import dataio, stats, teams
from vgc_toolkit.core.damage import Combatant, Field, calculate
from vgc_toolkit.core.stats import SPSpread
from vgc_toolkit.main import app

NEW_SPECIES = ["wigglytuff", "persian", "persian-alola", "farfetch-d", "mr-mime", "swalot", "gogoat",
               "cinderace", "inteleon", "thievul", "toxtricity", "toxtricity-low-key", "grapploct",
               "perrserker", "sirfetch-d", "pincurchin", "indeedee-m", "indeedee-f", "arboliva",
               "pawmot", "squawkabilly", "squawkabilly-yellow", "mabosstiff"]
RETIRED = ["weezing", "weezing-galar", "dondozo", "tatsugiri", "tatsugiri-mega"]
NEW_ITEMS = ["Leek", "Rocky Helmet", "Air Balloon", "Red Card", "Binding Band", "Eject Button",
             "Normal Gem", "Terrain Extender", "Electric Seed", "Psychic Seed", "Misty Seed", "Grassy Seed"]
RETIRED_ITEMS = ["Assault Vest", "Choice Band", "Choice Specs", "Tatsugirite"]
MEGA_ABILITIES = {"absol-mega-z": "Sharpness", "garchomp-mega-z": "Levitate", "lucario-mega-z": "Aura Guard",
                  "salamence-mega": "Aerilate", "golisopod-mega": "Tough Claws", "baxcalibur-mega": "Thermal Exchange"}


@pytest.fixture()
def client():
    return TestClient(app)


class TestRegulations:
    def test_only_published_regulations_remain(self, client):
        r = client.get("/api/regulations").json()
        tags = [x["regulation"] for x in r["regulations"]]
        assert tags == ["M-B", "M-C"]
        assert all(x["experimental"] is False for x in r["regulations"])
        assert r["default"] == dataio.DEFAULT_REGULATION == "M-C"
        assert dataio.base_regulation("M-C") == "M-C"

    def test_mc_roster_is_mb_plus_the_release(self, client):
        mb = {m["id"] for m in client.get("/api/pokemon", params={"regulation": "M-B"}).json()}
        mc = {m["id"] for m in client.get("/api/pokemon", params={"regulation": "M-C"}).json()}
        assert mb < mc
        assert set(NEW_SPECIES) <= mc - mb
        assert not (set(RETIRED) & mc)
        for pid in RETIRED:
            with pytest.raises(KeyError):
                dataio.get_pokemon(pid)
        for pid in NEW_SPECIES:
            mon = dataio.get_pokemon(pid)
            assert mon["regulations"] == ["M-C"], pid
            assert "experimental" not in mon, pid
            assert set(mon["base"]) == set(stats.STAT_KEYS) and mon["weight_kg"] > 0, pid
            assert dataio.get_learnset(pid)["moves"], pid


class TestSpecies:
    def test_stats_types_and_abilities_spot_check(self):
        assert dataio.get_pokemon("pawmot")["base"] == {"hp": 70, "atk": 115, "def": 70, "spa": 70, "spd": 60, "spe": 105}
        assert dataio.get_pokemon("pawmot")["types"] == ["Electric", "Fighting"]
        assert dataio.get_pokemon("sirfetch-d")["base"]["atk"] == 135
        assert dataio.get_pokemon("sirfetch-d")["abilities"] == ["Steadfast", "Scrappy"]
        assert dataio.get_pokemon("toxtricity")["abilities"] == ["Punk Rock", "Plus", "Technician"]
        assert dataio.get_pokemon("toxtricity-low-key")["abilities"] == ["Punk Rock", "Minus", "Technician"]
        assert dataio.get_pokemon("persian-alola")["types"] == ["Dark"] and "Fur Coat" in dataio.get_pokemon("persian-alola")["abilities"]
        assert dataio.get_pokemon("mr-mime")["types"] == ["Psychic", "Fairy"]
        assert dataio.get_pokemon("squawkabilly")["abilities"][-1] == "Guts"
        assert dataio.get_pokemon("squawkabilly-yellow")["abilities"][-1] == "Sheer Force"
        assert "Run Away" in dataio.get_pokemon("thievul")["abilities"]
        assert dataio.get_pokemon("mabosstiff")["abilities"] == ["Intimidate", "Guard Dog", "Stakeout"]

    def test_names_resolve_from_pastes(self):
        team = teams.import_paste("Farfetch'd @ Leek\nAbility: Defiant\nLevel: 50\n- Slash\n\n"
                                  "Mr. Mime @ Rocky Helmet\nAbility: Filter\nLevel: 50\n- Psychic\n")
        assert [m.combatant.pokemon_id for m in team] == ["farfetch-d", "mr-mime"]

    def test_mega_abilities_confirmed(self):
        for pid, ability in MEGA_ABILITIES.items():
            mon = dataio.get_pokemon(pid)
            assert mon["abilities"] == [ability], pid
            assert not mon.get("abilities_provisional"), pid
        assert not dataio.ability_overrides()


class TestMoves:
    def test_new_moves_and_release_changes(self):
        assert dataio.get_move("Slash")["base_power"] == 80
        assert dataio.get_move("Meteor Assault")["base_power"] == 170
        assert dataio.get_move("Snipe Shot")["base_power"] == 85
        assert dataio.get_move("Wish")["pp"] == 8
        assert dataio.get_move("Strength Sap")["pp"] == 8
        assert dataio.get_move("Double Shock")["flags"].get("punch") == 1
        assert dataio.get_move("Milk Drink")["target"] == "adjacentAllyOrSelf"
        for name in ("Overdrive", "Octolock", "Revival Blessing", "Jaw Lock", "Shift Gear"):
            assert dataio.get_move(name)["name"] == name
        for gone in ("Order Up", "Strange Steam"):
            with pytest.raises(KeyError):
                dataio.get_move(gone)

    def test_learnset_changes(self):
        assert "Slash" in dataio.get_learnset("kingambit")["moves"]
        assert "Slash" in dataio.get_learnset("persian")["moves"]
        assert "Pound" not in dataio.get_learnset("politoed")["moves"]
        arch = dataio.get_learnset("archaludon")["moves"]
        assert "Mirror Coat" not in arch and "Metal Burst" not in arch
        assert "Meteor Assault" in dataio.get_learnset("sirfetch-d")["moves"]
        assert "Double Shock" in dataio.get_learnset("pawmot")["moves"]
        assert "Milk Drink" in dataio.get_learnset("gogoat")["moves"]
        assert "Overdrive" in dataio.get_learnset("toxtricity-low-key")["moves"]


class TestItems:
    def test_new_items_are_scoped_to_mc_and_the_predictions_are_gone(self, client):
        items = dataio.items()
        names = {i["name"] for i in items.values()}
        assert set(NEW_ITEMS) <= names
        assert not (set(RETIRED_ITEMS) & names)
        for name in NEW_ITEMS:
            it = next(i for i in items.values() if i["name"] == name)
            assert it["regulations"] == ["M-C"] and "experimental" not in it, name
            assert dataio.item_legal(it, "M-C") and not dataio.item_legal(it, "M-B"), name
        mc = {i["name"] for i in client.get("/api/items", params={"regulation": "M-C"}).json()}
        mb = {i["name"] for i in client.get("/api/items", params={"regulation": "M-B"}).json()}
        assert set(NEW_ITEMS) <= mc and not (set(NEW_ITEMS) & mb)

    def test_validation_follows_the_item_pool(self):
        paste = "Sirfetch'd @ Leek\nAbility: Scrappy\nLevel: 50\nEVs: 32 HP / 32 Atk / 2 SpD\nAdamant Nature\n- Meteor Assault\n- Close Combat\n- Brave Bird\n- Protect\n"
        assert teams.validate_team(teams.import_paste(paste), "M-C")["valid"]
        assert not teams.validate_team(teams.import_paste(paste), "M-B")["valid"]
        av = "Rillaboom @ Assault Vest\nAbility: Grassy Surge\nLevel: 50\n- Grassy Glide\n"
        assert not teams.validate_team(teams.import_paste(av), "M-C")["valid"]


class TestCalc:
    def test_air_balloon_floats_over_ground_moves(self):
        chomp = Combatant("garchomp", spread=SPSpread(atk=32, spe=32), alignment="Jolly", ability="Rough Skin", item="Life Orb")
        gambit = Combatant("kingambit", spread=SPSpread(hp=32, atk=32), alignment="Adamant", ability="Defiant", item="Air Balloon")
        r = calculate(chomp, gambit, "Earthquake", Field())
        assert max(r["rolls"]) == 0 and "immune (Air Balloon)" in r["notes"]
        assert max(calculate(chomp, gambit, "Dragon Claw", Field())["rolls"]) > 0
        # Gravity grounds the balloon holder.
        assert max(calculate(chomp, gambit, "Earthquake", Field(gravity=True))["rolls"]) > 0

    def test_normal_gem_boosts_one_normal_move(self):
        att = Combatant("salamence", spread=SPSpread(atk=32, spe=32), alignment="Jolly", ability="Intimidate", item="Normal Gem")
        plain = Combatant("salamence", spread=SPSpread(atk=32, spe=32), alignment="Jolly", ability="Intimidate", item=None)
        target = Combatant("kingambit", spread=SPSpread(hp=32, atk=32), alignment="Adamant", ability="Defiant", item=None)
        with_gem = calculate(att, target, "Double-Edge", Field())
        without = calculate(plain, target, "Double-Edge", Field())
        assert 1.25 <= max(with_gem["rolls"]) / max(without["rolls"]) <= 1.35
        assert any("Normal Gem" in n for n in with_gem["notes"])
        assert max(calculate(att, target, "Dragon Claw", Field())["rolls"]) == max(calculate(plain, target, "Dragon Claw", Field())["rolls"])

    def test_slash_uses_its_new_power(self):
        att = Combatant("kingambit", spread=SPSpread(hp=32, atk=32), alignment="Adamant", ability="Defiant", item=None)
        target = Combatant("garchomp", spread=SPSpread(atk=32, spe=32), alignment="Jolly", ability="Rough Skin", item=None)
        assert calculate(att, target, "Slash", Field())["base_power"] == 80
