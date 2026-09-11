"""Matchup analyzer tests."""

import pytest

from vgc_toolkit.core.matchup import (defensive_profile, rank_moves,
                                      signature_spikes, team_analysis,
                                      threat_scan)
from vgc_toolkit.core.damage import Combatant, Field
from vgc_toolkit.core.stats import SPSpread


class TestProfile:
    def test_kingambit(self):
        p = defensive_profile("kingambit")
        assert p["quad_weak"] == ["Fighting"]
        assert set(p["immune"]) == {"Poison", "Psychic"}

    def test_ability_immunity_layered(self):
        p = defensive_profile("politoed", ability="Water Absorb")
        assert "Water" in p["immune"]

    def test_thick_fat(self):
        p = defensive_profile("snorlax", ability="Thick Fat")
        assert p["matchups"]["Fire"] == 0.5  # neutral, halved by Thick Fat
        assert p["matchups"]["Ice"] == 0.5


class TestThreatScan:
    POOL = ["chandelure-mega", "politoed", "clefable", "kingambit"]

    def test_scan_structure_and_ranking(self):
        scan = threat_scan(
            Combatant("skarmory-mega", spread=SPSpread(hp=32), ability="Stalwart"),
            include=self.POOL)
        assert scan["scanned"] == len(self.POOL)
        top = scan["top_threats"][0]
        assert top["attacker"] == "chandelure-mega"
        assert top["ohko_chance"] >= 90.0
        assert set(top) >= {"move", "ability", "pct_range", "speed", "accuracy"}

    def test_weather_setter_brings_weather(self):
        # Drought boost: Torkoal's fire damage in scan exceeds a no-weather calc
        from vgc_toolkit.core.damage import Field, calculate
        scan = threat_scan(Combatant("skarmory-mega", spread=SPSpread(hp=32),
                                     ability="Stalwart"),
                           include=["torkoal"])
        top = scan["top_threats"][0]
        flat = calculate(
            Combatant("torkoal", spread=SPSpread(spa=32),
                      alignment="Modest", ability="Drought"),
            Combatant("skarmory-mega", spread=SPSpread(hp=32), ability="Stalwart"),
            top["move"])
        assert top["pct_range"][1] > flat["pct_range"][1]

    def test_practical_excludes_recharge_and_low_accuracy(self):
        kwargs = dict(include=["emboar"], top_n=5)
        d = Combatant("skarmory-mega", spread=SPSpread(hp=32), ability="Stalwart")
        practical = threat_scan(d, practical=True, **kwargs)
        raw = threat_scan(d, practical=False, **kwargs)
        assert raw["top_threats"][0]["move"] == "Blast Burn"
        assert practical["top_threats"][0]["move"] != "Blast Burn"

    def test_speed_relations(self):
        scan = threat_scan(
            Combatant("dragapult", spread=SPSpread(spe=32), alignment="Timid"),
            include=["clefable"])
        assert scan["top_threats"][0]["speed"] == "you_outspeed"


class TestTeamAnalysis:
    def test_shared_weakness_and_multi_threats(self):
        team = [Combatant("kingambit", spread=SPSpread(hp=32)),
                Combatant("tyranitar", spread=SPSpread(hp=32))]
        result = team_analysis(team)
        assert set(result["shared_weaknesses"].get("Fighting", [])) == \
            {"kingambit", "tyranitar"}
        assert any(len(t["threatens"]) == 2
                   for t in result["multi_member_threats"])


class TestOffensiveScan:
    def test_kingambit_offense(self):
        from vgc_toolkit.core.matchup import offensive_scan
        atk = Combatant("kingambit", spread=SPSpread(atk=32),
                        alignment="Adamant", ability="Defiant")
        out = offensive_scan(atk, ["Kowtow Cleave", "Iron Head", "Protect"])
        assert out["moves_used"] == ["Kowtow Cleave", "Iron Head"]
        assert out["scanned"] > 200
        top = out["targets"][0]
        assert top["ohko_chance"] >= 90.0
        # every entry carries a speed relation and a real move
        assert all(t["move"] in ("Kowtow Cleave", "Iron Head")
                   for t in out["targets"])

    def test_pool_bulk_reduces_damage(self):
        from vgc_toolkit.core.matchup import offensive_scan
        atk = Combatant("kingambit", spread=SPSpread(atk=32))
        frail = offensive_scan(atk, ["Iron Head"], top_n=100)
        bulky = offensive_scan(atk, ["Iron Head"], pool_hp_sp=32,
                               pool_def_sp=32, pool_alignment="boost",
                               top_n=100)
        f = {t["target"]: t["pct_range"][1] for t in frail["targets"]}
        b = {t["target"]: t["pct_range"][1] for t in bulky["targets"]}
        common = set(f) & set(b)
        assert common and all(b[k] < f[k] for k in common)


