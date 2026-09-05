"""SP-system stat engine for Pokemon Champions.

Champions fixes Level 50 and 31 IVs in every stat. Players allocate SP:
0-32 per stat, 66 total. Each SP is worth 8 EVs, and the standard stat
formula uses floor(EVs / 4), so 1 SP = +2 points in the pre-level term
(equivalently +1 to the final stat at Level 50).

Stat formulas (Level 50, IV 31):
    non-HP: floor( (floor((2*Base + 31 + SP*2) * 50 / 100) + 5) * alignment )
    HP:     floor( (2*Base + 31 + SP*2) * 50 / 100 ) + 50 + 10

Alignments are Champions' natures: +10% to one stat, -10% to another,
never HP. Floor semantics here intentionally mirror the JS engine in
champions-speed-calc so both tools always agree.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, fields

from vgc_toolkit.core import dataio

LEVEL = 50
IV = 31
MAX_SP_PER_STAT = 32
MAX_SP_TOTAL = 66

STAT_KEYS = ("hp", "atk", "def", "spa", "spd", "spe")


class InvalidSpreadError(ValueError):
    """Raised when an SP spread breaks the per-stat or total budget rules."""


@dataclass(frozen=True)
class SPSpread:
    """An SP allocation across the six stats."""

    hp: int = 0
    atk: int = 0
    def_: int = 0  # `def` is a Python keyword
    spa: int = 0
    spd: int = 0
    spe: int = 0

    def __post_init__(self):
        for f in fields(self):
            value = getattr(self, f.name)
            if not isinstance(value, int) or not 0 <= value <= MAX_SP_PER_STAT:
                raise InvalidSpreadError(
                    f"{f.name} SP must be an integer 0-{MAX_SP_PER_STAT}, got {value!r}"
                )
        if self.total > MAX_SP_TOTAL:
            raise InvalidSpreadError(
                f"Total SP {self.total} exceeds budget of {MAX_SP_TOTAL}"
            )

    @property
    def total(self) -> int:
        return self.hp + self.atk + self.def_ + self.spa + self.spd + self.spe

    @property
    def remaining(self) -> int:
        return MAX_SP_TOTAL - self.total

    def as_dict(self) -> dict[str, int]:
        return {
            "hp": self.hp, "atk": self.atk, "def": self.def_,
            "spa": self.spa, "spd": self.spd, "spe": self.spe,
        }

    @classmethod
    def from_dict(cls, d: dict[str, int]) -> "SPSpread":
        return cls(
            hp=d.get("hp", 0), atk=d.get("atk", 0), def_=d.get("def", 0),
            spa=d.get("spa", 0), spd=d.get("spd", 0), spe=d.get("spe", 0),
        )


def alignment_multiplier(alignment: str, stat_key: str) -> float:
    """+10%/-10% multiplier this alignment applies to the given stat (HP is always 1.0)."""
    if stat_key == "hp":
        return 1.0
    alignments = dataio.alignments()
    if alignment not in alignments:
        raise KeyError(f"Unknown alignment: {alignment!r}")
    return alignments[alignment]["multipliers"][stat_key]


def calc_hp(base: int, sp: int) -> int:
    """Final HP at Level 50 with 31 IVs and the given SP."""
    pre_level = 2 * base + IV + math.floor(sp * 8 / 4)
    return math.floor(pre_level * LEVEL / 100) + LEVEL + 10


def calc_stat(base: int, sp: int, alignment_mult: float = 1.0) -> int:
    """Final non-HP stat at Level 50 with 31 IVs, given SP and alignment multiplier."""
    pre_level = 2 * base + IV + math.floor(sp * 8 / 4)
    raw = math.floor(pre_level * LEVEL / 100) + 5
    return math.floor(raw * alignment_mult)


def calc_all_stats(
    base: dict[str, int], spread: SPSpread, alignment: str = "Serious"
) -> dict[str, int]:
    """Compute the full six-stat block for a base-stat dict keyed by STAT_KEYS."""
    sp = spread.as_dict()
    stats = {"hp": calc_hp(base["hp"], sp["hp"])}
    for key in STAT_KEYS[1:]:
        stats[key] = calc_stat(base[key], sp[key], alignment_multiplier(alignment, key))
    return stats


def apply_stage(stat: int, stage: int) -> int:
    """In-battle stat stage multiplier, -6..+6 (standard (2+n)/2 and 2/(2+n) ladders)."""
    if not -6 <= stage <= 6:
        raise ValueError(f"Stat stage must be -6..+6, got {stage}")
    if stage >= 0:
        return math.floor(stat * (2 + stage) / 2)
    return math.floor(stat * 2 / (2 - stage))
