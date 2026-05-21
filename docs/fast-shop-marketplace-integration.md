# Fast Shop Marketplace Integration

## Goal

Add some of the APIs already running on `https://marketplace.fast.xyz` / `https://api.marketplace.fast.xyz` to the `shop.fast.xyz` experience, which is run from the local `fast-shop` repo.

The intended integration is not to copy marketplace internals into `fast-shop`. `fast-shop` should understand the marketplace's public catalog and execution contracts, then use the hosted marketplace API for discovery and, where needed, invocation.

## Marketplace Repo Shape

`ai-agent-marketplace` is a Node 20+ TypeScript npm workspace.

- `apps/api`: Express gateway. This is the primary integration surface for `fast-shop`. It serves catalog/docs endpoints and executes marketplace proxy routes.
- `apps/web`: Next.js UI for `marketplace.fast.xyz`. Useful as UI reference, but not the thing `fast-shop` should call.
- `apps/worker`: async job polling, refunds, stale-payment recovery, and provider payout settlement.
- `packages/shared`: shared contracts, route/catalog builders, OpenAPI generation, billing/auth/payment helpers, payout logic, and store behavior.
- `packages/cli`: working buyer/provider CLI. This is the best reference for programmatic marketplace discovery and invocation flows.
- `packages/mcp`: local MCP server that reuses the CLI wallet/payment flow.

## Live Hosts

Use the API host for machine-readable data and execution:

```ts
const MARKETPLACE_API_BASE_URL = "https://api.marketplace.fast.xyz";
```

The website host is mostly presentation:

```txt
https://marketplace.fast.xyz
```

Current important detail: marketplace service pages point executable endpoints at `https://api.marketplace.fast.xyz`, not the bare web host.

## Public API Contract For Fast Shop

Useful marketplace API endpoints:

```txt
GET /catalog/services
GET /catalog/search?q=...&category=...&limit=...
GET /catalog/services/:slug
GET /catalog/routes/:provider/:operation
GET /openapi.json
GET /.well-known/marketplace.json
GET /llms.txt
POST|GET /api/:provider/:operation
GET /api/jobs/:jobToken
```

The key endpoints to start with are:

- `GET /catalog/services`: list all published service summaries.
- `GET /catalog/search`: query/filter service and endpoint matches.
- `GET /catalog/services/:slug`: get service detail, endpoint examples, schemas, prompts, and executable proxy URLs.
- `GET /catalog/routes/:provider/:operation`: get one executable route's detail before invoking it.

## Service Types

Marketplace services have two high-level types.

### `marketplace_proxy`

Executable through the marketplace API. These services expose endpoints with:

- `endpointType: "marketplace_proxy"`
- `ref`, usually `provider.operation`
- `method`
- `path`, for example `/api/apify-google-search/search-results`
- `proxyUrl`, for example `https://api.marketplace.fast.xyz/api/apify-google-search/search-results`
- `billingType`
- `authRequirement`
- `requestSchemaJson`
- `responseSchemaJson`
- `requestExample`
- `responseExample`
- `usageNotes`

Use these when `fast-shop` should actually call marketplace-run APIs.

### `external_registry`

Discovery-only listings. These services expose direct provider metadata:

- `endpointType: "external_registry"`
- `publicUrl`
- `docsUrl`
- `authNotes`
- `requestExample`
- `responseExample`

Do not route these through the marketplace API. Calls go directly to the external provider, and payment/auth are provider-defined.

## Code To Reuse Or Mirror

Use these files as references:

- `apps/api/src/app.ts`: public API routes, especially `/catalog/*`, `/openapi.json`, `/llms.txt`, and `/.well-known/marketplace.json`.
- `apps/web/lib/api.ts`: small fetch wrapper and service detail fetch logic.
- `packages/shared/src/catalog.ts`: source of truth for service detail shape, endpoint shape, `proxyUrl`, prompts, and catalog search output.
- `packages/shared/src/types.ts`: TypeScript interfaces for `ServiceSummary`, `ServiceDetail`, `MarketplaceServiceCatalogEndpoint`, `ExternalServiceCatalogEndpoint`, and `MarketplaceRouteDetail`.
- `packages/cli/src/lib.ts`: reference implementation for route lookup, request construction, x402 handling, wallet-session handling, and job polling.

For `fast-shop`, mirror the small HTTP client pattern from `apps/web/lib/api.ts`, not the marketplace store/admin/provider internals.

