import express, { type Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  InMemoryMarketplaceStore,
  buildMerchantHandle,
  encryptSecret,
  issueMerchantHint,
  signMerchantHint,
  verifyMerchantHint,
  type CommerceShopRecord,
  type CommerceShopStatus,
  type ShopSearchClient,
  type MarketplaceStore
} from "@marketplace/shared";

import { registerCommerceRoutes } from "./commerce.js";

const SECRETS_KEY = "test-secrets-key-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const HINT_PLAINTEXT = "test-hint-plaintext-xxxxxxxxxxxxx";

interface SeedOptions {
  shopId: string;
  displayName?: string;
  baseUrl?: string;
  hintPlaintext?: string;
  status?: CommerceShopStatus;
  platform?: string;
  searchTimeoutMs?: number;
  secretsKey?: string;
}

async function seedShop(store: MarketplaceStore, opts: SeedOptions): Promise<CommerceShopRecord> {
  const plaintext = opts.hintPlaintext ?? HINT_PLAINTEXT;
  const secretsKey = opts.secretsKey ?? SECRETS_KEY;
  const enc = encryptSecret({ plaintext, secret: secretsKey });
  return store.upsertCommerceShop({
    shopId: opts.shopId,
    displayName: opts.displayName ?? opts.shopId,
    baseUrl: opts.baseUrl ?? `https://${opts.shopId}.example.com`,
    platform: opts.platform ?? "shopify",
    status: opts.status ?? "active",
    hintSecretCiphertext: enc.ciphertext,
    hintSecretIv: enc.iv,
    hintSecretAuthTag: enc.authTag,
    acceptedCurrency: "USDC",
    fulfillmentRegions: ["US"],
    searchTimeoutMs: opts.searchTimeoutMs ?? 2500,
    rateLimitPerMin: 60
  });
}

interface TestAppInput {
  store?: InMemoryMarketplaceStore;
  secretsKey?: string;
  searchClient?: ShopSearchClient;
}

function createCommerceTestApp(input: TestAppInput = {}): { app: Express; store: InMemoryMarketplaceStore; secretsKey: string } {
  const store = input.store ?? new InMemoryMarketplaceStore();
  const secretsKey = input.secretsKey ?? SECRETS_KEY;
  const app = express();
  app.use(express.json());
  registerCommerceRoutes(app, {
    store,
    secretsKey,
    searchClient: input.searchClient
  });
  return { app, store, secretsKey };
}

function fixedSearchClient(results: Record<string, Array<{ productId: string; title: string; priceUsd: string; imageUrl?: string }>>): ShopSearchClient {
  return {
    async searchShop({ shop }) {
      return results[shop.shopId] ?? [];
    }
  };
}

// ──────────────────────────────────────────────────────────────────────────
// GET /commerce/shops
// ──────────────────────────────────────────────────────────────────────────

