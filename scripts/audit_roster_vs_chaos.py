"""Cross-check the pokedex against Smogon chaos usage data.

Flags any Pokemon with real ladder usage that our data calls illegal,
missing, or learnset-less — catches roster gaps (e.g. forme rows the
roster sheet collapsed) at every regulation switch.

Usage: python scripts/audit_roster_vs_chaos.py CHAOS_FILE [--min-usage 0.1]
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scripts.ingest_meta_sets import map_pokemon  # noqa: E402
from vgc_toolkit.core import dataio  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("chaos", type=Path)
ap.add_argument("--min-usage", type=float, default=0.1)
ap.add_argument("--regulation", default="M-A")
a = ap.parse_args()

dex = dataio.pokedex()
data = json.loads(a.chaos.read_text())["data"]
issues = 0
for name, st in sorted(data.items(), key=lambda kv: -kv[1]["usage"]):
    usage = st["usage"] * 100
    if usage < a.min_usage:
        continue
    pid = map_pokemon(name, dex)
    if pid is None:
        print(f"MISSING FROM DEX   {name:24s} {usage:5.2f}%")
        issues += 1
        continue
    if a.regulation not in dex[pid].get("regulations", []):
        print(f"NOT {a.regulation} LEGAL    {name:24s} {usage:5.2f}%  ({pid})")
        issues += 1
    try:
        dataio.get_learnset(pid)
    except KeyError:
        print(f"NO LEARNSET        {name:24s} {usage:5.2f}%  ({pid})")
        issues += 1
print(f"--- {issues} issue(s)" if issues else "--- roster clean")
raise SystemExit(1 if issues else 0)
