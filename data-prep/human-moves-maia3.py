# The Maia-3 baseline for data-prep/human-moves.ts (https://github.com/CSSLab/maia3, AGPL-3.0 code;
# weights from Hugging Face, UofTCSSLab/Maia3-*). Maia-3 reads the last 8 positions of the game, so
# run `node data-prep/human-moves.ts history <games.pgn> <dir>` first. For each model it appends to
# <dir>/guesses.jsonl:
#   maia3-5m         the mover's real rating and the game's real history
#   maia3-5m-1500    1500 for both players, as an unprompted guess
#   maia3-5m-nohist  the current position only (repeated to fill the history), as for a pasted position
# and it prints each model's file size, load time and time per position.
#
# Setup, in a folder outside the repo:
#   git clone https://github.com/CSSLab/maia3 && uv venv -p 3.12 .venv && uv pip install -p .venv/bin/python \
#     --index-strategy unsafe-best-match --extra-index-url https://download.pytorch.org/whl/cpu torch ./maia3
# Usage: .venv/bin/python -I data-prep/human-moves-maia3.py <dir> [--models=5m,23m,79m]
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

run_dir = sys.argv[1]
models = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--models=")), "5m,23m,79m").split(",")
samples = json.load(open(os.path.join(run_dir, "samples.json")))
if any("moves" not in s for s in samples):
    sys.exit("Run `node data-prep/human-moves.ts history <games.pgn> <dir>` first: Maia-3 needs each game's moves.")
torch.set_num_threads(int(next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--threads=")), "4")))


def top3(engine, board, history, self_elo, oppo_elo):
    """The three legal moves with the highest scores, in UCI (castling as e1g1)."""
    tokens = engine._tokens_from_history(history).unsqueeze(0)
    with torch.no_grad():
        logits, _, _ = engine.model(tokens, torch.tensor([self_elo]), torch.tensor([oppo_elo]))
    logits = logits[0].float().masked_fill(~get_legal_moves_mask(board, engine.all_moves_dict), float("-inf"))
    out = []
    for idx in torch.topk(logits, k=min(3, board.legal_moves.count())).indices.tolist():
        uci = engine.idx_to_move[idx]
        out.append(mirror_move(uci) if board.turn == chess.BLACK else uci)
    return out


with open(os.path.join(run_dir, "guesses.jsonl"), "a") as out:
    for size in models:
        cfg = parse_args(["--model", f"maia3-{size}", "--device", "cpu", "--no-use-amp", "--use-uci-history"])
        engine = Maia3UCIEngine(cfg)
        started = time.time()
        engine.ensure_model_loaded()
        load = time.time() - started
        timed = 0.0
        for s in samples:
            board = chess.Board()
            history = deque([tokenize_board(board)], maxlen=cfg.history)
            for uci in s["moves"]:
                board.push(chess.Move.from_uci(uci))
                history.append(tokenize_board(board))
            assert board.fen() == chess.Board(s["fen"]).fen(), s["id"]
            only_now = deque([tokenize_board(board)], maxlen=cfg.history)
            variants = [(f"maia3-{size}", history, s["elo"], s["oppElo"])]
            if size == models[0]:
                variants += [(f"maia3-{size}-1500", history, 1500, 1500), (f"maia3-{size}-nohist", only_now, s["elo"], s["oppElo"])]
            for source, hist, self_elo, oppo_elo in variants:
                t = time.time()
                moves = top3(engine, board, hist, self_elo, oppo_elo)
                if source == f"maia3-{size}":
                    timed += time.time() - t
                out.write(json.dumps({"id": s["id"], "source": source, "raw": moves, "moves": moves, "illegal": []}) + "\n")
        size_mb = os.path.getsize(engine.cfg.checkpoint_path) / 1e6
        print(f"maia3-{size}: {size_mb:.0f} MB file, loaded in {load:.1f} s, {1000 * timed / len(samples):.0f} ms per position", file=sys.stderr)
