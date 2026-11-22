# CI AI Providers & Fallback Guide (Plain-English Owner's Guide)

OpenChessCoach uses AI in two automated GitHub checks on pull requests:

- **Verdict** — an independent AI judge that boots the app, clicks through the changes, and decides `PASS`, `PASS+NOTES`, or `FAIL`.
- **real Coach** — an automated check that runs every Coach job (Lesson, Hint, Why Question, Review, Think deeper) and verifies the Coach never invents illegal moves or breaks its rules.

So that your software factory keeps running even when you switch or pause AI subscriptions, CI automatically tries your configured providers in priority order, checks your saved logins once a week, and supports running the exact same checks on an independent agent's machine if every CI provider is down.

---

## 1. How the fallback order works

By default, CI tries providers in this order:

1. **Codex** (`codex`) — first choice.
2. **Claude** (`claude`) — used automatically whenever you renew Claude and save a key or token.
3. **OpenCode free ZDR models** (`opencode`) — last-resort zero-cost fallback that runs automatically in GitHub Actions with no paid key. To ensure no sensitive information is kept by a free provider, unauthenticated free OpenCode is **strictly pinned to Zero-Data-Retention (ZDR) free models**:
   - `opencode/deepseek-v4.1-flash-free`
   - `opencode/hy4-flash-free`
   - `opencode/longcat-2.5-free`

   Non-ZDR free models (such as `opencode/big-pickle`) are never used. If none of the ZDR free models is available, CI moves on instead of falling back to a model that retains data. When free OpenCode runs **Verdict**, both the GitHub status check and the PR comment are clearly labeled **`[weaker judge: opencode]`** so you know it was judged by a weaker free model.

**Smart fallback rule:** CI only falls back to the next provider when a secret is missing or a provider rejects the login / hits a billing or rate limit (`401`, `403`, `429`). If a provider runs and finds a real bug (`FAIL` or a Coach structural failure), CI **stops immediately and fails the PR** — it never retries a real bug on another model.

---

## 2. Click-by-click setup in GitHub (what you need to do)

### Step A (Optional): Save a subscription login in GitHub Secrets

You do **not** need to create a paid or free API key. With no secrets saved, GitHub Actions automatically tries OpenCode's free ZDR models above whenever the runner's IP still has daily free quota. Whenever you have an active subscription (such as Claude) and want GitHub Actions to use it first, add its secret in **GitHub Secrets** (encrypted passwords stored in your repository so GitHub Actions can use them without ever showing them publicly):

1. Open your repository on GitHub: `https://github.com/inprealpha/OpenChessCoach`
2. Click **Settings** (top menu bar).
3. In the left sidebar, click **Secrets and variables → Actions**.
4. Make sure you are on the **Secrets** tab, then click **New repository secret**.
5. Add one of these secrets (you can add more than one — CI will follow your priority order):

