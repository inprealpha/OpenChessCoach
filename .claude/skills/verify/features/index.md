# Feature map

Every Player-facing feature, how a Player reaches it, how to drive it and the end state that proves
it works. A feature isn't done until its entry passes. Each entry names its Player journey in
`e2e/journeys/`; run every journey to check the whole map against the app:

```bash
npm run build -w @chess-coach/web && npm run test:journeys
```

| Feature | Reached from | Journey | File |
| --- | --- | --- | --- |
| Main menu and navigation | the root (`#/`) once first run is done; the header on every screen | `menu.spec.ts` | [main-menu.md](main-menu.md) |
| Pairing (and away-from-home access) | the QR code on the desktop, `#pair=<code>` | `pairing.spec.ts` | [pairing.md](pairing.md) |
| Play on your phone (first run's first step, the main menu's reminder) | first visit on a desktop; the menu with no phone paired | `phone.spec.ts` | [phone.md](phone.md) |
| Board and Engine (Move Grades) | Main menu → the small Board link | `board.spec.ts` | [board-and-engine.md](board-and-engine.md) |
| Why Question | the Coach panel beside any board | `board.spec.ts` | [why-question.md](why-question.md) |
| First run and Player Profile | first visit after pairing; the profile icon in the header | `first-run.spec.ts` | [first-run-and-player-profile.md](first-run-and-player-profile.md) |
| Lesson (the four tracks, the Player's next Lesson) | Main menu → Learn → Lessons, or first run's `Start with the Lessons` | `lesson.spec.ts` | [lesson.md](lesson.md) |
| Puzzle | Main menu → Learn → Puzzles, or the end of a Lesson | `puzzles.spec.ts` | [puzzles.md](puzzles.md) |
| Imported Game | Main menu → Review your games, Import your games or Import more | `imported-game.spec.ts` | [imported-game.md](imported-game.md) |
| Review | Main menu → Review your games → Review, or the end of an Engine Game | `imported-game.spec.ts`, `first-run.spec.ts` | [review.md](review.md) |
| Engine Game, with Hints and Live Coaching | Main menu → Play a game | `engine-game.spec.ts` | [engine-game.md](engine-game.md) |
| Offline mode | any screen while the desktop is unreachable | `offline.spec.ts` | [offline-mode.md](offline-mode.md) |

The seed (`packages/backend/src/verify/seed.ts`): `default` is a casual-level Player with Goals, a
paired phone and one Imported Game (game 1, an Italian Game, the Player as White, with four key moments for White:
11. Bxf7+ and 12. Bg5 graded Mistake, 18. d5 and 24. Bxc5 graded Inaccuracy). `empty` is a fresh
install (with first run done, `#/menu` shows the menu with no games). `no-phone` is `default`
without the phone, so the main menu asks the Player to pair one.
