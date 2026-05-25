---
name: fast-marketplace-external-registry-monitoring
description: Use when a Fast operator wants to run or schedule an external_registry provider test or monitoring run for the Fast agents marketplace, record results in the testing ledger, inspect failures, or verify the weekly marketplace API monitoring job from a local Codex workspace.
---

# Fast Marketplace External Registry Monitoring

Use this skill from the `fastxyz/marketplace` repo when running operator checks for published `external_registry` services.

## Scope

- Run metadata, no-spend, monitoring, or paid-read smoke test runs through the marketplace admin API.
- Record results in the provider service testing ledger.
- Use bulk monitoring for published external registry services.
- Keep provider import artifacts and private review state out of commits.

## Required Context

Run commands from the marketplace repo root.

Required environment:

```bash
MARKETPLACE_API_BASE_URL=https://api.marketplace.fast.xyz
MARKETPLACE_ADMIN_TOKEN=<admin token>
```

Optional environment:

```bash
EXTERNAL_REGISTRY_MONITOR_MODE=monitoring
EXTERNAL_REGISTRY_MONITOR_EXECUTE=true
EXTERNAL_REGISTRY_MONITOR_FAIL_ON_ALERT=true
EXTERNAL_REGISTRY_MONITOR_MAX_SPEND=<decimal USDC budget for paid-read only>
```

## Safety Contract

External registry listings are discovery-only in this marketplace.

- Do not fetch provider-controlled external endpoint URLs from the marketplace API process.
- Do not pay external registry providers from the marketplace API process.
- Do not call mutating endpoints.
- Treat monitoring as ledger-backed metadata and manifest verification unless the marketplace implementation explicitly adds a reviewed execution boundary.
- MPP listings may check the machine-readable MPP service manifest for service and payment metadata.

## Standard Weekly Monitoring Run

For the normal external registry monitor, run:

```bash
npm run cli -- provider test \
  --all-external \
  --mode monitoring \
  --execute \
  --fail-on-alert \
  --api-url "$MARKETPLACE_API_BASE_URL"
```

Expected behavior:

- Published external registry services are included.
- Endpoint metadata is recorded in the testing ledger.
- Marketplace-side live endpoint execution is skipped for discovery-only listings.
- MPP listings also check the machine-readable MPP service manifest and payment metadata.
- Failed, degraded, errored, or blocked results should alert.

## Railway/Cron Entrypoint

If using the bundled monitor process, run:

```bash
EXTERNAL_REGISTRY_MONITOR_MODE=monitoring \
EXTERNAL_REGISTRY_MONITOR_EXECUTE=true \
EXTERNAL_REGISTRY_MONITOR_FAIL_ON_ALERT=true \
npm run dev:external-registry-monitor
```

After `npm run build`, the production entrypoint is:

```bash
FAST_PROCESS_SCRIPT=start:external-registry-monitor npm run start:external-registry-monitor
```

For Railway Docker services using `docker/api.Dockerfile`, set:

```bash
FAST_PROCESS_SCRIPT=start:external-registry-monitor
EXTERNAL_REGISTRY_MONITOR_MODE=monitoring
EXTERNAL_REGISTRY_MONITOR_EXECUTE=true
EXTERNAL_REGISTRY_MONITOR_FAIL_ON_ALERT=true
MARKETPLACE_API_BASE_URL=https://api.marketplace.fast.xyz
MARKETPLACE_ADMIN_TOKEN=<admin token>
```

## Single-Service Checks

Plan a run:

```bash
npm run cli -- provider test-plan --service <slug-or-id> --api-url "$MARKETPLACE_API_BASE_URL"
```

Run one service:

```bash
npm run cli -- provider test \
  --service <slug-or-id> \
  --mode monitoring \
  --execute \
  --api-url "$MARKETPLACE_API_BASE_URL"
```

Inspect prior runs:

```bash
npm run cli -- provider test-results \
  --service <slug-or-id> \
  --limit 20 \
  --api-url "$MARKETPLACE_API_BASE_URL"
```

## Paid Read Smoke Tests

Paid-read tests are currently blocked for external registry listings because those listings are discovery-only and marketplace-side external execution is disabled.

If an operator still needs to record a paid-read attempt, use an explicit budget so the ledger records the blocked state:

```bash
npm run cli -- provider test \
  --service <slug-or-id> \
  --mode paid-read \
  --execute \
  --max-spend 0.05 \
  --api-url "$MARKETPLACE_API_BASE_URL"
```

Guardrails:

- Mutating endpoints are blocked.
- High-risk services are blocked.
- Missing or non-positive budgets are blocked.
- Discovery-only external registry execution is blocked even with a budget.
- The marketplace API should not spend funds on external registry testing.

## Result Handling

When a run finishes:

- Parse the JSON `alert` object for bulk runs.
- Treat `alert.shouldAlert: true` as requiring operator review.
- Summarize affected services by `slug`, `status`, and `summary`.
- Do not commit generated provider specs, bulk sync JSON, or `.tmp/` operator state.

## Verification

If the code changed before a monitoring run, run:

```bash
npm run typecheck
npm test -- apps/api/src/app.test.ts packages/shared/src/shared.test.ts packages/cli/src/provider.test.ts packages/cli/src/index.test.ts
```

For release confidence, run:

```bash
npm run build
npm test
```