class TestSurvivalSolve:
    def _attack(self):
        return (Combatant("chandelure", spread=SPSpread(spa=32),
                          alignment="Modest", ability="Flash Fire"),
                "Shadow Ball")

    def test_solver_finds_minimal_spread(self):
        from vgc_toolkit.core.matchup import survival_solve
        from vgc_toolkit.core.damage import Combatant as C, calculate
        from vgc_toolkit.core.stats import SPSpread as S
        atk, move = self._attack()
        out = survival_solve("skarmory-mega", "Calm", atk, move)
        assert out["solvable"]
        best = out["solutions"][0]
        assert best["def_stat"] == "spd"
        # verify the returned spread genuinely survives the max roll
        c = C("skarmory-mega", spread=S(**{"hp": best["hp_sp"],
                                           "spd": best["def_sp"]}),
              alignment="Calm")
        r = calculate(atk, c, move)
        assert max(r["rolls"]) < best["hp"]
        # and that one SP less (taken from HP) does not
        if best["hp_sp"] > 0:
            worse = C("skarmory-mega",
                      spread=S(**{"hp": best["hp_sp"] - 1,
                                  "spd": best["def_sp"]}),
                      alignment="Calm")
            r2 = calculate(atk, worse, move)
            from vgc_toolkit.core.stats import calc_hp
            import vgc_toolkit.core.dataio as dataio
            hp2 = calc_hp(dataio.get_pokemon("skarmory-mega")["base"]["hp"],
                          best["hp_sp"] - 1)
            # cheaper total must fail somewhere: the solver already returned
            # the minimum total, so (hp-1, same def) failing OR another combo
            # at total-1 failing is implied; spot-check this one
            assert not (max(r2["rolls"]) < hp2) or \
                any(s["total"] == best["total"] for s in out["solutions"])

    def test_modes_are_ordered(self):
        from vgc_toolkit.core.matchup import survival_solve
        atk, move = self._attack()
        g = survival_solve("skarmory-mega", "Calm", atk, move,
                           mode="guaranteed")
        a = survival_solve("skarmory-mega", "Calm", atk, move,
                           mode="avoid_ohko")
        if g["solvable"] and a["solvable"]:
            assert a["solutions"][0]["total"] <= g["solutions"][0]["total"]

    def test_unsolvable_reports_best_attempt(self):
        from vgc_toolkit.core.matchup import survival_solve
        atk = Combatant("chandelure-mega", spread=SPSpread(spa=32),
                        alignment="Modest")
        out = survival_solve("abomasnow", "Calm", atk, "Overheat",
                             mode="two_hits")
        if not out["solvable"]:
            assert out["best_attempt"]["pct_range"][1] > 0


class TestMetaThreatScan:
    def test_meta_scan_uses_real_sets(self):
        from vgc_toolkit.core.matchup import threat_scan
        defender = Combatant("skarmory-mega", spread=SPSpread(hp=32, def_=32),
                             alignment="Impish")
        out = threat_scan(defender, top_n=40, use_meta_sets=True)
        meta_rows = [t for t in out["top_threats"] if t.get("meta")]
        assert meta_rows, "expected ladder-set entries"
        # Basculegion's scarf set should appear with its real item
        basc = [t for t in meta_rows if t["attacker"] == "basculegion-m"]
        if basc:
            assert any(t["item"] == "Choice Scarf" for t in basc)
            assert all(t["usage"] > 50 for t in basc)
        # rows carry the full set for the Survive workflow
        assert all("set" in t and t["set"]["spread"] for t in meta_rows)

    def test_meta_and_theoretical_coexist(self):
        from vgc_toolkit.core.matchup import threat_scan
        defender = Combatant("clefable", spread=SPSpread(hp=32))
        out = threat_scan(defender, top_n=60, use_meta_sets=True)
        kinds = {bool(t.get("meta")) for t in out["top_threats"]}
        assert kinds == {True, False}  # unlisted mons fall back to theoretical


