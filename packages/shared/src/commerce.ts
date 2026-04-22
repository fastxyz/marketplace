import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  CommerceSearchHit,
  CommerceSearchResponse,
  CommerceShopRecord,
  MerchantHandleHint
} from "./types.js";

export const COMMERCE_HINT_HEADER = "x-marketplace-hint";
export const COMMERCE_HINT_EXP_HEADER = "x-marketplace-hint-exp";
export const COMMERCE_HINT_HANDLE_HEADER = "x-marketplace-handle";
export const COMMERCE_SHOP_ID_HEADER = "x-shop-id";

export const DEFAULT_HINT_TTL_MS = 30 * 60 * 1000;

export function buildMerchantHandle(shopId: string, productId: string): string {
  return `${shopId}:${productId}`;
}

export function parseMerchantHandle(handle: string): { shopId: string; productId: string } | null {
  const idx = handle.indexOf(":");
  if (idx <= 0 || idx === handle.length - 1) return null;
  return {
    shopId: handle.slice(0, idx),
    productId: handle.slice(idx + 1)
  };
}

function hintPayload(input: { merchantHandle: string; merchantBaseUrl: string; hintExp: string }): string {
  return `${input.merchantHandle}|${input.merchantBaseUrl}|${input.hintExp}`;
}

export function signMerchantHint(input: {
  merchantHandle: string;
  merchantBaseUrl: string;
  hintExp: string;
  secret: string;
}): string {
  return createHmac("sha256", input.secret)
    .update(hintPayload({
      merchantHandle: input.merchantHandle,
      merchantBaseUrl: input.merchantBaseUrl,
      hintExp: input.hintExp
    }))
    .digest("base64url");
}

export function issueMerchantHint(input: {
  merchantHandle: string;
  merchantBaseUrl: string;
  secret: string;
  ttlMs?: number;
  now?: Date;
}): MerchantHandleHint {
  const now = input.now ?? new Date();
  const hintExp = new Date(now.getTime() + (input.ttlMs ?? DEFAULT_HINT_TTL_MS)).toISOString();
  const hintSig = signMerchantHint({
    merchantHandle: input.merchantHandle,
    merchantBaseUrl: input.merchantBaseUrl,
    hintExp,
    secret: input.secret
  });
  return {
    merchantHandle: input.merchantHandle,
    merchantBaseUrl: input.merchantBaseUrl,
    hintExp,
    hintSig
  };
}

export function verifyMerchantHint(input: {
  merchantHandle: string;
  merchantBaseUrl: string;
  hintExp: string;
  hintSig: string;
  secret: string;
  now?: Date;
}): { ok: true } | { ok: false; reason: "expired" | "bad_signature" | "malformed" } {
  const expiresAtMs = Date.parse(input.hintExp);
  if (Number.isNaN(expiresAtMs)) {
    return { ok: false, reason: "malformed" };
  }

  const nowMs = (input.now ?? new Date()).getTime();
  if (expiresAtMs <= nowMs) {
    return { ok: false, reason: "expired" };
  }

  const expected = signMerchantHint({
    merchantHandle: input.merchantHandle,
    merchantBaseUrl: input.merchantBaseUrl,
    hintExp: input.hintExp,
    secret: input.secret
  });

  if (expected.length !== input.hintSig.length) {
    return { ok: false, reason: "bad_signature" };
  }

  const match = timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(input.hintSig, "utf8")
  );

  return match ? { ok: true } : { ok: false, reason: "bad_signature" };
}

export interface ShopSearchClient {
  searchShop(input: {
    shop: CommerceShopRecord;
    query: string;
    limit: number;
    region?: string;
    signal: AbortSignal;
  }): Promise<Array<Omit<CommerceSearchHit, "hintSig" | "hintExp" | "merchantHandle" | "merchantBaseUrl" | "shopId" | "shopName"> & {
    productId: string;
    title: string;
    priceUsd: string;
    imageUrl?: string;
  }>>;
}

export interface FanOutOptions {
  deadlineMs?: number;
  concurrency?: number;
  perShopTimeoutMs?: number;
  limit?: number;
  region?: string;
}

const DEFAULT_DEADLINE_MS = 4000;
const DEFAULT_CONCURRENCY = 32;
const DEFAULT_LIMIT = 25;

export async function fanOutCommerceSearch(input: {
  shops: CommerceShopRecord[];
  query: string;
  client: ShopSearchClient;
  hintSecretResolver: (shop: CommerceShopRecord) => string;
  options?: FanOutOptions;
}): Promise<CommerceSearchResponse> {
  const deadlineMs = input.options?.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const concurrency = input.options?.concurrency ?? DEFAULT_CONCURRENCY;
  const limit = input.options?.limit ?? DEFAULT_LIMIT;
  const region = input.options?.region;

  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(), deadlineMs);

  const hits: CommerceSearchHit[] = [];
  const timedOutShops: string[] = [];
  let index = 0;
  let deadlineReached = false;

  async function worker() {
    while (index < input.shops.length) {
      const shop = input.shops[index++];
      if (deadlineController.signal.aborted) {
        deadlineReached = true;
        timedOutShops.push(shop.shopId);
        continue;
      }

      const perShopTimeoutMs = input.options?.perShopTimeoutMs ?? shop.searchTimeoutMs;
      const shopController = new AbortController();
      const abortListener = () => shopController.abort();
      deadlineController.signal.addEventListener("abort", abortListener, { once: true });
      const shopTimer = setTimeout(() => shopController.abort(), perShopTimeoutMs);

      try {
        const rawHits = await input.client.searchShop({
          shop,
          query: input.query,
          limit,
          region,
          signal: shopController.signal
        });
        const secret = input.hintSecretResolver(shop);
        for (const raw of rawHits) {
          const merchantHandle = buildMerchantHandle(shop.shopId, raw.productId);
          const hint = issueMerchantHint({
            merchantHandle,
            merchantBaseUrl: shop.baseUrl,
            secret
          });
          hits.push({
            shopId: shop.shopId,
            shopName: shop.displayName,
            productId: raw.productId,
            title: raw.title,
            priceUsd: raw.priceUsd,
            imageUrl: raw.imageUrl,
            merchantHandle: hint.merchantHandle,
            merchantBaseUrl: hint.merchantBaseUrl,
            hintExp: hint.hintExp,
            hintSig: hint.hintSig
          });
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError" || shopController.signal.aborted) {
          timedOutShops.push(shop.shopId);
          if (deadlineController.signal.aborted) {
            deadlineReached = true;
          }
        } else {
          timedOutShops.push(shop.shopId);
        }
      } finally {
        clearTimeout(shopTimer);
        deadlineController.signal.removeEventListener("abort", abortListener);
      }
    }
  }

  try {
    const workers = Array.from({ length: Math.min(concurrency, input.shops.length) }, () => worker());
    await Promise.all(workers);
  } finally {
    clearTimeout(deadlineTimer);
  }

  return {
    partial: deadlineReached || timedOutShops.length > 0,
    timedOutShops,
    hits
  };
}
