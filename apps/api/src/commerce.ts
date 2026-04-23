import type { Express, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  COMMERCE_HINT_EXP_HEADER,
  COMMERCE_HINT_HEADER,
  COMMERCE_HINT_HANDLE_HEADER,
  COMMERCE_SHOP_ID_HEADER,
  decryptSecret,
  encryptSecret,
  fanOutCommerceSearch,
  parseBearerToken,
  parseMerchantHandle,
  verifyMerchantHint,
  type CommerceOrderNotification,
  type CommerceShopRecord,
  type CommerceShopStatus,
  type CommerceShopSummary,
  type MarketplaceStore,
  type ShopSearchClient,
  type UpsertCommerceShopInput
} from "@marketplace/shared";

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const FAN_OUT_DEADLINE_MS = 4000;
const FAN_OUT_CONCURRENCY = 32;

export interface CommerceRoutesOptions {
  store: MarketplaceStore;
  secretsKey: string;
  adminToken: string;
  searchClient?: ShopSearchClient;
}

/**
 * Bearer-token check for admin-only endpoints. Mirrors the pattern used in
 * app.ts `requireAdminToken`; kept local to avoid a cross-file import for a
 * 6-line helper.
 */
function requireAdminToken(req: Request, res: Response, adminToken: string): boolean {
  const token = parseBearerToken(req.header("authorization"));
  if (!token || token.length !== adminToken.length) {
    res.status(401).json({ error: "Missing or invalid admin token." });
    return false;
  }
  const match = timingSafeEqual(
    Buffer.from(token, "utf8"),
    Buffer.from(adminToken, "utf8")
  );
  if (!match) {
    res.status(401).json({ error: "Missing or invalid admin token." });
    return false;
  }
  return true;
}

const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
  region: z.string().min(2).max(8).optional()
});

const notifyBodySchema = z.object({
  orderId: z.string().min(1),
  buyerWallet: z.string().min(1),
  amountUsd: z.string().min(1),
  status: z.string().min(1),
  createdAt: z.string().min(1)
});

function toSummary(shop: CommerceShopRecord): CommerceShopSummary {
  return {
    shopId: shop.shopId,
    displayName: shop.displayName,
    platform: shop.platform,
    fulfillmentRegions: shop.fulfillmentRegions
  };
}

function decryptShopSecret(shop: CommerceShopRecord, secretsKey: string): string {
  return decryptSecret({
    ciphertext: shop.hintSecretCiphertext,
    iv: shop.hintSecretIv,
    authTag: shop.hintSecretAuthTag,
    secret: secretsKey
  });
}

/**
 * Default search client — talks to each merchant's public `/search` endpoint
 * (the unchanged Storefront-API-backed route on fast-shop-shopify). This
 * keeps the fan-out wire format identical to what MCP already consumes,
 * so phase-1 doesn't require merchant code changes on the read path.
 */
function defaultSearchClient(): ShopSearchClient {
  return {
    async searchShop({ shop, query, limit, signal }) {
      const url = new URL(`${shop.baseUrl.replace(/\/$/, "")}/search`);
      url.searchParams.set("q", query);
      url.searchParams.set("max_results", String(limit));

      const response = await fetch(url, { signal });
      if (!response.ok) {
        throw new Error(`search ${shop.shopId} failed: HTTP ${response.status}`);
      }
      const body = (await response.json()) as Record<string, unknown>;
      // fast-shop-shopify uses `results`; leave room for `products` as a
      // generic fallback for other platform adapters (phase 3+).
      const rawList = Array.isArray(body?.results)
        ? (body.results as unknown[])
        : Array.isArray(body?.products)
          ? (body.products as unknown[])
          : [];
      return rawList
        .map((entry) => {
          const p = entry as Record<string, unknown>;
          const productId =
            (p.product_id as string) ??
            (p.productId as string) ??
            (p.id as string) ??
            null;
          const title = (p.title as string) ?? (p.name as string) ?? "";
          // `price` in fast-shop-shopify is an integer cents amount; other
          // response shapes may provide `price_usd` as a decimal string or
          // `price_cents` as a number.
          let priceUsd: string | null = null;
          if (typeof p.price_usd === "string") {
            priceUsd = p.price_usd;
          } else if (typeof p.price_cents === "number") {
            priceUsd = (p.price_cents / 100).toFixed(2);
          } else if (typeof p.price === "number") {
            priceUsd = (p.price / 100).toFixed(2);
          }
          const imageUrl =
            (p.image as string) ??
            (p.image_url as string) ??
            (p.imageUrl as string) ??
            undefined;
          if (!productId || !priceUsd) return null;
          return { productId, title, priceUsd, imageUrl };
        })
        .filter((hit): hit is NonNullable<typeof hit> => hit !== null);
    }
  };
}