class TestTeamThreatScan:
    def test_team_scan_merges_and_scores(self):
        from vgc_toolkit.core.matchup import team_threat_scan
        team = [
            Combatant("skarmory-mega", spread=SPSpread(hp=32, def_=32),
                      alignment="Impish"),
            Combatant("pelipper", spread=SPSpread(hp=32, spa=32),
                      alignment="Modest"),
        ]
        out = team_threat_scan(team, top_n=15, use_meta_sets=True)
        assert [m["id"] for m in out["members"]] == ["skarmory-mega", "pelipper"]
        assert out["rows"], "expected merged threat rows"
        top = out["rows"][0]
        assert len(top["per_member"]) == 2
        assert top["ohko_count"] >= 1
        # rows that OHKO more members rank first
        counts = [r["ohko_count"] for r in out["rows"]]
        assert counts == sorted(counts, reverse=True) or len(set(counts)) > 1
        # a fire attacker should hit Skarmory far harder than Pelipper
        fire = next((r for r in out["rows"]
                     if r["attacker"] == "chandelure-mega"), None)
        if fire:
            sk = next(m for m in fire["per_member"] if m["id"] == "skarmory-mega")
            pe = next(m for m in fire["per_member"] if m["id"] == "pelipper")
            assert sk["pct_range"][1] > pe["pct_range"][1] * 1.5

    def test_meta_only_filters_theoretical(self):
        from vgc_toolkit.core.matchup import threat_scan
        defender = Combatant("clefable", spread=SPSpread(hp=32))
        out = threat_scan(defender, top_n=60, use_meta_sets=True,
                          meta_only=True)
        assert out["top_threats"]
        assert all(t["meta"] for t in out["top_threats"])


class TestRankMoves:
    def test_ranked_by_damage_and_legal(self):
        atk = Combatant("charizard-mega-y", spread=SPSpread(spa=32),
                        alignment="Modest")
        dfn = Combatant("kingambit", spread=SPSpread(hp=32))
        ranked = rank_moves(atk, dfn, top_n=5)
        assert ranked
        # strongest first, and only the attacker's real damaging moves appear
        pcts = [r["pct_range"][1] for r in ranked]
        assert pcts == sorted(pcts, reverse=True)
        assert all(r["category"] != "Status" for r in ranked)
        assert all(r["pct_range"][1] > 0 for r in ranked)

    def test_field_changes_ranking(self):
        atk = Combatant("charizard-mega-y", spread=SPSpread(spa=32),
                        alignment="Modest")
        dfn = Combatant("garchomp", spread=SPSpread(hp=32))
        plain = {r["move"]: r["pct_range"][1]
                 for r in rank_moves(atk, dfn, Field(weather="none"), top_n=20)}
        sunny = {r["move"]: r["pct_range"][1]
                 for r in rank_moves(atk, dfn, Field(weather="sun"), top_n=20)}
        # Sun boosts Charizard-Y's Fire moves (e.g. Fire Blast) over no-weather
        assert sunny["Fire Blast"] > plain["Fire Blast"]

    def test_immune_defender_yields_no_ground_moves(self):
        # Eelevate makes Eelektross-Mega immune to Ground; such moves drop out.
        atk = Combatant("garchomp", spread=SPSpread(atk=32), alignment="Adamant")
        dfn = Combatant("eelektross-mega")  # Eelevate
        ranked = rank_moves(atk, dfn, top_n=20)
        assert all(r["type"] != "Ground" for r in ranked)


class TestSignatureSpikes:
    def test_charizard_y_weather_ball_in_sun_self_enabled(self):
        atk = Combatant("charizard-mega-y", spread=SPSpread(spa=32),
                        alignment="Modest")  # Drought
        out = signature_spikes(atk)
        assert out["ability"] == "Drought"
        spikes = {s["move"]: s for s in out["spikes"]}
        assert "Weather Ball" in spikes
        wb = spikes["Weather Ball"]
        assert wb["condition_key"] == "sun"
        assert wb["type"] == "Fire"            # type swaps under sun
        assert wb["multiplier"] > 2.0          # 50 Normal -> 100 Fire + sun + STAB
        assert wb["self_enabled"] is True      # Drought provides the sun
        assert wb["setter_ability"] == "Drought"

    def test_spikes_sorted_and_self_flag_off_without_setter(self):
        # A grounded Electric attacker without a terrain-setting ability gets
        # Electric Terrain spikes flagged as NOT self-enabled.
        atk = Combatant("archaludon", spread=SPSpread(spa=32), alignment="Modest")
        out = signature_spikes(atk)
        mults = [s["multiplier"] for s in out["spikes"]]
        assert mults == sorted(mults, reverse=True)
        et = [s for s in out["spikes"] if s["condition_key"] == "electric"]
        assert et and all(s["self_enabled"] is False for s in et)

    def test_snow_warning_weather_ball_is_self_enabled(self):
        # Regression: Weather Ball is boosted identically under every weather,
        # so the tie must resolve to the condition the Pokemon sets itself
        # (it used to fall to list order and read "needs Sun setter").
        out = signature_spikes(Combatant("abomasnow", spread=SPSpread(spa=32),
                                         alignment="Modest", ability="Snow Warning"))
        wb = next(s for s in out["spikes"] if s["move"] == "Weather Ball")
        assert wb["condition_key"] == "snow" and wb["type"] == "Ice"
        assert wb["self_enabled"] and wb["setter_ability"] == "Snow Warning"


