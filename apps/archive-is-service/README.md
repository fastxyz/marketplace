# Archive.is Service Example

This app is a standalone Archive.today-compatible provider wrapper. It exposes a read-only lookup endpoint that returns known archived snapshots for a submitted URL.

## What It Does

- exposes `POST /snapshots` for archived page lookup
- uses the local `@marketplace/archive-is` SDK to fetch and parse Memento TimeMap responses
- serves `GET /openapi.json` for marketplace-friendly OpenAPI import
- optionally serves `GET /.well-known/fast-marketplace-verification.txt` from `MARKETPLACE_VERIFICATION_TOKEN`

Snapshot creation is intentionally out of scope for v1. Archive.today submission flows are less stable than TimeMap lookup and may involve bot checks or captchas.

## Local Run

```bash
export ARCHIVE_IS_BASE_HOST=archive.today
export ARCHIVE_IS_TIMEOUT_MS=10000
export ARCHIVE_IS_SERVICE_PORT=4060
export MARKETPLACE_VERIFICATION_TOKEN=...
npm run dev:archive-is-service
```

Request example:

```bash
curl -X POST http://localhost:4060/snapshots \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/articles/launch","limit":20}'
```

## Using It With The Marketplace

1. Create a `marketplace_proxy` provider service in the website.
2. Set the service website URL to the deployed Archive.is service host.
3. Import the deployed OpenAPI document from `https://<your-host>/openapi.json`.
4. Review the imported endpoint draft for `list-snapshots`.
5. Set `MARKETPLACE_VERIFICATION_TOKEN` on the Archive.is service and host the verification file.
6. Complete provider verification and submit the service for review.

Provider website verification expects an HTTPS host.

## Environment

```bash
export ARCHIVE_IS_BASE_HOST=archive.today
export ARCHIVE_IS_TIMEOUT_MS=10000
export ARCHIVE_IS_SERVICE_PORT=4060
export MARKETPLACE_VERIFICATION_TOKEN=...
```

`ARCHIVE_IS_BASE_HOST` can be `archive.today`, `archive.is`, or `archive.ph`.
