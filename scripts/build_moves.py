"""Build moves.json: the Champions move database.

Two-layer build:
  1. BASELINE — full Gen 9 move definitions dumped from @pkmn/dex
     (run `node scripts/dump_gen9_moves.mjs > gen9_moves.json` first;
     requires `npm install @pkmn/dex` once).
  2. OVERLAY — Champions-specific changes from RoiDadadou's comparative doc
     (New Moves / Move Ch. / Moves Deleted tabs), supplied as
     champions_move_overrides.json when available.

The move universe is scoped to moves that actually appear in learnsets.json,
plus anything defined in the overlay. Moves in learnsets with no baseline
definition are emitted as stubs with needs_definition=true so gaps are
visible instead of silent.

Usage:
    python scripts/build_moves.py --baseline gen9_moves.json \
        [--overrides champions_move_overrides.json]
"""

import argparse
import json
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "vgc_toolkit" / "data"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True, help="gen9_moves.json from dump_gen9_moves.mjs")
    parser.add_argument("--overrides", help="Champions overlay JSON (optional until tabs are sourced)")
    args = parser.parse_args()

    baseline = json.loads(Path(args.baseline).read_text())
    learnsets = json.loads((OUT_DIR / "learnsets.json").read_text())
    universe = sorted({m for ls in learnsets.values() for m in ls["moves"]})

    overrides = {"new_moves": {}, "changed": {}, "deleted": []}
    if args.overrides:
        overrides.update(json.loads(Path(args.overrides).read_text()))

    moves, stubs = {}, []
    for name in universe:
        if name in overrides["deleted"]:
            continue
        if name in baseline:
            move = dict(baseline[name])
            move["source"] = "gen9_baseline"
        elif name in overrides["new_moves"]:
            move = dict(overrides["new_moves"][name])
            move["source"] = "champions_new"
        else:
            move = {"name": name, "needs_definition": True, "source": "unknown"}
            stubs.append(name)
        if name in overrides["changed"]:
            move.update(overrides["changed"][name])
            move["source"] = move.get("source", "") + "+champions_patch"
        moves[name] = move

    # Overlay-defined new moves that aren't in any learnset yet still belong.
    for name, spec in overrides["new_moves"].items():
        if name not in moves:
            moves[name] = {**spec, "source": "champions_new"}

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "moves.json").write_text(json.dumps(moves, indent=2))

    defined = sum(1 for m in moves.values() if not m.get("needs_definition"))
    print(f"moves.json: {len(moves)} moves ({defined} defined, {len(stubs)} stubs)")
    if stubs:
        print(f"  needs definition (likely Champions-new or renamed): {stubs}")


if __name__ == "__main__":
    main()
