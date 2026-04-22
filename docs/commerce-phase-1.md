# Commerce Phase 1 — Verification Walkthrough

This doc teaches you how to verify the phase-1 commerce abstraction end-to-end, assuming you've never touched the marketplace repo before. Everything runs locally — no cloud deploy required.

**What we're verifying:** `fast-mcp` (buyer binary) → `marketplace/apps/api` (new `/commerce/*` endpoints) → `fast-shop-shopify` (existing merchant server). The marketplace is a permissionless registry + fan-out search; quote/checkout still goes direct to the merchant with a signed hint header so the merchant can prove the request came via the marketplace.

```
    fast-mcp  ──── GET /commerce/search ─────▶  marketplace/apps/api
       │                                              │
       │   hits + signed merchantHandle               │  row reads
       │◀──────────────────────────────────────       │  commerce_shops
       │                                              ▼
       │                                          Postgres
       │
       └─── POST /quote, /orders ──────▶  fast-shop-shopify
             + X-Marketplace-Hint              (exists, unchanged
             + X-Marketplace-Handle             except for hint verify)
             + X-Marketplace-Hint-Exp
             + X-Shop-Id
                  │
                  │  order settles
                  ▼
          POST /commerce/orders/notify  ──▶  marketplace (attribution)
```

Three new pieces were added in phase 1:
1. **`commerce_shops` table** in marketplace Postgres.
2. **`GET /commerce/shops`, `GET /commerce/search`, `POST /commerce/orders/notify`** in [`marketplace/apps/api/src/commerce.ts`](../apps/api/src/commerce.ts).
3. **Hint-based merchant access** — `fast-shop-shopify` verifies `X-Marketplace-Hint` when `MARKETPLACE_HINT_SECRET` is set.

---

## Prerequisites

- Node.js ≥ 20
- A Postgres database the marketplace can talk to. We'll use port 5433 for the marketplace DB below to avoid colliding with `fast-shop-shopify`'s Postgres on port 5435.
- `curl`, `psql` (client, not server), `jq`
- Fast wallet funded with **testUSDC** (for step 4 end-to-end only — every other step is zero-payment). We run everything on Fast testnet here: no real money moves and the Shopify checkout runs against the merchant's test-card. `fast-mcp` and `fast-shop-shopify` both read `FAST_NETWORK=testnet` / `mainnet` — testnet is `fast-shop-shopify`'s default; `fast-mcp`'s default is mainnet, so we override below.

---

## Step 0 — Start the marketplace API

First time only — install deps in all three repos:

```bash
cd ~/pi2-inc/agents-marketplace/marketplace      && npm install
cd ~/pi2-inc/agents-marketplace/fast-shop-shopify && bun install
cd ~/pi2-inc/agents-marketplace/fast-mcp          && npm install
```

Launch a dedicated Postgres for the marketplace (one-shot Docker):

```bash
docker run -d --name fast-marketplace-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=fast_marketplace \
  -p 5433:5432 \
  postgres:16
```

Start the marketplace API. It needs a handful of env vars — the ones that matter for phase 1 are `DATABASE_URL` (where shops get stored) and `MARKETPLACE_SECRETS_KEY` (encrypts hint secrets at rest):

```bash
cd ~/pi2-inc/agents-marketplace/marketplace

export DATABASE_URL=postgres://postgres:postgres@localhost:5433/fast_marketplace
export MARKETPLACE_SECRETS_KEY=dev-secrets-key-32-chars-minimum-xxxxxxxxx
export MARKETPLACE_SESSION_SECRET=dev-session-secret-32-chars-minimum-xxxxx
export MARKETPLACE_ADMIN_TOKEN=dev-admin-token
export MARKETPLACE_TREASURY_ADDRESS=fast1dev000000000000000000000000000000000000
export PORT=3000
export MARKETPLACE_BASE_URL=http://localhost:3000

npm run dev:api
```

The process runs `store.ensureSchema()` on startup, which includes the new `CREATE TABLE IF NOT EXISTS commerce_shops` we added. No separate migration command to run.

Sanity check from another terminal:

```bash
curl -s http://localhost:3000/.well-known/marketplace.json | head -c 200
# Should print a JSON blob describing the marketplace catalog.
```

---

## Step 1 — Seed a shop

The `commerce_shops` row needs an **encrypted** `hint_secret` — the plaintext is what the merchant will also need, encrypted with `MARKETPLACE_SECRETS_KEY` at rest. Encrypt via a Node one-liner:

