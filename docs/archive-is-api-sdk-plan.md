# Archive.is API and SDK Plan

## Goal

Build a small, maintainable Archive.is-compatible client and marketplace provider so a user or agent can submit a URL and receive the known archived pages for that URL.

The first useful operation is archive lookup, not snapshot creation:

- input: a web address
- output: a normalized list of archived captures with capture timestamps and archive URLs
- marketplace route: `POST /api/archive-is/list-snapshots`

This should replace the need for depending on old, unmaintained Archive.is wrappers such as [`HRDepartment/archivetoday`](https://github.com/HRDepartment/archivetoday), while keeping the implementation narrow enough to ship and test.

## Product Decision

Start with a read-only lookup API backed by Archive.today/Archive.is TimeMap-style responses.

Do not start by automating snapshot submission. Archive.today submission paths are more likely to involve bot checks, captchas, or unstable HTML flows. Listing existing captures is the safer and more agent-useful v1 because it can support research, citation checking, and historical-page discovery without pretending Archive.today is a stable official API.

## Public Interface

### SDK package

Add a workspace package:

- `packages/archive-is`

Recommended exported API:

```ts
type ArchiveSnapshot = {
  originalUrl: string;
  archiveUrl: string;
  capturedAt: string;
  archiveId: string | null;
  sourceHost: string;
};

type ListSnapshotsInput = {
  url: string;
  limit?: number;
  from?: string;
  to?: string;
  archiveHost?: "archive.today" | "archive.is" | "archive.ph";
};

type ListSnapshotsResult = {
  originalUrl: string;
  normalizedUrl: string;
  sourceHost: string;
  count: number;
  snapshots: ArchiveSnapshot[];
};

async function listSnapshots(input: ListSnapshotsInput, options?: ArchiveClientOptions): Promise<ListSnapshotsResult>;
```

The SDK should be plain TypeScript with no marketplace dependencies. That keeps it reusable by the API service, tests, and any future direct user SDK.

### Provider service

Add a standalone provider wrapper:

- `apps/archive-is-service`

Recommended public routes:

- `POST /snapshots`
- `GET /openapi.json`
- `GET /.well-known/fast-marketplace-verification.txt`

The service follows the existing `apps/tavily-service` and `apps/apify-service` pattern: it owns upstream interaction, exposes marketplace-friendly OpenAPI, and is onboarded into the marketplace as a `marketplace_proxy` service.

### Marketplace route

Once the provider is deployed and verified, publish one route:

- provider: `archive-is`
- operation: `list-snapshots`
- method: `POST`
- mode: `sync`
- billing: `fixed_x402`
- settlement: `verified_escrow`

Example request:

```json
{
  "url": "https://example.com/articles/launch",
  "limit": 20
}
```

Example response:

```json
{
  "originalUrl": "https://example.com/articles/launch",
  "normalizedUrl": "https://example.com/articles/launch",
  "sourceHost": "archive.today",
  "count": 2,
  "snapshots": [
    {
      "originalUrl": "https://example.com/articles/launch",
      "archiveUrl": "https://archive.today/20240501120000/https://example.com/articles/launch",
      "capturedAt": "2024-05-01T12:00:00.000Z",
      "archiveId": "20240501120000",
      "sourceHost": "archive.today"
    }
  ]
}
```

## Implementation Sequence

### Phase 1: SDK and fixtures

Create `packages/archive-is` first.

Deliverables:

- URL validation and normalization
- configurable Archive.today mirror host
- TimeMap request construction
- parser for Memento `Link` header/body style responses
- deterministic sorting by capture time descending
- optional filtering by `from`, `to`, and `limit`
- typed errors for invalid input, upstream timeout, upstream rate limit, parse failure, and no captures
- fixture-based unit tests for representative TimeMap responses

The parser should be fixture-driven. Archive.today is unofficial and can change behavior, so tests should lock down our normalization and parsing contract rather than relying on live network calls.

### Phase 2: Standalone provider wrapper

Create `apps/archive-is-service` after the SDK contract is stable.

Deliverables:

- Express app with `POST /snapshots`
- Zod or JSON-schema validation matching the SDK input
- service-level timeout, retry, and user-agent configuration
- `GET /openapi.json` generated from the same route schema used by the app
- provider verification file support through `MARKETPLACE_VERIFICATION_TOKEN`
- app tests with mocked SDK responses and mocked SDK failures
- README with local run and marketplace onboarding instructions

Environment:

```bash
export ARCHIVE_IS_SERVICE_PORT=4050
export ARCHIVE_IS_BASE_HOST=archive.today
export ARCHIVE_IS_TIMEOUT_MS=10000
export MARKETPLACE_VERIFICATION_TOKEN=...
```

### Phase 3: Marketplace registration

Wire the new provider into the marketplace through the normal source-of-truth path.

Deliverables:

- provider spec template under `apps/archive-is-service/`
- seeded or imported service metadata where appropriate
- generated route docs through the existing shared catalog/OpenAPI/docs pipeline
- `llms.txt` and `.well-known/marketplace.json` coverage from the existing registry generation path
- CLI compatibility through the existing `npm run cli -- use archive-is.list-snapshots --input ...` flow

Keep the public marketplace surface Fast-only for v1. Do not add a separate API-key auth model.

### Phase 4: Optional snapshot creation

Only add snapshot creation after lookup is stable and operationally understood.

Before implementation, validate:

- whether Archive.today exposes a stable non-captcha submission path
- expected user consent and rate limits
- whether the operation should be async
- whether failed submissions can be refunded reliably

If built, publish it as a separate operation such as `archive-is.create-snapshot`, not as a hidden mode inside `list-snapshots`.

## Data Handling Rules

- Preserve the user-submitted URL in `originalUrl`.
- Normalize only for the upstream lookup and return the normalized query value separately.
- Do not strip query strings or fragments unless Archive.today requires it and the behavior is documented.
- Return absolute archive URLs only.
- Prefer ISO 8601 timestamps in UTC.
- Do not return raw upstream HTML or unbounded upstream response bodies.
- Cap `limit` with a conservative default, for example default `20` and maximum `100`.

## Operational Risks

Archive.today does not present this as a formal paid API. Treat it as an unofficial integration.

Risks to design for:

- mirror domains may vary by region or availability
- upstream responses may be plain text, HTML-adjacent, or malformed
- aggressive polling may be rate-limited
- captcha or bot checks may appear
- archive URLs can include sensitive historical content

Mitigations:

- default to one configured host with explicit mirror override
- set short timeouts and bounded retries
- keep tests fixture-based
- add clear error codes instead of swallowing upstream failures
- avoid captcha bypass logic
- avoid storing lookup results unless a future product requirement explicitly needs caching

## Testing Plan

Run these checks for the implementation PR:

```bash
npm run build
npm test
```

Add focused tests for:

- SDK URL validation
- TimeMap response parsing
- capture timestamp extraction from archive URLs
- sorting and `limit` behavior
- provider request validation
- provider upstream failure mapping
- OpenAPI output for `POST /snapshots`
- marketplace route/catalog output once registered

Live Archive.today checks should be manual smoke tests only, not required CI, because the upstream service is unofficial and may intermittently block automation.

## Proposed File Changes For Implementation

- `packages/archive-is/package.json`
- `packages/archive-is/src/index.ts`
- `packages/archive-is/src/timemap.ts`
- `packages/archive-is/src/index.test.ts`
- `packages/archive-is/fixtures/*.txt`
- `apps/archive-is-service/package.json`
- `apps/archive-is-service/src/app.ts`
- `apps/archive-is-service/src/index.ts`
- `apps/archive-is-service/src/openapi.ts`
- `apps/archive-is-service/src/app.test.ts`
- `apps/archive-is-service/README.md`
- `apps/archive-is-service/provider-spec.mainnet.template.json`
- `docker/archive-is-service.Dockerfile`
- `package.json`
- `tsup.config.ts`
- `README.md`

## Acceptance Criteria

- A developer can call the SDK directly with a URL and get typed snapshot results.
- The standalone service can expose `POST /snapshots` and `GET /openapi.json`.
- The marketplace can publish `archive-is.list-snapshots` as a paid Fast route.
- The CLI can call the route through the existing x402 flow.
- Build and tests pass.
- No temporary compatibility layers, feature flags, or old route shapes are introduced.
