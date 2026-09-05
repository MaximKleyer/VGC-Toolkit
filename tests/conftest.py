"""Suite-wide fixtures."""

import pytest

from vgc_toolkit.core import dataio


@pytest.fixture(autouse=True)
def isolated_ability_overrides(tmp_path, monkeypatch):
    """Point the user ability-override file at a temp path for every test.

    data/ability_overrides.json is user state edited from the UI (provisional
    abilities for unannounced forms). Tests must see the shipped pokedex data
    regardless of what the user has set locally, and must never write to the
    real file.
    """
    monkeypatch.setattr(dataio, "ABILITY_OVERRIDES_PATH",
                        tmp_path / "ability_overrides.json")
    dataio.clear_cache()
    yield
    dataio.clear_cache()
