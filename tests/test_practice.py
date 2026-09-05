"""Practice-bot opponent teams (vgc_toolkit.core.practice + /api/meta/random-team)."""

import pytest
from fastapi.testclient import TestClient

from vgc_toolkit.core import dataio, practice, teams
from vgc_toolkit.main import app


class TestRandomMetaTeam:
    def test_six_legal_members_with_species_and_item_clauses(self):
        members = practice.random_meta_team("M-B", size=6, seed=1)
        assert len(members) == 6
        roots = [teams.species_root(m.combatant.pokemon_id) for m in members]
        assert len(set(roots)) == 6                       # species clause
        items = [m.combatant.item for m in members if m.combatant.item]
        assert len(set(items)) == len(items)              # Item Clause = 1
        for m in members:
            assert 1 <= len(m.moves) <= 4
            assert "M-B" in dataio.get_pokemon(m.combatant.pokemon_id)["regulations"]
        # Every member is a legal M-B build according to the toolkit's validator.
        assert teams.validate_team(members, "M-B")["valid"], teams.validate_team(members, "M-B")

    def test_seed_is_deterministic_and_usage_weighted(self):
        a = [m.combatant.pokemon_id for m in practice.random_meta_team("M-B", seed=42)]
        b = [m.combatant.pokemon_id for m in practice.random_meta_team("M-B", seed=42)]
        assert a == b
        # Across many rolls the most-used Pokemon shows up far more than a fringe one.
        counts = {}
        for s in range(60):
            for m in practice.random_meta_team("M-B", seed=s):
                counts[m.combatant.pokemon_id] = counts.get(m.combatant.pokemon_id, 0) + 1
        top = max(dataio.meta_sets()["pokemon"].items(), key=lambda kv: kv[1]["usage"])[0]
        assert counts.get(top, 0) >= 20

    def test_paste_round_trips_through_the_importer(self):
        members = practice.random_meta_team("M-B", seed=3)
        paste = teams.export_paste(members)
        back = teams.import_paste(paste)
        assert [m.combatant.pokemon_id for m in back] == [m.combatant.pokemon_id for m in members]
        assert [m.moves for m in back] == [m.moves for m in members]

    def test_endpoint_shape(self):
        r = TestClient(app).get("/api/meta/random-team", params={"regulation": "M-B", "seed": 5})
        assert r.status_code == 200
        body = r.json()
        assert body["paste"].count("Level: 50") == 6
        assert len(body["members"]) == 6
        assert {"pokemon_id", "name", "item", "ability", "alignment", "spread", "moves"} <= set(body["members"][0])

    def test_unknown_regulation_is_a_404(self):
        assert TestClient(app).get("/api/meta/random-team", params={"regulation": "M-Z"}).status_code == 404


class TestCoherentTeams:
    def test_meta_sets_carry_teammates(self):
        meta = dataio.meta_sets()["pokemon"]
        top = max(meta.items(), key=lambda kv: kv[1]["usage"])[1]
        assert top.get("teammates"), "ingest should keep chaos Teammates"
        assert all(t["pokemon_id"] in meta for t in top["teammates"])

    def test_members_are_real_ladder_partners_of_the_seed(self):
        meta = dataio.meta_sets()["pokemon"]
        hits = 0
        for s in range(20):
            members = practice.random_meta_team("M-B", seed=s)
            seed_id = members[0].combatant.pokemon_id
            mates = {t["pokemon_id"] for t in meta[seed_id].get("teammates", [])}
            hits += sum(1 for m in members[1:] if m.combatant.pokemon_id in mates)
        # 20 teams x 5 partners; a coherent builder should land most of them.
        assert hits >= 60

    def test_incoherent_mode_still_builds_legal_teams(self):
        members = practice.random_meta_team("M-B", seed=9, coherent=False)
        assert len(members) == 6 and teams.validate_team(members, "M-B")["valid"]
