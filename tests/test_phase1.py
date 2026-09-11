"""Tests for the SP stat engine and data integrity.

Reference values cross-checked two ways:
  - against the JS engine in champions-speed-calc (same floor semantics)
  - against published Champions speed tables (base 142 -> 213 max,
    base 150 -> 222 max, both confirmed externally)
"""

import pytest

from vgc_toolkit.core import dataio, stats
from vgc_toolkit.core.stats import SPSpread, InvalidSpreadError


# ---------- stat formula ----------

class TestStatFormula:
    def test_max_speed_matches_published_tables(self):
        # Dragapult (base 142): 32 SP + speed-boosting alignment -> 213
        assert stats.calc_stat(142, 32, 1.1) == 213
        # Base 150 (e.g. fastest M-A megas): -> 222
        assert stats.calc_stat(150, 32, 1.1) == 222

    def test_known_speed_ladder_base_100(self):
        # Charizard-line base 100 Speed reference points
        assert stats.calc_stat(100, 0, 1.0) == 120     # uninvested neutral
        assert stats.calc_stat(100, 32, 1.0) == 152    # max SP neutral
        assert stats.calc_stat(100, 32, 1.1) == 167    # max SP, +spe alignment
        assert stats.calc_stat(100, 0, 0.9) == 108     # uninvested, -spe

    def test_hp_formula(self):
        # Venusaur base 80 HP: floor((160+31+64)*0.5) + 60 = 127 + 60
        assert stats.calc_hp(80, 32) == 187
        assert stats.calc_hp(80, 0) == 155

    def test_one_sp_is_one_final_stat_point(self):
        # 1 SP = 8 EVs = +2 pre-level points = +1 final stat at L50
        for sp in range(0, 32):
            assert stats.calc_stat(100, sp + 1, 1.0) == stats.calc_stat(100, sp, 1.0) + 1

    def test_calc_all_stats_venusaur(self):
        venusaur = dataio.get_pokemon("venusaur")
        block = stats.calc_all_stats(
            venusaur["base"], SPSpread(hp=4, spa=31, spe=31), alignment="Modest"
        )
        assert block["hp"] == 159
        assert block["spa"] == stats.calc_stat(100, 31, 1.1)
        assert block["atk"] == stats.calc_stat(82, 0, 0.9)  # Modest reduces atk
        assert block["spe"] == stats.calc_stat(80, 31, 1.0)

    def test_alignment_never_touches_hp(self):
        assert stats.alignment_multiplier("Timid", "hp") == 1.0


# ---------- spread validation ----------

class TestSpreadValidation:
    def test_total_budget_enforced(self):
        with pytest.raises(InvalidSpreadError):
            SPSpread(hp=32, atk=32, spe=32)  # 96 > 66

    def test_per_stat_cap_enforced(self):
        with pytest.raises(InvalidSpreadError):
            SPSpread(spe=33)

    def test_negative_rejected(self):
        with pytest.raises(InvalidSpreadError):
            SPSpread(atk=-1)

    def test_valid_max_spread(self):
        spread = SPSpread(hp=2, spa=32, spe=32)
        assert spread.total == 66
        assert spread.remaining == 0


# ---------- stat stages ----------

class TestStages:
    @pytest.mark.parametrize("stage,expected", [
        (0, 100), (1, 150), (2, 200), (6, 400),
        (-1, 66), (-2, 50), (-6, 25),
    ])
    def test_stage_ladder(self, stage, expected):
        assert stats.apply_stage(100, stage) == expected

    def test_stage_bounds(self):
        with pytest.raises(ValueError):
            stats.apply_stage(100, 7)


# ---------- data integrity ----------

