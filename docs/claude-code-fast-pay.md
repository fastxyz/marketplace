# Claude Code Fast Pay CI Template

This repo ships `fast-pay-mcp` as a local stdio MCP server. The recommended first CI integration is to run that MCP server inside the GitHub runner and let Claude Code call marketplace tools through a dedicated Fast wallet.

The ready-to-copy workflow template lives at [examples/github-actions/claude-code-fast-pay.yml](/Users/chris/Documents/Workspace/ai-agent-marketplace/examples/github-actions/claude-code-fast-pay.yml). It stays outside `.github/workflows/` on purpose so it does not run in this repo by default.

## What This Template Covers

- `npm ci` on a GitHub-hosted runner
- inline MCP config for `fast-pay-mcp`
- a dedicated Fast CI wallet passed in through GitHub secrets
- local spend controls through `FAST_MARKETPLACE_CONFIG`
- one sync route example and one async route example
- post-run spend review through `/spend`

## Required GitHub Secrets

Add these as repository or organization Actions secrets before copying the example workflow into a live repo:

- `ANTHROPIC_API_KEY`: Claude Code model access
- `MARKETPLACE_API_BASE_URL`: Fast marketplace API base URL, for example `https://api.marketplace.fast.xyz`
- `MARKETPLACE_FAST_NETWORK`: `mainnet` or `testnet`
- `FAST_PRIVATE_KEY`: dedicated CI wallet private key as a 32-byte hex string

Do not reuse a personal day-to-day wallet for CI. Use a dedicated wallet with a small balance and narrow local spend controls.

## Recommended CI Config

Point `FAST_MARKETPLACE_CONFIG` at a checked-in config file such as [examples/fast-marketplace.ci.config.json](/Users/chris/Documents/Workspace/ai-agent-marketplace/examples/fast-marketplace.ci.config.json).

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

The template assumes two common CI paths:

1. A sync enrichment call, for example research or documentation lookup through a Fast-executed proxy route
2. An async job kickoff followed by `marketplace_get_job` polling

The checked-in example route refs are placeholders. Replace them with published route refs from your marketplace environment before enabling the workflow in a live repository.

## Workflow Notes

- The template runs the MCP server from source with `npx tsx packages/mcp/src/index.ts`. That avoids requiring a prebuilt published MCP package.
- The runner still needs this repo checked out because the MCP server and CLI live in the workspace.
- The example uses `anthropics/claude-code-base-action@beta` because it has an explicit `mcp_config` input for inline stdio server setup. Once teams are happy with the template, they can wrap the same MCP config in a higher-level Claude Code workflow.
- Keep the workflow outside `.github/workflows/` until you are ready to run it for real.

## Minimal Adoption Steps

1. Copy [examples/github-actions/claude-code-fast-pay.yml](/Users/chris/Documents/Workspace/ai-agent-marketplace/examples/github-actions/claude-code-fast-pay.yml) into your repo’s `.github/workflows/`
2. Replace the placeholder route refs in the prompt and allowlist config
3. Add the required GitHub secrets
4. Fund the dedicated CI wallet
5. Start with `workflow_dispatch` before enabling automatic PR triggers

After the first run, review marketplace spend in the wallet-authenticated spend dashboard at `/spend`.

## Local Verification

Use the smoke check below to verify the non-interactive stdio path locally:

```bash
npm run test:mcp:ci-smoke
```

That command launches `fast-pay-mcp` as a subprocess, connects to it over stdio, and exercises a mock marketplace route with env-only wallet configuration.
