---
name: pr-review-sop
description: PR and issue review SOP for this repository. Use when reviewing PRs, scanning open PRs, triaging issues, or when user says "review PRs", "check PRs", "scan issues". Defines the mandatory security audit, branch workflow, comment/label checks, and merge flow.
user-invocable: false
---

# PR & Issue Review SOP

## Project Philosophy (Read First - Governs Every Review)

**SSoT: README.md § Philosophy.** This fork is **lean and pragmatic**. Local stdio MCP server, minimal dependencies, maintainer dogfoods it daily - "if I wouldn't run it or maintain it myself, it doesn't go in." The **maximalist** direction lives in the downstream fork **klodr/gmail-mcp** (unaffiliated); feature-hungry users get redirected there, politely, with the standard caveat that we don't track its security.

**Every PR and issue assessment MUST include a philosophy verdict: MATCH / MISMATCH / NEUTRAL.**

Heuristics:
- **MATCH:** bugfixes, correctness/reliability of the existing surface, docs accuracy, test coverage for existing behavior, zero-dependency improvements, credential-safety per the local threat model.
- **MISMATCH (default decline + redirect to klodr fork):** new feature surface the maintainer wouldn't use daily, new dependencies, infra/deployment expansion (Docker images, hosting), hardening classes the local threat model explicitly excludes (see Security Standards below), capabilities with an existing simple workaround (e.g. registering the server twice ≈ multi-account).
- **NEUTRAL:** repo hygiene, triage, support/environmental issues, distribution of the existing lean server.

MISMATCH handling: don't build it, don't merge it. **Pitch the item to the maintainer FIRST (angry-king style) and close only after his explicit call** - never auto-close a contributor's PR/issue on philosophy grounds alone (inherited upstream policy: outward-facing closures are the maintainer's judgment, MISMATCH verdict or not). Once he says close: comment kindly, point to klodr/gmail-mcp, close.

## Branch Workflow

**Single `main`.** 🚨 This fork has NO `experimental` branch — `git ls-remote --heads origin` shows only `main` and `claude/*` work branches. The two-branch model below was inherited from upstream; following it produced `gh pr edit --base experimental` → HTTP 422, and a "checkout experimental before finishing" step that simply fails.

1. Work on a feature branch, open a PR against `main`.
2. Merge with `gh pr merge {N} --merge` so the contributor gets the purple badge.
3. If a staging branch is ever wanted, create it deliberately and update this file — do not conjure one because a step here mentions it.
4. **After every push to `main` or to a branch with an open PR:** verify CI. Note the trigger set in `ci.yml` is `[main]` plus PRs targeting it, so a push to a `claude/*` branch with no PR yet produces **no run at all** — an empty `gh run list` there means "not applicable", not "still starting". If CI fails, fix it immediately; do not leave it for the user.

## npm & MCP Registry Releases

Published as **@geniushub/gmail-mcp** on npm + **io.github.roylam-beep/Gmail-MCP-Server-jev** on the official MCP Registry.

🚨 **This is a fork of `ArtyMcLabin/Gmail-MCP-Server`, which is itself a fork of `GongRzhe/Gmail-MCP-Server`.** Until 1.3.0 the release workflow still pointed at the upstream author's identities — `@artymclabin/gmail-mcp` on npm (maintainer `artymclabin`, not us), the `io.github.ArtyMcLabin/*` registry namespace, and `rawceo/gmail-mcp` on Smithery. A tag push from here would have attempted to publish under someone else's names; npm and the registry would have refused it on OIDC, and Smithery would not have. Everything now names this repo. If any of these ever read `ArtyMcLabin` again, do not tag — fix the identity first.

