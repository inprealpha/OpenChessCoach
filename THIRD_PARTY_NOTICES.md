# Third-party notices

OpenChessCoach is licensed under the GNU General Public License, version 3 or later (`LICENSE`).
It includes or is built from the following work.

## Software

| Component | Used for | Licence |
| --- | --- | --- |
| [Stockfish](https://stockfishchess.org/) 18, WebAssembly build by [nmrugg/stockfish.js](https://github.com/nmrugg/stockfish.js) | The Engine, in the browser and in coachctl | GPL-3.0 (engine); MIT (the Node loader, `dist/stockfish/index.cjs`) |
| [chessops](https://github.com/niklasf/chessops) | Chess rules, FEN, PGN and SAN | GPL-3.0-or-later |
| [Svelte](https://svelte.dev/) | The web app | MIT |
| [ws](https://github.com/websockets/ws) | The WebSocket server | MIT |
| [qrcode](https://github.com/soldair/node-qrcode) | Pairing QR codes | MIT |
| [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) | The Coach, through your own Claude Code login | Anthropic's terms (see the package) |
| [cloudflared](https://github.com/cloudflare/cloudflared) | Away-from-home access; downloaded on first use, not bundled | Apache-2.0 |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.30.0 (`onnxruntime-web` with `onnxruntime-common`), `dist/ort/` | Runs the Maia-3 model on the desktop | MIT, Copyright (c) Microsoft Corporation |

The Stockfish source code is available at <https://github.com/official-stockfish/Stockfish>, and
the WebAssembly build's at <https://github.com/nmrugg/stockfish.js>.

## Maia-3

The moves a Player would reach for come from **Maia-3** (5M model) by the Computational Social
Science Lab, University of Toronto: <https://github.com/CSSLab/maia3>, weights at
<https://huggingface.co/UofTCSSLab/Maia3-5M> (revision `b6559de2398d7140b985f28fd2c19fb5e47ddabe`),
from the paper "Chessformer: A Unified Architecture for Chess Modeling" (Monroe, Eilender, Chalmers,
Tang and Anderson, ICLR 2026). Maia-3's code is licensed under the GNU Affero General Public License,
version 3 (AGPL-3.0), and its weights carry no other licence, so OpenChessCoach treats them as
AGPL-3.0 too (ADR 0011). The app downloads them after install, converted to ONNX by
`data-prep/maia3-onnx-export.py`; it does not include Maia-3's code. The source of OpenChessCoach, as
the AGPL asks, is at <https://github.com/inprealpha/OpenChessCoach>, and the app's Settings link to it.

## ONNX Runtime

The `onnxruntime-web` and `onnxruntime-common` packages carry this notice:

> MIT License
>
> Copyright (c) Microsoft Corporation
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
> NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
> DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
> OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Chess pieces

The piece set (`packages/web/public/pieces/`, and the knight in the app icon) is **cburnett** by
Colin M.L. Burnett, as distributed with Lichess (<https://github.com/lichess-org/lila>),
licensed GPL-2.0-or-later.

## Data

| Data | Where | Source | Licence |
| --- | --- | --- | --- |
| Lesson notes | `data/lessons/`, `data/lesson-notes.json` | [Wikibooks, Chess Opening Theory](https://en.wikibooks.org/wiki/Chess_Opening_Theory), condensed; each note names its page | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), Wikibooks contributors. Adapted notes are shared under the same licence. |
| How often players at each level choose each move | `data/lesson-stats.json`, `data/lessons/` | [Lichess games database](https://database.lichess.org/), rated games from January 2013 and July 2014 | CC0 1.0 |
| Theme and endgame Lessons: texts, positions and lines | `data/lessons/`, `data/lesson-topics.json` | [Wikibooks, Chess/Tactics](https://en.wikibooks.org/wiki/Chess/Tactics) and [Chess/The Endgame](https://en.wikibooks.org/wiki/Chess/The_Endgame); Wikipedia's articles on [forks](https://en.wikipedia.org/wiki/Fork_(chess)), [discovered attacks](https://en.wikipedia.org/wiki/Discovered_attack), [back-rank mate](https://en.wikipedia.org/wiki/Back-rank_checkmate), [undermining](https://en.wikipedia.org/wiki/Undermining_(chess)), the [Lucena position](https://en.wikipedia.org/wiki/Lucena_position) and the [Philidor position](https://en.wikipedia.org/wiki/Philidor_position); condensed, each part names its page | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), Wikibooks and Wikipedia contributors. Adapted texts are shared under the same licence. |
| Puzzles, and some Theme Lesson positions | `data/puzzles.json`, `data/theme-puzzles.json`, `data/lessons/` | [Lichess puzzle database](https://database.lichess.org/#puzzles) | CC0 1.0 |
| Opening names | `data/openings.json` | [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) | CC0 1.0 |
| Golden-test games | `packages/shared/test/fixtures/` | Lichess games database, January 2013 | CC0 1.0 |

The app shows each Lesson note's and each Lesson position's credit, with a link to its page, next to it.
