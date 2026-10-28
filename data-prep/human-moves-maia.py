# The Maia2 baseline for data-prep/human-moves.ts: a neural network trained on Lichess games to
# predict the move a human of a given rating plays (https://github.com/CSSLab/maia2). It appends
# two sources to <dir>/guesses.jsonl: "maia2" is given the mover's real rating, which the Claude
# models never see; "maia2-1500" is given 1500 for everyone, a fairer match for an unprompted guess.
#
# Setup, in a folder outside the repo (the package downloads its weights from the authors' Google Drive):
#   uv venv -p 3.12 .venv && uv pip install -p .venv/bin/python \
#     --index-strategy unsafe-best-match --extra-index-url https://download.pytorch.org/whl/cpu torch maia2
# Usage: .venv/bin/python -I data-prep/human-moves-maia.py <dir> [<weights dir>]
import json
import os
import sys

from maia2 import inference, model

run_dir = sys.argv[1]
weights = sys.argv[2] if len(sys.argv) > 2 else os.path.join(run_dir, "maia2_models")
samples = json.load(open(os.path.join(run_dir, "samples.json")))
maia = model.from_pretrained(type="blitz", device="cpu", save_root=weights)
prepared = inference.prepare()

with open(os.path.join(run_dir, "guesses.jsonl"), "a") as out:
    for s in samples:
        for source, elo, opp in (("maia2", s["elo"], s["oppElo"]), ("maia2-1500", 1500, 1500)):
            probs, _ = inference.inference_each(maia, prepared, s["fen"], elo, opp)
            moves = sorted(probs, key=probs.get, reverse=True)[:3]
            out.write(json.dumps({"id": s["id"], "source": source, "raw": moves, "moves": moves, "illegal": []}) + "\n")
print(f"Maia2 guesses written for {len(samples)} positions", file=sys.stderr)
