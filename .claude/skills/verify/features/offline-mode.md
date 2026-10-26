# Offline mode

On a secure origin (see Gotchas), the web app is installable and keeps working when the desktop
can't be reached: the board, the Engine, Lessons and Puzzles run on the device; Engine Games are
saved on the device and sent to the desktop when it comes back. Coach features say they need the
desktop, and so do Reviews, which are graded on the desktop's Engine (ADR 0007). Lesson moves are
graded by the browser's Engine instead.

**Reached from:** any screen; the banner status `Connection` says "Desktop connected" or not.

## Sub-features

- A service worker caches the app shell and the Engine (never `/api`, `/ws` or `/__verify`).
- A desktop that goes silent without closing the connection (asleep, off the Wi-Fi): while the
  page is on screen, a connection quiet for 10 s gets a cheap request (`settings.get`); no answer
  within 5 s and the header says "Desktop offline", every request waiting on the desktop (a Why
  Question) fails with "Your desktop can’t be reached…", and the app keeps retrying. Coming back
  on screen or onto a network reconnects at once instead of waiting for the next retry. A Review
  in progress isn't cut short while the desktop is awake: it answers the check while it works.
- An Engine Game finished offline: "Saved on this device…", then synced when the desktop is back.
- The game list (`#/games`) while offline: a note "Your games live on your desktop, which can’t
  be reached right now.", with the list this device kept from the last time it was opened online
  (never "No games yet"): only the games it was shown, with the total then ("Showing 50 of 61
  games.") and no `Show more`.
- The Player Profile while offline: the one kept on this device, with a note "Your Player Profile
  lives on your desktop, which can’t be reached right now. You can change it once it’s back."
  above its greyed-out buttons. A save the desktop never answered says "Not saved: your desktop
  can’t be reached right now. Save again once it’s back." beside Save, and keeps the form.
- The web app manifest and icons, so the app can be added to the home screen.
- A tab left open across an update: the desktop answers the previous build's missing chunks with a
  404 (never index.html, never cached), and the tab reloads once to fetch the new app instead of
  hanging on "Loading the Lesson…"; at most once a minute, so it never loops.

## Drive

`offline.spec.ts` shows the way: pair, wait for the service worker, stop the instance, reload, play
an Engine Game and resign, start a new instance on the same data folder and port, reload.

A silent desktop: `offline.spec.ts` › "a desktop that goes silent…" relays the connection with
`page.routeWebSocket` and stops relaying, with Playwright's clock to skip the wait. By hand:
`kill -STOP <pid>` the verify instance (its `pid` is in `npm run verify`'s JSON) while a Why
Question is in flight, wait 20 s, then `kill -CONT <pid>`.

## Proof

- While offline: "Saved on this device" on the end-of-game card, under `Game status`.
- While offline, `#/games` shows that note and, if it was opened online before, the cached
  `Game list`.
- After the desktop is back: a `games` row with `source: engine` for that game, and no duplicate
  if it is synced twice.
- A desktop frozen mid-question: "Desktop offline" within 20 s and the Coach panel shows "Your
  desktop can’t be reached…"; after it wakes, "Desktop connected" and `Ask the Coach why` is
  enabled again.
- A desktop frozen mid-way through a Player Profile save that links Lichess `CoachVerify`, then
  Cancel and wake it: the `profile` row still has `rating: null` (by hand with `kill -STOP`;
  `games.test.ts` pins the desktop's side, `offline.spec.ts` the form's).

## Gotchas

- Service workers only run on a secure origin; `http://127.0.0.1` counts, a LAN IP does not. So
  the QR code's Wi-Fi address (`http://<LAN IP>:8737`) gets no offline app, and the README and the
  welcome page send phones to an `https://` address for it.
- Each origin has its own pairing token and offline queue (IndexedDB). A quick tunnel's address
  changes every time it starts, so games queued under an old tunnel address never sync.
