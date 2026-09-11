"""Tests for the move database and learnset layer (Phase 2a)."""

import pytest

from vgc_toolkit.core import dataio


class TestMoves:
    def test_universe_size_and_all_defined(self):
        moves = dataio.moves()
        # 496 from Champions learnsets + Drum Beating and Glaive Rush (M-C signatures)
        # + the six signature moves of the Reg M-C Experimental predictions
        assert len(moves) == 511
        assert not any(m.get("needs_definition") for m in moves.values())

    def test_move_spot_checks(self):
        air_slash = dataio.get_move("Air Slash")
        assert (air_slash["type"], air_slash["category"], air_slash["base_power"]) == \
            ("Flying", "Special", 75)
        kowtow = dataio.get_move("Kowtow Cleave")
        assert (kowtow["type"], kowtow["category"], kowtow["base_power"]) == \
            ("Dark", "Physical", 85)

    def test_every_move_has_damage_fields(self):
        for move in dataio.moves().values():
            assert move["category"] in ("Physical", "Special", "Status")
            assert move["type"] in dataio.type_chart()
            assert isinstance(move["base_power"], int)
            assert isinstance(move["priority"], int)

    def test_unknown_move_raises(self):
        with pytest.raises(KeyError):
            dataio.get_move("Splashy Splash")


class TestLearnsets:
    def test_counts(self):
        # 233 M-B species + the 27 species Regulation M-C added (provisional learnsets)
        assert len(dataio.learnsets()) == 260

    def test_known_learnset_facts(self):
        assert "Kowtow Cleave" in dataio.get_learnset("kingambit")["moves"]
        chz = dataio.get_learnset("charizard")["moves"]
        assert "Air Slash" in chz and "Heat Wave" in chz
        assert len(chz) == 73          # + Slash, usable again since Regulation M-C

    def test_megas_share_base_learnset(self):
        assert dataio.get_learnset("dragonite-mega") == dataio.get_learnset("dragonite")
        assert dataio.get_learnset("skarmory-mega") == dataio.get_learnset("skarmory")

    def test_missing_learnset_raises(self):
        # Amoonguss was pruned from the roster in M-B; no longer a known id.
        with pytest.raises(KeyError):
            dataio.get_learnset("amoonguss")

    def test_every_learnset_move_exists_in_move_db(self):
        move_db = dataio.moves()
        for ls in dataio.learnsets().values():
            for m in ls["moves"]:
                assert m in move_db


class TestLearnsetAPI:
    @pytest.fixture()
    def client(self):
        from fastapi.testclient import TestClient
        from vgc_toolkit.main import app
        return TestClient(app)

    def test_learnset_endpoint_resolves_mega(self, client):
        resp = client.get("/api/pokemon/dragonite-mega/learnset")
        assert resp.status_code == 200
        moves = resp.json()["moves"]
        assert any(m["name"] == "Draco Meteor" for m in moves)
        # full move objects, not just names
        assert all("category" in m for m in moves)

    def test_learnset_endpoint_404_for_unfilled(self, client):
        assert client.get("/api/pokemon/amoonguss/learnset").status_code == 404

    def test_moves_endpoint(self, client):
        resp = client.get("/api/moves/Kowtow%20Cleave")
        assert resp.status_code == 200
        assert resp.json()["base_power"] == 85