```bash
cd ~/pi2-inc/agents-marketplace/marketplace

# Pick ANY long random string — this is the shared secret the marketplace
# and the merchant will both hold in plaintext form. Write it down; you'll
# set it on fast-shop-shopify in step 3.
export HINT_SECRET="shared-hint-secret-for-stance-shopify-$(openssl rand -hex 8)"
echo "HINT_SECRET=$HINT_SECRET"

# Encrypt the secret with the marketplace's secrets key. This is a line-for-line
# copy of encryptSecret() in packages/shared/src/secrets.ts — AES-256-GCM with
# the key SHA-256'd. What it produces is bit-identical to what the marketplace
# API decrypts at runtime.
ENC=$(node -e '
const { createCipheriv, createHash, randomBytes } = require("node:crypto");
const key = createHash("sha256").update(process.env.MARKETPLACE_SECRETS_KEY).digest();
const iv = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", key, iv);
const ct = Buffer.concat([cipher.update(process.env.HINT_SECRET, "utf8"), cipher.final()]);
console.log(JSON.stringify({
  ciphertext: ct.toString("base64"),
  iv: iv.toString("base64"),
  authTag: cipher.getAuthTag().toString("base64"),
}));
')

CIPHER=$(echo "$ENC" | jq -r .ciphertext)
IV=$(echo    "$ENC" | jq -r .iv)
TAG=$(echo   "$ENC" | jq -r .authTag)

# Insert the shop row.
psql "$DATABASE_URL" <<SQL
INSERT INTO commerce_shops (
  shop_id, display_name, base_url, platform, status,
  hint_secret_ciphertext, hint_secret_iv, hint_secret_auth_tag,
  accepted_currency, fulfillment_regions, search_timeout_ms, rate_limit_per_min
) VALUES (
  'stance-shopify',
  'Stance',
  'http://localhost:8082',
  'shopify',
  'active',
  '$CIPHER', '$IV', '$TAG',
  'USDC', ARRAY['US']::TEXT[], 2500, 60
);
SQL
```

> `base_url` in this row is what the marketplace fans out to for search AND what the hint signature binds. For local testing use `http://localhost:8082` so it matches where your `fast-shop-shopify` dev server answers. In production this becomes `https://stance.shop.fast.xyz`.

---

## Step 2 — Discovery (GET /commerce/shops, /commerce/search)

```bash
curl -s http://localhost:3000/commerce/shops | jq
# Expect: { "shops": [ { "shopId": "stance-shopify", "displayName": "Stance", "platform": "shopify", "fulfillmentRegions": ["US"] } ] }

curl -s 'http://localhost:3000/commerce/search?q=socks' | jq
# Expect:
#   partial: false
#   timedOutShops: []
#   hits: [ { shopId, shopName, productId, title, priceUsd,
#             merchantHandle: "stance-shopify:<productId>",
#             merchantBaseUrl: "http://localhost:8082",
#             hintSig: "<base64url>",
#             hintExp: "<ISO date in future>" } ]
```

If `hits` is empty and `timedOutShops: ["stance-shopify"]`, the merchant's `/search` endpoint didn't respond within `searchTimeoutMs=2500`. Either point `base_url` at a reachable merchant or raise the timeout with an UPDATE.

---

## Step 3 — Merchant-side hint verification

Enable hint enforcement on `fast-shop-shopify`. Until you set these env vars, the merchant still accepts direct (unsigned) requests — good for the cutover window, but for verification we want to prove the check fires.

```bash
cd ~/pi2-inc/agents-marketplace/fast-shop-shopify

# Add to .env (or export before bun run dev):
cat >> .env <<EOF
SHOP_ID=stance-shopify
MARKETPLACE_HINT_SECRET=$HINT_SECRET
MARKETPLACE_NOTIFY_URL=http://localhost:3000/commerce/orders/notify
MARKETPLACE_CANONICAL_BASE_URL=http://localhost:8082
FAST_NETWORK=testnet
EOF

bun run dev
```

Test that the middleware rejects a direct POST:

```bash
curl -sv -X POST http://localhost:8082/quote \
  -H 'Content-Type: application/json' \
  -d '{"products":[],"shipping_address":{},"email":"test@test.com"}' 2>&1 | grep -E '^< HTTP|marketplace hint'
# Expect: HTTP/1.1 401 Unauthorized
# Body:   {"error":"marketplace hint verification failed: missing"}
```

And that a valid hint (from the search response) is accepted:

```bash
# Copy one hit out of the /commerce/search response from step 2.
HIT=$(curl -s 'http://localhost:3000/commerce/search?q=socks' | jq -c '.hits[0]')
HANDLE=$(echo "$HIT" | jq -r .merchantHandle)
EXP=$(echo    "$HIT" | jq -r .hintExp)
SIG=$(echo    "$HIT" | jq -r .hintSig)

curl -sv -X POST http://localhost:8082/quote \
  -H "X-Shop-Id: stance-shopify" \
  -H "X-Marketplace-Handle: $HANDLE" \
  -H "X-Marketplace-Hint-Exp: $EXP" \
  -H "X-Marketplace-Hint: $SIG" \
  -H 'Content-Type: application/json' \
  -d '{"products":[{"url":"...","price_cents":2500}],"shipping_address":{},"email":"test@test.com"}' 2>&1 | grep -E '^< HTTP'
# Expect: HTTP 201 with a quote body (or 400 on a bad product payload — but NOT 401).
```

