# The Maia2 baseline for data-prep/human-moves.ts: a neural network trained on Lichess games to
# predict the move a human of a given rating plays (https://github.com/CSSLab/maia2). It appends
# two sources to <dir>/guesses.jsonl: "maia2" is given the mover's real rating, which the Claude
# models never see; "maia2-1500" is given 1500 for everyone, a fairer match for an unprompted guess.
#
# It ranks the legal moves by the model's own scores rather than using maia2's inference_each,
# which flattens a (1, n) index tensor and so lists the move at index 0 ("a1h8", or "a8h1" for
# Black) among the legal moves, and rounds probabilities to four places.
#
# Setup, in a folder outside the repo (the package downloads its weights from the authors' Google Drive):
#   uv venv -p 3.12 .venv && uv pip install -p .venv/bin/python \
#     --index-strategy unsafe-best-match --extra-index-url https://download.pytorch.org/whl/cpu \
#     torch maia2 chess einops gdown numpy pandas pyzstd requests tqdm pyyaml
# Usage: .venv/bin/python -I data-prep/human-moves-maia.py <dir> [<weights dir>]
import json
import os
import sys

import chess
import torch
from maia2 import inference, model
from maia2.utils import mirror_move

run_dir = sys.argv[1]
weights = sys.argv[2] if len(sys.argv) > 2 else os.path.join(run_dir, "maia2_models")
samples = json.load(open(os.path.join(run_dir, "samples.json")))
maia = model.from_pretrained(type="blitz", device="cpu", save_root=weights).eval()
all_moves_dict, elo_dict, _ = inference.prepare()


def top3(fen, elo_self, elo_oppo):
    board_input, self_cat, oppo_cat, _ = inference.preprocessing(fen, elo_self, elo_oppo, elo_dict, all_moves_dict)
    with torch.no_grad():
        logits, _, _ = maia(board_input.unsqueeze(0), torch.tensor([self_cat]), torch.tensor([oppo_cat]))
    board = chess.Board(fen)
    black = board.turn == chess.BLACK
    scored = []
    for move in board.legal_moves:
        key = mirror_move(move.uci()) if black else move.uci()
        if key in all_moves_dict:
            scored.append((logits[0, all_moves_dict[key]].item(), move.uci()))
    return [uci for _, uci in sorted(scored, reverse=True)[:3]]


with open(os.path.join(run_dir, "guesses.jsonl"), "a") as out:
    for s in samples:
        for source, elo, opp in (("maia2", s["elo"], s["oppElo"]), ("maia2-1500", 1500, 1500)):
            moves = top3(s["fen"], elo, opp)
            out.write(json.dumps({"id": s["id"], "source": source, "raw": moves, "moves": moves, "illegal": []}) + "\n")
print(f"Maia2 guesses written for {len(samples)} positions", file=sys.stderr)
