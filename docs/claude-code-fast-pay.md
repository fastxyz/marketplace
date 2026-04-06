# Fast Pay CI Templates

This repo ships `fast-pay-mcp` as a local stdio MCP server. The recommended first CI integration is still Claude Code, but the same Fast marketplace MCP setup can also be used from Codex and Gemini workflows in GitHub Actions.

The ready-to-copy workflow templates live at:

- [examples/github-actions/claude-code-fast-pay.yml](../examples/github-actions/claude-code-fast-pay.yml)
- [examples/github-actions/codex-fast-pay.yml](../examples/github-actions/codex-fast-pay.yml)
- [examples/github-actions/gemini-fast-pay.yml](../examples/github-actions/gemini-fast-pay.yml)

They stay outside `.github/workflows/` on purpose so they do not run in this repo by default.

## What This Template Covers

- `npm ci` on a GitHub-hosted runner
- inline MCP config for `fast-pay-mcp`
- a dedicated Fast CI wallet passed in through GitHub secrets
- local spend controls through `FAST_MARKETPLACE_CONFIG`
- one sync route example and one async route example
- post-run spend review through `/me/spend`

## Supported Runners

### Claude Code

- Action: `anthropics/claude-code-base-action`
- Auth: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`
- MCP config: inline `mcp_config`

### Codex

- Action: `openai/codex-action`
- Auth: `OPENAI_API_KEY`
- MCP config: `config.toml` inside `codex-home`

There is no GitHub Actions equivalent of Claude Code OAuth for Codex in the official action today. The supported production path is API-key based.

### Gemini

- Action: `google-github-actions/run-gemini-cli`
- Auth: `GEMINI_API_KEY`
- MCP config: `settings` written to `.gemini/settings.json`

## Required GitHub Secrets

Add these as repository or organization Actions secrets before copying the example workflow into a live repo:

- `MARKETPLACE_API_BASE_URL`: Fast marketplace API base URL, for example `https://api.marketplace.fast.xyz`
- `MARKETPLACE_FAST_NETWORK`: `mainnet` or `testnet`
- `FAST_PRIVATE_KEY`: dedicated CI wallet private key as a 32-byte hex string

Then add the runner-specific model credential:

- Claude: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`
- Codex: `OPENAI_API_KEY`
- Gemini: `GEMINI_API_KEY`

Do not reuse a personal day-to-day wallet for CI. Use a dedicated wallet with a small balance and narrow local spend controls.

## Recommended CI Config

Point `FAST_MARKETPLACE_CONFIG` at a checked-in config file such as [examples/fast-marketplace.ci.config.json](../examples/fast-marketplace.ci.config.json).

The recommended baseline is:

- strict route allowlist
- conservative `maxPerCall`
- optional `manualApprovalAbove` only for attended runs
- optional `dailyCap` with a runner-local caveat

`dailyCap` is stored in the local CLI config ledger. On default GitHub-hosted runners that state does not persist across jobs, so `dailyCap` is not a reliable cross-run budget unless you add your own persistence layer.

## Supported Route Shapes

`fast-pay-mcp` exposes the following tools:

- `marketplace_search`
- `marketplace_show`
- `marketplace_call`
- `marketplace_topup`
- `marketplace_get_job`

The template currently standardizes on this pair:

- sync: `tavily.search`
- async: `apify-google-search.search-results`

The template assumes two common CI paths:

1. A sync enrichment call, for example research or documentation lookup through a Fast-executed proxy route
2. An async job kickoff followed by `marketplace_get_job` polling

Both refs map to currently deployed marketplace-operated services:

- `tavily.search` from the Tavily proxy at `fast-mainnet-provider-tavily`
- `apify-google-search.search-results` from the Google Search Results Scraper at `fast-provider-apify-google-search`

## Workflow Notes

- The templates run the MCP server from source with `npx tsx packages/mcp/src/index.ts`. That avoids requiring a prebuilt published MCP package.
- The runner still needs this repo checked out because the MCP server and CLI live in the workspace.
- The Claude example uses `anthropics/claude-code-base-action@beta` because it has an explicit `mcp_config` input for inline stdio server setup.
- The Codex example uses `openai/codex-action@v1` and writes a `config.toml` into `codex-home` before invoking the action.
- The Gemini example uses `google-github-actions/run-gemini-cli@v0` and passes an inline `settings` JSON payload with `mcpServers`.
- Keep the templates outside `.github/workflows/` until you are ready to run them for real.

## Minimal Adoption Steps

1. Copy one of the templates into your repo’s `.github/workflows/`
   - [examples/github-actions/claude-code-fast-pay.yml](../examples/github-actions/claude-code-fast-pay.yml)
   - [examples/github-actions/codex-fast-pay.yml](../examples/github-actions/codex-fast-pay.yml)
   - [examples/github-actions/gemini-fast-pay.yml](../examples/github-actions/gemini-fast-pay.yml)
2. Confirm the route refs still match the published marketplace services in your target environment
3. Add the required GitHub secrets for the selected runner
4. Fund the dedicated CI wallet
5. Start with `workflow_dispatch` before enabling automatic PR triggers

After the first run, review marketplace spend in the wallet-authenticated spend dashboard at `/me/spend`.

## Local Verification

Use the smoke check below to verify the non-interactive stdio path locally:

```bash
npm run test:mcp:ci-smoke
```

That command launches `fast-pay-mcp` as a subprocess, connects to it over stdio, and exercises a mock marketplace route with env-only wallet configuration.