The middleware is feature-flagged: unset `MARKETPLACE_HINT_SECRET` and restart to return to unsigned direct access.

---

## Step 4 — End-to-end through fast-mcp

Point `fast-mcp` at your local marketplace and use it from Claude Desktop.

```bash
cd ~/pi2-inc/agents-marketplace/fast-mcp
npm run build
```

In Claude Desktop, edit `~/.config/Claude/claude_desktop_config.json` (Linux) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) to register the MCP:

```json
{
  "mcpServers": {
    "fast-shop-dev": {
      "command": "node",
      "args": ["/absolute/path/to/fast-mcp/dist/server.js"],
      "env": {
        "MARKETPLACE_API_BASE_URL": "http://localhost:3000",
        "FAST_NETWORK": "testnet"
      }
    }
  }
}
```

Restart Claude Desktop, then in a chat: "Buy me a pair of socks from Stance." The LLM should:

1. Call `fast_shop_search` — the hit comes from your local marketplace fan-out.
2. Call `fast_shop_quote` with `merchant_base_url`, `merchant_handle`, `hint_exp`, `hint_sig` from the hit.
3. Call `fast_shop_create_order` with the same hint fields (x402 pays USDC direct to the merchant).
4. The merchant's `/commerce/orders/notify` call shows up in the marketplace API logs — grep for `[commerce] order notify`.

---

## Step 5 — Graceful degradation

Stop the merchant (`Ctrl-C` the `bun run dev` process). Re-run search:

```bash
curl -s 'http://localhost:3000/commerce/search?q=socks' | jq
```

Expected within ~2.5s (the per-shop timeout; the 4s global deadline would kick in only with many shops):

```json
{ "partial": true, "timedOutShops": ["stance-shopify"], "hits": [] }
```

`partial: true` is the signal the MCP can surface to the LLM ("results are incomplete — some stores didn't respond").

---

## Step 6 — Runtime enable/disable

This is the payoff: add/remove a merchant with no restart, no rebuild, no user upgrade.

```bash
# Pause the shop.
psql "$DATABASE_URL" -c "UPDATE commerce_shops SET status='paused' WHERE shop_id='stance-shopify';"

# Search again — no hits, no timeouts.
curl -s 'http://localhost:3000/commerce/search?q=socks' | jq
# { "partial": false, "timedOutShops": [], "hits": [] }

# Re-enable.
psql "$DATABASE_URL" -c "UPDATE commerce_shops SET status='active' WHERE shop_id='stance-shopify';"

curl -s 'http://localhost:3000/commerce/search?q=socks' | jq
# Hits return.
```

**Phase 1 is done when step 4 and step 6 both pass with no code change between them.**

---

## Where things live

| Concern | File |
|---|---|
| Commerce types | [`packages/shared/src/types.ts`](../packages/shared/src/types.ts) — search `CommerceShopRecord` |
| HMAC sign / verify / fan-out | [`packages/shared/src/commerce.ts`](../packages/shared/src/commerce.ts) |
| `commerce_shops` schema | [`packages/shared/src/store.ts`](../packages/shared/src/store.ts) — search `CREATE TABLE IF NOT EXISTS commerce_shops` |
| Store CRUD | same file: `listActiveCommerceShops` / `getCommerceShop` / `upsertCommerceShop` |
| API handlers | [`apps/api/src/commerce.ts`](../apps/api/src/commerce.ts) |
| Mount point | [`apps/api/src/app.ts`](../apps/api/src/app.ts) — search `registerCommerceRoutes` |
| Merchant hint middleware | `fast-shop-shopify/src/marketplace/hint.ts` |
| Merchant notify helper | `fast-shop-shopify/src/marketplace/notify.ts` |
| MCP client rewire | `fast-mcp/src/shop.ts` (`MarketplaceShopClient`) |

## Common gotchas

- **`hintSig` mismatch** — the signature binds `merchantHandle + baseUrl + hintExp`. If the merchant's `MARKETPLACE_CANONICAL_BASE_URL` doesn't match the `base_url` seeded in `commerce_shops`, verify fails with `bad_signature`. For local testing both should be `http://localhost:8082`.
- **Hint expiry** — `DEFAULT_HINT_TTL_MS` is 30 min. Old search hits sitting in a buyer's context window eventually fail verify with `expired`; the buyer must re-search.
- **Secrets-key rotation** — `MARKETPLACE_SECRETS_KEY` encrypts `hint_secret_enc` at rest. Changing it invalidates every row's ability to be decrypted; you'd need to re-seed every shop. Don't rotate casually.
- **Empty search results** — check marketplace logs for per-shop timeouts. The default search client hits each merchant's existing `/search` endpoint, so if that endpoint doesn't exist or doesn't return the expected shape (`{ products: [...] }` with `product_id`, `title`, `price_cents`/`price_usd`), hits get filtered out and the shop contributes zero.
