# Prototype, not the app: exports the Maia2 blitz model (see data-prep/human-moves-maia.py) to ONNX,
# so the Node backend could run it with onnxruntime-node instead of Python and PyTorch. Writes:
#   <out>/maia2-blitz.onnx         the network (float32; --fp16 also writes maia2-blitz-fp16.onnx)
#   <out>/maia2-moves.json         Maia2's move list: output index -> move, from White's side
#   <out>/maia2-python-top3.json   Python's top three for each position in <dir>/samples.json, to check Node against
#
# Usage, from the Maia2 venv: .venv/bin/python -I data-prep/maia2-onnx-export.py <dir> <weights dir> <out>
import json
import os
import sys
import time

import chess
import torch
from maia2 import inference, model
from maia2.utils import mirror_move

run_dir, weights, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)
maia = model.from_pretrained(type="blitz", device="cpu", save_root=weights).eval()
all_moves_dict, elo_dict, reversed_moves = inference.prepare()

boards = torch.zeros((1, 18, 8, 8), dtype=torch.float32)
elos = torch.zeros((1,), dtype=torch.long)
path = os.path.join(out, "maia2-blitz.onnx")
torch.onnx.export(
    maia,
    (boards, elos, elos),
    path,
    input_names=["boards", "elos_self", "elos_oppo"],
    output_names=["logits_maia", "logits_side_info", "logits_value"],
    dynamic_axes={"boards": {0: "n"}, "elos_self": {0: "n"}, "elos_oppo": {0: "n"}, "logits_maia": {0: "n"}, "logits_side_info": {0: "n"}, "logits_value": {0: "n"}},
    opset_version=17,
    dynamo=False,
)
print(f"{path}: {os.path.getsize(path) / 1e6:.1f} MB", file=sys.stderr)
if "--fp16" in sys.argv:
    half = os.path.join(out, "maia2-blitz-fp16.onnx")
    torch.onnx.export(maia.half(), (boards.half(), elos, elos), half, input_names=["boards", "elos_self", "elos_oppo"],
                      output_names=["logits_maia", "logits_side_info", "logits_value"],
                      dynamic_axes={"boards": {0: "n"}, "elos_self": {0: "n"}, "elos_oppo": {0: "n"}}, opset_version=17, dynamo=False)
    maia.float()
    print(f"{half}: {os.path.getsize(half) / 1e6:.1f} MB", file=sys.stderr)

json.dump([reversed_moves[i] for i in range(len(reversed_moves))], open(os.path.join(out, "maia2-moves.json"), "w"))

# The same ranking as data-prep/human-moves-maia.py: legal moves by the model's score.
def python_top3(fen, elo_self, elo_oppo):
    board_input, self_cat, oppo_cat, _ = inference.preprocessing(fen, elo_self, elo_oppo, elo_dict, all_moves_dict)
    with torch.no_grad():
        logits, _, _ = maia(board_input.unsqueeze(0), torch.tensor([self_cat]), torch.tensor([oppo_cat]))
    board = chess.Board(fen)
    black = board.turn == chess.BLACK
    scored = [(logits[0, all_moves_dict[mirror_move(m.uci()) if black else m.uci()]].item(), m.uci()) for m in board.legal_moves]
    return [uci for _, uci in sorted(scored, reverse=True)[:3]]


samples = json.load(open(os.path.join(run_dir, "samples.json")))
top3 = {}
started = time.time()
for s in samples:
    top3[s["id"]] = python_top3(s["fen"], s["elo"], s["oppElo"])
per = (time.time() - started) / len(samples)
json.dump(top3, open(os.path.join(out, "maia2-python-top3.json"), "w"))
print(f"Python top three for {len(samples)} positions, {per * 1000:.0f} ms per position", file=sys.stderr)
