# One owner per install, running on the owner's desktop

Each install belongs to one Player, the owner. The backend runs on the owner's desktop and reaches Claude through the Claude Agent SDK, which uses the owner's own Claude Code login. The app has no accounts and no hosted service, and other people use it by running their own install. We chose this because Anthropic doesn't allow apps to offer Claude subscription login to other people without its approval. The Agent SDK also can't run in a browser or on a phone, because it launches the Claude Code program, which only ships for macOS, Windows and Linux. A desktop backend is the lightest setup that bills Claude usage to the owner's subscription rather than to an API key.

## Consequences

- Phones reach the desktop by scanning a QR code that holds the desktop's address and a secret pairing code. The default only works on the same Wi-Fi network. A checkbox starts a Cloudflare quick tunnel for use away from home, which needs no account but gets a new address each time it starts. Tailscale also works, and it's documented rather than built in.
- Coach replies stream over a WebSocket, not Server-Sent Events, because quick tunnels don't support Server-Sent Events.
- A pairing code is always required, so nobody else on the network or the internet can spend the owner's Claude limits.
- Calling the Messages API directly with the owner's subscription token was rejected. Anthropic's terms forbid apps from handling those tokens.
- Running the Coach from a cloud function, paid for with the API credits included in Max plans, was considered and set aside because the owner wanted a desktop-only setup.
