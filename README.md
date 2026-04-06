# Fast-Native Agent Data Marketplace

Fast-native data marketplace using [`@fastxyz/sdk`](https://www.npmjs.com/package/@fastxyz/sdk), [`@fastxyz/x402-client`](https://www.npmjs.com/package/@fastxyz/x402-client), and [`@fastxyz/fast-connector`](https://www.npmjs.com/package/@fastxyz/fast-connector).

## Architecture

- `apps/api`: Express gateway for public catalog discovery, provider/admin workflows, wallet auth, and marketplace-executed API routes
- `apps/web`: Next.js frontend for the marketplace catalog, provider dashboard, and admin review surfaces
- `apps/worker`: background processing for async jobs, treasury refunds, stale-payment recovery, and provider payout settlement
- `apps/facilitator`: x402 facilitator service used for payment verification
- `apps/tavily-service`: optional standalone Tavily-backed provider example that can be onboarded through the website like any other provider service. See [`apps/tavily-service/README.md`](./apps/tavily-service/README.md)
- `packages/shared`: source of truth for shared contracts, route registry, catalog/docs generation, auth, billing, payout logic, and store behavior
- `packages/cli`: buyer and provider CLI for discovery-first marketplace search/show/use flows, wallet setup, provider draft sync/verification/submission, and job retrieval
- `packages/mcp`: local stdio MCP server for agent clients that reuses the marketplace CLI wallet and payment flow

## Billing Model

Marketplace-executed routes use one of four billing modes:

- `fixed_x402`: standard paid route; buyer sends the request, gets `402 Payment Required`, pays with x402, then retries the same request
- `topup_x402_variable`: buyer supplies an amount in the request body, pays that exact amount with x402, and receives marketplace-managed service credit
- `prepaid_credit`: buyer first funds service credit, then invokes the route with wallet-session bearer auth instead of paying x402 on every call
- `free`: buyer invokes the marketplace route without x402 payment; async free routes still use wallet-session auth for job-bound retrieval

Discovery-only `external_registry` listings do not use marketplace billing. They publish direct provider URLs and the provider defines payment and auth outside the marketplace.

## Settlement Model

Marketplace-executed `marketplace_proxy` services publish under `verified_escrow`:

- `verified_escrow`: buyer pays marketplace treasury, marketplace can refund failures, reconcile stale payments, support free routes, variable top-ups, prepaid credit, async jobs, and settle provider payouts later

Marketplace-operated and provider-authored `marketplace_proxy` services use `verified_escrow` in the current cutover, and can publish `fixed_x402`, `free`, `topup_x402_variable`, `prepaid_credit`, and async routes.

For `verified_escrow`, successful route charges and top-ups create provider payout records, and the worker batches and sends those payouts on Fast.

`external_registry` services do not use marketplace settlement. They are discovery-only listings and are never executed by the marketplace.

## Persona Flows

### External API Provider

- Creates a service as `external_registry`
- Adds direct `GET` or `POST` endpoint listings with `publicUrl`, `docsUrl`, auth notes, and examples
- Does not need website verification to submit
- Submits for admin review
- After publish, appears in the catalog as a discovery-only external API
- Marketplace does not proxy calls, collect payment, mint runtime auth, or track execution analytics

### Verified Escrow API Provider

- Starts with the same onboarding flow as the External API provider, but publishes as a marketplace-hosted `marketplace_proxy` service
- Admin publishes with `verified_escrow`
- Marketplace acts as execution and settlement middleman
- Supports the broader marketplace-managed billing, refund, payout, and async/prepaid flows

### Marketplace Admin

- Log in at `/admin/login`
- Reviews submitted provider services
- Checks service completeness and website verification where required
- Requests changes or publishes
- Publishes discovery-only metadata for `external_registry` services
- Publishes `marketplace_proxy` services as `verified_escrow`
- Can later suspend live services

### Human User

- Browses one shared marketplace catalog
- Sees marketplace-hosted services with pricing, settlement badges, metrics, and runnable proxy routes
- Sees external services with an `External API` label, direct URLs, docs links, and auth notes
- Uses marketplace-hosted services through the marketplace
- Uses external services by going directly to the provider

### Agent User

- Discovers services through catalog pages, `llms.txt`, and `.well-known/marketplace.json`
- Uses marketplace execution prompts and `SKILL.md` for marketplace-hosted services
- Calls marketplace routes when the service is executable by the marketplace
- Uses direct-integration prompts for external services instead
- Calls the provider directly for discovery-only external services

## Development

### Quick Start

1. Install dependencies:

```bash
npm install
```

2. Set environment variables:

```bash
export DATABASE_URL=postgres://localhost:5432/fast_marketplace
export MARKETPLACE_TREASURY_ADDRESS=fast1...
export MARKETPLACE_FACILITATOR_URL=http://localhost:4020
export MARKETPLACE_SESSION_SECRET=change-me
export MARKETPLACE_SECRETS_KEY=change-me-again
export MARKETPLACE_ADMIN_TOKEN=change-me-too
export MARKETPLACE_FAST_NETWORK=mainnet
export MARKETPLACE_WEB_BASE_URL=http://localhost:3001
```

Use long random values for `MARKETPLACE_SESSION_SECRET` and `MARKETPLACE_SECRETS_KEY`.

Optional refund worker variables:

```bash
export MARKETPLACE_TREASURY_PRIVATE_KEY=<fast-ed25519-private-key-hex>
export FAST_RPC_URL=https://api.fast.xyz/proxy
```

`MARKETPLACE_SECRETS_KEY` is required. It is used for provider runtime keys, encrypted upstream secrets, and signed marketplace identity headers for Community/direct and prepaid-credit providers.

Optional facilitator variables:

```bash
export FACILITATOR_PORT=4020
export FACILITATOR_FAST_RPC_URL=https://api.fast.xyz/proxy
export FACILITATOR_EVM_PRIVATE_KEY=<evm-private-key-if-you-later-enable-evm-settlement>
```

Optional frontend variables:

```bash
export MARKETPLACE_API_BASE_URL=http://localhost:3000
```

`MARKETPLACE_FAST_NETWORK` supports `mainnet` or `testnet`. Marketplace routes use `USDC` on mainnet and `testUSDC` on testnet. For paid calls, treat the `402` response `accepts[*].asset` field as authoritative over any nickname.

3. Run the facilitator:

```bash
npm run dev:facilitator
```

4. Run the API:

```bash
npm run dev:api
```

5. Run the worker:

```bash
npm run dev:worker
```

6. Run the web app:

```bash
npm run dev:web
```

7. Optional: run the standalone Tavily provider example:

See [`apps/tavily-service/README.md`](./apps/tavily-service/README.md) for the full setup and onboarding flow.

```bash
export TAVILY_API_KEY=tvly-...
export TAVILY_API_BASE_URL=https://api.tavily.com
export TAVILY_SERVICE_PORT=4030
npm run dev:tavily-service
```

This service is not wired into `apps/api`. To use it, create a `marketplace_proxy` provider service in the web UI, import `http://localhost:4030/openapi.json` or your deployed host's `/openapi.json`, review the imported Tavily endpoint drafts, and serve the marketplace website-verification token from `/.well-known/fast-marketplace-verification.txt` by setting `MARKETPLACE_VERIFICATION_TOKEN` on that service. Provider website verification still expects an HTTPS host.

8. Use the CLI:

```bash
npm run cli -- wallet init
npm run cli -- search "quick insight"
npm run cli -- show mock-research-signals
npm run cli -- show mock.quick-insight
npm run cli -- use mock.quick-insight --input '{"query":"alpha"}'
npm run cli -- job get <jobToken>
```

The buyer CLI is discovery-first. `search` and `show` only consume machine-readable catalog APIs, and `use` fetches route detail first before executing through the existing x402 or wallet-session flow. Payable routes still use `@fastxyz/x402-client@^0.1.2` under the hood.

For provider-authored top-up routes, pass the amount in `--input`. For prepaid-credit routes, fund credit first and then call the prepaid route with `use`; the CLI will mint a route-scoped wallet session automatically when the route requires bearer auth. Async free routes also use wallet-session auth and return a `jobToken` for `job get`.

Async retrieval uses a second wallet challenge flow scoped to the `jobToken`. Poll `GET /api/jobs/:jobToken` with `Authorization: Bearer <accessToken>` from the same wallet that paid for or authorized the original trigger. The default poll interval is `5000` ms.

### Local MCP Server

`fast-pay-mcp` is a local stdio MCP server. It is not hosted by the marketplace and does not require a server deployment. The user or agent runner starts it locally, and it calls the hosted marketplace API with the user's Fast wallet.

Required environment:

```bash
export MARKETPLACE_API_BASE_URL=http://localhost:3000
export MARKETPLACE_FAST_NETWORK=mainnet
export FAST_PRIVATE_KEY=<32-byte-hex-private-key>
# or: export FAST_KEYFILE_PATH=~/.fast/keys/default.json
# optional: export FAST_MARKETPLACE_CONFIG=~/.fast-marketplace/config.json
```

Typical MCP client config:

```json
{
  "mcpServers": {
    "fast-pay": {
      "command": "fast-pay-mcp",
      "env": {
        "MARKETPLACE_API_BASE_URL": "https://api.marketplace.fast.xyz",
        "MARKETPLACE_FAST_NETWORK": "mainnet",
        "FAST_PRIVATE_KEY": "<private key hex>"
      }
    }
  }
}
```

V1 MCP tools:

- `marketplace_search`
- `marketplace_show`
- `marketplace_call`
- `marketplace_topup`
- `marketplace_get_job`

The MCP server reuses the CLI wallet loader and spend controls. If `FAST_MARKETPLACE_CONFIG` points at a CLI config with spend controls, MCP calls enforce the same limits.

For GitHub Actions and Claude Code runner setup, use:

- [docs/claude-code-fast-pay.md](docs/claude-code-fast-pay.md)
- [examples/github-actions/claude-code-fast-pay.yml](examples/github-actions/claude-code-fast-pay.yml)
- [examples/fast-marketplace.ci.config.json](examples/fast-marketplace.ci.config.json)

Provider-agent workflow:

```bash
cp .env.example .env
```

Set `AGENT_WALLET_KEY`, `MARKETPLACE_API_BASE_URL`, and `MARKETPLACE_FAST_NETWORK` in `.env`, then create a provider spec JSON and run:

```bash
npm run cli -- provider sync --spec ./provider-spec.json
npm run cli -- provider submit --service <slug-or-id>
```

For `marketplace_proxy` services, run verification before submit:

```bash
npm run cli -- provider verify --service <slug-or-id>
```

`provider verify` always creates a fresh verification challenge and prompts before the marketplace attempts verification. For arbitrary external sites, host the token outside this repo first; the CLI will not mutate deploy, DNS, or cloud env settings on its own. Discovery-only `external_registry` services can submit without verification and still wait in `pending_review` until an admin publishes them.

For curated x402 imports, keep local `ProviderSyncSpec` seed files under a gitignored path and use the normal `provider sync` plus `provider submit` flow with a Fast-operated provider account.

9. Build runtime artifacts:

```bash
npm run build
```

10. Start production-style processes:

```bash
npm run start:api
npm run start:facilitator
npm run start:tavily-service
npm run start:worker
npm run start:web
```

### Docker Deployment

Use the repo-root Docker context with one Dockerfile per service:

- API: `docker/api.Dockerfile`
- Facilitator: `docker/facilitator.Dockerfile`
- Web: `docker/web.Dockerfile`
- Worker: `docker/worker.Dockerfile`

`fast-pay-mcp` is local stdio only and is not deployed with Docker or Coolify.

Required API environment:

```bash
DATABASE_URL=postgres://...
MARKETPLACE_TREASURY_ADDRESS=fast1...
MARKETPLACE_FACILITATOR_URL=https://fastfacilitator.example.com
MARKETPLACE_SESSION_SECRET=change-me
MARKETPLACE_ADMIN_TOKEN=change-me-too
MARKETPLACE_SECRETS_KEY=change-me-again
MARKETPLACE_FAST_NETWORK=mainnet
MARKETPLACE_BASE_URL=https://api.marketplace.fast.xyz
MARKETPLACE_WEB_BASE_URL=https://marketplace.fast.xyz
PORT=3000
```

Required worker environment:

```bash
DATABASE_URL=postgres://...
MARKETPLACE_TREASURY_PRIVATE_KEY=<fast-ed25519-private-key-hex>
MARKETPLACE_SECRETS_KEY=change-me-again
MARKETPLACE_FAST_NETWORK=mainnet
FAST_RPC_URL=https://api.fast.xyz/proxy
WORKER_POLL_INTERVAL_MS=5000
```

The worker now handles:

- async job polling and completion
- treasury refunds for failed jobs and unrecoverable stale paid requests
- provider payout settlement for route charges and top-up purchases

Facilitator environment:

```bash
FACILITATOR_PORT=4020
FACILITATOR_FAST_RPC_URL=https://api.fast.xyz/proxy
```

Required web environment:

```bash
MARKETPLACE_API_BASE_URL=https://api.marketplace.fast.xyz
MARKETPLACE_WEB_BASE_URL=https://marketplace.fast.xyz
MARKETPLACE_ADMIN_TOKEN=change-me-too
MARKETPLACE_FAST_NETWORK=mainnet
PORT=3000
```

If you want both networks, deploy two stacks from the same repo:

- mainnet: `MARKETPLACE_FAST_NETWORK=mainnet`
- testnet: `MARKETPLACE_FAST_NETWORK=testnet`

Keep the web, API, and worker on the same network value inside each stack. The facilitator can stay shared if it supports both Fast networks.

### Provider Credit Runtime

Provider runtime keys are used in three cases:

- `verified_escrow` HTTP routes that require signed marketplace identity: the marketplace forwards signed buyer identity headers so the provider can trust the requester wallet and `X-MARKETPLACE-REQUEST-ID`
- `verified_escrow` async HTTP routes: the marketplace signs async execute and poll requests, injects `X-MARKETPLACE-JOB-TOKEN`, and can inject webhook callback auth for provider completion
- `verified_escrow` prepaid-credit routes: the provider uses the runtime credit APIs to reserve, capture, and release marketplace-held credit

Provider runtime key operations:

- rotate a runtime key from the provider service dashboard or `POST /provider/services/:id/runtime-key`
- marketplace forwards signed buyer identity headers to the provider upstream when the settlement flow requires them
- async HTTP providers can complete webhook jobs through `POST /provider/runtime/jobs/:jobToken/callback`
- provider backends reserve, capture, and release buyer credit through:
  - `POST /provider/runtime/credits/reserve`
  - `POST /provider/runtime/credits/:reservationId/capture`
- `POST /provider/runtime/credits/:reservationId/release`
- `POST /provider/runtime/credits/:reservationId/extend`
- top-up purchases recognize provider revenue at purchase time; later credit consumption does not create a second provider payout

Webhook async providers require an HTTPS `MARKETPLACE_BASE_URL` so the marketplace can inject a callback URL during execute.

### Scripts

- `npm run typecheck`: typecheck the workspace
- `npm run build`: typecheck and emit runtime bundles into `dist`
- `npm run build:runtime`: emit runtime bundles into `dist`
- `npm run build:web`: build the Next.js frontend
- `npm run test`: run unit and integration tests
- `npm run test:web:smoke`: run the browser smoke suite against the built frontend
- `npm run dev:api`: run the API with `tsx`
- `npm run dev:facilitator`: run the facilitator with `tsx`
- `npm run dev:worker`: run the worker with `tsx`
- `npm run dev:web`: run the Next.js frontend
- `npm run start:api`: run the built API bundle
- `npm run start:facilitator`: run the built facilitator bundle
- `npm run start:worker`: run the built worker bundle
- `npm run start:web`: run the Next.js frontend
- `npm run cli -- ...`: run the buyer CLI
