# The Engine runs in the browser for play, and on the backend for everything the Coach touches

This partly supersedes ADR 0003. Stockfish runs in two places, with the same WebAssembly build in both:

- **In the browser (a Web Worker)**: the board, Engine Games and board analysis. Play stays instant with no network wait, and it keeps working when the desktop is off or out of reach.
- **On the backend (Node)**: every job that involves the Coach, namely grading a whole game for a Review, the Engine facts in each Coach brief, Lesson turns and Hints. These jobs need the desktop anyway because the Coach runs there.

Grading a whole game on a phone's single-threaded Engine is slow, while the desktop does it quickly with several threads. When the backend computes the Engine facts itself, the Coach move guard (ADR 0002) checks Coach moves against facts the backend produced, not facts a client sent. A future client, such as a GNOME app, also gets Engine analysis from the backend without bringing its own Engine.

## Consequences

- One Engine interface has three implementations: the browser Worker, the backend's multi-threaded build for real use, and the backend's fixed-depth build for tests and verify mode.
- A Coach request carries only the position and the moves played. It no longer carries Engine findings, and the backend ignores any that a client sends.
- When the desktop can't be reached, the board, Engine Games and board analysis still work in the browser, and the Coach's features are greyed out. Engine Games played meanwhile are held on the phone and sent to the desktop when it can be reached again. The desktop's SQLite file is the single source of truth.
- Move Grades shown during an Engine Game come from the browser Engine. A Review regrades the whole game on the backend, so the two can differ slightly. The Review's grades are the record that counts.
- Over the default same-Wi-Fi connection the page isn't cross-origin isolated, so the browser Engine runs single-threaded there. The backend Engine is multi-threaded on any connection.