export function registerCommerceRoutes(app: Express, options: CommerceRoutesOptions): void {
  const searchClient = options.searchClient ?? defaultSearchClient();

  app.get("/commerce/shops", async (_req: Request, res: Response) => {
    const shops = await options.store.listActiveCommerceShops();
    res.json({ shops: shops.map(toSummary) });
  });

  app.get("/commerce/search", async (req: Request, res: Response) => {
    try {
      const parsed = searchQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid query",
          issues: parsed.error.issues
        });
      }

      const shops = await options.store.listActiveCommerceShops();
      if (shops.length === 0) {
        return res.json({ partial: false, timedOutShops: [], hits: [] });
      }

      const secretsByShop = new Map<string, string>();
      for (const shop of shops) {
        try {
          secretsByShop.set(shop.shopId, decryptShopSecret(shop, options.secretsKey));
        } catch (err) {
          // Bad authTag here usually means MARKETPLACE_SECRETS_KEY changed
          // between seed and runtime. Surface a specific 500 so operators
          // don't chase an empty-body mystery.
          // eslint-disable-next-line no-console
          console.error(`[commerce] failed to decrypt hint_secret for ${shop.shopId}:`, err);
          return res.status(500).json({
            error: "Failed to decrypt shop hint secret. Usually means MARKETPLACE_SECRETS_KEY rotated between seed and runtime.",
            shopId: shop.shopId,
          });
        }
      }

      const response = await fanOutCommerceSearch({
        shops,
        query: parsed.data.q,
        client: searchClient,
        hintSecretResolver: (shop) => {
          const secret = secretsByShop.get(shop.shopId);
          if (!secret) throw new Error(`missing secret for ${shop.shopId}`);
          return secret;
        },
        options: {
          deadlineMs: FAN_OUT_DEADLINE_MS,
          concurrency: FAN_OUT_CONCURRENCY,
          limit: parsed.data.limit ?? DEFAULT_SEARCH_LIMIT,
          region: parsed.data.region
        }
      });

      return res.json(response);
    } catch (err) {
      // Log full detail server-side; return a generic message so we don't
      // leak internal state (DB errors, SQL text, env-shaped messages)
      // through the catch-all.
      // eslint-disable-next-line no-console
      console.error("[commerce] /commerce/search failed:", err);
      return res.status(500).json({ error: "Internal commerce search error" });
    }
  });

  app.post("/commerce/orders/notify", async (req: Request, res: Response) => {
    try {
      const shopId = (req.header(COMMERCE_SHOP_ID_HEADER) ?? "").trim();
      const handle = (req.header(COMMERCE_HINT_HANDLE_HEADER) ?? "").trim();
      const hintSig = (req.header(COMMERCE_HINT_HEADER) ?? "").trim();
      const hintExp = (req.header(COMMERCE_HINT_EXP_HEADER) ?? "").trim();

      if (!shopId || !handle || !hintSig || !hintExp) {
        return res.status(400).json({ error: "missing hint headers" });
      }

      const parsedHandle = parseMerchantHandle(handle);
      if (!parsedHandle || parsedHandle.shopId !== shopId) {
        return res.status(400).json({ error: "invalid merchant handle" });
      }

      const shop = await options.store.getCommerceShop(shopId);
      if (!shop || shop.status !== "active") {
        return res.status(404).json({ error: "shop not found" });
      }

      const secret = decryptShopSecret(shop, options.secretsKey);
      const verify = verifyMerchantHint({
        merchantHandle: handle,
        merchantBaseUrl: shop.baseUrl,
        hintExp,
        hintSig,
        secret
      });
      if (!verify.ok) {
        return res.status(401).json({ error: `hint verification failed: ${verify.reason}` });
      }

      const body = notifyBodySchema.safeParse(req.body);
      if (!body.success) {
        return res.status(400).json({
          error: "Invalid notify payload",
          issues: body.error.issues
        });
      }

      const notification: CommerceOrderNotification = body.data;
      // Phase 1: accept + log. Phase 2 introduces commerce_orders persistence +
      // attribution / analytics pipeline (see plan, Phase 2+).
      // eslint-disable-next-line no-console
      console.info("[commerce] order notify", {
        shopId,
        merchantHandle: handle,
        orderId: notification.orderId,
        status: notification.status,
        amountUsd: notification.amountUsd
      });

      return res.status(204).end();
    } catch (err) {
      // Log full detail server-side; return a generic message so we don't
      // leak internal state through the catch-all.
      // eslint-disable-next-line no-console
      console.error("[commerce] /commerce/orders/notify failed:", err);
      return res.status(500).json({ error: "Internal commerce notify error" });
    }
  });

  // ── Admin endpoints ──────────────────────────────────────────────────
  // All /admin/commerce/* routes require Bearer MARKETPLACE_ADMIN_TOKEN.
  // The operator never holds MARKETPLACE_SECRETS_KEY — they submit plaintext
  // hint secrets and the API encrypts server-side before storage.

  app.post("/admin/commerce/shops", async (req: Request, res: Response) => {
    if (!requireAdminToken(req, res, options.adminToken)) return;
    try {
      const parsed = upsertShopBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid shop payload", issues: parsed.error.issues });
      }
      const record = await upsertShopFromAdmin(options.store, options.secretsKey, parsed.data);
      return res.status(200).json(toAdminView(record));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[commerce] admin upsert failed:", err);
      return res.status(500).json({ error: "Failed to upsert shop" });
    }
  });

  app.get("/admin/commerce/shops", async (req: Request, res: Response) => {
    if (!requireAdminToken(req, res, options.adminToken)) return;
    try {
      const raw = typeof req.query.status === "string" ? req.query.status : undefined;
      let statusFilter: CommerceShopStatus | undefined;
      if (raw !== undefined) {
        if (!isCommerceShopStatus(raw)) {
          return res.status(400).json({ error: "Invalid status filter" });
        }
        statusFilter = raw;
      }
      const shops = await options.store.listCommerceShops(
        statusFilter ? { status: statusFilter } : undefined
      );
      return res.json({ shops: shops.map(toAdminView) });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[commerce] admin list failed:", err);
      return res.status(500).json({ error: "Failed to list shops" });
    }
  });

  app.get("/admin/commerce/shops/:shopId", async (req: Request, res: Response) => {
    if (!requireAdminToken(req, res, options.adminToken)) return;
    try {
      const shopId = String(req.params.shopId ?? "");
      const shop = await options.store.getCommerceShop(shopId);
      if (!shop) return res.status(404).json({ error: "shop not found" });
      return res.json(toAdminView(shop));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[commerce] admin get failed:", err);
      return res.status(500).json({ error: "Failed to fetch shop" });
    }
  });

  app.patch("/admin/commerce/shops/:shopId", async (req: Request, res: Response) => {
    if (!requireAdminToken(req, res, options.adminToken)) return;
    try {
      const parsed = patchShopBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid patch payload", issues: parsed.error.issues });
      }
      const shopId = String(req.params.shopId ?? "");
      const existing = await options.store.getCommerceShop(shopId);
      if (!existing) return res.status(404).json({ error: "shop not found" });

      const merged: UpsertCommerceShopInput = {
        shopId: existing.shopId,
        displayName: parsed.data.displayName ?? existing.displayName,
        baseUrl: parsed.data.baseUrl ?? existing.baseUrl,
        platform: parsed.data.platform ?? existing.platform,
        status: parsed.data.status ?? existing.status,
        hintSecretCiphertext: existing.hintSecretCiphertext,
        hintSecretIv: existing.hintSecretIv,
        hintSecretAuthTag: existing.hintSecretAuthTag,
        acceptedCurrency: parsed.data.acceptedCurrency ?? existing.acceptedCurrency,
        fulfillmentRegions: parsed.data.fulfillmentRegions ?? existing.fulfillmentRegions,
        searchTimeoutMs: parsed.data.searchTimeoutMs ?? existing.searchTimeoutMs,
        rateLimitPerMin: parsed.data.rateLimitPerMin ?? existing.rateLimitPerMin
      };

      // If a new plaintext hint is provided, re-encrypt and overwrite the
      // ciphertext triple. Operator never sees MARKETPLACE_SECRETS_KEY.
      if (parsed.data.hintPlaintext !== undefined) {
        const enc = encryptSecret({ plaintext: parsed.data.hintPlaintext, secret: options.secretsKey });
        merged.hintSecretCiphertext = enc.ciphertext;
        merged.hintSecretIv = enc.iv;
        merged.hintSecretAuthTag = enc.authTag;
      }

      const record = await options.store.upsertCommerceShop(merged);
      return res.json(toAdminView(record));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[commerce] admin patch failed:", err);
      return res.status(500).json({ error: "Failed to update shop" });
    }
  });
}

