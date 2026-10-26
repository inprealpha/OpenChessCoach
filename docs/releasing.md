# Sharing the app and releasing it

Friends and early testers install the app from npm with one command and follow the welcome page,
`site/index.html`, for everything else. This page is for the owner: what to do once to get there,
and what a release takes after that.

## What a tester goes through

The welcome page walks them through it for Windows, macOS and Linux:

1. A paid Claude plan (Pro or Max), since the Coach runs on their own Claude Code login (ADR 0001).
2. Node.js 22.18 or later. The app stops with a message naming the fix when it is older.
3. Claude Code, installed with its native installer, and logged in. The app also finds `claude`
   in the installer's folder (`~/.local/bin`) when the terminal's PATH doesn't have it yet.
4. `npx openchesscoach@latest` (`npx.cmd` in Windows PowerShell, which blocks `npx.ps1` by
   default). `@latest` means every start picks up the newest release.

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

2. Tag the merge commit with that version, with a `v` in front, and push the tag. The Release
   workflow stops if the tag and `package.json` disagree. For 0.2.0:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

3. The **Release** workflow checks the npm package on Windows, macOS and Linux
   (`scripts/package-smoke.ts`), publishes it to npm and creates a GitHub release with the tarball.
   Testers get it the next time they start the app.

The same package check runs on any PR that changes how the package is built or started.
