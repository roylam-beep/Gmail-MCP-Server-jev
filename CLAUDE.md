# CLAUDE.md - Gmail MCP Server

## Branch Workflow
Single `main`. There is no `experimental` branch in this fork — work on a feature branch, open a PR against `main`.
See `.claude/skills/pr-review-sop/SKILL.md` for the full SOP.

## Repository facts that change what works here
- Issues are **disabled**. `gh issue` calls fail; report through PRs.
- CI runs on pushes to `main` and on PRs targeting it. A push to a `claude/*` branch produces no run — an empty `gh run list` there is normal, not something to wait on.
- The README gate applies only to non-test files under `src/`.
- This is a fork of `ArtyMcLabin/Gmail-MCP-Server` (itself a fork of `GongRzhe/Gmail-MCP-Server`), published as `@geniushub/gmail-mcp`.

## PR & Issue Review
Mandatory security audit on every PR before presenting. See `.claude/skills/pr-review-sop/SKILL.md`.
