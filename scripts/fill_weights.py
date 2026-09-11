"""Fill in ``weight_kg`` for every form in pokedex.json.

Weights drive Low Kick / Grass Knot (target weight) and Heavy Slam / Heat Crash
(user-to-target ratio) in the damage engine, so the Team Builder's analysis,
the Damage Calc and the threat scans can rank those moves for real. The source
is the pokemon-showdown engine the Battle tab already runs on: its ``champions``
mod carries the datamined weights of the Champions-new megas. It is read
through ``sim/node_modules``; ``--weights`` accepts a prepared ``{id: kg}`` dump
instead.

Additive and idempotent: only forms with no weight are written. Forms whose
recorded weight differs from the engine's are reported, and replaced only with
``--force``.

Usage:  python scripts/fill_weights.py [--dry-run] [--force] [--weights dump.json]
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "vgc_toolkit" / "data"
SIM = ROOT / "sim"

# Toolkit ids whose engine id is not simply the dashes removed.
ALIASES = {
    "meowstic-m": "meowstic", "basculegion-m": "basculegion", "lycanroc-day": "lycanroc",
    "lycanroc-night": "lycanrocmidnight", "palafin-zero": "palafin",
}
DUMP_JS = (
    "const ps = require('pokemon-showdown'); const dex = ps.Dex.mod('champions'); const out = {};"
    "for (const s of dex.species.all()) if (s.exists && s.weightkg) out[s.id] = s.weightkg;"
    "console.log(JSON.stringify(out));"
)


def to_id(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def engine_weights(dump: Path | None) -> dict[str, float]:
    if dump:
        raw = json.loads(dump.read_text(encoding="utf-8"))
    else:
        if not (SIM / "node_modules" / "pokemon-showdown").exists():
            sys.exit("pokemon-showdown is not installed: run `npm install` in sim/ (or pass --weights)")
        r = subprocess.run(["node", "-e", DUMP_JS], cwd=SIM, capture_output=True, text=True, check=True)
        raw = json.loads(r.stdout)
    return {k: (v["weightkg"] if isinstance(v, dict) else v) for k, v in raw.items()}


def engine_id(pid: str, weights: dict) -> str | None:
    for cand in (ALIASES.get(pid), to_id(pid), to_id(pid).replace("eternal", "")):
        if cand and cand in weights:
            return cand
    return None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="also replace weights that differ from the engine's")
    ap.add_argument("--weights", type=Path, help="prepared {engine id: kg} dump instead of reading sim/")
    args = ap.parse_args()

    weights = engine_weights(args.weights)
    path = DATA / "pokedex.json"
    dex = json.loads(path.read_text(encoding="utf-8"))
    filled, replaced, differs, missing = [], [], [], []
    for pid, mon in dex.items():
        eid = engine_id(pid, weights)
        if eid is None:
            missing.append(pid)
            continue
        w = weights[eid]
        have = mon.get("weight_kg")
        if not have:
            mon["weight_kg"] = w
            filled.append(pid)
        elif have != w:
            if args.force:
                mon["weight_kg"] = w
                replaced.append(pid)
            else:
                differs.append(f"{pid} ({have} vs engine {w})")
    print(f"{len(dex)} forms: {len(filled)} filled, {len(replaced)} replaced, "
          f"{len(dex) - len(filled) - len(replaced) - len(missing)} already set")
    if differs:
        print("kept (differ from the engine; --force to replace): " + ", ".join(differs))
    if missing:
        print("no engine weight for: " + ", ".join(missing))
    if not (filled or replaced):
        print("nothing to write")
        return
    if args.dry_run:
        print("dry run: nothing written")
        return
    path.write_text(json.dumps(dex, indent=1) + "\n")
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
