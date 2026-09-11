from vgc_toolkit.core import team_preview as tp


def _rain_team():
    return [
        {"pokemon_id": "pelipper", "spread": {"hp": 2, "spa": 32, "spe": 32},
         "alignment": "Modest", "ability": "Drizzle", "item": "Focus Sash",
         "moves": ["Hurricane", "Weather Ball", "Tailwind", "Protect"]},
        {"pokemon_id": "basculegion-m",
         "spread": {"atk": 32, "spe": 32, "def": 2}, "alignment": "Adamant",
         "ability": "Swift Swim", "item": "Choice Scarf",
         "moves": ["Wave Crash", "Last Respects", "Aqua Jet", "Protect"]},
        {"pokemon_id": "skarmory-mega",
         "spread": {"hp": 2, "atk": 32, "spe": 32}, "alignment": "Jolly",
         "ability": "Stalwart", "item": "Skarmorite",
         "moves": ["Iron Head", "Brave Bird", "Swords Dance", "Protect"]},
        {"pokemon_id": "incineroar", "spread": {"hp": 32, "atk": 4, "spd": 30},
         "alignment": "Careful", "ability": "Intimidate", "item": "Safety Goggles",
         "moves": ["Fake Out", "Flare Blitz", "Knock Off", "Parting Shot"]},
        {"pokemon_id": "starmie", "spread": {"hp": 32, "spa": 32, "spe": 2},
         "alignment": "Modest", "ability": "Analytic", "item": "Sitrus Berry",
         "moves": ["Hydro Pump", "Thunderbolt", "Ice Beam", "Protect"]},
        {"pokemon_id": "garchomp", "spread": {"atk": 32, "spe": 32},
         "alignment": "Jolly", "ability": "Rough Skin", "item": "Life Orb",
         "moves": ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"]},
    ]


def _opp():
    return [{"pokemon_id": p} for p in
            ["sinistcha", "kingambit", "garchomp", "incineroar",
             "sneasler", "dragonite"]]


class TestTeamPreview:
    def test_shape_and_field_detection(self):
        out = tp.team_preview(_rain_team(), _opp())
        # Pelipper's Drizzle should be auto-detected as the field
        assert out["field"]["weather"] == "rain"
        assert "Pelipper" in (out["field"]["source"] or "")
        m = out["matrix"]
        assert len(m["rows"]) == 6 and len(m["cols"]) == 6
        assert len(m["cells"]) == 6 and len(m["cells"][0]) == 6
        assert out["summary"]

    def test_opponent_leads_scored_and_ranked(self):
        out = tp.team_preview(_rain_team(), _opp())
        mons = out["opponent"]["mons"]
        assert len(mons) == 6
        pct_sum = sum(m["lead_pct"] for m in mons)
        assert 99 <= pct_sum <= 101                      # normalised
        # Incineroar (Fake Out + Intimidate) should out-rank a bare attacker
        inc = next(m for m in mons if m["id"] == "incineroar")
        chomp = next(m for m in mons if m["id"] == "garchomp")
        assert inc["lead_pct"] >= chomp["lead_pct"]
        assert any("Fake Out" in r for r in inc["lead_reasons"])
        assert out["opponent"]["projected_lead"]["pair"]

    def test_your_leads_and_bring_four(self):
        out = tp.team_preview(_rain_team(), _opp())
        assert len(out["your_leads"]) == 3
        top = out["your_leads"][0]
        assert len(top["pair"]) == 2 and top["pair"][0] != top["pair"][1]
        assert len(out["bring_four"]) == 3          # three options, each with its rationale
        four = out["bring_four"][0]
        assert len(four["mons"]) == 4
        assert len(four["bench"]) == 2
        assert set(four["lead"]) <= set(four["mons"])     # lead is within the 4

    def test_meta_sets_resolve_opponent_builds(self):
        out = tp.team_preview(_rain_team(), _opp())
        cha = next(m for m in out["opponent"]["mons"]
                   if m["id"] == "sinistcha")
        assert cha["meta"] is True
        assert cha["usage"] and cha["usage"] > 20
        assert cha["set"]["moves"]

    def test_unknown_opponent_falls_back(self):
        out = tp.team_preview(
            _rain_team(),
            [{"pokemon_id": "pelipper"}, {"pokemon_id": "arbok"}])
        luv = next((m for m in out["opponent"]["mons"]
                    if m["id"] == "arbok"), None)
        assert luv is not None
        if luv:
            assert luv["meta"] is False
            assert luv["set_name"] == "assumed max-offense"

    def test_neutral_vs_rain_changes_matrix(self):
        team = _rain_team()
        rain = tp.team_preview(team, _opp(),
                               field={"weather": "rain", "terrain": "none"})
        neutral = tp.team_preview(team, _opp(),
                                  field={"weather": "none", "terrain": "none"})
        # Basculegion's water damage should read higher under rain somewhere
        basc_row_rain = rain["matrix"]["rows"].index("basculegion-m")
        basc_row_neu = neutral["matrix"]["rows"].index("basculegion-m")
        rain_max = max(c["my_pct"] for c in rain["matrix"]["cells"][basc_row_rain])
        neu_max = max(c["my_pct"] for c in neutral["matrix"]["cells"][basc_row_neu])
        assert rain_max >= neu_max


def _two_mega_team():
    team = _rain_team()
    # Garchomp holding its stone counts as a Mega slot, like the Mega Skarmory form.
    team[5] = {**team[5], "item": "Garchompite"}
    return team


class TestMegaRuleAndReasons:
    def test_only_one_mega_in_any_four_or_lead(self):
        out = tp.team_preview(_two_mega_team(), _opp())
        assert set(out["my_megas"]) == {"Mega Skarmory", "Garchomp"}
        for b in out["bring_four"]:
            megas = [m for m in b["mons"] if m in ("skarmory-mega", "garchomp")]
            assert len(megas) <= 1, b["mons"]
            assert b["mega"] in (None, "Mega Skarmory", "Garchomp")
        for lo in out["your_leads"]:
            assert not {"skarmory-mega", "garchomp"} <= set(lo["pair"]), lo["pair"]
        # a four that carries a Mega says which one, and who stays home
        with_mega = next(b for b in out["bring_four"] if b["mega"])
        assert any(w.startswith("Mega: ") and "stays home" in w for w in with_mega["why"])

    def test_bring_four_explains_answers_and_speed_control(self):
        out = tp.team_preview(_rain_team(), _opp())
        b = out["bring_four"][0]
        assert b["why"] and b["why"][0].startswith("Two answers to ")
        assert set(b["answers"]) == {m["name"] for m in out["opponent"]["mons"]}
        for name, ans in b["answers"].items():
            for a in ans:
                assert a["mon"] in b["mon_names"] and a["pct"] > 0, (name, a)
        assert any(w.startswith("Speed control") or w.startswith("No speed control") for w in b["why"])

    def test_lead_reasons_name_speed_and_ohkos(self):
        out = tp.team_preview(_rain_team(), _opp())
        lo = out["your_leads"][0]
        assert isinstance(lo["why"], list) and lo["why"]
        assert any("outspeeds" in w or "slower than" in w or "OHKOs" in w for w in lo["why"])

    def test_single_mega_team_is_unaffected(self):
        out = tp.team_preview(_rain_team(), _opp())
        assert out["my_megas"] == ["Mega Skarmory"]
        assert len(out["bring_four"]) == 3
