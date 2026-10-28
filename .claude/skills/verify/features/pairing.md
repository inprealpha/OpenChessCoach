# Pairing

Only devices that scanned the desktop's QR code (or typed its pairing code) reach the backend, on
the LAN or through the away-from-home tunnel (ADR 0001).

**Reached from:** the QR code the desktop prints at start and shows in Settings (the header's cog); it opens
`<url>/#pair=<code>`. An unpaired visit shows "This device isn’t paired" with a code field.

## Sub-features

- Pair by QR link or by typing the code; a wrong code is refused with a clear error.
- A pairing link opened in a tab that already shows the pairing screen pairs it, without a reload.
- A paired device stays paired across reloads (its token is in IndexedDB).
- First run and the main menu ask a desktop Player to pair their phone (`phone.md`).
- Settings → the region `Pairing` shows the QR code, the pairing code in groups of four
  (`data-testid="pairing-code"`, typed as is on the pairing screen) and the pairing link
  (`data-testid="pairing-link"`, with `Copy link` where the browser allows it), so a device without
  a camera can pair from another paired device.
- Settings → Reset pairing → Yes, reset pairing: every other device is revoked and must scan again;
  "Pairing reset." shows in the Pairing card with the new code.
- Settings → away-from-home access: starts a Cloudflare quick tunnel and shows its QR code.
- A connection without a valid token is refused before the WebSocket opens.
- The QR code's Wi-Fi address is plain http, which browsers don't treat as a secure origin (no
  `crypto.randomUUID`, no service worker): every board screen still opens there (`e2e/journeys/lan.spec.ts`).

## Drive

```bash
C="npm run -s coachctl --"
$C pair                                   # a new device token, using the run's code
$C pair --code WRONGCODE0000              # refused
$C doctor                                 # pairing-guard: a tokenless connection is refused
$C db get devices                         # one row per paired device; revoked_at set after a reset
```

In the browser: open `pairUrl`, check the main menu shows; then the header's `Settings` cog → `Reset pairing`.

## Proof

- `coachctl db get devices` has a row for the new device with `revoked_at: null`.
- After a reset, every other row has `revoked_at` set, and the other browser shows the pairing screen.
- Doctor's `pairing-guard` check is ok.
- In verify mode the tunnel URL is always `https://verify-mode.trycloudflare.com` (`data-testid="tunnel-url"`).

## Gotchas

- Journeys reach the app on 127.0.0.1, which browsers treat as secure, so they miss what only fails on
  the Wi-Fi address; `lan.spec.ts` starts its instance on `0.0.0.0` and opens the machine's own IPv4 address.
- The verify-mode readiness handshake pairs a device called `verify-handshake`; expect it in `devices`,
  with the `default` seed's `iPhone or iPad browser`. A browser that connects with its token, such as
  `coachctl screenshot`'s, renames it to the browser's own name (`Linux browser`) at `hello`.
- Resetting pairing revokes the run's own token too: coachctl prints the new one, and the
  verify routes (`db get`) need it. Prefer resetting from the browser at the end of a run.
- A real tunnel needs `cloudflared` and the network; verify mode never opens one.
