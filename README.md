# Fast-Native Agent Data Marketplace v1

Greenfield TypeScript workspace for a Fast-native paid data marketplace.

## Workspace

- `apps/api`: Express gateway with x402 compatibility, wallet auth, docs, provider passthrough routes, and the marketplace-owned Tavily example
- `apps/facilitator`: x402 facilitator service for payment verification
- `apps/web`: Next.js marketplace frontend for service discovery, `SKILL.md`, and suggestion intake
- `apps/worker`: async job poller and refund worker
- `packages/shared`: shared route registry, hashing, auth, payment compatibility, docs, and stores
- `packages/cli`: buyer CLI for wallet, paid invocation, and job retrieval

## Implementation Example

This repo includes a concrete marketplace-owned third-party API integration: `Tavily Search`.

- buyer-facing route: `POST /api/tavily/search`
- upstream route: `POST https://api.tavily.com/search`
- auth: server-side `TAVILY_API_KEY`
- catalog behavior: the Tavily service is only published when `TAVILY_API_KEY` is configured

This is the reference example for "marketplace-operated wrapper" routes in v1. The marketplace owns the public catalog entry, pricing, and payment flow, while the API executes the upstream request with server-held credentials.

## Quick Start

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
export MARKETPLACE_ADMIN_TOKEN=change-me-too
export MARKETPLACE_FAST_NETWORK=mainnet
export MARKETPLACE_WEB_BASE_URL=http://localhost:3001
export TAVILY_API_KEY=tvly-...
```

Optional refund worker variables:

```bash
export MARKETPLACE_TREASURY_PRIVATE_KEY=<fast-ed25519-private-key-hex>
export FAST_RPC_URL=https://api.fast.xyz/proxy
```

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

`MARKETPLACE_FAST_NETWORK` supports `mainnet` or `testnet`. The deployment token is `fastUSDC` on mainnet and `testUSDC` on testnet.

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

7. Use the CLI:

```bash
npm run cli -- wallet init
npm run cli -- wallet address
npm run cli -- invoke mock quick-insight --body '{"query":"alpha"}'
npm run cli -- invoke tavily search --body '{"query":"latest Fast blockchain updates","topic":"general","max_results":5}'
```

8. Build runtime artifacts:

```bash
npm run build
```

9. Start production-style processes:

```bash
npm run start:api
npm run start:facilitator
npm run start:worker
npm run start:web
```

## Docker Deployment

Use the repo-root Docker context with one Dockerfile per service:

- API: `docker/api.Dockerfile`
- Facilitator: `docker/facilitator.Dockerfile`
- Web: `docker/web.Dockerfile`
- Worker: `docker/worker.Dockerfile`

Coolify setup:

- Web service
  - Dockerfile: `docker/web.Dockerfile`
  - Port: `3000`
  - Domain: `fast.8o.vc`
  - Health check: `/`
- API service
  - Dockerfile: `docker/api.Dockerfile`
  - Port: `3000`
  - Domain: `fastapi.8o.vc`
  - Health check: `/openapi.json`
- Facilitator service
  - Dockerfile: `docker/facilitator.Dockerfile`
  - Port: `4020`
  - Domain: `fastfacilitator.8o.vc`
  - Health check: `/supported`
- Worker service
  - Dockerfile: `docker/worker.Dockerfile`
  - No public domain or HTTP listener
  - No HTTP health check

Required API environment:

```bash
DATABASE_URL=postgres://...
MARKETPLACE_TREASURY_ADDRESS=fast1...
MARKETPLACE_FACILITATOR_URL=https://fastfacilitator.example.com
MARKETPLACE_SESSION_SECRET=change-me
MARKETPLACE_ADMIN_TOKEN=change-me-too
MARKETPLACE_FAST_NETWORK=mainnet
MARKETPLACE_BASE_URL=https://fastapi.example.com
MARKETPLACE_WEB_BASE_URL=https://fast.example.com
TAVILY_API_KEY=tvly-...
PORT=3000
```

Required worker environment:

```bash
DATABASE_URL=postgres://...
MARKETPLACE_TREASURY_PRIVATE_KEY=<fast-ed25519-private-key-hex>
MARKETPLACE_FAST_NETWORK=mainnet
FAST_RPC_URL=https://api.fast.xyz/proxy
WORKER_POLL_INTERVAL_MS=5000
```

Facilitator environment:

```bash
FACILITATOR_PORT=4020
FACILITATOR_FAST_RPC_URL=https://api.fast.xyz/proxy
```

Required web environment:

```bash
MARKETPLACE_API_BASE_URL=https://fastapi.example.com
MARKETPLACE_WEB_BASE_URL=https://fast.example.com
MARKETPLACE_ADMIN_TOKEN=change-me-too
MARKETPLACE_FAST_NETWORK=mainnet
PORT=3000
```

If you want both networks, deploy two stacks from the same repo:

- mainnet: `MARKETPLACE_FAST_NETWORK=mainnet`
- testnet: `MARKETPLACE_FAST_NETWORK=testnet`

Keep the web, API, and worker on the same network value inside each stack. The facilitator can stay shared if it supports both Fast networks.

## Website Wallet Login

The web app supports wallet login with the Fast browser extension through `@fastxyz/fast-connector`.

- login happens in the site header via a signed wallet challenge
- this creates a short-lived website session token
- service pages also support in-browser x402 execution for endpoints through the extension
- async browser calls can refresh job results by signing a job-specific challenge with the same wallet

## Scripts

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
