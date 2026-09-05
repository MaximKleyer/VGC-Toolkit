"""Speed tier engine tests."""

from vgc_toolkit.core.speed import SpeedField, effective_speed, speed_tiers
from vgc_toolkit.core.damage import Combatant
from vgc_toolkit.core.stats import SPSpread


class TestEffectiveSpeed:
    def test_baseline_matches_speed_calc(self):
        # Dragapult base 142, 32 SP Timid -> 213 (externally verified value)
        c = Combatant("dragapult", spread=SPSpread(spe=32), alignment="Timid")
        assert effective_speed(c, SpeedField())["speed"] == 213

    def test_swift_swim_in_rain(self):
        c = Combatant("politoed", spread=SPSpread(spe=32), alignment="Timid",
                      ability="Swift Swim")
        dry = effective_speed(c, SpeedField())
        wet = effective_speed(c, SpeedField(weather="rain"))
        assert wet["speed"] == dry["speed"] * 2
        assert any("Swift Swim" in a for a in wet["applied"])

    def test_scarf_and_tailwind_and_para_order(self):
        c = Combatant("kingambit", spread=SPSpread(spe=32),
                      item="Choice Scarf", status="paralysis")
        eff = effective_speed(c, SpeedField(tailwind=True), tailwind_applies=True)
        base = effective_speed(
            Combatant("kingambit", spread=SPSpread(spe=32)), SpeedField())["speed"]
        import math
        expected = math.floor(math.floor(math.floor(base * 1.5) * 2) * 0.5)
        assert eff["speed"] == expected
        assert len(eff["applied"]) == 3


class TestTiers:
    def test_team_rows_merged_and_sorted(self):
        team = [Combatant("politoed", spread=SPSpread(spe=4), alignment="Calm",
                          ability="Drizzle")]
        out = speed_tiers(team, SpeedField())
        speeds = [r["speed"] for r in out["rows"]]
        assert speeds == sorted(speeds, reverse=True)
        mine = [r for r in out["rows"] if r["is_team"]]
        assert len(mine) == 1 and mine[0]["id"] == "politoed"
        # the pool must not also contain politoed
        assert sum(1 for r in out["rows"] if r["id"] == "politoed") == 1

    def test_rain_ladder_boosts_swift_swimmers(self):
        dry = {r["id"]: r["speed"] for r in speed_tiers([], SpeedField())["rows"]}
        wet = {r["id"]: r["speed"] for r in
               speed_tiers([], SpeedField(weather="rain"))["rows"]}
        boosted = [pid for pid in dry if wet[pid] == dry[pid] * 2]
        assert len(boosted) > 0  # rain ladder shows Swift Swim doubled

    def test_trick_room_reverses(self):
        out = speed_tiers([], SpeedField(trick_room=True))
        speeds = [r["speed"] for r in out["rows"]]
        assert speeds == sorted(speeds)


class TestPoolBenchmark:
    def test_trick_room_benchmark(self):
        from vgc_toolkit.core.speed import PoolBenchmark
        from vgc_toolkit.core import dataio, stats
        out = speed_tiers([], SpeedField(trick_room=True),
                          pool=PoolBenchmark(sp=0, alignment="reduce"))
        row = next(r for r in out["rows"] if r["id"] == "dragapult")
        assert row["speed"] == stats.calc_stat(142, 0, 0.9)
        assert row["detail"] == "0 SP -Spe"
        speeds = [r["speed"] for r in out["rows"]]
        assert speeds == sorted(speeds)  # slowest first

    def test_opposing_tailwind_hits_pool_not_team(self):
        team = [Combatant("politoed", spread=SPSpread(spe=4))]
        plain = speed_tiers(team, SpeedField())
        opp = speed_tiers(team, SpeedField(opposing_tailwind=True))
        pool_plain = {r["id"]: r["speed"] for r in plain["rows"] if not r["is_team"]}
        pool_opp = {r["id"]: r["speed"] for r in opp["rows"] if not r["is_team"]}
        assert all(pool_opp[k] == pool_plain[k] * 2 for k in pool_plain)
        mine = lambda o: next(r["speed"] for r in o["rows"] if r["is_team"])
        assert mine(opp) == mine(plain)


class TestSpeedItems:
    def test_iron_ball_halves_speed(self):
        import math
        base = effective_speed(Combatant("garchomp", spread=SPSpread(spe=32)), SpeedField())["speed"]
        ball = effective_speed(Combatant("garchomp", spread=SPSpread(spe=32), item="Iron Ball"),
                               SpeedField())
        assert ball["speed"] == math.floor(base * 0.5)
        assert any("Iron Ball" in a for a in ball["applied"])