describe("GET /commerce/shops", () => {
  it("returns only active shops and filters paused/archived", async () => {
    const { app, store } = createCommerceTestApp();
    await seedShop(store, { shopId: "live", status: "active" });
    await seedShop(store, { shopId: "on-hold", status: "paused" });
    await seedShop(store, { shopId: "gone", status: "archived" });

    const response = await request(app).get("/commerce/shops");

    expect(response.status).toBe(200);
    expect(response.body.shops).toHaveLength(1);
    expect(response.body.shops[0].shopId).toBe("live");
  });

  it("returns a summary shape without hint_secret fields", async () => {
    const { app, store } = createCommerceTestApp();
    await seedShop(store, { shopId: "stance", displayName: "Stance" });

    const response = await request(app).get("/commerce/shops");

    expect(response.status).toBe(200);
    expect(response.body.shops[0]).toEqual({
      shopId: "stance",
      displayName: "Stance",
      platform: "shopify",
      fulfillmentRegions: ["US"]
    });
    // Make sure no secret material leaks.
    const body = JSON.stringify(response.body);
    expect(body).not.toContain("hintSecret");
    expect(body).not.toContain("Ciphertext");
  });

  it("returns empty array when no shops are seeded", async () => {
    const { app } = createCommerceTestApp();
    const response = await request(app).get("/commerce/shops");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ shops: [] });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// GET /commerce/search
// ──────────────────────────────────────────────────────────────────────────

describe("GET /commerce/search", () => {
  it("returns hits whose hintSig verifies against the seeded plaintext secret", async () => {
    const { app, store } = createCommerceTestApp({
      searchClient: fixedSearchClient({
        "stance": [
          { productId: "prod_a", title: "Sock A", priceUsd: "9.99", imageUrl: "https://img/a" },
          { productId: "prod_b", title: "Sock B", priceUsd: "19.99" }
        ]
      })
    });
    await seedShop(store, { shopId: "stance" });

    const response = await request(app).get("/commerce/search").query({ q: "socks" });

    expect(response.status).toBe(200);
    expect(response.body.partial).toBe(false);
    expect(response.body.timedOutShops).toEqual([]);
    expect(response.body.hits).toHaveLength(2);

    const hit = response.body.hits[0];
    expect(hit.merchantHandle).toBe(`stance:${hit.productId}`);
    expect(hit.merchantBaseUrl).toBe("https://stance.example.com");

    const verify = verifyMerchantHint({
      merchantHandle: hit.merchantHandle,
      merchantBaseUrl: hit.merchantBaseUrl,
      hintExp: hit.hintExp,
      hintSig: hit.hintSig,
      secret: HINT_PLAINTEXT
    });
    expect(verify).toEqual({ ok: true });
  });

  it("marks partial:true when a shop hangs past its per-shop timeout", async () => {
    const { app, store } = createCommerceTestApp({
      searchClient: {
        async searchShop({ shop, signal }) {
          if (shop.shopId === "slow") {
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
            });
            return [];
          }
          return [{ productId: "p1", title: "t", priceUsd: "1.00" }];
        }
      }
    });
    await seedShop(store, { shopId: "fast", searchTimeoutMs: 5000 });
    await seedShop(store, { shopId: "slow", searchTimeoutMs: 25 });

    const response = await request(app).get("/commerce/search").query({ q: "socks" });

    expect(response.status).toBe(200);
    expect(response.body.timedOutShops).toContain("slow");
    expect(response.body.hits.map((h: { shopId: string }) => h.shopId)).toEqual(["fast"]);
  });

  it("returns empty payload when there are no active shops", async () => {
    const { app, store } = createCommerceTestApp({
      searchClient: fixedSearchClient({})
    });
    await seedShop(store, { shopId: "paused", status: "paused" });

    const response = await request(app).get("/commerce/search").query({ q: "socks" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ partial: false, timedOutShops: [], hits: [] });
  });

  it("rejects empty q with 400", async () => {
    const { app } = createCommerceTestApp();
    const response = await request(app).get("/commerce/search").query({ q: "" });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Invalid query");
  });

  it("rejects limit > 50 with 400", async () => {
    const { app } = createCommerceTestApp();
    const response = await request(app).get("/commerce/search").query({ q: "socks", limit: "51" });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Invalid query");
  });

  it("returns 500 with a specific error when the secrets key cannot decrypt a shop ciphertext", async () => {
    // Seed the row encrypted with keyA; boot the app with keyB.
    const { app, store } = createCommerceTestApp({
      secretsKey: "keyB-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    });
    await seedShop(store, {
      shopId: "mismatch",
      secretsKey: "keyA-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    });

    const response = await request(app).get("/commerce/search").query({ q: "socks" });

    expect(response.status).toBe(500);
    expect(response.body.error).toMatch(/Failed to decrypt shop hint secret/i);
    expect(response.body.shopId).toBe("mismatch");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /commerce/orders/notify
// ──────────────────────────────────────────────────────────────────────────

interface NotifyRequestOpts {
  shopId?: string;
  handle?: string;
  baseUrl?: string;
  exp?: string;
  sig?: string;
  body?: unknown;
}

async function postNotify(app: Express, opts: NotifyRequestOpts = {}) {
  const req = request(app).post("/commerce/orders/notify").set("Content-Type", "application/json");
  if (opts.shopId !== undefined) req.set("X-Shop-Id", opts.shopId);
  if (opts.handle !== undefined) req.set("X-Marketplace-Handle", opts.handle);
  if (opts.exp !== undefined) req.set("X-Marketplace-Hint-Exp", opts.exp);
  if (opts.sig !== undefined) req.set("X-Marketplace-Hint", opts.sig);
  const body = opts.body ?? {
    orderId: "ord_1",
    buyerWallet: "fast1buyer",
    amountUsd: "9.99",
    status: "submitted",
    createdAt: new Date().toISOString()
  };
  return req.send(body);
}

describe("POST /commerce/orders/notify", () => {
  const BASE_URL = "https://stance.example.com";
  let app: Express;
  let store: InMemoryMarketplaceStore;
  let shopId: string;
  let handle: string;
  let exp: string;
  let sig: string;

  beforeEach(async () => {
    const created = createCommerceTestApp();
    app = created.app;
    store = created.store;
    shopId = "stance";
    await seedShop(store, { shopId, baseUrl: BASE_URL });
    handle = buildMerchantHandle(shopId, "prod_123");
    const hint = issueMerchantHint({
      merchantHandle: handle,
      merchantBaseUrl: BASE_URL,
      secret: HINT_PLAINTEXT
    });
    exp = hint.hintExp;
    sig = hint.hintSig;
  });

  it("accepts a signed, valid notification with 204", async () => {
    const response = await postNotify(app, { shopId, handle, exp, sig });
    expect(response.status).toBe(204);
  });

  it("rejects a missing X-Shop-Id header with 400 \"missing hint headers\"", async () => {
    const response = await postNotify(app, { handle, exp, sig });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("missing hint headers");
  });

  it("rejects a missing hint sig with 400 \"missing hint headers\"", async () => {
    const response = await postNotify(app, { shopId, handle, exp });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("missing hint headers");
  });

  it("rejects a shop_id that doesn't match the handle prefix with 400 \"invalid merchant handle\"", async () => {
    const response = await postNotify(app, { shopId: "other", handle, exp, sig });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid merchant handle");
  });

  it("returns 404 for an unknown shop", async () => {
    const response = await postNotify(app, {
      shopId: "ghost",
      handle: `ghost:p1`,
      exp,
      sig
    });
    expect(response.status).toBe(404);
    expect(response.body.error).toBe("shop not found");
  });

  it("returns 404 for a paused shop", async () => {
    await seedShop(store, { shopId: "quiet", status: "paused", baseUrl: BASE_URL });
    const quietHandle = buildMerchantHandle("quiet", "p1");
    const quietHint = issueMerchantHint({
      merchantHandle: quietHandle,
      merchantBaseUrl: BASE_URL,
      secret: HINT_PLAINTEXT
    });
    const response = await postNotify(app, {
      shopId: "quiet",
      handle: quietHandle,
      exp: quietHint.hintExp,
      sig: quietHint.hintSig
    });
    expect(response.status).toBe(404);
    expect(response.body.error).toBe("shop not found");
  });

  it("rejects an expired hint with 401 \"hint verification failed: expired\"", async () => {
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    const expiredSig = signMerchantHint({
      merchantHandle: handle,
      merchantBaseUrl: BASE_URL,
      hintExp: expiredAt,
      secret: HINT_PLAINTEXT
    });
    const response = await postNotify(app, {
      shopId,
      handle,
      exp: expiredAt,
      sig: expiredSig
    });
    expect(response.status).toBe(401);
    expect(response.body.error).toBe("hint verification failed: expired");
  });

  it("rejects a tampered sig with 401 \"hint verification failed: bad_signature\"", async () => {
    const tampered = sig.replace(/^./, (c) => (c === "A" ? "B" : "A"));
    const response = await postNotify(app, { shopId, handle, exp, sig: tampered });
    expect(response.status).toBe(401);
    expect(response.body.error).toBe("hint verification failed: bad_signature");
  });

  it("rejects an invalid body with 400 \"Invalid notify payload\"", async () => {
    const response = await postNotify(app, {
      shopId,
      handle,
      exp,
      sig,
      body: { orderId: "ord_1" } // missing required fields
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Invalid notify payload");
  });
});

afterEach(() => {
  // Ensure no lingering timers from hanging search clients.
  return Promise.resolve();
});