- **Tags are cut from `main` ONLY.** Pushing a `v*` tag triggers `.github/workflows/publish.yml` -> npm publish. Tag only commits that are on `main` and green. (Upstream incident: v1.2.0/v1.2.1 were tagged off a staging branch and put unsoaked code on npm as `latest`.)
- **1.3.0 is a MANUAL first publish.** npm cannot register a trusted publisher for a package that does not exist yet (npm/cli#8544), so `@geniushub/gmail-mcp@1.3.0` must be published by hand once, then the trusted publisher registered (repo `roylam-beep/Gmail-MCP-Server-jev`, workflow file `publish.yml`). From 1.3.1 the tag push is fully automatic. Until that is done, a `v*` tag fails in the npm job and takes `mcp-registry` (which declares `needs: npm`) down with it.
- **Release procedure:** bump version in package.json + package-lock.json + server.json (both `version` fields) + mcpb-manifest.json -> commit on main -> verify CI is green on main -> `git tag vX.Y.Z && git push origin vX.Y.Z` -> verify the "Publish release" workflow is green. The tag push publishes npm -> official MCP Registry (both OIDC, no stored secrets, no interactive login). No manual `mcp-publisher` step needed.
- **Version lives in four files.** package.json, package-lock.json (two fields — use `npm version X.Y.Z --no-git-tag-version`), server.json (two fields: top-level and `packages[0].version`) and mcpb-manifest.json. The last one used to be synced by CI's jq step and drifted to 1.2.2 while the package was at 1.2.3; nothing syncs it now, so bump it by hand. `src/node-version.test.ts` reads it, so it cannot simply be deleted.
- `mcpName` in package.json must always equal `name` in server.json (registry ownership validation), and `server.json`'s `packages[0].identifier` must equal package.json's `name`.
- **npm publishes over OIDC, not a token.** The trust is registered on npmjs.com against repo `roylam-beep/Gmail-MCP-Server-jev` and the exact filename `publish.yml`. Renaming or moving that file makes npm refuse the run. There is no NPM_TOKEN secret to rotate. 🚨 NEVER document token/auth posture details (expiry dates, 2FA state, token types) in this public repo, including GitHub issues (incident 2026-07-11: such an issue was created and had to be deleted - supply-chain recon risk).
- **Smithery publishing was removed at 1.3.0** — it was hardcoded to the upstream namespace `rawceo/gmail-mcp` and needed a stored `SMITHERY_API_KEY`. `mcpb-manifest.json` is kept for a manual `.mcpb` build; nothing in CI builds it.

## PR Review Checklist (All Steps Mandatory)

### Step 1: Read All Comments and Reviews
- Fetch PR comments: `gh api repos/{owner}/{repo}/pulls/{N}/comments`
- Fetch review comments: `gh api repos/{owner}/{repo}/pulls/{N}/reviews`
- Fetch issue-level comments: included in `gh pr view --json comments`
- Summarize unresolved discussions or requests from repo owner.

### Step 2: Check Labels
- Check for labels: "help wanted", "needs help", "good first issue", etc.
- If "help wanted" / "needs help": assess if anyone volunteered, if PR is stale, if requested help was provided.

### Step 3: Security Audit (Conditional)
- Run it with the **`security-review` skill** available in this session. (An earlier version of this file named a `security-auditor` subagent; no such agent exists here, and a mandatory step with no runnable executor is a step that gets quietly skipped or faked.)
- **Skip security audit for PRs with "help wanted" label that are still waiting for community testing/volunteers.** These PRs are parked - auditing them wastes resources. Report a one-liner instead: "PR #N: still waiting for community help, no action needed."
- For all other PRs: run comprehensive security audit using `security-auditor` subagent.
- Explicitly report verdict: "Security audit: **PASS**" or "Security audit: **FAIL** - [findings]"
- Never present a PR review to user without a completed security audit (unless skipped per above).
- For FAIL verdicts: list all findings with severity (CRITICAL/HIGH/MEDIUM/LOW/INFO).
- **Local MCP threat model:** This is a local stdio MCP server (user self-hosts on own PC, not remote/hosted). The LLM client already has full filesystem/shell access. Path traversal, filename injection, and local XSS are NOT security issues in this context - the "attacker" (LLM) already has more powerful tools (Bash, Write). Only flag issues that represent actual risk in the local threat model (e.g., credential leaks to third parties, network-exposed endpoints, dependency supply chain). Do NOT flag local filesystem operations as security vulnerabilities.

### Step 4: Code Review
- Check for merge conflicts, build breakage, test failures.
- Verify consistency with project's established patterns (security hardening, coding style).
- Note missing tests, documentation gaps, dependency concerns.

### Step 5: Philosophy Alignment (Mandatory)
- Assess against **Project Philosophy** (top of this file; SSoT = README.md § Philosophy).
- Verdict per PR: **MATCH / MISMATCH / NEUTRAL** with one-line reasoning.
- MISMATCH default action: request changes or close + redirect to klodr/gmail-mcp - regardless of code quality or security PASS.

### Step 6: Present Findings
- Each PR gets: security verdict, **philosophy verdict**, comment summary, label status, code review findings, recommendation (approve/request changes/close).
- **All tables (PRs and issues) MUST include the author/opener name AND the created date** (last-update date too when it differs meaningfully). Never omit who created the PR/issue or when - the user needs both for context.
- **Pitch decisions one at a time, self-contained, with closed options** (the `angry-king.md` output style this line used to reference does not exist in this environment): one PR at a time, self-contained ≤300-char pitch with date + author, closed A/B/C options, `→ rec:` marked. No technical detail unless asked.

## Merge Flow (When Approving)

**Use GitHub's merge to get the purple "merged" badge - do NOT close manually.**

1. Confirm the PR targets `main` (there is no other base in this fork).
2. If post-merge fixes are needed (indentation, lockfiles, missing annotations, etc.):
   a. Fetch and fix locally on the PR's head branch, push - the PR diff updates automatically.
   b. Or: merge first via GitHub, then commit fixes on top.
3. `gh pr merge {N} --merge` (merge via GitHub - shows purple "merged" badge, credits the contributor)
4. **Verify CI:** `gh run list --branch main --limit 1` - wait for the result. If CI fails, fix before proceeding.
5. Comment on PR explaining security audit result + any post-merge fixes applied.

**Why not manual close:** "Closed" (red) looks like rejection to contributors and doesn't credit their work on their GitHub profile. Always use `gh pr merge` for accepted PRs.

**Post-merge integration test (mandatory for feature PRs):**
After merging a PR that adds new tools or features, rebuild from source (`npm run build`) and test the actual new functionality end-to-end. Do NOT simulate by using existing tools that happen to call the same API - test the actual new code path. For new MCP tools: rebuild, then invoke the tool via the local MCP server or direct `node` execution to verify it returns correct data.

**If `gh pr merge` can't be used (conflicts):** Merge locally, resolve conflicts, push to the target branch. GitHub will auto-detect the PR as merged when the PR's head commit appears in the target branch history. Leave the PR open (don't close manually) - let GitHub close it automatically with the purple badge.

## Staleness Policy

- PRs with "help wanted" label: keep open for up to **8 months from creation** (inherited upstream policy; this fork's maintainer is roylam-beep and may set a different one). Close as stale if no community participation by then.
- Stale PRs without label: assess on a case-by-case basis.

## Issue Review (Same Rules Apply)

🚨 **Issues are DISABLED on this repository** — `gh issue list` fails and there is nothing to triage. `package.json` `bugs.url` still points at an issues page that does not accept issues [needs a decision: point it at the PR list, or enable issues]. The rules below apply if issues are ever turned on.

When scanning issues:
- **Philosophy verdict (MATCH / MISMATCH / NEUTRAL) mandatory per issue**, same heuristics as PRs. Feature requests default MISMATCH -> decline + redirect to klodr/gmail-mcp unless maintainer would use it daily.
- Read all comments.
- Check labels ("help wanted", "needs help", "bug", "enhancement", etc.).
- Assess actionability: is someone working on it? Is it stale? Is help still needed?
- Report findings same as PRs.

## Security Standards (This Project)

**Threat model: local stdio MCP server.** User self-hosts on own machine. LLM client already has full filesystem/shell access. Security audits must account for this context.

Established hardening from commits `95071e7` and `208ce00`:
- CRLF header injection prevention
- OAuth callback localhost binding
- Credential file permission hardening
- Dependency security (npm audit)

**NOT security issues for this project** (local MCP context):
- Path traversal on filesystem operations (LLM already has Bash/Write)
- Filename injection (same reasoning)
- Local XSS in exported files (user opens their own files)
- Symlink following (local user's filesystem)

## CI Verification (Mandatory)

After every push (to any branch), check CI status: `gh run list --branch {branch} --limit 1`
- If CI fails: investigate and fix before moving on. Do NOT leave broken CI.
- **README check:** CI requires a README.md update only when a **non-test** file under `src/` changes. Test-only and config-only changes are exempt automatically — do not reach for `[skip-readme]` out of habit. On a push the flag is honored anywhere in the pushed range; on a PR it is read from the PR title.
- **Build & Test:** Must pass. If it fails, fix the code.
- CI triggers on pushes to `main` and on PRs targeting it. A `claude/*` branch with no open PR gets no run; an empty `gh run list` there is expected.

## Session Hygiene

- **End on `main`** (or on the feature branch whose PR is still open). There is no `experimental` branch to return to.
