import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildMerchantHandle,
  fanOutCommerceSearch,
  issueMerchantHint,
  parseMerchantHandle,
  signMerchantHint,
  verifyMerchantHint,
  type ShopSearchClient
} from "./commerce.js";
import type { CommerceShopRecord } from "./types.js";

const SECRET = "test-hint-secret";
const HANDLE = "stance-shopify:prod_123";
const BASE_URL = "https://stance.shop.fast.xyz";

describe("signMerchantHint / verifyMerchantHint", () => {
  it("round-trips a freshly issued hint", () => {
    const hint = issueMerchantHint({
      merchantHandle: HANDLE,
      merchantBaseUrl: BASE_URL,
      secret: SECRET
    });

    const result = verifyMerchantHint({
      merchantHandle: hint.merchantHandle,
      merchantBaseUrl: hint.merchantBaseUrl,
      hintExp: hint.hintExp,
      hintSig: hint.hintSig,
      secret: SECRET
    });

    expect(result).toEqual({ ok: true });
  });

  it("rejects a tampered signature as bad_signature", () => {
    const hint = issueMerchantHint({
      merchantHandle: HANDLE,
      merchantBaseUrl: BASE_URL,
      secret: SECRET
    });
    const tampered = hint.hintSig.replace(/^./, (c) => (c === "A" ? "B" : "A"));

    const result = verifyMerchantHint({
      merchantHandle: hint.merchantHandle,
      merchantBaseUrl: hint.merchantBaseUrl,
      hintExp: hint.hintExp,
      hintSig: tampered,
      secret: SECRET
    });

    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a past hintExp as expired", () => {
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    const sig = signMerchantHint({
      merchantHandle: HANDLE,
      merchantBaseUrl: BASE_URL,
      hintExp: expiredAt,
      secret: SECRET
    });

    const result = verifyMerchantHint({
      merchantHandle: HANDLE,
      merchantBaseUrl: BASE_URL,
      hintExp: expiredAt,
      hintSig: sig,
      secret: SECRET
    });

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a non-ISO hintExp as malformed", () => {
    const result = verifyMerchantHint({
      merchantHandle: HANDLE,
      merchantBaseUrl: BASE_URL,
      hintExp: "not-a-date",
      hintSig: "anything",
      secret: SECRET
    });

    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  it("sig binds baseUrl — verify against different URL fails as bad_signature", () => {
    const hint = issueMerchantHint({
      merchantHandle: HANDLE,
      merchantBaseUrl: BASE_URL,
      secret: SECRET
    });

    const result = verifyMerchantHint({
      merchantHandle: hint.merchantHandle,
      merchantBaseUrl: "https://evil.example.com",
      hintExp: hint.hintExp,
      hintSig: hint.hintSig,
      secret: SECRET
    });

    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("sig of wrong length is rejected without timingSafeEqual crashing", () => {
    const hint = issueMerchantHint({
      merchantHandle: HANDLE,
      merchantBaseUrl: BASE_URL,
      secret: SECRET
    });

    const result = verifyMerchantHint({
      merchantHandle: hint.merchantHandle,
      merchantBaseUrl: hint.merchantBaseUrl,
      hintExp: hint.hintExp,
      hintSig: "short",
      secret: SECRET
    });

    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("signMerchantHint is deterministic given identical inputs", () => {
    const exp = new Date(Date.now() + 60_000).toISOString();
    const a = signMerchantHint({
      merchantHandle: HANDLE,
      merchantBaseUrl: BASE_URL,
      hintExp: exp,
      secret: SECRET
    });
    const b = signMerchantHint({
      merchantHandle: HANDLE,
      merchantBaseUrl: BASE_URL,
      hintExp: exp,
      secret: SECRET
    });
    expect(a).toBe(b);
  });

  it("sig is HMAC-SHA256 base64url of merchantHandle|merchantBaseUrl|hintExp", () => {
    const exp = new Date(Date.now() + 60_000).toISOString();
    const expected = createHmac("sha256", SECRET)
      .update(`${HANDLE}|${BASE_URL}|${exp}`)
      .digest("base64url");
    const actual = signMerchantHint({
      merchantHandle: HANDLE,
      merchantBaseUrl: BASE_URL,
      hintExp: exp,
      secret: SECRET
    });
    expect(actual).toBe(expected);
  });
});

describe("buildMerchantHandle / parseMerchantHandle", () => {
  it("round-trips shopId + productId", () => {
    const handle = buildMerchantHandle("shop_a", "prod_123");
    expect(handle).toBe("shop_a:prod_123");
    expect(parseMerchantHandle(handle)).toEqual({ shopId: "shop_a", productId: "prod_123" });
  });

  it("returns null for handle missing colon", () => {
    expect(parseMerchantHandle("justshop")).toBeNull();
  });

  it("returns null for handle with empty productId", () => {
    expect(parseMerchantHandle("shop:")).toBeNull();
  });

  it("returns null for handle starting with colon", () => {
    expect(parseMerchantHandle(":prod")).toBeNull();
  });

  it("productIds may contain further colons (Shopify variants, etc.)", () => {
    const parsed = parseMerchantHandle("shop_a:gid://shopify/Product/123");
    expect(parsed).toEqual({ shopId: "shop_a", productId: "gid://shopify/Product/123" });
  });
});

// ── fanOutCommerceSearch fixtures ─────────────────────────────────────────

function makeShop(
  id: string,
  opts: { searchTimeoutMs?: number; baseUrl?: string } = {}
): CommerceShopRecord {
  const now = new Date().toISOString();
  return {
    shopId: id,
    displayName: id,
    baseUrl: opts.baseUrl ?? `https://${id}.example.com`,
    platform: "shopify",
    status: "active",
    hintSecretCiphertext: "",
    hintSecretIv: "",
    hintSecretAuthTag: "",
    acceptedCurrency: "USDC",
    fulfillmentRegions: ["US"],
    searchTimeoutMs: opts.searchTimeoutMs ?? 5000,
    rateLimitPerMin: 60,
    createdAt: now,
    updatedAt: now
  };
}

interface Gate {
  promise: Promise<void>;
  release: () => void;
}
function makeGate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

describe("fanOutCommerceSearch", () => {
  const openGates: Gate[] = [];
  afterEach(() => {
    // Release any still-held gates so pending promises don't leak across tests.
    while (openGates.length) {
      const g = openGates.pop();
      g?.release();
    }
  });

  it("aggregates hits from all shops when all respond; partial=false", async () => {
    const shops = [makeShop("a"), makeShop("b"), makeShop("c")];
    const client: ShopSearchClient = {
      async searchShop({ shop }) {
        return [
          { productId: `${shop.shopId}-p1`, title: "t1", priceUsd: "1.00" },
          { productId: `${shop.shopId}-p2`, title: "t2", priceUsd: "2.00" }
        ];
      }
    };

    const response = await fanOutCommerceSearch({
      shops,
      query: "socks",
      client,
      hintSecretResolver: () => SECRET
    });

    expect(response.partial).toBe(false);
    expect(response.timedOutShops).toEqual([]);
    expect(response.hits).toHaveLength(6);
    expect(response.hits.map((h) => h.productId).sort()).toEqual(
      ["a-p1", "a-p2", "b-p1", "b-p2", "c-p1", "c-p2"]
    );
  });

  it("marks a single shop as timedOut when it hangs past searchTimeoutMs without failing the others", async () => {
    const shops = [makeShop("fast"), makeShop("slow", { searchTimeoutMs: 25 })];
    const slowGate = makeGate();
    openGates.push(slowGate);

    const client: ShopSearchClient = {
      async searchShop({ shop, signal }) {
        if (shop.shopId === "slow") {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
            slowGate.promise.then(() => _resolve());
          });
          return [];
        }
        return [{ productId: "fast-p", title: "t", priceUsd: "9.99" }];
      }
    };

    const response = await fanOutCommerceSearch({
      shops,
      query: "socks",
      client,
      hintSecretResolver: () => SECRET
    });

    expect(response.timedOutShops).toContain("slow");
    expect(response.hits.map((h) => h.shopId)).toEqual(["fast"]);
  });

  it("sets partial=true when the global deadline fires", async () => {
    const shops = [makeShop("eternal", { searchTimeoutMs: 10_000 })];
    const gate = makeGate();
    openGates.push(gate);

    const client: ShopSearchClient = {
      async searchShop({ signal }) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          gate.promise.then(() => _resolve());
        });
        return [];
      }
    };

    const response = await fanOutCommerceSearch({
      shops,
      query: "socks",
      client,
      hintSecretResolver: () => SECRET,
      options: { deadlineMs: 20 }
    });

    expect(response.partial).toBe(true);
    expect(response.hits).toEqual([]);
  });

  it("shop that throws synchronously is counted as timedOut; siblings still emit", async () => {
    const shops = [makeShop("ok"), makeShop("boom")];
    const client: ShopSearchClient = {
      async searchShop({ shop }) {
        if (shop.shopId === "boom") throw new Error("intentional");
        return [{ productId: "ok-p", title: "t", priceUsd: "1.00" }];
      }
    };

    const response = await fanOutCommerceSearch({
      shops,
      query: "socks",
      client,
      hintSecretResolver: () => SECRET
    });

    expect(response.timedOutShops).toContain("boom");
    expect(response.hits.map((h) => h.productId)).toEqual(["ok-p"]);
  });

  it("respects concurrency cap — maxInflight never exceeds concurrency", async () => {
    const shops = Array.from({ length: 6 }, (_, i) => makeShop(`s${i}`, { searchTimeoutMs: 30_000 }));
    let inflight = 0;
    let maxInflight = 0;
    const gates = shops.map(() => makeGate());
    openGates.push(...gates);

    const client: ShopSearchClient = {
      async searchShop({ shop }) {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        const idx = Number(shop.shopId.slice(1));
        await gates[idx].promise;
        inflight--;
        return [{ productId: `${shop.shopId}-p`, title: "t", priceUsd: "1.00" }];
      }
    };

    const concurrency = 2;
    const responsePromise = fanOutCommerceSearch({
      shops,
      query: "socks",
      client,
      hintSecretResolver: () => SECRET,
      options: { concurrency, deadlineMs: 30_000 }
    });

    // Let workers spin up before we release.
    await new Promise((r) => setTimeout(r, 10));
    expect(maxInflight).toBeLessThanOrEqual(concurrency);

    // Release in order so each worker can pick up the next shop.
    for (const g of gates) g.release();
    const response = await responsePromise;

    expect(response.hits).toHaveLength(6);
    expect(maxInflight).toBeLessThanOrEqual(concurrency);
  });

  it("hit carries a hintSig that verifies against the resolved plaintext secret", async () => {
    const shops = [makeShop("shop_a", { baseUrl: BASE_URL })];
    const client: ShopSearchClient = {
      async searchShop() {
        return [{ productId: "prod_123", title: "sock", priceUsd: "9.99", imageUrl: "https://img" }];
      }
    };

    const response = await fanOutCommerceSearch({
      shops,
      query: "socks",
      client,
      hintSecretResolver: () => SECRET
    });

    expect(response.hits).toHaveLength(1);
    const hit = response.hits[0];
    expect(hit.merchantHandle).toBe("shop_a:prod_123");
    expect(hit.merchantBaseUrl).toBe(BASE_URL);
    expect(hit.imageUrl).toBe("https://img");

    const verify = verifyMerchantHint({
      merchantHandle: hit.merchantHandle,
      merchantBaseUrl: hit.merchantBaseUrl,
      hintExp: hit.hintExp,
      hintSig: hit.hintSig,
      secret: SECRET
    });
    expect(verify).toEqual({ ok: true });
  });

  it("returns an empty response when shops list is empty", async () => {
    const response = await fanOutCommerceSearch({
      shops: [],
      query: "socks",
      client: { async searchShop() { return []; } },
      hintSecretResolver: () => SECRET
    });

    expect(response).toEqual({ partial: false, timedOutShops: [], hits: [] });
  });
});
