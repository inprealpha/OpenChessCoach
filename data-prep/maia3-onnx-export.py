# Prototype, not the app: exports a Maia-3 model (see data-prep/human-moves-maia3.py) to ONNX, so
# the Node backend could run it with onnxruntime instead of Python and PyTorch. Writes:
#   <out>/maia3-<size>.onnx              the network: tokens (n, 64, 97) float, self_elos and oppo_elos (n) int64
#   <out>/maia3-<size>-python-top3.json  Python's top three for each position in <dir>/samples.json, to check Node against
#
# Usage, from the Maia-3 venv: .venv/bin/python -I data-prep/maia3-onnx-export.py <dir> <out> [--model=5m]
import json
import os
import sys
import time
from collections import deque

import chess
import torch
from maia3.dataset import get_legal_moves_mask, tokenize_board
from maia3.uci import Maia3UCIEngine, parse_args
from maia3.utils import mirror_move

run_dir, out = sys.argv[1], sys.argv[2]
size = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--model=")), "5m")
os.makedirs(out, exist_ok=True)
cfg = parse_args(["--model", f"maia3-{size}", "--device", "cpu", "--no-use-amp", "--use-uci-history"])
engine = Maia3UCIEngine(cfg)
engine.ensure_model_loaded()
model = engine.model.eval()


class Moves(torch.nn.Module):
    """Only the move scores, so the file holds no unused outputs."""

    def __init__(self, inner):
        super().__init__()
        self.inner = inner

    def forward(self, tokens, self_elos, oppo_elos):
        return self.inner(tokens, self_elos, oppo_elos)[0]


class PlainRMSNorm(torch.nn.Module):
    """torch.nn.RMSNorm written out in basic operations, which the ONNX exporter knows; same result."""

    def __init__(self, norm):
        super().__init__()
        self.weight, self.eps = norm.weight, norm.eps if norm.eps is not None else torch.finfo(torch.float32).eps

    def forward(self, x):
        y = x * torch.rsqrt(x.pow(2).mean(dim=-1, keepdim=True) + self.eps)
        return y * self.weight if self.weight is not None else y


def plain_norms(module):
    for name, child in module.named_children():
        if isinstance(child, torch.nn.RMSNorm):
            setattr(module, name, PlainRMSNorm(child))
        else:
            plain_norms(child)


plain_norms(model)
width = 12 * cfg.history + 1  # 8 positions × 12 piece planes, then the think-time column the model ignores
path = os.path.join(out, f"maia3-{size}.onnx")
torch.onnx.export(
    Moves(model),
    (torch.zeros((1, 64, width)), torch.tensor([1500]), torch.tensor([1500])),
    path,
    input_names=["tokens", "self_elos", "oppo_elos"],
    output_names=["logits_move"],
    dynamic_axes={"tokens": {0: "n"}, "self_elos": {0: "n"}, "oppo_elos": {0: "n"}, "logits_move": {0: "n"}},
    opset_version=17,
    dynamo=False,
)
print(f"{path}: {os.path.getsize(path) / 1e6:.1f} MB", file=sys.stderr)

samples = json.load(open(os.path.join(run_dir, "samples.json")))
top3 = {}
started = time.time()
for s in samples:
    board = chess.Board()
    history = deque([tokenize_board(board)], maxlen=cfg.history)
    for uci in s["moves"]:
        board.push(chess.Move.from_uci(uci))
        history.append(tokenize_board(board))
    tokens = engine._tokens_from_history(history).unsqueeze(0)
    with torch.no_grad():
        logits = model(tokens, torch.tensor([s["elo"]]), torch.tensor([s["oppElo"]]))[0][0]
    logits = logits.masked_fill(~get_legal_moves_mask(board, engine.all_moves_dict), float("-inf"))
    idxs = torch.topk(logits, k=min(3, board.legal_moves.count())).indices.tolist()
    top3[s["id"]] = [mirror_move(engine.idx_to_move[i]) if board.turn == chess.BLACK else engine.idx_to_move[i] for i in idxs]
json.dump(top3, open(os.path.join(out, f"maia3-{size}-python-top3.json"), "w"))
print(f"Python top three for {len(samples)} positions, {1000 * (time.time() - started) / len(samples):.0f} ms per position", file=sys.stderr)
