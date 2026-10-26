# OpenChessCoach

A chess coach that runs on your own desktop: the Engine (Stockfish) judges every move, and Claude,
the Coach, explains why in plain words, on your own Claude subscription.

![A Review of an Italian Game: the Winning Chances bar beside the board, arrows for the move played and the Engine's best, the Winning Chances graph under it, and the key moments with their Move Grades](https://github.com/inprealpha/OpenChessCoach/raw/HEAD/docs/images/review.png)

```bash
npx openchesscoach@latest
```

In Windows PowerShell, type `npx.cmd` instead of `npx`. You need Node.js 22.18 or later and Claude
Code, logged in: see [What you need](#what-you-need).

- **Review your own games** from Lichess, chess.com or a PGN: every move gets a Move Grade, a graph
  shows where the game turned, and the Coach walks you through the key moments.
- **Play the Engine** at your strength, with Live Coaching and Hints.
- **Learn** openings, Themes such as forks and pins, and basic endgames in Lessons, then practise
  them in Puzzles.
- **Ask the Coach why** a move is good or bad, beside any board.
- **See the verdicts at a glance**: Winning Chances as a percentage and a bar, Move Grade symbols on
  the board, and a Threat arrow for what your opponent wants next.
- **Play on your phone** too: scan the QR code the desktop prints.

## What you need

- **Node.js 22.18 or later** (`node --version`).
- **Claude Code, logged in** with a paid Claude plan (Pro or Max): install it from
  <https://claude.com/claude-code>, run `claude` once and log in. The Coach uses that login; the
  app never sees your password or token.
- A desktop running macOS, Windows or Linux. Phones and tablets connect to it.

## Start

```bash
npx openchesscoach@latest
```

In Windows PowerShell, type `npx.cmd` instead of `npx`. `@latest` picks up the newest release
each time you start the app.

The desktop checks Claude Code, starts the app and opens your browser already paired. It also
prints a QR code: scan it with your phone on the same Wi-Fi to open the app there, already paired.

Browsers keep an offline copy of the app only on an `https://` address or on the desktop itself.
There you can add the app to your home screen (or install it, on the desktop) to use it like an
app: the board, the Engine, Lessons and Puzzles keep working when the desktop can't be reached,
and Engine Games played offline are saved when it comes back. The QR code's Wi-Fi address is plain
`http://`, so a phone on it needs the desktop running each time it opens the app. For an
`https://` address on your phone, see [Away from home](#away-from-home).

Options: `--port <n>` (default 8737), `--host <address>`, `--data-dir <path>`, `--no-open`, `--version`, `--help`. Your games and
Player Profile live in one SQLite file in your data folder (on Linux `~/.local/share/ai-chess-coach`,
on macOS `~/Library/Application Support/ai-chess-coach`, on Windows `%APPDATA%\ai-chess-coach`).

## Pairing

Only devices that scanned the QR code, or typed the pairing code shown on the desktop, can use the
app: nobody else on your network can spend your Claude limits. Settings shows the QR code again,
and **Reset pairing** signs every other device out.

## Away from home

Two ways to reach your desktop from outside your Wi-Fi:

- **The away-from-home checkbox** in Settings starts a Cloudflare quick tunnel. It needs no
  account (the app downloads `cloudflared` the first time) and shows a new QR code. Pairing still
  applies. The address is `https://`, so the app works offline there too, but it changes each time
  the tunnel starts, including every time you start the app: scan again after a restart.
  The phone treats each address as a separate app, so Engine Games played offline under an old
  address are never sent to the desktop.
- **Tailscale**, if you already use it or want a fixed address:
  1. Install Tailscale on the desktop and the phone and sign in to the same tailnet
     (<https://tailscale.com/download>).
  2. Start OpenChessCoach as usual. Find the desktop's Tailscale name with `tailscale status`.
  3. On the phone, open `http://<desktop-name>:8737/` and type the pairing code from the desktop.
  4. For the offline app and Stockfish's faster multi-threaded mode in the phone's browser, the
     browser needs HTTPS:
     run `tailscale serve --bg 8737` on the desktop and open the `https://<desktop-name>.<tailnet>.ts.net`
     address it prints instead. It stays the same, so add that one to your home screen.

## Coach quality

Settings → Coach quality picks how much of your Claude limits the Coach uses:

- **Thrifty**: Haiku for every job.
- **Balanced** (the default): Sonnet for Reviews, Why Questions and Lessons; Haiku for Hints and
  Live Coaching.
- **Best**: Opus for Reviews, Why Questions and Lessons; Haiku for Hints and Live Coaching, which
  must stay quick.

Under **Advanced** you can choose the model for each job yourself; the choice then shows as Custom.
The models are named by family (`haiku`, `sonnet`, `opus`), and the Claude Agent SDK maps each to
the newest model of that family it knows, so updating the app keeps the Coach on the latest models.

## For contributors

To run your own changes, start the app from a copy of this repository:

```bash
git clone https://github.com/inprealpha/OpenChessCoach.git
cd OpenChessCoach
npm ci
npm run build -w @chess-coach/web
npm start                 # options go after --, as in npm start -- --port 9000
```

After `git pull`, run `npm ci` and the build again. Then:

```bash
npm test                          # unit, golden, data and protocol tests
npx playwright install chromium   # once: the browser the Player journeys run in
npm run test:journeys             # the Player journeys in a real browser
npm run verify                    # a disposable verify-mode copy of the app for checking a change
```

Read `CLAUDE.md` and `.claude/skills/verify/SKILL.md` before opening a PR: changes merge on
evidence from the running app (`docs/adr/0006-merge-on-evidence.md`).

## Licence

GPL-3.0-or-later. Stockfish, the chess pieces and the Lesson and Puzzle data have their own
licences and credits: see `THIRD_PARTY_NOTICES.md`.