class TestData:
    def test_roster_size_and_megas(self):
        dex = dataio.pokedex()
        # 310 M-B forms + the 33 Regulation M-C additions (2026-09-08)
        assert len(dex) == 343
        megas = [m for m in dex.values() if "mega_of" in m]
        assert len(megas) == 82
        # Every mega's base form exists and back-links
        for mega in megas:
            base = dataio.get_pokemon(mega["mega_of"])
            assert mega["id"] in base["mega_forms"]

    def test_every_pokemon_has_complete_base_stats(self):
        for mon in dataio.pokedex().values():
            assert set(mon["base"].keys()) == set(stats.STAT_KEYS)
            assert all(isinstance(v, int) and v > 0 for v in mon["base"].values())

    def test_type_chart_complete_and_spot_checked(self):
        chart = dataio.type_chart()
        assert len(chart) == 18
        assert all(len(row) == 18 for row in chart.values())
        assert chart["Electric"]["Ground"] == 0.0
        assert chart["Fighting"]["Ghost"] == 0.0
        assert chart["Dragon"]["Fairy"] == 0.0
        assert chart["Fire"]["Water"] == 0.5
        assert chart["Ice"]["Dragon"] == 2.0

    def test_all_roster_types_exist_in_chart(self):
        chart = dataio.type_chart()
        for mon in dataio.pokedex().values():
            for t in mon["types"]:
                assert t in chart, f"{mon['id']} has unknown type {t}"

    def test_dual_type_effectiveness(self):
        # Electric into Gyarados (Water/Flying) = 4x
        assert dataio.type_effectiveness("Electric", ["Water", "Flying"]) == 4.0
        # Ground into Charizard (Fire/Flying) = immune
        assert dataio.type_effectiveness("Ground", ["Fire", "Flying"]) == 0.0

    def test_alignments_loaded(self):
        al = dataio.alignments()
        assert len(al) == 21          # every +10%/-10% pairing of the five stats, plus Serious
        assert al["Timid"]["boost"] == "spe"
        assert al["Serious"]["boost"] is None
        # The six the speed-calc source omits (the game has them).
        for name, boost, reduce in [("Lonely", "atk", "def"), ("Naughty", "atk", "spd"), ("Mild", "spa", "def"),
                                    ("Rash", "spa", "spd"), ("Lax", "def", "spd"), ("Gentle", "spd", "def")]:
            assert (al[name]["boost"], al[name]["reduce"]) == (boost, reduce)
            assert al[name]["multipliers"][boost] == 1.1 and al[name]["multipliers"][reduce] == 0.9

    def test_every_form_has_a_weight(self):
        dex = dataio.pokedex()
        missing = [pid for pid, m in dex.items() if not m.get("weight_kg")]
        assert not missing, f"forms without weight_kg (run scripts/fill_weights.py): {missing[:10]}"
        assert dex["snorlax"]["weight_kg"] == 460
        assert dex["golisopod-mega"]["weight_kg"] == 148      # Champions-new mega, from the engine's champions mod

    def test_mega_stones_link_to_forms(self):
        items = dataio.items()
        stones = [i for i in items.values() if i["category"] == "mega_stone"]
        linked = [s for s in stones if s.get("mega_form")]
        # Mega stones link to a mega form (meowstic m/f share Meowsticite);
        # 75 M-B stones + 6 for the M-C megas.
        assert len(linked) == 81
        for stone in linked:
            assert stone["mega_form"] in dataio.pokedex()


# ---------- API ----------

class TestAPI:
    @pytest.fixture()
    def client(self):
        from fastapi.testclient import TestClient
        from vgc_toolkit.main import app
        return TestClient(app)

    def test_stats_endpoint(self, client):
        resp = client.post("/api/stats", json={
            "pokemon_id": "dragapult" if "dragapult" in dataio.pokedex() else "venusaur",
            "spread": {"hp": 4, "spa": 30, "spe": 32},
            "alignment": "Timid",
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["sp_used"] == 66
        assert set(body["stats"].keys()) == set(stats.STAT_KEYS)

    def test_stats_endpoint_rejects_overbudget(self, client):
        resp = client.post("/api/stats", json={
            "pokemon_id": "venusaur",
            "spread": {"hp": 32, "atk": 32, "spe": 32},
        })
        assert resp.status_code == 422

    def test_pokemon_list_filters_by_regulation(self, client):
        resp = client.get("/api/pokemon", params={"regulation": "M-B"})
        assert resp.status_code == 200
        assert len(resp.json()) == 310

    def test_roster_membership_follows_learnset_sheet(self, client):
        mb_ids = {m["id"] for m in client.get(
            "/api/pokemon", params={"regulation": "M-B"}).json()}
        # In the game per the learnset sheet:
        assert {"pikachu", "ditto", "machamp", "lopunny", "emboar"} <= mb_ids
        # In the old speed-calc roster but not in Champions:
        assert not {"amoonguss", "rillaboom", "dondozo"} & mb_ids
        # Mega legality follows the base form:
        assert "garchomp-mega" in mb_ids
        # In-game megas legal; ZA-only stub megas and legendary megas excluded:
        assert {"emboar-mega", "starmie-mega"} <= mb_ids
        assert not {"heatran-mega", "darkrai-mega", "garchomp-mega-z"} & mb_ids
        # Raichu megas arrived in M-B:
        assert {"raichu-mega-x", "raichu-mega-y"} <= mb_ids
        # Aegislash is in via its single sheet row (shield forme):
        assert "aegislash" in mb_ids

    def test_megas_tab_is_authoritative(self, client):
        clef = client.get("/api/pokemon/clefable-mega").json()
        assert clef["types"] == ["Fairy", "Flying"]
        assert clef["abilities"] == ["Magic Bounce"]
        emboar = client.get("/api/pokemon/emboar-mega").json()
        assert emboar["base"]["atk"] == 148
        assert emboar["mega_stone"] == "Emboarite"

    def test_unknown_pokemon_404(self, client):
        assert client.get("/api/pokemon/missingno").status_code == 404
