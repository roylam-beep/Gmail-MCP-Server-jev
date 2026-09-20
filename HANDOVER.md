# Handover

State as of `a9fc921` on `main`. Everything below was verified, not assumed.

## Where this stands

The server works. It was driven over the real MCP protocol at this commit:
`initialize` and `tools/list` answer correctly, 29 tools are advertised,
stdout carries only JSON-RPC, and an unauthenticated call returns an
actionable message rather than a library internal.

| | |
|---|---|
| Branch | `main` only — there is **no** `experimental` branch, whatever older docs said |
| Tests | 407, all passing |
| CI | green; runs on pushes to `main` and PRs targeting it |
| npm package | `@geniushub/gmail-mcp` — **not published yet** (`npm view` returns 404) |
| MCP Registry | `io.github.roylam-beep/Gmail-MCP-Server-jev` — not published yet |
| Version | 1.3.0 in package.json, package-lock.json, server.json (×2), mcpb-manifest.json |
| Issues | **disabled** on this repo — `gh issue` calls fail |

What has NOT been verified: **real Gmail API round-trips**. Every test uses a
fake OAuth client, so "does sending an email actually work against Google" is
open. That is the first thing the next session should establish.

---

## Task 1 — Get it running on the user's own machine

This is the only task that matters until it is done. Everything else is
optional.

The repo lives in an ephemeral cloud container, so the user must clone it
locally:

```bash
git clone https://github.com/roylam-beep/Gmail-MCP-Server-jev.git
cd Gmail-MCP-Server-jev
npm install
npm run setup
```

`npm run setup` builds, locates the OAuth client, validates it, runs the
sign-in, and prints the client config. `npm run setup -- --check` reports the
state without opening a browser.

### The OAuth client

The user needs one, once. **Do not re-litigate this** — it was already
researched and settled:

Gmail scopes are [restricted](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).
A shared, pre-registered client would need a CASA security assessment plus
[annual recertification](https://support.google.com/cloud/answer/13463816?hl=en).
Google's own Gmail MCP server asks users to bring their own for this reason.
The step can be shortened, not removed. The user has pushed back on this
twice; state it once if asked and move on.

**The user already has a Google Cloud project** (they run a Google Ads MCP),
so the consent screen is configured and only two steps remain:

1. https://console.cloud.google.com/apis/library/gmail.googleapis.com → Enable
2. https://console.cloud.google.com/apis/credentials → Create Credentials →
   OAuth client ID → **Desktop app** → Download

The download needs no renaming or moving — `npm run setup` finds
`client_secret_*.json` in Downloads/Desktop/cwd, validates its shape, and
places it at `~/.gmail-mcp/gcp-oauth.keys.json` with mode 0600.

### Two failure modes to expect

- **Re-auth needed every 7 days.** Google expires refresh tokens for OAuth
  projects still in "Testing" publishing status. Publishing the consent screen
  to "In production" fixes it permanently; no Google review is needed for
  personal use. The error message already names this cause.
- **`auth` must run as the same user the MCP client launches the server as.**
  Otherwise the server looks in a different `$HOME` and reports
  `Not authenticated. No Gmail credentials at ...`.

### Connect it

```bash
claude mcp add gmail -- node /absolute/path/Gmail-MCP-Server-jev/dist/index.js
```

Claude Desktop: same command/args in `claude_desktop_config.json`, absolute
path only (no `~`), then fully quit and reopen.

Verify by asking Claude to list Gmail labels.

---

## Task 2 — Publish to npm (optional; only needed so others can `npx` it)

Blocked on two things only the user can do.

npm cannot register a trusted publisher for a package that does not exist
([npm/cli#8544](https://github.com/npm/cli/issues/8544), still open), so the
first version must be published by hand:

1. The `geniushub` npm org exists and the user owns it (account name is
   `geniushub-ai`). Confirmed.
2. Publish once: `npm publish --access public` from a clone, or from the
   tarball this session built.
3. Register the trusted publisher on npmjs.com → the package → Settings →
   Trusted publishing:
   - Provider: GitHub Actions
   - Repository: `roylam-beep/Gmail-MCP-Server-jev`
   - Workflow: `publish.yml` ← the filename must match exactly or npm refuses
   - Environment: blank
4. Then push the tag: `git tag v1.3.0 && git push origin v1.3.0`

`publish.yml` skips the npm step when that exact version is already on npm, so
pushing the tag after a manual 1.3.0 publish still lets the `mcp-registry` job
run. It also fails loudly if the tag does not match package.json.

From 1.3.1 onward a tag push is fully automatic.

---

## Deferred, with reasons

Nothing here blocks anything.

- **Real Gmail API verification.** Needs live credentials. Once Task 1 is
  done, exercise `search_emails`, `read_email`, `send_email`,
  `download_attachment`, `forward_email` against a real mailbox and check the
  error paths too. The Gmail error-shape handling (409 on duplicate label,
  `invalid_grant`, 403 scope errors) was written from documentation and stub
  objects, not observed responses.
- **`js-yaml` override.** A review flagged it as pinning `@yarnpkg/parsers`
  below its declared `^3.10.0`. Removing it produces an identical tree and an
  identical clean audit — npm's hoisting causes the mismatch, not the
  override, and lockfile-lint runs `--type npm` and never reaches the syml
  parser. Left alone deliberately. Do not "fix" it.
- **`bugs.url` points at pull requests** because issues are disabled. If the
  user would rather accept bug reports, enable issues and point it back.
- **`tsconfig.json` targets ES2020** on a Node 22 floor. Conservative rather
  than wrong; ES2021+ built-ins are invisible to the checker. Nothing uses
  them today.

---

## Things that will waste your time if you do not know them

- **`npm test 2>&1 | grep ...` reports grep's exit status, not the test
  run's.** A commit went out red in this session because of exactly that.
  Check the suite by exit code.
- **TypeScript globs do not support extglob.** Writing
  `src/**/*.test.?(c|m)ts` in `tsconfig.json` silently excludes nothing and
  ships the test files inside the npm tarball. `src/packaging.test.ts` now
  guards this.
- **Tests that wait on elapsed time instead of on a condition flake on CI.**
  Two suites had to be rewritten for this. Poll for the thing you need.
- **The end-to-end suites need `dist/`.** `npm test` alone after
  `npm run prebuild` silently skips them locally; in CI a missing `dist/` is a
  hard error.
- **`.claude/skills/pr-review-sop/SKILL.md` is the repo's PR SOP** and is now
  accurate. Earlier revisions mandated an `experimental` branch, a Personal
  CRM tool and a `security-auditor` subagent — none of which exist here.
- The mandatory security audit for PRs runs via the **`security-review`
  skill**.