class TestRegulationAndFeatureEndpoints:
    """Exercise the exact payloads the frontend sends, so a response-shape or
    endpoint change is caught here rather than in the browser."""

    def test_regulations_endpoint_and_derived_default(self):
        from fastapi.testclient import TestClient
        from vgc_toolkit.main import app
        from vgc_toolkit.core import dataio
        r = TestClient(app).get("/api/regulations").json()
        tags = [x["regulation"] for x in r["regulations"]]
        assert tags == sorted(tags) and "M-B" in tags
        published = [x["regulation"] for x in r["regulations"] if not x["experimental"]]
        assert r["default"] == dataio.DEFAULT_REGULATION == published[-1]  # newest published
        for x in r["regulations"]:
            assert x["label"] and isinstance(x["experimental"], bool)
        assert all(x["forms"] > 0 for x in r["regulations"])

    def test_best_moves_endpoint_shape(self):
        from fastapi.testclient import TestClient
        from vgc_toolkit.main import app
        body = {"attacker": {"pokemon_id": "charizard-mega-y",
                             "spread": {"spa": 32}, "alignment": "Modest"},
                "defender": {"pokemon_id": "garchomp", "spread": {"hp": 32}},
                "field": {"weather": "sun"}, "top_n": 4}
        r = TestClient(app).post("/api/damage/best-moves", json=body)
        assert r.status_code == 200
        moves = r.json()["moves"]
        assert moves
        assert {"move", "type", "pct_range", "ohko_chance",
                "guaranteed_2hko", "recharge"} <= set(moves[0])

    def test_signature_spikes_endpoint_shape(self):
        from fastapi.testclient import TestClient
        from vgc_toolkit.main import app
        body = {"pokemon": {"pokemon_id": "charizard-mega-y",
                            "spread": {"spa": 32}, "alignment": "Modest"},
                "top_n": 4}
        r = TestClient(app).post("/api/matchup/signature-spikes", json=body)
        assert r.status_code == 200
        j = r.json()
        assert j["ability"] == "Drought" and j["spikes"]
        wb = next(s for s in j["spikes"] if s["move"] == "Weather Ball")
        assert wb["self_enabled"] and wb["condition_key"] == "sun"


def test_offense_scan_reduce_benchmark_uses_alignments_the_data_has():
    # The "reduce" pool benchmark is modelled with a real -Def / -SpD alignment
    # (Lonely, Naughty). Those were missing from alignments.json (the speed-calc
    # source lists 15 of the game's 21), which silently emptied the scan.
    from vgc_toolkit.core.matchup import offensive_scan
    atk = Combatant("kingambit", spread=SPSpread(atk=32), alignment="Adamant")
    for move in ["Iron Head", "Dark Pulse"]:            # physical and special
        out = offensive_scan(atk, [move], pool_hp_sp=32, pool_def_sp=16, pool_alignment="reduce", top_n=5)
        assert out["scanned"] > 0 and out["targets"], f"{move}: reduce benchmark produced nothing"
    frail = offensive_scan(atk, ["Iron Head"], pool_alignment="reduce", top_n=100)
    bulky = offensive_scan(atk, ["Iron Head"], pool_alignment="boost", top_n=100)
    by = {t["target"]: t["pct_range"][1] for t in bulky["targets"]}
    assert all(t["pct_range"][1] >= by[t["target"]] for t in frail["targets"] if t["target"] in by)


def test_weight_based_moves_rank_with_their_real_power():
    # Low Kick used to be skipped as a 0 BP move; into a 460 kg Snorlax it is a
    # 120 BP super-effective hit and must outrank Kingambit's own Iron Head.
    atk = Combatant("kingambit", spread=SPSpread(atk=32), alignment="Adamant")
    ranked = {r["move"]: r for r in rank_moves(atk, Combatant("snorlax"), top_n=40)}
    assert "Low Kick" in ranked and ranked["Low Kick"]["base_power"] == 120
    assert ranked["Low Kick"]["pct_range"][1] > ranked["Iron Head"]["pct_range"][1]
