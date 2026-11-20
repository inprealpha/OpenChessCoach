# Sharing the app and releasing it

Friends and early testers install the standalone app with one command (no Node.js or npm needed)
or run it from npm with `npx openchesscoach@latest`, and follow the welcome page, `site/index.html`,
for everything else. This page is for the owner: what to do once to get there, and what a release
takes after that.

## What a tester goes through

The welcome page walks them through it for Windows, macOS and Linux:

1. A paid Claude plan (Pro or Max), since the Coach runs on their own Claude Code login (ADR 0001).
2. One-line standalone install (`install.ps1` on Windows, `install.sh` on macOS and Linux), which
   downloads a verified archive bundling the official signed Node.js runtime — no Node.js, npm, or
   administrator rights required. Users who already have Node.js 22.18+ can also run
   `npx openchesscoach@latest` (`npx.cmd` in Windows PowerShell).
3. Claude Code, installed with its native installer, and logged in. The app also finds `claude`
   in the installer's folder (`~/.local/bin`, Windows WinGet/npm links, and macOS Homebrew paths)
   when the terminal's PATH doesn't have it yet.
4. `openchesscoach` (or the **OpenChessCoach** Start Menu shortcut on Windows).

## Once

1. **An npm account.** Sign up at <https://www.npmjs.com/signup> and turn on two-factor
   authentication. The name `openchesscoach` was free on 2026-10-13.
2. **The first publish, from your desktop.** npm only lets a package trust GitHub once it exists.
   On the default branch, build the package, run the same check the release workflow runs, and
   publish that checked tarball:

   ```bash
   npm login
   git pull
   npm ci && npm run build && npm pack -w packages/backend
   node scripts/package-smoke.ts openchesscoach-0.1.0.tgz
   npm publish openchesscoach-0.1.0.tgz --access public
   ```

   This makes the built app public on npm under the GPL, while the repository stays private.
3. **Trust the release workflow.** On npmjs.com, open the package's **Settings → Trusted
   publishing**, choose **GitHub Actions** and enter owner `inprealpha`, repository `OpenChessCoach` and
   workflow `release.yml`. Releases then publish from GitHub with no npm token stored anywhere.
4. **Host the welcome page** where testers can open it without an account. Either share the
   claude.ai page from its **Share** menu, or put `site/` on Cloudflare Pages: **Workers & Pages →
   Create → Pages → Connect to Git**, pick this repository and the default branch, leave the build
   command empty and set the output folder to `site`. Cloudflare redeploys it on every merge.
   Then, in `site/index.html`, replace `og.png` in the `og:image` and `twitter:image` tags with the
   page's full address (such as `https://<host>/og.png`): link previews on Twitter and elsewhere
   only load an image from an absolute URL.

## Each release

1. Bump the version in `packages/backend/package.json` and merge that change: `minor` for new
   features (0.1.1 → 0.2.0), `patch` for fixes only (0.2.0 → 0.2.1), `major` for the next whole
   number (0.2.0 → 1.0.0).

   ```bash
   npm version minor -w packages/backend    # or patch, or major
   ```

2. On GitHub, open **Actions → Release → Run workflow**, keep the default branch and run it. It
   releases the version in `package.json`, creates the `v` tag for it (`v0.2.0`) and stops if that
   version is already released. Pushing the tag yourself works too, and stops if the tag and
   `package.json` disagree:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

3. The **Release** workflow builds the npm tarball and standalone bundles (`scripts/build-standalone.ts`)
   for Windows (`win-x64`, `win-arm64`), macOS (`darwin-arm64`, `darwin-x64`), and Linux (`linux-x64`,
   `linux-arm64`). It checks both the npm package (`scripts/package-smoke.ts`) and the standalone
   installers with system Node stripped from `PATH` (`scripts/standalone-smoke.ts`) on Windows,
   macOS and Linux, then publishes the tarball to npm and attaches all standalone archives,
   `SHA256SUMS.txt`, `install.ps1`, and `install.sh` to the GitHub release.

The same package and standalone checks run on any PR that changes how the package or standalone
bundles are built or started.
