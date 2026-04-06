# Implementation Plan: `#6` GitHub Action / CI Payment Bot

Issue reference: [#29](https://github.com/fastxyz/marketplace/issues/29)

## Summary

Implement `#6` as a Fast-powered CI integration track built on top of the existing local MCP server, not as a standalone payment primitive first.

The first shippable version should:

- use `fast-pay-mcp` inside an existing GitHub Action-based coding/review workflow
- route paid API/tool calls through marketplace-executed Fast services
- use a dedicated CI wallet plus existing local spend controls
- ship as example workflows and setup docs before introducing a separate `fast-pay-action`

This matches the current architecture of this repo:

- `packages/mcp` already exposes a local stdio MCP server for marketplace search/show/call/top-up/job retrieval
- `packages/cli` already enforces local spend controls and route allowlists
- `apps/tavily-service` and `apps/apify-service` already show the thin provider-wrapper pattern we can use for CI-friendly paid tools
- `/me/spend` already provides the buyer-side spend view once CI usage starts

## Product Decision

Do not start by building a generic `fast-pay-action`.

Start with:

1. one recommended CI target
2. one or two Fast-executed services that make sense inside CI
3. one or two ready-to-copy workflow templates

The recommended first target is `anthropics/claude-code-action`, because it already supports MCP-style tool use and maps cleanly to the local stdio MCP model we ship today.

The recommended first Fast services are:

- Tavily-backed search/research
- one Apify-backed async enrichment or scraping workflow

These are already close to production shape in this repo and do not require inventing a new provider model.

## Scope

### In scope for v1

- docs and workflow templates for using `fast-pay-mcp` inside GitHub Actions
- CI-specific setup guidance for Fast wallet secrets and spend controls
- one documented Claude Code Action path
- one documented Gemini CLI path if the first path is straightforward enough
- one or two concrete marketplace service examples for CI use
- test coverage for any MCP or CLI changes needed to make CI usage reliable

### Out of scope for v1

- a hosted MCP server
- a generic hosted Fast billing gateway for arbitrary review bots
- a first-class `fast-pay-action` wrapper
- direct OpenAI-compatible model routing through Fast
- org-wide budget management UI
- custom GitHub App infrastructure

## Recommended User Story

A developer wants a PR workflow that can use paid tools during review or enrichment without storing third-party API keys in GitHub.

They:

1. create a dedicated Fast CI wallet
2. fund it with a small amount
3. configure `FAST_PRIVATE_KEY`, `MARKETPLACE_API_BASE_URL`, and `MARKETPLACE_FAST_NETWORK` as GitHub secrets
4. optionally point `FAST_MARKETPLACE_CONFIG` at a checked-in allowlist/max-per-call config, treating any daily-cap logic as runner-local unless spend state is persisted between jobs
5. run a GitHub Action that launches `fast-pay-mcp`
6. let Claude Code call `marketplace_search` / `marketplace_call` against approved Fast services
7. inspect resulting spend in `/me/spend`

## Implementation Sequence

### Phase 1: Claude Code workflow template

Ship the narrowest useful integration first.

Deliverables:

- a tracked example workflow for Claude Code Action using `fast-pay-mcp`
- setup docs for required GitHub secrets and the local MCP config shape
- one example prompt that uses a Fast service during PR review or issue work
- one example using a sync service and one example using an async service

Recommended new files:

- `docs/claude-code-fast-pay.md`
- `examples/github-actions/claude-code-fast-pay.yml`
- optional checked-in example config such as `examples/fast-marketplace.ci.config.json`

The example workflow should stay outside `.github/workflows/` so it does not auto-run in this repo. Teams can copy it into their own live workflow directory when they adopt it.

Workflow shape:

1. checkout repo
2. install dependencies
3. expose Fast secrets as env
4. launch `fast-pay-mcp` via MCP config
5. run Claude Code Action with a prompt that explicitly allows approved Fast tools
6. post result back to the PR or issue

### Phase 2: CI hardening for MCP usage

Make CI usage reliable and safe without changing the MCP model.

Potential repo changes:

- add a short CLI/MCP-specific CI setup section to `README.md`
- add an example spend-control config for CI
- improve MCP startup/docs around non-interactive environments
- verify that `FAST_MARKETPLACE_CONFIG` works cleanly in ephemeral runners
- document that the current spend ledger is local config state, so cross-run daily caps are not reliable on fresh GitHub runners unless that state is persisted

If code changes are needed, they should stay narrow:

- no hosted state
- no new auth model
- no new server component

### Phase 3: Gemini CLI template

If Phase 1 works cleanly, add a second official example using `google-github-actions/run-gemini-cli`.

This gives a second distribution channel without changing the backend product.

### Phase 4: Thin `fast-pay-action` only if adoption justifies it

Only after the template-based approach proves useful should we consider a wrapper action that mainly:

- installs workspace dependencies or a packaged MCP binary
- writes the MCP config file
- validates required env

This action should remain packaging-only. It should not become a hosted payment layer.

## Concrete Codebase Fit

### Existing components to reuse

`packages/mcp`

- already provides the correct fixed tool surface:
  - `marketplace_search`
  - `marketplace_show`
  - `marketplace_call`
  - `marketplace_topup`
  - `marketplace_get_job`
- already validates local wallet/env config
- already reuses CLI behavior for x402, wallet sessions, async jobs, and spend controls

`packages/cli`

- already has local spend caps and allowlists
- already supports config-driven route restrictions
- persists spend ledger state locally, which means `dailyCap` is runner-local by default in ephemeral CI
- should be the only local policy layer for CI in v1

`apps/tavily-service`

- already demonstrates the thin proxy plus `openapi.json` pattern
- is a strong first CI enrichment tool for research, verification, and context gathering

`apps/apify-service`

- already demonstrates async provider execution
- is a strong second example for queued enrichment or scraping workflows

`apps/web`

- `/me/spend` already provides the buyer control plane once CI workflows start spending

## Proposed Deliverables For The Future Implementation PR

### 1. CI docs

Add a doc page that covers:

- when to use Fast in CI
- required secrets
- example `FAST_MARKETPLACE_CONFIG`
- recommended dedicated-wallet setup
- how to observe spend afterward in `/me/spend`

### 2. Example workflow(s)

Add at least one ready-to-copy example workflow that shows:

- local `fast-pay-mcp` configuration
- one approved paid Fast service
- one review/enrichment prompt

### 3. Example spend controls

Add a checked-in config example for CI such as:

- a strict route allowlist
- a conservative max per call
- one or two approved route keys only

Treat the current `dailyCap` as optional and clearly caveated. It only works as a true cross-run daily budget if the spend ledger persists between CI runs, which default GitHub-hosted runners do not provide.

This is important because CI is autonomous and repeatable by default.

### 4. Optional MCP docs polish

If needed, tighten `packages/mcp` docs to make CI usage explicit:

- stdio only
- user-runner-hosted
- wallet remains local to the runner
- no Coolify deployment needed

## Example V1 Workflow Scenarios

### PR research enrichment

Use Claude Code Action plus Tavily through `fast-pay-mcp` to:

- read the diff
- search docs or public references
- enrich the review with citations or external context

### Async lead or data enrichment

Use Claude Code Action or Gemini CLI plus an Apify-backed Fast route to:

- kick off a job
- poll via `marketplace_get_job`
- summarize results back into a PR comment or issue update

### Repo maintenance bot

Use Fast-paid tools only for explicit high-value steps, not for every workflow run.

Examples:

- vulnerability context lookup
- package-release research
- documentation verification

## Public Interfaces A Future Implementation Would Likely Add

No new backend API is required for the first template-based version.

Likely additions are docs/examples only:

- example workflow YAML under `examples/github-actions/`
- CI setup docs under `docs/`
- optional example spend-control config under `examples/`

If a later thin wrapper action is built, that would likely live as:

- `.github/actions/fast-pay/`
  or
- a separate published GitHub Action repository

That should be a later decision, not part of the first implementation.

## Test Plan For The Future Implementation

### Docs/example verification

- validate example workflow YAML
- ensure example env names match the actual MCP/CLI expectations
- ensure example route refs map to real published services or clearly marked placeholders

### MCP/CLI verification

- `fast-pay-mcp` starts in a non-interactive runner environment
- spend controls still block disallowed CI calls
- async job polling works from a workflow-like environment

### Smoke test

- run one local CI-style script that launches the MCP server with env-only config and executes at least one allowed tool call

## Assumptions / Defaults

- the first CI integration target is Claude Code Action
- Fast remains a tool/API marketplace in CI, not a model router
- `fast-pay-mcp` remains local stdio and runs inside the GitHub runner
- a dedicated Fast wallet is used for CI, not a personal everyday wallet
- local spend controls are mandatory in the recommended setup
- the first examples should use Fast-executed marketplace services we already control or can onboard quickly

## Suggested Next Step

After this plan is approved, the next implementation PR should be scoped to:

1. one docs page
2. one Claude Code example workflow
3. one example spend-control config
4. any minimal MCP/CLI documentation polish required for CI use

That keeps `#6` small, testable, and aligned with the product shape this repo already has.
