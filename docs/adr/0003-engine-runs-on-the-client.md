---
status: partly superseded by ADR-0007
---

# The Engine runs on the client

Stockfish runs in the browser as WebAssembly, in a Web Worker, rather than on the backend. Play and analysis stay instant with no network round-trip, and everything except the Coach keeps working when the desktop is off or out of reach. When the Coach is needed, the client sends the Engine's findings along with the request.

## Consequences

- When the desktop can't be reached, the board, Engine Games and Engine analysis still work, and the Coach's features are greyed out. Engine Games played meanwhile are held on the phone and sent to the desktop when it can be reached again. The desktop's SQLite file is the single source of truth.
- Over the default same-Wi-Fi connection the page is served over plain HTTP, so it isn't cross-origin isolated. Stockfish therefore runs single-threaded there, and the app can't be installed as a full PWA.
- Future clients, such as a GNOME app, bring their own Engine.

ADR 0007 adds a backend Engine for everything the Coach touches. The browser Engine still handles play and board analysis.
