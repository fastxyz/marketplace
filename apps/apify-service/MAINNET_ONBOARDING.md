# Apify Mainnet Onboarding

This is the operator runbook for the Apify-backed provider batch that uses `apps/apify-service`.

## Recommended Shape

- service type: `marketplace_proxy`
- settlement tier at publish time: `verified_escrow`
- billing model right now: `fixed_x402`
- endpoint mode: `async`
- async strategy: `poll`

This mirrors the six Apify services that are already live on mainnet.

## Existing Coolify Convention

The current live apps follow this pattern:

- app name prefix: `fast-provider-apify-...`
- public host prefix: `https://fastmainnetapify...`
- shared `APIFY_API_TOKEN` across the batch
- base directory: repo root
- build pack: `nixpacks`
- build command: `npm install && npm run build`
- start command: `npm run start:apify-service`
- port: `4040`
- health path: `/health`
- provider payout wallet: `fast1rv8wsdd5pnkwt4u637g2yj4tpuyq26rzw8380rfhpnsnljz7v3tqv4njuq`

Use `apps/apify-service/specs/SERVICES.md` as the source of truth for actor IDs, hostnames, app names, and spec template filenames.

## Per-App Env

Set these for every deployment:

- `APIFY_API_TOKEN`
- `APIFY_ACTOR_ID`
- `APIFY_SERVICE_NAME`
- `APIFY_SERVICE_DESCRIPTION`
- `APIFY_API_BASE_URL=https://api.apify.com/v2`
- `APIFY_DEFAULT_POLL_AFTER_MS=5000`
- `APIFY_DATASET_ITEM_LIMIT=100`
- `APIFY_SERVICE_PORT=4040`
- `MARKETPLACE_VERIFICATION_TOKEN`

## Marketplace Flow

1. Deploy one Coolify app per actor.
2. Copy the matching `*.mainnet.template.json` from `apps/apify-service/specs/`.
3. Replace:
   - provider contact email
   - website host if you choose a different hostname
   - starter price if you want different marketplace pricing

The existing marketplace-owned Apify services already use the shared treasury wallet above as `payoutWallet`, and the templates in this folder now match that convention.
4. Sync the provider draft:

```bash
npm run cli -- provider sync --spec ./apps/apify-service/specs/<template>.mainnet.template.json
```

5. Verify the website host:

```bash
npm run cli -- provider verify --service <slug>
```

6. Submit after the verification token is live:

```bash
npm run cli -- provider submit --service <slug>
```

7. In admin, publish the submitted service as `verified_escrow`.

## Pricing Note

The new templates include starter `fixed_x402` prices so they can be synced immediately. Review those prices before submit/publish because Apify usage cost varies materially by actor and by input shape.