// ── Admin helpers ─────────────────────────────────────────────────────

const ADMIN_STATUSES = ["active", "paused", "archived"] as const;

function isCommerceShopStatus(value: string): value is CommerceShopStatus {
  return (ADMIN_STATUSES as readonly string[]).includes(value);
}

const upsertShopBodySchema = z.object({
  shopId: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/, {
    message: "shopId must be lowercase alphanumeric with hyphens/underscores"
  }),
  displayName: z.string().min(1).max(120),
  baseUrl: z.string().url(),
  platform: z.string().min(1).max(32),
  hintPlaintext: z.string().min(16).max(256),
  status: z.enum(ADMIN_STATUSES).optional(),
  acceptedCurrency: z.string().optional(),
  fulfillmentRegions: z.array(z.string()).optional(),
  searchTimeoutMs: z.number().int().min(100).max(30_000).optional(),
  rateLimitPerMin: z.number().int().min(1).max(10_000).optional()
});

const patchShopBodySchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  baseUrl: z.string().url().optional(),
  platform: z.string().min(1).max(32).optional(),
  hintPlaintext: z.string().min(16).max(256).optional(),
  status: z.enum(ADMIN_STATUSES).optional(),
  acceptedCurrency: z.string().optional(),
  fulfillmentRegions: z.array(z.string()).optional(),
  searchTimeoutMs: z.number().int().min(100).max(30_000).optional(),
  rateLimitPerMin: z.number().int().min(1).max(10_000).optional()
}).refine((v) => Object.keys(v).length > 0, { message: "patch body must set at least one field" });

