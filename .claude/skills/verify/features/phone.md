# Play on your phone

Most people play chess on their phone, so a desktop browser asks the Player to pair one: as the
first step of first run, and with a reminder on the main menu for a Player who never did. A phone
or tablet never asks.

**Reached from:** the first visit after pairing on a fresh install (`npm run verify -- --seed
empty`), on a desktop browser; the main menu (`#/`) on an install with no phone paired (`--seed
no-phone`).

## Sub-features

- A phone is a device paired under the name `iPhone or iPad browser` or `Android browser`
  (`packages/shared/src/devices.ts`). An iPad whose Safari calls itself a Mac is told by its touch
  screen; an Android tablet whose Chrome asks for desktop sites, and so calls itself Linux, by touch
  being its only pointer. Desktop browsers, `coachctl` and `verify-handshake` are not phones.
- The web app gives its name at `hello` too, and the desktop renames the device to it: an iPad that
  paired as a Mac before the app told them apart counts as a phone once it connects.
- The desktop asks while no phone is paired and not revoked, and the Player hasn't put it off:
  `pairing.info` returns `phone: { paired, remind }`.
- First run on a desktop: the region `Play on your phone` ("Step 1 of 2") with three steps, the
  figure `Pairing QR code`, a note to keep the app running, and `No link appears?` (a disclosure
  with the Wi-Fi address and the pairing code, `data-testid="phone-pairing-code"`). The level and
  Goals come second ("Step 2 of 2"). On a phone, or with a phone paired, first run starts at the
  level and Goals with no step numbers.
- When a phone pairs, every desktop showing the QR code says "Your phone is paired." in its
  `status`, without a reload (the `device-paired` event), and the QR code goes. First run then
  offers `Continue here`: to the main menu if the Player finished setting up on the phone, else to
  the level and Goals, whose heading `About you` takes the focus. Either device's form saves only if
  the other hasn't finished first run meanwhile.
- `I’ll do it later` (first run or the reminder) puts it off for 3 days (`ASK_AGAIN_MS`); Escape
  on the reminder counts as later. The reminder's `Don’t ask again` puts it off for good.
- The main menu's reminder: the dialog `Play on your phone`, modal, focus on its heading, shown
  once per visit to the menu to a Player who finished first run, on a desktop, while the desktop
  says to ask. Once the phone pairs it shows `Done` instead of the two put-off buttons, and takes
  the focus if the button that had it went.
- A pairing reset revokes every phone, so the desktop asks again at once (the `pairing-reset` event).
- Settings still shows the QR code for any device (`pairing.md`).

## Drive

```bash
npm run verify -- --seed no-phone
C="npm run -s coachctl --"
$C screenshot --route "#/" --width 1280 --height 800 --wait 1500   # the reminder over the menu
$C db get meta                                                      # phone_reminder once put off
$C clock --advance 259200000                                       # 3 days on: due again
```

In the browser: on `--seed empty`, open `pairUrl` (the phone step), then open the same `pairUrl` in
a second browser with an iPhone's user agent: the desktop says "Your phone is paired.", the phone
starts at the level and Goals.

## Proof

- `meta` row `phone_reminder`: the fake clock's time plus 3 days after `I’ll do it later` (or
  Escape), `never` after `Don’t ask again`, no row when the phone paired.
- `devices` has an `iPhone or iPad browser` row with `revoked_at: null` after the phone scans.
- `pairing.info`'s `phone` is `{ paired: false, remind: true }` on `no-phone`, `{ paired: true,
  remind: false }` on `default` (`packages/backend/test/phone.test.ts`).
- `phone.spec.ts` drives the sub-features above in the browser, at 1280px and 390px; the renaming
  at `hello` is in `phone.test.ts` only. A phone that connects is a paired phone, so the desktop
  stops asking for everyone: the journeys show what a phone sees, not that it would hold back alone.

## Gotchas

- The `default` and `many-games` seeds have a phone paired (a device row nobody holds the token
  for), so the reminder never covers the menu in other journeys. `no-phone` is `default` without it.
- `empty` asks on first run: a journey that goes through first run on a desktop calls
  `phoneLater(page)` (`e2e/fixtures/app.ts`) first.
- A check that the reminder is hidden after a reload means nothing until the `pairing.info` answer
  arrives: `phone.spec.ts`'s `reloadAndHearBack` waits for it.
- In verify mode the app listens on 127.0.0.1, so the QR code's address only works on the same
  machine; drive the phone with a second browser context, not a real phone.