## Suggested Fast Shop Client

Add a small module in `fast-shop`, for example `src/marketplace-client.ts`:

```ts
const DEFAULT_MARKETPLACE_API_BASE_URL = "https://api.marketplace.fast.xyz";

function marketplaceBaseUrl(): string {
  return (process.env.MARKETPLACE_API_BASE_URL ?? DEFAULT_MARKETPLACE_API_BASE_URL).replace(/\/$/, "");
}

export async function fetchMarketplace<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${marketplaceBaseUrl()}${path}`, {
    cache: "no-store",
    ...init,
    headers: {
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    throw new Error(await response.text() || `Marketplace request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}
```

Then fetch services or details:

```ts
const { services } = await fetchMarketplace<{ services: ServiceSummary[] }>("/catalog/services");

const detail = await fetchMarketplace<ServiceDetail>(
  "/catalog/services/apify-google-search-scraper"
);
```

## Suggested Fast Shop Product Behavior

Start with discovery/display rather than execution:

1. Keep Fast Shop's own routes as-is: `/search`, `/products/:product_id`, `/quote`, `/orders`, order tracking, and cancellation.
2. Add a "More agent APIs" or "Marketplace APIs" section to the `shop.fast.xyz` page.
3. Source that section from `GET https://api.marketplace.fast.xyz/catalog/search` or `/catalog/services`.
4. Use an allowlist of slugs/categories so only relevant marketplace APIs appear on the shop page.
5. For each selected service, show the service name, tagline, categories, access model, pricing, and endpoint count.
6. For `marketplace_proxy` services, expose endpoint examples or link to the executable `proxyUrl`.
7. For `external_registry` services, link to `publicUrl` or `docsUrl` and avoid implying the marketplace executes those calls.

## If Fast Shop Should Execute Marketplace APIs

For a marketplace route:

1. Fetch route detail:

```txt
GET https://api.marketplace.fast.xyz/catalog/routes/:provider/:operation
```

2. Build the invocation URL:

```txt
https://api.marketplace.fast.xyz/api/:provider/:operation
```

3. For `GET` routes, serialize input fields as query parameters.
4. For `POST` routes, send JSON with `content-type: application/json`.
5. Validate request bodies against `requestSchemaJson` when practical.
6. If the route returns `402`, use `@fastxyz/x402-client` to pay and retry.
7. If the response returns a `jobToken`, poll:

```txt
GET https://api.marketplace.fast.xyz/api/jobs/:jobToken
```

Async job retrieval requires the wallet/session flow described by the marketplace route detail and CLI code.

## Rough Invocation Shape

```ts
async function callMarketplaceRoute(input: {
  provider: string;
  operation: string;
  method: "GET" | "POST";
  body?: unknown;
}) {
  const base = "https://api.marketplace.fast.xyz";
  const url = new URL(`/api/${input.provider}/${input.operation}`, base);

  if (input.method === "GET" && input.body && typeof input.body === "object") {
    for (const [key, value] of Object.entries(input.body as Record<string, unknown>)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return fetch(url, {
    method: input.method,
    headers: input.method === "POST" ? { "content-type": "application/json" } : undefined,
    body: input.method === "POST" ? JSON.stringify(input.body ?? {}) : undefined
  });
}
```

This only covers the raw request. Paid routes still need x402 handling, and async authenticated routes need wallet-session handling. Use `packages/cli/src/lib.ts` as the full reference for those flows.

## What Not To Reuse In Fast Shop

Avoid copying these into `fast-shop`:

- marketplace database/store code
- provider onboarding/admin review code
- payout/refund worker internals
- route registry generation internals
- `apps/web` pages/components wholesale

The clean boundary is: `fast-shop` consumes the hosted marketplace catalog and, for selected `marketplace_proxy` endpoints, calls the hosted marketplace API.

## Practical First Cut

Recommended first implementation in `fast-shop`:

1. Add `MARKETPLACE_API_BASE_URL=https://api.marketplace.fast.xyz`.
2. Add a minimal `marketplace-client.ts`.
3. Fetch `/catalog/search?limit=...` server-side.
4. Filter to selected slugs or categories.
5. Render cards on the homepage.
6. Link each card to the marketplace service detail page or show endpoint examples from `/catalog/services/:slug`.
7. Add tests that mock the marketplace API response and assert the page still renders if the marketplace request fails.