async function upsertShopFromAdmin(
  store: MarketplaceStore,
  secretsKey: string,
  input: z.infer<typeof upsertShopBodySchema>
): Promise<CommerceShopRecord> {
  const enc = encryptSecret({ plaintext: input.hintPlaintext, secret: secretsKey });
  return store.upsertCommerceShop({
    shopId: input.shopId,
    displayName: input.displayName,
    baseUrl: input.baseUrl,
    platform: input.platform,
    status: input.status,
    hintSecretCiphertext: enc.ciphertext,
    hintSecretIv: enc.iv,
    hintSecretAuthTag: enc.authTag,
    acceptedCurrency: input.acceptedCurrency,
    fulfillmentRegions: input.fulfillmentRegions,
    searchTimeoutMs: input.searchTimeoutMs,
    rateLimitPerMin: input.rateLimitPerMin
  });
}

/**
 * Admin-facing projection of a shop record. Deliberately omits the encrypted
 * hint material — the operator never needs it (they'd only know the plaintext
 * they submitted, and they can rotate via PATCH).
 */
interface AdminShopView {
  shopId: string;
  displayName: string;
  baseUrl: string;
  platform: string;
  status: CommerceShopStatus;
  acceptedCurrency: string;
  fulfillmentRegions: string[];
  searchTimeoutMs: number;
  rateLimitPerMin: number;
  createdAt: string;
  updatedAt: string;
}

function toAdminView(shop: CommerceShopRecord): AdminShopView {
  return {
    shopId: shop.shopId,
    displayName: shop.displayName,
    baseUrl: shop.baseUrl,
    platform: shop.platform,
    status: shop.status,
    acceptedCurrency: shop.acceptedCurrency,
    fulfillmentRegions: shop.fulfillmentRegions,
    searchTimeoutMs: shop.searchTimeoutMs,
    rateLimitPerMin: shop.rateLimitPerMin,
    createdAt: shop.createdAt,
    updatedAt: shop.updatedAt
  };
}