| Secret name | Provider | Notes |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | **Claude** | Claude subscription OAuth token (add back whenever you renew Claude). |
| `OPENAI_API_KEY` | **Codex** | Optional pay-as-you-go OpenAI API key (set a small monthly spend cap at [platform.openai.com/settings/organization/limits](https://platform.openai.com/settings/organization/limits)). |
| `ANTHROPIC_API_KEY` | **Claude** | Optional pay-as-you-go Anthropic API key. |
| `CODEX_AUTH_JSON` | **Codex** (not recommended on public repos) | See section 3 below before using this. |

> **If you pause a subscription later:** You don't need to edit any code. Either delete the old secret in **Secrets**, or leave it alone (CI will skip it after an auth error, and the weekly health check will remind you to clean it up).

### Step B (Optional): Change the provider order without touching code

**GitHub Variables** are plain-text settings you can edit in GitHub's web UI.

1. Go to **Settings → Secrets and variables → Actions → Variables** tab.
2. Click **New repository variable**.
3. Name: `CI_PROVIDER_ORDER`
4. Value: a comma-separated list, e.g. `codex,claude,opencode` (or `claude,codex,opencode` whenever you renew Claude).

Optional advanced variables (you do not need to set these unless you want different providers for the two checks):
- `JUDGE_PROVIDER` — overrides the order for **Verdict** only.
- `COACH_CHECK_PROVIDER` — overrides the order for **real Coach** only (supports `codex,claude,pi,opencode`).
- `OPENCODE_ZDR_FREE_MODELS` — comma-separated list of Zero-Data-Retention free OpenCode models (defaults to `opencode/deepseek-v4.1-flash-free,opencode/hy4-flash-free,opencode/longcat-2.5-free`; set to `none` to disable free OpenCode fallback).
- `CODEX_JUDGE_MODEL`, `CLAUDE_JUDGE_MODEL`, `OPENCODE_JUDGE_MODEL` — override the model name for a specific judge (for unauthenticated free OpenCode, `OPENCODE_JUDGE_MODEL` must be in the ZDR allowlist).

### Step C: Update `main` Branch Protection (exact clicks)

GitHub's **Branch protection** (or **Rulesets**) controls which checks must be green before GitHub lets a pull request merge into `main`:

- **`Verdict` stays required** (and its source is set to **`Any source`** so a separate agent running locally can unblock a merge when no CI provider is available).
- **`real Coach` becomes optional** (removed from the required list). GitHub Actions still tries `real Coach` first using your provider order (including free ZDR OpenCode when the runner's shared IP still has quota), and if GitHub can't run it, the PR status and agent instructions remind the agent to run `node scripts/real-coach-check.ts --provider auto --post` on its own machine (using OpenCode, Claude Code, Codex, or Pi — whatever is available) and post the result to the PR.

**Exact steps in GitHub:**

1. Open your repository on GitHub: `https://github.com/inprealpha/OpenChessCoach`
2. Click **Settings** (top menu bar).
3. In the left sidebar, click **Branches** (under **Code and automation**).
   - *(If your rule is under Rulesets instead of Branches, click **Rules → Rulesets** in the left sidebar and click the ruleset for `main`.)*
4. Next to `main`, click **Edit**.
5. Scroll to **Require status checks to pass before merging**.
6. **Make `real Coach` optional:** find **`real Coach`** in the list of required status checks and click the **`×`** (or trash/remove button) next to it to remove it from the required list. *(Do not delete the workflow — removing it here only stops GitHub from blocking merges when a shared GitHub runner IP hits OpenCode's daily free cap.)*
7. **Keep `Verdict` required and allow local agent fallback:** find **`Verdict`** in the required status checks list, open its **source** dropdown (next to the check name), and select **`Any source`** *(if it already says `Any source`, leave it as is)*.
8. Scroll to the bottom of the page and click **Save changes**.

- **Security tradeoff to know:** Setting `Verdict`'s source to **`Any source`** is what lets a separate agent post a passing Verdict from its own machine when CI providers are unavailable, **but** it also means any user or token with `statuses: write` permission on this repository (not just GitHub Actions) can post a passing `Verdict` status. Because only people/agents you grant write access to can do that — and you still review and merge protected PRs by hand — this is the same trust model as ADR 0013.

> **How CI protects your API keys on a public repo:** `verdict.yml` runs under `pull_request_target` so a PR cannot modify its own judge workflow, and the gate **rejects all fork PRs** before any secret is ever loaded (only branches pushed by collaborators with write access to `inprealpha/OpenChessCoach` can run). Provider secrets are scoped strictly to the judge/Coach steps — never job-level and never exposed during `npm ci` or build steps — and every configured secret is scrubbed before public artifacts are uploaded. Still, because the judge runs PR code pushed by repo collaborators, set a low monthly spend cap on `OPENAI_API_KEY` (e.g. $10–$15) as recommended by OpenAI's non-interactive Codex docs.

---

## 3. Can a ChatGPT / Codex subscription login work inside GitHub Actions?

**Short answer: technically yes for a few days, but OpenAI officially advises against it on public repos — use `OPENAI_API_KEY` instead.**

Here is what OpenAI's official Codex CI/CD documentation says:

1. Codex stores your ChatGPT subscription login in `~/.codex/auth.json` and automatically refreshes the token bundle about every **8 days** (or on `401`), writing the refreshed tokens back to disk.
2. Because GitHub Actions runners are fresh virtual machines wiped after every job, a static `CODEX_AUTH_JSON` secret does **not** get updated on disk and will stop working once the token rotates unless you refresh it manually.
3. OpenAI explicitly states: *"The right way to authenticate automation is with an API key... Do not use this workflow (`auth.json`) for public or open-source repositories."* Because `inprealpha/OpenChessCoach` is a public repository, `OPENAI_API_KEY` with a low monthly spending limit is the safe, set-and-forget choice.

`scripts/ci-providers.ts` still supports `CODEX_AUTH_JSON` (raw JSON or base64) and automatically scrubs its tokens from public artifacts, in case you ever test it temporarily.

---

## 4. Weekly login health check

Every Monday at 09:17 UTC (and anytime you click **Run workflow** in **Actions → CI Provider Health**), GitHub runs a tiny probe against every secret you have saved:

- If a saved login stops working (expired subscription, revoked key, or empty credit balance), the workflow automatically **opens (or updates) a GitHub issue** titled `[CI Provider Health] One or more saved AI logins stopped working` with plain-English fix steps.
- Once you update or delete the broken secret and re-run **CI Provider Health**, the workflow **closes the issue automatically**.

---

## 5. Independent agent local fallback (when no CI provider works)

If all CI providers are unavailable (for example, every paid login expired and free OpenCode is rate-limited), CI will post a clear `Verdict` error listing the failed providers.

Then a **separate agent** — never the agent that wrote the PR — checks out the PR's exact head commit and runs the same checks locally:

```bash
# 1. Verify the PR's head commit and run the real-Coach check (if touches-coach):
node scripts/real-coach-check.ts --provider auto --post

# 2. Run the Verdict judge against the PR (writing verdict.json + verdict.md into <out-dir>),
#    then post the Verdict status and PR comment:
node scripts/verdict.ts --post <out-dir> --pr <PR_NUMBER> --sha <HEAD_SHA> --local --judge-agent "<agent-name>"
```

The posted PR comment clearly records:
- which commit SHA was tested,
- that it ran as a local independent fallback and which agent ran it,
- the full `verdict.md` evidence (what was checked, commands, and results).
