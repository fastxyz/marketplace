import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { URL } from "node:url";

import type { Express, Request, Response as ExpressResponse } from "express";
import express from "express";
import { verifyPayment } from "@fastxyz/x402-server";
import { z } from "zod";
import {
  MARKETPLACE_CALLBACK_AUTH_HEADER,
  MARKETPLACE_CALLBACK_URL_HEADER,
  MARKETPLACE_JOB_TOKEN_HEADER,
  buildLlmsTxt,
  buildMarketplaceCatalog,
  buildMarketplaceRouteDetail,
  buildOpenApiDocument,
  buildPaymentRequiredHeaders,
  buildPaymentRequiredResponse,
  buildPaymentRequirementForRoute,
  buildPaymentResponseHeaders,
  buildPayoutSplit,
  buildServiceDetail,
  buildServiceSummary,
  buildCatalogSearchResults,
  computeNextPollAt,
  computeTimeoutAt,
  createChallenge,
  createMarketplaceCallbackAuthToken,
  createDefaultProviderRegistry,
  createOpaqueToken,
  createProviderRuntimeKeyMaterial,
  createSessionToken,
  decimalToRawString,
  decryptProviderRuntimeKey,
  decryptSecret,
  encryptSecret,
  coerceQueryInput,
  getDefaultMarketplaceNetworkConfig,
  getQuerySchemaProperties,
  hashNormalizedRequest,
  MAX_ASYNC_TIMEOUT_MS,
  resolveAsyncJobFailure,
  serializeQueryInput,
  isPrepaidCreditBilling,
  isTopupX402Billing,
  normalizeFastWalletAddress,
  normalizePaymentHeaders,
  parseOpenApiImportDocument,
  parseBearerToken,
  quotedPriceRaw,
  rawToDecimalString,
  requiresWalletSession,
  requiresX402Payment,
  buildMarketplaceIdentityHeaders,
  validateJsonSchema,
  verifyMarketplaceCallbackAuthToken,
  verifyMarketplaceCallbackHeaders,
  verifyMarketplaceIdentityHeaders,
  verifySessionToken,
  verifyWalletChallenge,
  CREDIT_RESERVATION_TTL_MS,
  MARKETPLACE_IDENTITY_PAYMENT_HEADER,
  MARKETPLACE_IDENTITY_REQUEST_HEADER,
  PAYMENT_EXECUTION_RECOVERY_MS,
  PAYMENT_IDENTIFIER_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type BuyerActivityRange,
  type CreateProviderEndpointDraftInput,
  type ExternalProviderEndpointDraftRecord,
  type FacilitatorClient,
  type IdempotencyRecord,
  type JobRecord,
  type MarketplaceRoute,
  type MarketplaceStore,
  type OpenApiImportPreview,
  type PollResult,
  type ProviderEndpointDraftRecord,
  type ProviderExecuteContext,
  type ProviderRequestRecord,
  type ProviderRuntimeKeyRecord,
  type ProviderServiceDetailRecord,
  type ProviderServiceRecord,
  type ProviderServiceType,
  type ProviderRegistry,
  type PublishedEndpointVersionRecord,
  type PublishedServiceEndpointVersionRecord,
  type PublishedServiceVersionRecord,
  type RefundService,
  type RouteBillingType,
  type RouteAsyncConfig,
  type SettlementMode,
  type SuggestionRecord,
  type UpdateProviderEndpointDraftInput,
  type UpstreamAuthMode
} from "@marketplace/shared";

export interface MarketplaceApiOptions {
  store: MarketplaceStore;
  payTo: string;
  sessionSecret: string;
  adminToken: string;
  facilitatorClient: FacilitatorClient;
  refundService: RefundService;
  providers?: ProviderRegistry;
  baseUrl?: string;
  webBaseUrl?: string;
  secretsKey: string;
  siteProofToken?: string | null;
}

type PublishedCatalogService = {
  service: PublishedServiceVersionRecord;
  endpoints: PublishedServiceEndpointVersionRecord[];
};

type RawBodyRequest = Request & {
  rawBody?: Buffer;
};

class UnsafePublicUrlError extends Error {}

const suggestionCreateSchema = z
  .object({
    type: z.enum(["endpoint", "source"]),
    serviceSlug: z.string().min(1).optional().nullable(),
    title: z.string().min(3).max(160),
    description: z.string().min(10).max(4_000),
    sourceUrl: z.string().url().optional().nullable(),
    requesterName: z.string().min(1).max(120).optional().nullable(),
    requesterEmail: z.string().email().optional().nullable()
  })
  .superRefine((value, ctx) => {
    if (value.type === "endpoint" && !value.serviceSlug) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "serviceSlug is required when type=endpoint.",
        path: ["serviceSlug"]
      });
    }
  });

const suggestionStatusSchema = z.enum(["submitted", "reviewing", "accepted", "rejected", "shipped"]);
const catalogSearchQuerySchema = z.object({
  q: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  billingType: z.enum(["fixed_x402", "topup_x402_variable", "prepaid_credit", "free"]).optional(),
  mode: z.enum(["sync", "async"]).optional(),
  settlementMode: z.enum(["verified_escrow"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});
const buyerActivityQuerySchema = z.object({
  range: z.enum(["7d", "30d", "90d", "all"]).default("30d"),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

const suggestionUpdateSchema = z.object({
  status: suggestionStatusSchema.optional(),
  internalNotes: z.string().max(4_000).nullable().optional()
});

const providerAccountSchema = z.object({
  displayName: z.string().min(2).max(120),
  bio: z.string().max(1_000).optional().nullable(),
  websiteUrl: z.string().url().optional().nullable(),
  contactEmail: z.string().email().optional().nullable()
});

const providerServiceTypeSchema = z.enum(["marketplace_proxy", "external_registry"]);

const providerServiceCreateSchema = z.object({
  serviceType: providerServiceTypeSchema,
  slug: z.string().regex(/^[a-z0-9-]{3,64}$/),
  apiNamespace: z.string().regex(/^[a-z0-9-]{3,64}$/).optional().nullable(),
  name: z.string().min(2).max(120),
  tagline: z.string().min(5).max(240),
  about: z.string().min(20).max(4_000),
  categories: z.array(z.string().min(2).max(40)).min(1).max(8),
  promptIntro: z.string().min(10).max(500),
  setupInstructions: z.array(z.string().min(3).max(240)).min(1).max(10),
  websiteUrl: z.string().url().optional().nullable(),
  payoutWallet: z.string().min(1).optional().nullable(),
  featured: z.boolean().optional()
}).superRefine((value, ctx) => {
  if (value.serviceType === "marketplace_proxy" && !value.apiNamespace) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "apiNamespace is required when serviceType=marketplace_proxy.",
      path: ["apiNamespace"]
    });
  }

  if (value.serviceType === "marketplace_proxy" && !value.payoutWallet) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "payoutWallet is required when serviceType=marketplace_proxy.",
      path: ["payoutWallet"]
    });
  }
});

const providerServiceUpdateSchema = z.object({
  serviceType: providerServiceTypeSchema.optional(),
  slug: z.string().regex(/^[a-z0-9-]{3,64}$/).optional(),
  apiNamespace: z.string().regex(/^[a-z0-9-]{3,64}$/).optional().nullable(),
  name: z.string().min(2).max(120).optional(),
  tagline: z.string().min(5).max(240).optional(),
  about: z.string().min(20).max(4_000).optional(),
  categories: z.array(z.string().min(2).max(40)).min(1).max(8).optional(),
  promptIntro: z.string().min(10).max(500).optional(),
  setupInstructions: z.array(z.string().min(3).max(240)).min(1).max(10).optional(),
  websiteUrl: z.string().url().optional().nullable(),
  payoutWallet: z.string().min(1).optional().nullable(),
  featured: z.boolean().optional()
});

const routeBillingTypeSchema = z.enum(["fixed_x402", "topup_x402_variable", "prepaid_credit", "free"]);
const decimalAmountSchema = z.string().regex(/^\d+(?:\.\d{1,6})?$/);

const marketplaceEndpointSchemaInput = z.object({
  endpointType: z.literal("marketplace_proxy"),
  operation: z.string().regex(/^[a-z0-9-]{2,64}$/),
  title: z.string().min(2).max(120),
  description: z.string().min(10).max(500),
  billingType: routeBillingTypeSchema,
  price: z.string().regex(/^\$\d+(?:\.\d{1,6})?$/).optional().nullable(),
  minAmount: decimalAmountSchema.optional().nullable(),
  maxAmount: decimalAmountSchema.optional().nullable(),
  method: z.enum(["GET", "POST"]),
  mode: z.enum(["sync", "async"]),
  asyncStrategy: z.enum(["poll", "webhook"]).optional().nullable(),
  asyncTimeoutMs: z.number().int().min(1_000).max(MAX_ASYNC_TIMEOUT_MS).optional().nullable(),
  pollPath: z.string().startsWith("/").optional().nullable(),
  requestSchemaJson: z.record(z.string(), z.any()),
  responseSchemaJson: z.record(z.string(), z.any()),
  requestExample: z.unknown(),
  responseExample: z.unknown(),
  usageNotes: z.string().max(1_000).optional().nullable(),
  upstreamBaseUrl: z.string().url().optional().nullable(),
  upstreamPath: z.string().startsWith("/").optional().nullable(),
  upstreamAuthMode: z.enum(["none", "bearer", "header"]).optional().nullable(),
  upstreamAuthHeaderName: z.string().min(1).max(120).optional().nullable(),
  upstreamSecret: z.string().min(1).max(4_000).optional().nullable()
});

const externalEndpointSchemaInput = z.object({
  endpointType: z.literal("external_registry"),
  title: z.string().min(2).max(120),
  description: z.string().min(10).max(500),
  method: z.enum(["GET", "POST"]),
  publicUrl: z.string().url(),
  docsUrl: z.string().url(),
  authNotes: z.string().max(1_000).optional().nullable(),
  requestExample: z.unknown(),
  responseExample: z.unknown(),
  usageNotes: z.string().max(1_000).optional().nullable()
});

const endpointCreateSchema = z.discriminatedUnion("endpointType", [
  marketplaceEndpointSchemaInput,
  externalEndpointSchemaInput
]);

const marketplaceEndpointUpdateSchema = marketplaceEndpointSchemaInput
  .partial()
  .extend({
    endpointType: z.literal("marketplace_proxy"),
    clearUpstreamSecret: z.boolean().optional()
  });

const externalEndpointUpdateSchema = externalEndpointSchemaInput
  .partial()
  .extend({
    endpointType: z.literal("external_registry")
  });

const endpointUpdateSchema = z.discriminatedUnion("endpointType", [
  marketplaceEndpointUpdateSchema,
  externalEndpointUpdateSchema
]);

const openApiImportSchema = z.object({
  documentUrl: z.string().url()
});

const reviewRequestSchema = z.object({
  reviewNotes: z.string().min(3).max(4_000),
  reviewerIdentity: z.string().min(1).max(120).optional().nullable()
});

const publishSchema = z.object({
  reviewerIdentity: z.string().min(1).max(120).optional().nullable(),
  settlementMode: z.enum(["verified_escrow"]).optional().nullable()
});

const settlementModeUpdateSchema = z.object({
  reviewerIdentity: z.string().min(1).max(120).optional().nullable(),
  settlementMode: z.enum(["verified_escrow"])
});

const suspendSchema = z.object({
  reviewNotes: z.string().min(1).max(4_000).optional().nullable(),
  reviewerIdentity: z.string().min(1).max(120).optional().nullable()
});

const runtimeReserveSchema = z.object({
  buyerWallet: z.string().min(1),
  amount: decimalAmountSchema,
  idempotencyKey: z.string().min(1).max(200),
  jobToken: z.string().min(1).max(200).optional().nullable(),
  providerReference: z.string().max(500).optional().nullable(),
  expiresAt: z.string().datetime().optional().nullable()
});

const runtimeCaptureSchema = z.object({
  amount: decimalAmountSchema
});

const runtimeExtendSchema = z.object({
  expiresAt: z.string().datetime()
});

const callbackCompletedSchema = z.object({
  providerJobId: z.string().min(1),
  status: z.literal("completed"),
  result: z.unknown(),
  providerState: z.record(z.string(), z.any()).optional().nullable()
});

const callbackFailedSchema = z.object({
  providerJobId: z.string().min(1),
  status: z.literal("failed"),
  error: z.string().min(1),
  providerState: z.record(z.string(), z.any()).optional().nullable()
});

const callbackBodySchema = z.discriminatedUnion("status", [
  callbackCompletedSchema,
  callbackFailedSchema
]);

export function createMarketplaceApi(options: MarketplaceApiOptions): Express {
  if (!options.sessionSecret) {
    throw new Error("sessionSecret is required.");
  }

  if (!options.secretsKey) {
    throw new Error("secretsKey is required.");
  }

  const app = express();
  const providers = options.providers ?? createDefaultProviderRegistry();
  const baseUrl = options.baseUrl ?? "http://localhost:3000";
  const webBaseUrl = options.webBaseUrl ?? baseUrl;
  const allowedWebOrigins = parseAllowedOrigins(webBaseUrl);
  const networkConfig = getDefaultMarketplaceNetworkConfig();
  const secretsKey = options.secretsKey;

  app.use(express.json({
    limit: "1mb",
    verify(req, _res, buffer) {
      (req as RawBodyRequest).rawBody = Buffer.from(buffer);
    }
  }));
  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (origin && allowedWebOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        [
          "Content-Type",
          "Authorization",
          PAYMENT_IDENTIFIER_HEADER,
          PAYMENT_SIGNATURE_HEADER,
          PAYMENT_REQUIRED_HEADER,
          PAYMENT_RESPONSE_HEADER
        ].join(", ")
      );
      res.setHeader(
        "Access-Control-Expose-Headers",
        [PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER].join(", ")
      );
    }

    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }

    return next();
  });

  app.get("/openapi.json", async (_req, res) => {
    const catalog = await loadPublishedCatalog(options.store);
    res.json(
      buildOpenApiDocument({
        baseUrl,
        services: catalog.services.map((entry) => entry.service),
        routes: catalog.routes
      })
    );
  });

  app.get("/llms.txt", async (_req, res) => {
    const catalog = await loadPublishedCatalog(options.store);
    res.type("text/plain").send(
      buildLlmsTxt({
        baseUrl,
        services: catalog.services,
        routes: catalog.routes
      })
    );
  });

  app.get("/.well-known/marketplace.json", async (_req, res) => {
    const catalog = await loadPublishedCatalog(options.store);
    res.json(
      buildMarketplaceCatalog({
        baseUrl,
        services: catalog.services,
        routes: catalog.routes
      })
    );
  });

  app.get("/.well-known/fast-marketplace-verification.txt", (_req, res) => {
    if (!options.siteProofToken) {
      return res.status(404).type("text/plain").send("Not found");
    }
    return res.type("text/plain").send(options.siteProofToken);
  });

  app.get("/catalog/services", async (_req, res) => {
    const catalog = await loadPublishedCatalog(options.store);

    const services = await Promise.all(
      catalog.services.map(async (serviceDetail) =>
        buildServiceSummary({
          service: serviceDetail.service,
          endpoints: serviceDetail.endpoints,
          analytics: await options.store.getServiceAnalytics(serviceDetail.service.routeIds)
        })
      )
    );

    return res.json({ services });
  });

  app.get("/catalog/search", async (req, res) => {
    const parsed = catalogSearchQuerySchema.safeParse({
      q: typeof req.query.q === "string" ? req.query.q : undefined,
      category: typeof req.query.category === "string" ? req.query.category : undefined,
      billingType: typeof req.query.billingType === "string" ? req.query.billingType : undefined,
      mode: typeof req.query.mode === "string" ? req.query.mode : undefined,
      settlementMode: typeof req.query.settlementMode === "string" ? req.query.settlementMode : undefined,
      limit: req.query.limit
    });
    if (!parsed.success) {
      return res.status(400).json({
        error: "Search query validation failed.",
        issues: parsed.error.issues
      });
    }

    const catalog = await loadPublishedCatalog(options.store);
    const services = await Promise.all(
      catalog.services.map(async (serviceDetail) => ({
        ...serviceDetail,
        analytics: await options.store.getServiceAnalytics(serviceDetail.service.routeIds)
      }))
    );

    return res.json({
      results: buildCatalogSearchResults({
        services,
        apiBaseUrl: baseUrl,
        filters: parsed.data
      })
    });
  });

  app.get("/catalog/services/:slug", async (req, res) => {
    const published = await options.store.getPublishedServiceBySlug(req.params.slug);
    if (!published) {
      return res.status(404).json({ error: "Service not found." });
    }

    const detail = buildServiceDetail({
      service: published.service,
      endpoints: published.endpoints,
      analytics: await options.store.getServiceAnalytics(published.service.routeIds),
      apiBaseUrl: baseUrl,
      webBaseUrl
    });

    return res.json(detail);
  });

  app.get("/catalog/routes/:provider/:operation", async (req, res) => {
    const route = await options.store.findPublishedRoute(
      req.params.provider,
      req.params.operation,
      networkConfig.paymentNetwork
    );
    if (!route) {
      return res.status(404).json({ error: "Route not found." });
    }

    const catalog = await loadPublishedCatalog(options.store);
    const published = catalog.services.find((serviceDetail) =>
      serviceDetail.endpoints.some((endpoint) => endpoint.endpointType === "marketplace_proxy" && endpoint.routeId === route.routeId)
    );
    if (!published) {
      return res.status(404).json({ error: "Service not found for route." });
    }

    return res.json(
      buildMarketplaceRouteDetail({
        route,
        service: published.service,
        serviceEndpoints: published.endpoints,
        analytics: await options.store.getServiceAnalytics(published.service.routeIds),
        apiBaseUrl: baseUrl
      })
    );
  });

  app.post("/catalog/suggestions", async (req, res) => {
    const parsed = suggestionCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: "Suggestion validation failed.",
        issues: parsed.error.issues
      });
    }

    if (parsed.data.serviceSlug) {
      const published = await options.store.getPublishedServiceBySlug(parsed.data.serviceSlug);
      if (!published) {
        return res.status(400).json({ error: "Unknown serviceSlug." });
      }
    }

    const suggestion = await options.store.createSuggestion(parsed.data);
    return res.status(201).json(suggestion);
  });

  app.get("/internal/suggestions", async (req, res) => {
    if (!requireAdminToken(req, res, options.adminToken)) {
      return;
    }

    const rawStatus = typeof req.query.status === "string" ? req.query.status : undefined;
    const parsedStatus = rawStatus ? suggestionStatusSchema.safeParse(rawStatus) : null;
    if (parsedStatus && !parsedStatus.success) {
      return res.status(400).json({ error: "Invalid status filter." });
    }

    const suggestions = await options.store.listSuggestions({
      status: parsedStatus?.success ? parsedStatus.data : undefined
    });

    return res.json({ suggestions });
  });

  app.patch("/internal/suggestions/:id", async (req, res) => {
    if (!requireAdminToken(req, res, options.adminToken)) {
      return;
    }

    const parsed = suggestionUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: "Suggestion update validation failed.",
        issues: parsed.error.issues
      });
    }

    const updated = await options.store.updateSuggestion(req.params.id, parsed.data);
    if (!updated) {
      return res.status(404).json({ error: "Suggestion not found." });
    }

    return res.json(updated);
  });

  app.post("/auth/challenge", async (req, res) => {
    const wallet = typeof req.body?.wallet === "string" ? req.body.wallet : "";
    const resourceType = req.body?.resourceType;
    const resourceId = typeof req.body?.resourceId === "string" ? req.body.resourceId : "";

    if ((resourceType !== "job" && resourceType !== "api") || !wallet || !resourceId) {
      return res.status(400).json({ error: "wallet, resourceType, and resourceId are required" });
    }

    let normalizedWallet: string;
    try {
      normalizedWallet = normalizeFastWalletAddress(wallet);
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : "Invalid wallet address."
      });
    }

    if (resourceType === "job") {
      const accessGrant = await options.store.getAccessGrant("job", resourceId, normalizedWallet);
      if (!accessGrant) {
        return res.status(403).json({ error: "No paid access grant exists for that wallet and resource." });
      }
    } else {
      const route = await findPublishedRouteByRouteId(options.store, resourceId);
      if (!route) {
        return res.status(404).json({ error: "Route not found." });
      }
      if (!requiresWalletSession(route)) {
        return res.status(400).json({ error: "That route does not use wallet-session auth." });
      }
    }

    return res.json(createChallenge({ wallet: normalizedWallet, resourceType, resourceId }));
  });

  app.post("/auth/wallet/challenge", async (req, res) => {
    const wallet = typeof req.body?.wallet === "string" ? req.body.wallet : "";

    if (!wallet) {
      return res.status(400).json({ error: "wallet is required" });
    }

    let normalizedWallet: string;
    try {
      normalizedWallet = normalizeFastWalletAddress(wallet);
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : "Invalid wallet address."
      });
    }

    return res.json(
      createChallenge({
        wallet: normalizedWallet,
        resourceType: "site",
        resourceId: webBaseUrl
      })
    );
  });

  app.post("/auth/session", async (req, res) => {
    const wallet = typeof req.body?.wallet === "string" ? req.body.wallet : "";
    const signature = typeof req.body?.signature === "string" ? req.body.signature : "";
    const nonce = typeof req.body?.nonce === "string" ? req.body.nonce : "";
    const expiresAt = typeof req.body?.expiresAt === "string" ? req.body.expiresAt : "";
    const resourceId = typeof req.body?.resourceId === "string" ? req.body.resourceId : "";
    const resourceType = req.body?.resourceType;

    if ((resourceType !== "job" && resourceType !== "api") || !wallet || !signature || !nonce || !expiresAt || !resourceId) {
      return res.status(400).json({
        error: "wallet, signature, nonce, expiresAt, resourceType, and resourceId are required"
      });
    }

    let normalizedWallet: string;
    try {
      normalizedWallet = normalizeFastWalletAddress(wallet);
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : "Invalid wallet address."
      });
    }

    if (resourceType === "job") {
      const accessGrant = await options.store.getAccessGrant("job", resourceId, normalizedWallet);
      if (!accessGrant) {
        return res.status(403).json({ error: "No paid access grant exists for that wallet and resource." });
      }
    } else {
      const route = await findPublishedRouteByRouteId(options.store, resourceId);
      if (!route) {
        return res.status(404).json({ error: "Route not found." });
      }
      if (!requiresWalletSession(route)) {
        return res.status(400).json({ error: "That route does not use wallet-session auth." });
      }
    }

    const verified = await verifyWalletChallenge({
      wallet: normalizedWallet,
      signature,
      challenge: {
        wallet: normalizedWallet,
        resourceType,
        resourceId,
        nonce,
        expiresAt
      }
    });

    if (!verified) {
      return res.status(401).json({ error: "Invalid wallet challenge signature." });
    }

    return res.json({
      accessToken: createSessionToken({
        wallet: normalizedWallet,
        resourceType,
        resourceId,
        secret: options.sessionSecret
      }),
      tokenType: "Bearer"
    });
  });

  app.post("/auth/wallet/session", async (req, res) => {
    const wallet = typeof req.body?.wallet === "string" ? req.body.wallet : "";
    const signature = typeof req.body?.signature === "string" ? req.body.signature : "";
    const nonce = typeof req.body?.nonce === "string" ? req.body.nonce : "";
    const expiresAt = typeof req.body?.expiresAt === "string" ? req.body.expiresAt : "";

    if (!wallet || !signature || !nonce || !expiresAt) {
      return res.status(400).json({
        error: "wallet, signature, nonce, and expiresAt are required"
      });
    }

    let normalizedWallet: string;
    try {
      normalizedWallet = normalizeFastWalletAddress(wallet);
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : "Invalid wallet address."
      });
    }

    const verified = await verifyWalletChallenge({
      wallet: normalizedWallet,
      signature,
      challenge: {
        wallet: normalizedWallet,
        resourceType: "site",
        resourceId: webBaseUrl,
        nonce,
        expiresAt
      }
    });

    if (!verified) {
      return res.status(401).json({ error: "Invalid wallet challenge signature." });
    }

    return res.json({
      accessToken: createSessionToken({
        wallet: normalizedWallet,
        resourceType: "site",
        resourceId: webBaseUrl,
        secret: options.sessionSecret
      }),
      wallet: normalizedWallet,
      resourceType: "site",
      resourceId: webBaseUrl,
      tokenType: "Bearer"
    });
  });

  app.get("/buyer/me/activity", async (req, res) => {
    const session = requireSiteSession(req, res, options.sessionSecret, webBaseUrl);
    if (!session) {
      return;
    }

    const parsed = buyerActivityQuerySchema.safeParse({
      range: typeof req.query.range === "string" ? req.query.range : undefined,
      limit: req.query.limit
    });
    if (!parsed.success) {
      return res.status(400).json({
        error: "Buyer activity query validation failed.",
        issues: parsed.error.issues
      });
    }

    return res.json(await options.store.listBuyerActivity({
      wallet: session.wallet,
      range: parsed.data.range as BuyerActivityRange,
      limit: parsed.data.limit
    }));
  });

  app.get("/provider/me", async (req, res) => {
    const session = requireSiteSession(req, res, options.sessionSecret, webBaseUrl);
    if (!session) {
      return;
    }

    const account = await options.store.getProviderAccountByWallet(session.wallet);
    if (!account) {
      return res.status(404).json({ error: "Provider account not found." });
    }

    return res.json(account);
  });

  app.post("/provider/me", async (req, res) => {
    const session = requireSiteSession(req, res, options.sessionSecret, webBaseUrl);
    if (!session) {
      return;
    }

    const parsed = providerAccountSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Provider account validation failed.", issues: parsed.error.issues });
    }

    const account = await options.store.upsertProviderAccount(session.wallet, parsed.data);
    return res.status(201).json(account);
  });

  app.get("/provider/requests", async (req, res) => {
    const session = requireSiteSession(req, res, options.sessionSecret, webBaseUrl);
    if (!session) {
      return;
    }

    const account = await options.store.getProviderAccountByWallet(session.wallet);
    if (!account) {
      return res.json({ requests: [] satisfies ProviderRequestRecord[] });
    }

    const requests = await options.store.listProviderRequests(session.wallet);
    return res.json({
      requests: requests.map((request) => buildProviderRequestResponse(request, account.id))
    });
  });

  app.post("/provider/requests/:id/claim", async (req, res) => {
    const session = requireSiteSession(req, res, options.sessionSecret, webBaseUrl);
    if (!session) {
      return;
    }

    try {
      const account = await options.store.getProviderAccountByWallet(session.wallet);
      if (!account) {
        return res.status(404).json({ error: "Provider account not found." });
      }

      const claimed = await options.store.claimProviderRequest(req.params.id, session.wallet);
      if (!claimed) {
        return res.status(404).json({ error: "Request not found." });
      }

      return res.json(buildProviderRequestResponse(claimed, account.id));
    } catch (error) {
      return handleProviderMutationError(res, error);
    }
  });

  app.get("/provider/services", async (req, res) => {
    const session = requireSiteSession(req, res, options.sessionSecret, webBaseUrl);
    if (!session) {
      return;
    }

    const services = await options.store.listProviderServices(session.wallet);
    return res.json({ services });
  });

  app.post("/provider/services", async (req, res) => {
    const session = requireSiteSession(req, res, options.sessionSecret, webBaseUrl);
    if (!session) {
      return;
    }

    const parsed = providerServiceCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Provider service validation failed.", issues: parsed.error.issues });
    }

    let payoutWallet: string | null = null;
    if (parsed.data.serviceType === "marketplace_proxy" && parsed.data.payoutWallet) {
      try {
        payoutWallet = normalizeFastWalletAddress(parsed.data.payoutWallet);
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid payout wallet." });
      }
    }

    try {
      const detail = await options.store.createProviderService(session.wallet, {
        ...parsed.data,
        payoutWallet
      });
      return res.status(201).json(detail);
    } catch (error) {
      return handleProviderMutationError(res, error);
    }
  });

  app.get("/provider/services/:id", async (req, res) => {
    const session = requireSiteSession(req, res, options.sessionSecret, webBaseUrl);
    if (!session) {
      return;
    }

    const detail = await options.store.getProviderServiceForOwner(req.params.id, session.wallet);
    if (!detail) {
      return res.status(404).json({ error: "Provider service not found." });
    }

    return res.json(detail);
  });

  app.get("/provider/services/:id/runtime-key", async (req, res) => {
    const session = requireSiteSession(req, res, options.sessionSecret, webBaseUrl);
    if (!session) {
      return;
    }

    const detail = await options.store.getProviderServiceForOwner(req.params.id, session.wallet);
    if (!detail) {
      return res.status(404).json({ error: "Provider service not found." });
    }

    if (detail.service.serviceType === "external_registry") {
      return res.json({ runtimeKey: null });
    }

    const runtimeKey = await options.store.getProviderRuntimeKeyForOwner(req.params.id, session.wallet);
    return res.json({
      runtimeKey: runtimeKey
        ? {
            id: runtimeKey.id,
            keyPrefix: runtimeKey.keyPrefix,
            createdAt: runtimeKey.createdAt,
            updatedAt: runtimeKey.updatedAt
          }
        : null
    });
  });

  app.post("/provider/services/:id/runtime-key", async (req, res) => {
    const session = requireSiteSession(req, res, options.sessionSecret, webBaseUrl);
    if (!session) {
      return;
    }

    const detail = await options.store.getProviderServiceForOwner(req.params.id, session.wallet);
    if (!detail) {
      return res.status(404).json({ error: "Provider service not found." });
    }

    if (detail.service.serviceType === "external_registry") {
      return res.status(400).json({ error: "External registry services do not use runtime keys." });
    }

    try {
      const material = createProviderRuntimeKeyMaterial(secretsKey);
      const runtimeKey = await options.store.rotateProviderRuntimeKey(req.params.id, session.wallet, {
        keyHash: material.keyHash,
        keyPrefix: material.keyPrefix,
        ciphertext: material.ciphertext,
        iv: material.iv,
        authTag: material.authTag
      });

      return res.status(201).json({
        runtimeKey: {
          id: runtimeKey.id,
          keyPrefix: runtimeKey.keyPrefix,
          createdAt: runtimeKey.createdAt,
          updatedAt: runtimeKey.updatedAt
        },
        plaintextKey: material.plaintextKey
      });
    } catch (error) {
      return handleProviderMutationError(res, error);
    }
  });

  app.patch("/provider/services/:id", async (req, res) => {
    const session = requireSiteSession(req, res, options.sessionSecret, webBaseUrl);
    if (!session) {
      return;
    }

    const existing = await options.store.getProviderServiceForOwner(req.params.id, session.wallet);
    if (!existing) {
      return res.status(404).json({ error: "Provider service not found." });
    }

    const parsed = providerServiceUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Provider service validation failed.", issues: parsed.error.issues });
    }

    const nextServiceType = parsed.data.serviceType ?? existing.service.serviceType;
    if (
      nextServiceType === "marketplace_proxy" &&
      parsed.data.apiNamespace &&
      parsed.data.apiNamespace !== existing.service.apiNamespace &&
      existing.endpoints.length > 0
    ) {
      return res.status(409).json({ error: "apiNamespace cannot change after endpoints exist." });
    }

    let payoutWallet = parsed.data.payoutWallet;
    if (nextServiceType === "marketplace_proxy" && payoutWallet) {
      try {
        payoutWallet = normalizeFastWalletAddress(payoutWallet);
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid payout wallet." });
      }
    } else if (nextServiceType === "external_registry") {
      payoutWallet = null;
    }

    try {
      const updated = await options.store.updateProviderServiceForOwner(req.params.id, session.wallet, {
        ...parsed.data,
        apiNamespace: nextServiceType === "external_registry" ? null : parsed.data.apiNamespace,
        payoutWallet
      });
      if (!updated) {
        return res.status(404).json({ error: "Provider service not found." });
      }

      if (websiteHostChanged(existing.service.websiteUrl, updated.websiteUrl)) {
        await options.store.markProviderVerificationResult(req.params.id, "failed", {
          verifiedHost: null,
          failureReason: "Website URL changed. Re-verify ownership before submit."
        });
      }

      return res.json(updated);
    } catch (error) {
      return handleProviderMutationError(res, error);
    }
  });

  app.post("/provider/services/:id/endpoints", async (req, res) => {
    const session = requireSiteSession(req, res, options.sessionSecret, webBaseUrl);
    if (!session) {
      return;
    }

    const service = await options.store.getProviderServiceForOwner(req.params.id, session.wallet);
    if (!service) {
      return res.status(404).json({ error: "Provider service not found." });
    }

    if (service.service.serviceType === "external_registry") {
      const parsed = externalEndpointSchemaInput.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "Endpoint validation failed.", issues: parsed.error.issues });
      }

      const validation = validateExternalEndpointInput({
        service: service.service,
        input: parsed.data
      });
      if (!validation.ok) {
        return res.status(validation.statusCode).json({ error: validation.error });
      }

      try {
        const endpoint = await options.store.createProviderEndpointDraft(
          req.params.id,
          session.wallet,
          parsed.data as CreateProviderEndpointDraftInput
        );

        return res.status(201).json(endpoint);
      } catch (error) {
        return handleProviderMutationError(res, error);
      }
    }

    const parsed = marketplaceEndpointSchemaInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Endpoint validation failed.", issues: parsed.error.issues });
    }

    const validation = await validateProviderEndpointInput({
      mode: "create",
      service: service.service,
      existingEndpoint: null,
      input: parsed.data
    });
    if (!validation.ok) {
      return res.status(validation.statusCode).json({ error: validation.error });
    }

    try {
      const endpoint = await options.store.createProviderEndpointDraft(
        req.params.id,
        session.wallet,
        parsed.data as CreateProviderEndpointDraftInput,
        parsed.data.upstreamSecret
          ? {
              label: `${service.service.slug}:${parsed.data.operation}`,
              ...encryptSecretForStore(parsed.data.upstreamSecret, secretsKey)
            }
          : null
      );

      return res.status(201).json(endpoint);
    } catch (error) {
      return handleProviderMutationError(res, error);
    }
  });

  app.patch("/provider/services/:id/endpoints/:endpointId", async (req, res) => {
    const session = requireSiteSession(req, res, options.sessionSecret, webBaseUrl);
    if (!session) {
      return;
    }

    const service = await options.store.getProviderServiceForOwner(req.params.id, session.wallet);
    if (!service) {
      return res.status(404).json({ error: "Provider service not found." });
    }

    const existingEndpoint = service.endpoints.find((endpoint) => endpoint.id === req.params.endpointId);
    if (!existingEndpoint) {
      return res.status(404).json({ error: "Endpoint draft not found." });
    }

    if (service.service.serviceType === "external_registry") {
      const parsed = externalEndpointUpdateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "Endpoint validation failed.", issues: parsed.error.issues });
      }

      if (existingEndpoint.endpointType !== "external_registry") {
        return res.status(409).json({ error: "Endpoint type does not match the parent service." });
      }

      const validation = validateExternalEndpointInput({
        service: service.service,
        existingEndpoint,
        input: parsed.data
      });
      if (!validation.ok) {
        return res.status(validation.statusCode).json({ error: validation.error });
      }

      try {
        const endpoint = await options.store.updateProviderEndpointDraft(
          req.params.id,
          req.params.endpointId,
          session.wallet,
          parsed.data as UpdateProviderEndpointDraftInput
        );

        if (!endpoint) {
          return res.status(404).json({ error: "Endpoint draft not found." });
        }

        return res.json(endpoint);
      } catch (error) {
        return handleProviderMutationError(res, error);
      }
    }

    const parsed = marketplaceEndpointUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Endpoint validation failed.", issues: parsed.error.issues });
    }

    if (existingEndpoint.endpointType !== "marketplace_proxy") {
      return res.status(409).json({ error: "Endpoint type does not match the parent service." });
    }

    const validation = await validateProviderEndpointInput({
      mode: "update",
      service: service.service,
      existingEndpoint,
      input: parsed.data
    });
    if (!validation.ok) {
      return res.status(validation.statusCode).json({ error: validation.error });
    }

    try {
      const endpoint = await options.store.updateProviderEndpointDraft(
        req.params.id,
        req.params.endpointId,
        session.wallet,
        parsed.data as UpdateProviderEndpointDraftInput,
        parsed.data.upstreamSecret
          ? {
              label: `${service.service.slug}:${parsed.data.operation ?? existingEndpoint.operation}`,
              ...encryptSecretForStore(parsed.data.upstreamSecret, secretsKey)
            }
          : null
      );

      if (!endpoint) {
        return res.status(404).json({ error: "Endpoint draft not found." });
      }

      return res.json(endpoint);
    } catch (error) {
      return handleProviderMutationError(res, error);
    }
  });

  app.delete("/provider/services/:id/endpoints/:endpointId", async (req, res) => {
    const session = requireSiteSession(req, res, options.sessionSecret, webBaseUrl);
    if (!session) {
      return;
    }

    const deleted = await options.store.deleteProviderEndpointDraft(req.params.id, req.params.endpointId, session.wallet);
    if (!deleted) {
      return res.status(404).json({ error: "Endpoint draft not found." });
    }

    return res.status(204).end();
  });

  app.post("/provider/services/:id/openapi/import", async (req, res) => {
    const session = requireSiteSession(req, res, options.sessionSecret, webBaseUrl);
    if (!session) {
      return;
    }

    const service = await options.store.getProviderServiceForOwner(req.params.id, session.wallet);
    if (!service) {
      return res.status(404).json({ error: "Provider service not found." });
    }

    if (service.service.serviceType === "external_registry") {
      return res.status(400).json({ error: "External registry services do not support OpenAPI import." });
    }

    const parsed = openApiImportSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "OpenAPI import validation failed.", issues: parsed.error.issues });
    }

    if (!service.service.websiteUrl) {
      return res.status(400).json({ error: "websiteUrl is required before OpenAPI import." });
    }

    if (!isSafePublicHttpsUrl(service.service.websiteUrl) || !isSafePublicHttpsUrl(parsed.data.documentUrl)) {
      return res.status(400).json({ error: "OpenAPI import only supports public HTTPS URLs." });
    }

    const serviceHost = new URL(service.service.websiteUrl).hostname;
    const documentHost = new URL(parsed.data.documentUrl).hostname;
    if (!isSameOrSubdomain(serviceHost, documentHost)) {
      return res.status(400).json({
        error: "documentUrl host must match the service website host or one of its subdomains."
      });
    }

    let importResponse: globalThis.Response;
    let importDocumentUrl: string;
    try {
      const result = await fetchSafePublicHttpsUrl({
        url: parsed.data.documentUrl,
        init: {
          headers: {
            accept: "application/json"
          }
        },
        validateUrl(url) {
          return isSameOrSubdomain(serviceHost, url.hostname);
        },
        invalidRedirectMessage: "OpenAPI document redirects must stay on the service website host or one of its subdomains."
      });
      importResponse = result.response;
      importDocumentUrl = result.finalUrl;
    } catch (error) {
      if (error instanceof UnsafePublicUrlError) {
        return res.status(400).json({ error: error.message });
      }
      return res.status(502).json({
        error: error instanceof Error ? error.message : "OpenAPI document fetch failed."
      });
    }

    if (!importResponse.ok) {
      return res.status(502).json({
        error: `OpenAPI document fetch failed with status ${importResponse.status}.`
      });
    }

    let document: unknown;
    try {
      document = JSON.parse(await importResponse.text());
    } catch {
      return res.status(400).json({
        error: "Only JSON OpenAPI documents are supported right now."
      });
    }

    let preview: OpenApiImportPreview;
    try {
      preview = parseOpenApiImportDocument({
        document,
        documentUrl: importDocumentUrl
      });
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : "OpenAPI import parsing failed."
      });
    }

    const existingOperations = new Set(service.endpoints.map((endpoint) => endpoint.operation));
    return res.json({
      ...preview,
      endpoints: preview.endpoints.map((endpoint) => {
        const warnings = [...endpoint.warnings];

        if (existingOperations.has(endpoint.operation)) {
          warnings.push("An endpoint draft with this operation already exists. Rename it before creating a new draft.");
        }

        if (!isSameOrSubdomain(serviceHost, new URL(endpoint.upstreamBaseUrl).hostname)) {
          warnings.push("Upstream base URL host must match the service website host or one of its subdomains.");
        }

        return {
          ...endpoint,
          warnings
        };
      })
    });
  });

  app.post("/provider/services/:id/verification-challenge", async (req, res) => {
    const session = requireSiteSession(req, res, options.sessionSecret, webBaseUrl);
    if (!session) {
      return;
    }

    const detail = await options.store.getProviderServiceForOwner(req.params.id, session.wallet);
    if (!detail) {
      return res.status(404).json({ error: "Provider service not found." });
    }

    if (!detail.service.websiteUrl) {
      return res.status(400).json({ error: "websiteUrl is required before verification." });
    }

    if (!isSafePublicHttpsUrl(detail.service.websiteUrl)) {
      return res.status(400).json({ error: "Verification only supports public HTTPS website URLs." });
    }

    const verification = await options.store.createProviderVerificationChallenge(req.params.id, session.wallet);
    if (!verification) {
      return res.status(404).json({ error: "Provider service not found." });
    }

    const host = new URL(detail.service.websiteUrl).host;
    return res.json({
      verificationId: verification.id,
      token: verification.token,
      expectedUrl: `https://${host}/.well-known/fast-marketplace-verification.txt`
    });
  });

  app.post("/provider/services/:id/verify", async (req, res) => {
    const session = requireSiteSession(req, res, options.sessionSecret, webBaseUrl);
    if (!session) {
      return;
    }

    const detail = await options.store.getProviderServiceForOwner(req.params.id, session.wallet);
    if (!detail) {
      return res.status(404).json({ error: "Provider service not found." });
    }

    if (!detail.service.websiteUrl) {
      return res.status(400).json({ error: "websiteUrl is required before verification." });
    }

    if (!isSafePublicHttpsUrl(detail.service.websiteUrl)) {
      return res.status(400).json({ error: "Verification only supports public HTTPS website URLs." });
    }

    const latestVerification = await options.store.getLatestProviderVerification(req.params.id);
    if (!latestVerification) {
      return res.status(400).json({ error: "Create a verification challenge first." });
    }

    const serviceHost = new URL(detail.service.websiteUrl).host;
    const expectedUrl = `https://${serviceHost}/.well-known/fast-marketplace-verification.txt`;

    try {
      const { response: verificationResponse } = await fetchSafePublicHttpsUrl({
        url: expectedUrl,
        validateUrl(url) {
          return url.host === serviceHost;
        },
        invalidRedirectMessage: "Verification redirects must stay on the verified website host."
      });
      const body = (await verificationResponse.text()).trim();
      if (!verificationResponse.ok || body !== latestVerification.token) {
        const updated = await options.store.markProviderVerificationResult(req.params.id, "failed", {
          failureReason: `Verification token mismatch at ${expectedUrl}.`
        });
        return res.status(400).json({
          error: "Verification token mismatch.",
          verification: updated
        });
      }

      const updated = await options.store.markProviderVerificationResult(req.params.id, "verified", {
        verifiedHost: serviceHost,
        failureReason: null
      });
      return res.json(updated);
    } catch (error) {
      if (error instanceof UnsafePublicUrlError) {
        const updated = await options.store.markProviderVerificationResult(req.params.id, "failed", {
          failureReason: error.message
        });
        return res.status(400).json({
          error: error.message,
          verification: updated
        });
      }
      const updated = await options.store.markProviderVerificationResult(req.params.id, "failed", {
        failureReason: error instanceof Error ? error.message : "Verification request failed."
      });
      return res.status(502).json({
        error: error instanceof Error ? error.message : "Verification request failed.",
        verification: updated
      });
    }
  });

  app.post("/provider/services/:id/submit", async (req, res) => {
    const session = requireSiteSession(req, res, options.sessionSecret, webBaseUrl);
    if (!session) {
      return;
    }

    const detail = await options.store.getProviderServiceForOwner(req.params.id, session.wallet);
    if (!detail) {
      return res.status(404).json({ error: "Provider service not found." });
    }

    const submitValidation = await validateProviderServiceForSubmit(detail);
    if (!submitValidation.ok) {
      return res.status(submitValidation.statusCode).json({ error: submitValidation.error });
    }

    const submitted = await options.store.submitProviderService(req.params.id, session.wallet);
    if (!submitted) {
      return res.status(404).json({ error: "Provider service not found." });
    }

    return res.status(202).json(submitted);
  });

  app.post("/provider/runtime/credits/reserve", async (req, res) => {
    const runtimeKey = await requireProviderRuntimeKey(req, res, options.store);
    if (!runtimeKey) {
      return;
    }

    const parsed = runtimeReserveSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Reserve request validation failed.", issues: parsed.error.issues });
    }

    let buyerWallet: string;
    try {
      buyerWallet = normalizeFastWalletAddress(parsed.data.buyerWallet);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid buyer wallet." });
    }

    try {
      const reserveJobToken = parsed.data.jobToken ?? req.header(MARKETPLACE_JOB_TOKEN_HEADER) ?? null;
      let signedIdentity: ReturnType<typeof verifyMarketplaceIdentityHeaders> | null = null;
      if (reserveJobToken) {
        const job = await options.store.getJob(reserveJobToken);
        if (!job || job.serviceId !== runtimeKey.serviceId) {
          return res.status(404).json({ error: "Async prepaid job not found." });
        }
        if (job.status !== "pending") {
          return res.status(409).json({ error: "Async prepaid job is no longer pending." });
        }
        if (!isPrepaidCreditBilling(job.routeSnapshot) || job.routeSnapshot.mode !== "async") {
          return res.status(400).json({ error: "jobToken is only valid for async prepaid-credit jobs." });
        }
        if (job.buyerWallet !== buyerWallet) {
          return res.status(409).json({ error: "buyerWallet does not match the async prepaid job." });
        }
      } else {
        signedIdentity = verifyRuntimeMarketplaceIdentity({
          req,
          runtimeKey,
          secretsKey,
          expectedBuyerWallet: buyerWallet
        });
        if (!signedIdentity) {
          return res.status(401).json({ error: "Missing or invalid marketplace identity headers." });
        }
      }

      const result = await options.store.reserveCredit({
        serviceId: runtimeKey.serviceId,
        buyerWallet,
        currency: networkConfig.tokenSymbol,
        amount: decimalToRawString(parsed.data.amount, 6),
        idempotencyKey: parsed.data.idempotencyKey,
        jobToken: parsed.data.jobToken ?? req.header(MARKETPLACE_JOB_TOKEN_HEADER) ?? null,
        requestId: signedIdentity?.requestId ?? null,
        paymentId: signedIdentity?.paymentId ?? null,
        providerReference: parsed.data.providerReference ?? null,
        expiresAt: clampCreditReservationExpiry(parsed.data.expiresAt ?? null)
      });

      return res.json({
        account: serializeCreditAccount(result.account),
        reservation: serializeCreditReservation(result.reservation),
        entry: serializeCreditEntry(result.entry)
      });
    } catch (error) {
      return handleProviderMutationError(res, error);
    }
  });

  app.post("/provider/runtime/credits/:reservationId/capture", async (req, res) => {
    const runtimeKey = await requireProviderRuntimeKey(req, res, options.store);
    if (!runtimeKey) {
      return;
    }

    const reservation = await options.store.getCreditReservationById(req.params.reservationId);
    if (!reservation || reservation.serviceId !== runtimeKey.serviceId) {
      return res.status(404).json({ error: "Credit reservation not found." });
    }

    const parsed = runtimeCaptureSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Capture request validation failed.", issues: parsed.error.issues });
    }

    if (!reservation.jobToken) {
      const signedIdentity = verifyRuntimeMarketplaceIdentity({
        req,
        runtimeKey,
        secretsKey,
        expectedBuyerWallet: reservation.buyerWallet
      });
      if (
        !signedIdentity
        || signedIdentity.requestId !== reservation.requestId
        || (reservation.paymentId && signedIdentity.paymentId !== reservation.paymentId)
      ) {
        return res.status(401).json({ error: "Missing or invalid marketplace identity headers." });
      }
    }

    try {
      const result = await options.store.captureCreditReservation({
        reservationId: req.params.reservationId,
        amount: decimalToRawString(parsed.data.amount, 6)
      });

      return res.json({
        account: serializeCreditAccount(result.account),
        reservation: serializeCreditReservation(result.reservation),
        captureEntry: serializeCreditEntry(result.captureEntry),
        releaseEntry: result.releaseEntry ? serializeCreditEntry(result.releaseEntry) : null
      });
    } catch (error) {
      return handleProviderMutationError(res, error);
    }
  });

  app.post("/provider/runtime/credits/:reservationId/release", async (req, res) => {
    const runtimeKey = await requireProviderRuntimeKey(req, res, options.store);
    if (!runtimeKey) {
      return;
    }

    const reservation = await options.store.getCreditReservationById(req.params.reservationId);
    if (!reservation || reservation.serviceId !== runtimeKey.serviceId) {
      return res.status(404).json({ error: "Credit reservation not found." });
    }

    try {
      const result = await options.store.releaseCreditReservation({
        reservationId: req.params.reservationId
      });

      return res.json({
        account: serializeCreditAccount(result.account),
        reservation: serializeCreditReservation(result.reservation),
        entry: result.entry ? serializeCreditEntry(result.entry) : null
      });
    } catch (error) {
      return handleProviderMutationError(res, error);
    }
  });

  app.post("/provider/runtime/credits/:reservationId/extend", async (req, res) => {
    const runtimeKey = await requireProviderRuntimeKey(req, res, options.store);
    if (!runtimeKey) {
      return;
    }

    const reservation = await options.store.getCreditReservationById(req.params.reservationId);
    if (!reservation || reservation.serviceId !== runtimeKey.serviceId) {
      return res.status(404).json({ error: "Credit reservation not found." });
    }

    const parsed = runtimeExtendSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Extend request validation failed.", issues: parsed.error.issues });
    }

    if (reservation.status !== "reserved") {
      return res.status(409).json({ error: "Only reserved credit reservations can be extended." });
    }

    const updated = await options.store.extendCreditReservation({
      reservationId: reservation.id,
      expiresAt: clampCreditReservationExpiry(parsed.data.expiresAt)
    });

    return res.json({
      account: serializeCreditAccount(updated.account),
      reservation: serializeCreditReservation(updated.reservation),
    });
  });

  app.post("/provider/runtime/jobs/:jobToken/callback", async (req, res) => {
    const bearerToken = parseBearerToken(req.header("authorization"));
    if (!bearerToken) {
      return res.status(401).json({ error: "Missing bearer token." });
    }

    const job = await options.store.getJob(req.params.jobToken);
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    try {
      verifyMarketplaceCallbackAuthToken({
        jobToken: job.jobToken,
        token: bearerToken,
        secret: options.secretsKey
      });
    } catch (error) {
      return res.status(401).json({ error: error instanceof Error ? error.message : "Invalid callback bearer token." });
    }

    try {
      verifyMarketplaceCallbackHeaders({
        method: req.method,
        path: req.path,
        body: (req as RawBodyRequest).rawBody ?? Buffer.alloc(0),
        headers: req.headers as Record<string, string | string[] | undefined>,
        sharedSecret: bearerToken
      });
    } catch (error) {
      return res.status(401).json({ error: error instanceof Error ? error.message : "Invalid callback signature." });
    }

    const parsed = callbackBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Callback validation failed.", issues: parsed.error.issues });
    }

    if (job.providerJobId && job.providerJobId !== parsed.data.providerJobId) {
      return res.status(409).json({ error: "providerJobId does not match the pending job." });
    }

    if (job.status !== "pending") {
      const refund = await options.store.getRefundByJobToken(job.jobToken);
      return res.json(buildJobResponse(job, refund));
    }

    if (parsed.data.status === "completed") {
      await options.store.recordProviderAttempt({
        jobToken: job.jobToken,
        routeId: job.routeId,
        requestId: job.requestId,
        phase: "callback",
        status: "succeeded",
        requestPayload: req.body ?? {},
        responsePayload: parsed.data
      });

      const completed = await options.store.completeJob(job.jobToken, parsed.data.result);
      return res.json(buildJobResponse(completed, await options.store.getRefundByJobToken(completed.jobToken)));
    }

    await options.store.recordProviderAttempt({
      jobToken: job.jobToken,
      routeId: job.routeId,
      requestId: job.requestId,
      phase: "callback",
      status: "failed",
      requestPayload: req.body ?? {},
      responsePayload: parsed.data,
      errorMessage: parsed.data.error
    });

    await expireAsyncPrepaidReservation(options.store, job);
    const failed = await resolveAsyncJobFailure({
      store: options.store,
      refundService: options.refundService,
      job,
      error: parsed.data.error
    });
    return res.json(buildJobResponse(failed.job, failed.refund));
  });

  app.get("/internal/provider-services", async (req, res) => {
    if (!requireAdminToken(req, res, options.adminToken)) {
      return;
    }

    const rawStatus = typeof req.query.status === "string" ? req.query.status : undefined;
    const status = parseServiceStatus(rawStatus);
    if (rawStatus && !status) {
      return res.status(400).json({ error: "Invalid provider service status filter." });
    }

    const services = await options.store.listAdminProviderServices(status ?? undefined);
    return res.json({ services });
  });

  app.get("/internal/provider-services/:id", async (req, res) => {
    if (!requireAdminToken(req, res, options.adminToken)) {
      return;
    }

    const detail = await options.store.getAdminProviderService(req.params.id);
    if (!detail) {
      return res.status(404).json({ error: "Provider service not found." });
    }

    return res.json(detail);
  });

  app.get("/internal/provider-services/:id/submitted", async (req, res) => {
    if (!requireAdminToken(req, res, options.adminToken)) {
      return;
    }

    const detail = await options.store.getSubmittedProviderService(req.params.id);
    if (!detail) {
      return res.status(404).json({ error: "Submitted provider service snapshot not found." });
    }

    return res.json(detail);
  });

  app.post("/internal/provider-services/:id/request-changes", async (req, res) => {
    if (!requireAdminToken(req, res, options.adminToken)) {
      return;
    }

    const parsed = reviewRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Review request validation failed.", issues: parsed.error.issues });
    }

    const updated = await options.store.requestProviderServiceChanges(req.params.id, parsed.data);
    if (!updated) {
      return res.status(404).json({ error: "Provider service not found." });
    }

    return res.json(updated);
  });

  app.post("/internal/provider-services/:id/publish", async (req, res) => {
    if (!requireAdminToken(req, res, options.adminToken)) {
      return;
    }

    const parsed = publishSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Publish request validation failed.", issues: parsed.error.issues });
    }

    const detail = await options.store.getAdminProviderService(req.params.id);
    if (!detail) {
      return res.status(404).json({ error: "Provider service not found." });
    }

    const validationDetail = (await options.store.getSubmittedProviderService(req.params.id)) ?? detail;
    const settlementMode = detail.service.serviceType === "marketplace_proxy"
      ? (parsed.data.settlementMode ?? detail.service.settlementMode ?? "verified_escrow")
      : null;

    if (detail.service.serviceType === "marketplace_proxy") {
      const publishValidation = await validateProviderServiceForSettlement({
        detail: validationDetail,
        store: options.store,
        settlementMode,
        marketplaceBaseUrl: baseUrl
      });
      if (!publishValidation.ok) {
        return res.status(publishValidation.statusCode).json({ error: publishValidation.error });
      }
    }

    try {
      const updated = await options.store.publishProviderService(req.params.id, {
        reviewerIdentity: parsed.data.reviewerIdentity,
        settlementMode,
        submittedVersionId: validationDetail.latestReview?.submittedVersionId ?? null
      });
      if (!updated) {
        return res.status(404).json({ error: "Provider service not found." });
      }

      return res.json(updated);
    } catch (error) {
      return handleProviderMutationError(res, error);
    }
  });

  app.patch("/internal/provider-services/:id/settlement-mode", async (req, res) => {
    if (!requireAdminToken(req, res, options.adminToken)) {
      return;
    }

    const parsed = settlementModeUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Settlement mode update validation failed.", issues: parsed.error.issues });
    }

    const detail = await options.store.getAdminProviderService(req.params.id);
    if (!detail) {
      return res.status(404).json({ error: "Provider service not found." });
    }

    if (detail.service.serviceType === "external_registry") {
      return res.status(400).json({ error: "External registry services do not use settlement modes." });
    }

    const validationDetail = (await options.store.getSubmittedProviderService(req.params.id)) ?? detail;
    const validation = await validateProviderServiceForSettlement({
      detail: validationDetail,
      store: options.store,
      settlementMode: parsed.data.settlementMode,
      marketplaceBaseUrl: baseUrl
    });
    if (!validation.ok) {
      return res.status(validation.statusCode).json({ error: validation.error });
    }

    const updated = await options.store.updateProviderServiceSettlementMode(req.params.id, {
      ...parsed.data,
      submittedVersionId: validationDetail.latestReview?.submittedVersionId ?? null,
      publishedVersionId: detail.latestPublishedVersionId
    });
    if (!updated) {
      return res.status(404).json({ error: "Provider service not found." });
    }

    return res.json(updated);
  });

  app.post("/internal/provider-services/:id/suspend", async (req, res) => {
    if (!requireAdminToken(req, res, options.adminToken)) {
      return;
    }

    const parsed = suspendSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Suspend request validation failed.", issues: parsed.error.issues });
    }

    const updated = await options.store.suspendProviderService(req.params.id, parsed.data);
    if (!updated) {
      return res.status(404).json({ error: "Provider service not found." });
    }

    return res.json(updated);
  });

  app.get("/api/jobs/:jobToken", async (req, res) => {
    const token = parseBearerToken(req.header("authorization"));
    if (!token) {
      return res.status(401).json({ error: "Missing bearer token." });
    }

    const session = verifySessionToken(token, options.sessionSecret);
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired bearer token." });
    }

    if (session.resourceType !== "job" || session.resourceId !== req.params.jobToken) {
      return res.status(403).json({ error: "Bearer token scope does not match the requested job." });
    }

    const accessGrant = await options.store.getAccessGrant("job", req.params.jobToken, session.wallet);
    if (!accessGrant) {
      return res.status(403).json({ error: "No access grant exists for that wallet and job." });
    }

    const job = await options.store.getJob(req.params.jobToken);
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    const refund = await options.store.getRefundByJobToken(job.jobToken);
    return res.json(buildJobResponse(job, refund));
  });

  const handleMarketplaceRoute = async (req: Request, res: ExpressResponse) => {
    const provider = Array.isArray(req.params.provider) ? (req.params.provider[0] ?? "") : req.params.provider;
    const operation = Array.isArray(req.params.operation) ? (req.params.operation[0] ?? "") : req.params.operation;
    const route = await options.store.findPublishedRoute(
      provider,
      operation,
      networkConfig.paymentNetwork
    );
    if (!route) {
      return res.status(404).json({ error: "Route not found." });
    }

    if (route.method !== req.method) {
      return res.status(405).set("Allow", route.method).json({
        error: `Route requires ${route.method}.`
      });
    }

    let requestInput: unknown;
    try {
      requestInput = normalizeMarketplaceRouteInput(req, route);
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : "Route input validation failed."
      });
    }

    if (requiresWalletSession(route)) {
      return handleWalletSessionRoute({
        req,
        res,
        route,
        requestInput,
        payTo: options.payTo,
        marketplaceBaseUrl: baseUrl,
        sessionSecret: options.sessionSecret,
        providers,
        store: options.store,
        secretsKey
      });
    }

    if (!requiresX402Payment(route)) {
      return handleFreeRoute({
        req,
        res,
        route,
        requestInput,
        store: options.store,
        secretsKey
      });
    }

    return handleX402Route({
      req,
      res,
      route,
      requestInput,
      payTo: options.payTo,
      marketplaceBaseUrl: baseUrl,
      facilitatorClient: options.facilitatorClient,
      refundService: options.refundService,
      providers,
      store: options.store,
      secretsKey
    });
  };

  app.get("/api/:provider/:operation", handleMarketplaceRoute);
  app.post("/api/:provider/:operation", handleMarketplaceRoute);

  app.use((error: unknown, _req: Request, res: ExpressResponse, _next: unknown) => {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unexpected marketplace error."
    });
  });

  return app;
}

async function loadPublishedCatalog(store: MarketplaceStore): Promise<{
  services: PublishedCatalogService[];
  routes: PublishedEndpointVersionRecord[];
}> {
  const [services, routes] = await Promise.all([store.listPublishedServices(), store.listPublishedRoutes()]);
  const serviceDetails = (
    await Promise.all(services.map((service) => store.getPublishedServiceBySlug(service.slug)))
  ).filter((service): service is PublishedCatalogService => Boolean(service));

  return { services: serviceDetails, routes };
}

function normalizeMarketplaceRouteInput(req: Request, route: MarketplaceRoute): unknown {
  if (route.method === "GET") {
    const url = new URL(req.originalUrl, "http://localhost");
    return coerceQueryInput({
      schema: route.requestSchemaJson,
      searchParams: url.searchParams,
      label: "Query parameters"
    });
  }

  const requestBody = req.body ?? {};
  validateJsonSchema({
    schema: route.requestSchemaJson,
    value: requestBody,
    label: "Request body"
  });
  return requestBody;
}

async function handleWalletSessionRoute(input: {
  req: Request;
  res: ExpressResponse;
  route: PublishedEndpointVersionRecord;
  requestInput: unknown;
  payTo: string;
  marketplaceBaseUrl: string;
  sessionSecret: string;
  providers: ProviderRegistry;
  store: MarketplaceStore;
  secretsKey: string;
}) {
  if (input.route.settlementMode !== "verified_escrow") {
    return input.res.status(500).json({ error: "Wallet-session routes require Verified escrow settlement." });
  }

  const session = requireApiSession(input.req, input.res, input.sessionSecret, input.route.routeId);
  if (!session) {
    return;
  }

  const requestId = randomUUID();
  const jobToken = input.route.mode === "async" ? createOpaqueToken("job") : null;
  const asyncAccessPaymentId = jobToken ? createOpaqueToken("wallet") : null;
  const pendingAsyncNextPollAt = jobToken ? computeNextPollAt() : null;
  let paymentDestinationWallet: string | null = null;
  let asyncPayoutSplit: ReturnType<typeof buildPayoutSplit> | null = null;

  if (jobToken) {
    try {
      paymentDestinationWallet = resolvePaymentDestinationWallet(input.route, input.payTo);
      asyncPayoutSplit = buildPayoutSplit({
        route: input.route,
        treasuryWallet: input.payTo,
        paymentDestinationWallet,
        quotedPrice: "0"
      });
      await input.store.savePendingAsyncJob({
        jobToken,
        paymentId: asyncAccessPaymentId,
        buyerWallet: session.wallet,
        route: input.route,
        quotedPrice: "0",
        payoutSplit: asyncPayoutSplit,
        serviceId: input.route.serviceId,
        requestId,
        requestBody: input.requestInput,
        nextPollAt: pendingAsyncNextPollAt,
        timeoutAt: null
      });
      await input.store.createAccessGrant({
        resourceType: "job",
        resourceId: jobToken,
        wallet: session.wallet,
        paymentId: asyncAccessPaymentId!,
        metadata: {
          routeId: input.route.routeId
        }
      });
    } catch (error) {
      return input.res.status(500).json({
        error: error instanceof Error ? error.message : "Async job initialization failed."
      });
    }
  }

  await recordProviderAttemptSafely(input.store, {
    routeId: input.route.routeId,
    requestId,
    phase: "execute",
    status: "pending",
    requestPayload: input.requestInput
  });

  let executeResult: Awaited<ReturnType<typeof executeRoute>>;
  try {
    executeResult = await executeRoute({
      route: input.route,
      input: input.requestInput,
      buyerWallet: session.wallet,
      requestId,
      paymentId: null,
      jobToken,
      marketplaceBaseUrl: input.marketplaceBaseUrl,
      providers: input.providers,
      store: input.store,
      secretsKey: input.secretsKey
    });
  } catch (error) {
    if (jobToken) {
      await failPendingAsyncJobSafely(input.store, jobToken, error instanceof Error ? error.message : "Wallet-session route execution failed.");
    }
    await recordProviderAttemptSafely(input.store, {
      routeId: input.route.routeId,
      requestId,
      responseStatusCode: 500,
      phase: "execute",
      status: "failed",
      requestPayload: input.requestInput,
      errorMessage: error instanceof Error ? error.message : "Wallet-session route execution failed."
    });

    return input.res.status(500).json({
      error: error instanceof Error ? error.message : "Wallet-session route execution failed."
    });
  }

  if (executeResult.kind === "sync") {
    if (jobToken) {
      await failPendingAsyncJobSafely(
        input.store,
        jobToken,
        executeResult.statusCode >= 200 && executeResult.statusCode < 400
          ? "Async route returned a synchronous response."
          : `Async route failed with status ${executeResult.statusCode} before acceptance.`
      );
    }
    await recordProviderAttemptSafely(input.store, {
      routeId: input.route.routeId,
      requestId,
      responseStatusCode: executeResult.statusCode,
      phase: "execute",
      status: jobToken ? "failed" : executeResult.statusCode >= 200 && executeResult.statusCode < 400 ? "succeeded" : "failed",
      requestPayload: input.requestInput,
      responsePayload: executeResult.body
    });

    if (jobToken) {
      return input.res.status(502).json({
        error: "Async route returned a synchronous response."
      });
    }

    return input.res
      .status(executeResult.statusCode)
      .set(executeResult.headers ?? {})
      .json(executeResult.body);
  }

  const acceptedBody = {
    jobToken: jobToken ?? createOpaqueToken("job"),
    status: "pending",
    pollAfterMs: executeResult.pollAfterMs ?? 5_000
  };

  await recordProviderAttemptSafely(input.store, {
    jobToken: acceptedBody.jobToken,
    routeId: input.route.routeId,
    requestId,
    phase: "execute",
    status: "succeeded",
    requestPayload: input.requestInput,
    responsePayload: executeResult
  });

  try {
    await input.store.savePendingAsyncJob({
      jobToken: acceptedBody.jobToken,
      paymentId: asyncAccessPaymentId,
      buyerWallet: session.wallet,
      route: input.route,
      quotedPrice: "0",
      payoutSplit: asyncPayoutSplit ?? buildPayoutSplit({
        route: input.route,
        treasuryWallet: input.payTo,
        paymentDestinationWallet: paymentDestinationWallet ?? resolvePaymentDestinationWallet(input.route, input.payTo),
        quotedPrice: "0"
      }),
      serviceId: input.route.serviceId,
      requestId,
      providerJobId: executeResult.providerJobId,
      requestBody: input.requestInput,
      providerState: executeResult.providerState,
      nextPollAt: computeNextPollAt(executeResult.pollAfterMs),
      timeoutAt: computeTimeoutAt(input.route)
    });
  } catch (error) {
    try {
      await input.store.recordProviderAttempt({
        jobToken: acceptedBody.jobToken,
        routeId: input.route.routeId,
        requestId,
        phase: "execute",
        status: "succeeded",
        requestPayload: input.requestInput,
        responsePayload: executeResult
      });
    } catch (attemptError) {
      console.error("Failed to persist wallet-session async acceptance recovery attempt:", attemptError);
      return input.res.status(500).json({
        error: attemptError instanceof Error ? attemptError.message : "Async acceptance recovery persistence failed."
      });
    }

    console.error("Failed to persist wallet-session async acceptance:", error);
    return input.res.status(202).json(acceptedBody);
  }

  return input.res.status(202).json(acceptedBody);
}

async function handleFreeRoute(input: {
  req: Request;
  res: ExpressResponse;
  route: PublishedEndpointVersionRecord;
  requestInput: unknown;
  store: MarketplaceStore;
  secretsKey: string;
}) {
  if (input.route.mode !== "sync" || input.route.executorKind !== "http") {
    return input.res.status(500).json({ error: "Free routes currently support sync HTTP execution only." });
  }

  const requestBody = input.requestInput;
  const requestId = randomUUID();
  try {
    await input.store.recordProviderAttempt({
      routeId: input.route.routeId,
      requestId,
      phase: "execute",
      status: "pending",
      requestPayload: requestBody
    });
  } catch (error) {
    return input.res.status(500).json({
      error: error instanceof Error ? error.message : "Free route execution persistence failed."
    });
  }

  let executeResult: Awaited<ReturnType<typeof executeHttpRoute>>;
  try {
    executeResult = await executeHttpRoute({
      route: input.route,
      input: requestBody,
      buyerWallet: null,
      requestId,
      paymentId: null,
      store: input.store,
      secretsKey: input.secretsKey
    });
  } catch (error) {
    await recordProviderAttemptSafely(input.store, {
      routeId: input.route.routeId,
      requestId,
      responseStatusCode: 500,
      phase: "execute",
      status: "failed",
      requestPayload: requestBody,
      errorMessage: error instanceof Error ? error.message : "Free route execution failed."
    });

    return input.res.status(500).json({
      error: error instanceof Error ? error.message : "Free route execution failed."
    });
  }

  if (executeResult.kind !== "sync") {
    await recordProviderAttemptSafely(input.store, {
      routeId: input.route.routeId,
      requestId,
      responseStatusCode: 500,
      phase: "execute",
      status: "failed",
      requestPayload: requestBody,
      errorMessage: "Free routes must be sync."
    });
    return input.res.status(500).json({ error: "Free routes must be sync." });
  }

  await recordProviderAttemptSafely(input.store, {
    routeId: input.route.routeId,
    requestId,
    responseStatusCode: executeResult.statusCode,
    phase: "execute",
    status: executeResult.statusCode >= 200 && executeResult.statusCode < 400 ? "succeeded" : "failed",
    requestPayload: requestBody,
    responsePayload: executeResult.body
  });

  return input.res
    .status(executeResult.statusCode)
    .set(executeResult.headers ?? {})
    .json(executeResult.body);
}

async function handleX402Route(input: {
  req: Request;
  res: ExpressResponse;
  route: PublishedEndpointVersionRecord;
  requestInput: unknown;
  payTo: string;
  marketplaceBaseUrl: string;
  facilitatorClient: FacilitatorClient;
  refundService: RefundService;
  providers: ProviderRegistry;
  store: MarketplaceStore;
  secretsKey: string;
}) {
  const requestBody = input.requestInput;
  const paymentHeaders = normalizePaymentHeaders(
    input.req.headers as Record<string, string | string[] | undefined>
  );
  let paymentDestinationWallet: string;
  try {
    paymentDestinationWallet = resolvePaymentDestinationWallet(input.route, input.payTo);
  } catch (error) {
    return input.res.status(500).json({
      error: error instanceof Error ? error.message : "Route settlement configuration is invalid."
    });
  }

  let requiredBody: ReturnType<typeof buildPaymentRequiredResponse>;
  let requiredHeaders: Record<string, string>;
  let paymentRequirement: ReturnType<typeof buildPaymentRequirementForRoute>;
  let quotedPrice: string;
  try {
    requiredBody = buildPaymentRequiredResponse(input.route, paymentDestinationWallet, requestBody);
    requiredHeaders = buildPaymentRequiredHeaders(input.route, paymentDestinationWallet, requestBody);
    paymentRequirement = buildPaymentRequirementForRoute(input.route, paymentDestinationWallet, requestBody);
    quotedPrice = quotedPriceRaw(input.route, requestBody);
  } catch (error) {
    return input.res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to quote this route."
    });
  }

  if (!paymentHeaders.paymentPayload) {
    return input.res.status(402).set(requiredHeaders).json(requiredBody);
  }

  if (!paymentHeaders.paymentId) {
    return input.res.status(400).json({
      error: "PAYMENT-IDENTIFIER is required for paid trigger routes."
    });
  }

  const verifyResult = await input.facilitatorClient.verify(
    paymentHeaders.paymentPayload,
    paymentRequirement
  );

  if (!verifyResult.isValid || !verifyResult.payer) {
    return input.res
      .status(402)
      .set(requiredHeaders)
      .json({
        ...requiredBody,
        error: verifyResult.invalidReason ?? "Payment verification failed."
      });
  }

  if (verifyResult.network && verifyResult.network !== input.route.network) {
    return input.res
      .status(402)
      .set(requiredHeaders)
      .json({
        ...requiredBody,
        error: `Payment network mismatch. Expected ${input.route.network}, received ${verifyResult.network}.`
      });
  }

  let buyerWallet: string;
  try {
    buyerWallet = normalizeFastWalletAddress(verifyResult.payer);
  } catch (error) {
    return input.res.status(402).json({
      error: error instanceof Error ? error.message : "Invalid payer returned by facilitator."
    });
  }

  const requestHash = hashNormalizedRequest(input.route, requestBody);
  const payoutSplit = buildPayoutSplit({
    route: input.route,
    treasuryWallet: input.payTo,
    paymentDestinationWallet,
    quotedPrice
  });
  const paymentResponseHeaders = buildPaymentResponseHeaders({
    success: true,
    network: input.route.network,
    payer: buyerWallet
  });
  const claimedExecution = await input.store.claimPaymentExecution({
    paymentId: paymentHeaders.paymentId,
    normalizedRequestHash: requestHash,
    buyerWallet,
    routeId: input.route.routeId,
    routeVersion: input.route.version,
    pendingRecoveryAction: pendingPaymentRecoveryActionForRoute(input.route),
    quotedPrice,
    payoutSplit,
    paymentPayload: paymentHeaders.paymentPayload,
    facilitatorResponse: verifyResult,
    responseKind: input.route.mode === "async" ? "job" : "sync",
    requestId: randomUUID(),
    jobToken: input.route.mode === "async" ? createOpaqueToken("job") : undefined,
    responseBody: {
      status: "processing"
    },
    responseHeaders: paymentResponseHeaders
  });
  let existing = claimedExecution.record;

  if (
    existing.normalizedRequestHash !== requestHash ||
    existing.buyerWallet !== buyerWallet ||
    existing.routeVersion !== input.route.version
  ) {
    return input.res.status(409).json({
      error: "PAYMENT-IDENTIFIER has already been used for a different request."
    });
  }

  if (existing.executionStatus === "completed") {
    return replayExistingResponse(existing, requestHash, buyerWallet, input.route.version, input.store, input.res);
  }

  const refund = await input.store.getRefundByPaymentId(paymentHeaders.paymentId);
  if (refund) {
    return input.res.status(409).json({
      error: "This paid request has already failed and refund handling has started.",
      refund: refund.status === "sent"
        ? {
            status: refund.status,
            txHash: refund.txHash
          }
        : {
            status: refund.status,
            error: refund.errorMessage
          }
    });
  }

  if (!claimedExecution.created) {
    if (!isPendingExecutionRecoverable(existing)) {
      return input.res.status(202).set(existing.responseHeaders).json({
        status: "processing",
        retryAfterMs: 5_000
      });
    }

    if (existing.pendingRecoveryAction !== "retry") {
      return input.res.status(409).json({
        error:
          "This paid request is being reconciled automatically because the upstream outcome was not durably recorded. Do not retry with a new payment identifier."
      });
    }

    existing = (await input.store.touchPendingPaymentExecution(paymentHeaders.paymentId)) ?? existing;
    if (existing.executionStatus === "completed") {
      return replayExistingResponse(existing, requestHash, buyerWallet, input.route.version, input.store, input.res);
    }
  }

  const requestId = existing.requestId ?? randomUUID();
  const asyncJobToken = input.route.mode === "async" ? (existing.jobToken ?? createOpaqueToken("job")) : null;
  const pendingAsyncNextPollAt = input.route.mode === "async" ? computeNextPollAt() : null;

  if (isTopupX402Billing(input.route)) {
    try {
      const topup = await input.store.completeCreditTopupCharge({
        paymentId: paymentHeaders.paymentId,
        normalizedRequestHash: requestHash,
        buyerWallet,
        routeId: input.route.routeId,
        routeVersion: input.route.version,
        quotedPrice,
        payoutSplit,
        paymentPayload: paymentHeaders.paymentPayload,
        facilitatorResponse: verifyResult,
        responseHeaders: paymentResponseHeaders,
        requestId,
        serviceId: input.route.serviceId,
        metadata: {
          routeId: input.route.routeId
        }
      });
      return input.res
        .status(200)
        .set(topup.idempotency.responseHeaders)
        .json(topup.idempotency.responseBody);
    } catch (error) {
      const failedResponse = await buildRejectedSyncResponse({
        executeResult: {
          kind: "sync",
          statusCode: 500,
          body: {
            error: error instanceof Error ? error.message : "Top-up failed."
          }
        },
        paymentId: paymentHeaders.paymentId,
        buyerWallet,
        quotedPrice,
        route: input.route,
        store: input.store,
        refundService: input.refundService
      });

      await input.store.saveSyncIdempotency({
        paymentId: paymentHeaders.paymentId,
        normalizedRequestHash: requestHash,
        buyerWallet,
        routeId: input.route.routeId,
        routeVersion: input.route.version,
        quotedPrice,
        payoutSplit,
        paymentPayload: paymentHeaders.paymentPayload,
        facilitatorResponse: verifyResult,
        statusCode: failedResponse.statusCode,
        body: failedResponse.body,
        headers: failedResponse.headers,
        requestId
      });

      return input.res.status(failedResponse.statusCode).set(failedResponse.headers).json(failedResponse.body);
    }
  }

  if (asyncJobToken) {
    try {
      await input.store.savePendingAsyncJob({
        jobToken: asyncJobToken,
        paymentId: paymentHeaders.paymentId,
        buyerWallet,
        route: input.route,
        quotedPrice,
        payoutSplit,
        serviceId: input.route.serviceId,
        requestId,
        requestBody,
        nextPollAt: pendingAsyncNextPollAt,
        timeoutAt: null
      });
    } catch (error) {
      const failedResponse = await buildRejectedSyncResponse({
        executeResult: {
          kind: "sync",
          statusCode: 500,
          body: {
            error: error instanceof Error ? error.message : "Async job initialization failed."
          }
        },
        paymentId: paymentHeaders.paymentId,
        buyerWallet,
        quotedPrice,
        route: input.route,
        store: input.store,
        refundService: input.refundService
      });

      await input.store.saveSyncIdempotency({
        paymentId: paymentHeaders.paymentId,
        normalizedRequestHash: requestHash,
        buyerWallet,
        routeId: input.route.routeId,
        routeVersion: input.route.version,
        quotedPrice,
        payoutSplit,
        paymentPayload: paymentHeaders.paymentPayload,
        facilitatorResponse: verifyResult,
        statusCode: failedResponse.statusCode,
        body: failedResponse.body,
        headers: failedResponse.headers,
        requestId
      });

      return input.res.status(failedResponse.statusCode).set(failedResponse.headers).json(failedResponse.body);
    }
  }

  let executeResult: Awaited<ReturnType<typeof executeRoute>>;
  try {
    executeResult = await executeRoute({
      route: input.route,
      input: requestBody,
      buyerWallet,
      requestId,
      paymentId: paymentHeaders.paymentId,
      jobToken: asyncJobToken,
      marketplaceBaseUrl: input.marketplaceBaseUrl,
      providers: input.providers,
      store: input.store,
      secretsKey: input.secretsKey
    });
  } catch (error) {
    if (asyncJobToken) {
      await failPendingAsyncJobSafely(input.store, asyncJobToken, error instanceof Error ? error.message : "Route execution failed.");
      await recordProviderAttemptSafely(input.store, {
        jobToken: asyncJobToken,
        paymentId: paymentHeaders.paymentId,
        routeId: input.route.routeId,
        requestId,
        responseStatusCode: 500,
        phase: "execute",
        status: "failed",
        requestPayload: requestBody,
        responsePayload: {
          error: error instanceof Error ? error.message : "Route execution failed."
        },
        errorMessage: error instanceof Error ? error.message : "Route execution failed."
      });
    }
    const failedResponse = await buildRejectedSyncResponse({
      executeResult: {
        kind: "sync",
        statusCode: 500,
        body: {
          error: error instanceof Error ? error.message : "Route execution failed."
        }
      },
      paymentId: paymentHeaders.paymentId,
      buyerWallet,
      quotedPrice,
      route: input.route,
      store: input.store,
      refundService: input.refundService
    });

    await input.store.saveSyncIdempotency({
      paymentId: paymentHeaders.paymentId,
      normalizedRequestHash: requestHash,
      buyerWallet,
      routeId: input.route.routeId,
      routeVersion: input.route.version,
      quotedPrice,
      payoutSplit,
      paymentPayload: paymentHeaders.paymentPayload,
      facilitatorResponse: verifyResult,
      statusCode: failedResponse.statusCode,
      body: failedResponse.body,
      headers: failedResponse.headers,
      requestId
    });

    return input.res.status(failedResponse.statusCode).set(failedResponse.headers).json(failedResponse.body);
  }

  if (executeResult.kind === "sync") {
    await recordProviderAttemptSafely(input.store, {
      paymentId: paymentHeaders.paymentId,
      jobToken: asyncJobToken,
      routeId: input.route.routeId,
      requestId,
      responseStatusCode: executeResult.statusCode,
      phase: "execute",
      status: asyncJobToken
        ? "failed"
        : executeResult.statusCode >= 200 && executeResult.statusCode < 400
          ? "succeeded"
          : "failed",
      requestPayload: requestBody,
      responsePayload: executeResult.body,
      errorMessage: asyncJobToken && executeResult.statusCode >= 200 && executeResult.statusCode < 400
        ? "Async route returned a synchronous response."
        : undefined
    });

    if (asyncJobToken) {
      await failPendingAsyncJobSafely(
        input.store,
        asyncJobToken,
        executeResult.statusCode >= 200 && executeResult.statusCode < 400
          ? "Async route returned a synchronous response."
          : `Async route failed with status ${executeResult.statusCode} before acceptance.`
      );
    }
    if (asyncJobToken || executeResult.statusCode < 200 || executeResult.statusCode >= 400) {
      const failedResponse = await buildRejectedSyncResponse({
        executeResult: asyncJobToken && executeResult.statusCode >= 200 && executeResult.statusCode < 400
          ? {
              ...executeResult,
              statusCode: 502,
              body: {
                error: "Async route returned a synchronous response.",
                upstreamStatus: executeResult.statusCode,
                upstreamBody: executeResult.body
              }
            }
          : executeResult,
        paymentId: paymentHeaders.paymentId,
        buyerWallet,
        quotedPrice,
        route: input.route,
        store: input.store,
        refundService: input.refundService
      });

      await input.store.saveSyncIdempotency({
        paymentId: paymentHeaders.paymentId,
        normalizedRequestHash: requestHash,
        buyerWallet,
        routeId: input.route.routeId,
        routeVersion: input.route.version,
        quotedPrice,
        payoutSplit,
        paymentPayload: paymentHeaders.paymentPayload,
        facilitatorResponse: verifyResult,
        statusCode: failedResponse.statusCode,
        body: failedResponse.body,
        headers: failedResponse.headers,
        requestId
      });

      return input.res.status(failedResponse.statusCode).set(failedResponse.headers).json(failedResponse.body);
    }

    let persisted: Awaited<ReturnType<MarketplaceStore["saveSyncIdempotency"]>>;
    try {
      persisted = await input.store.saveSyncIdempotency({
        paymentId: paymentHeaders.paymentId,
        normalizedRequestHash: requestHash,
        buyerWallet,
        routeId: input.route.routeId,
        routeVersion: input.route.version,
        quotedPrice,
        payoutSplit,
        paymentPayload: paymentHeaders.paymentPayload,
        facilitatorResponse: verifyResult,
        statusCode: executeResult.statusCode,
        body: executeResult.body,
        headers: {
          ...paymentResponseHeaders,
          ...(executeResult.headers ?? {})
        },
        requestId,
        providerPayoutSourceKind: "route_charge"
      });
    } catch (error) {
      return input.res.status(500).json({
        error: error instanceof Error ? error.message : "Paid sync response persistence failed."
      });
    }

    await persistProviderPayoutSafely(input.store, {
      payoutSplit,
      sourceKind: "route_charge",
      sourceId: paymentHeaders.paymentId
    });

    return input.res
      .status(executeResult.statusCode)
      .set(persisted.responseHeaders)
      .json(executeResult.body);
  }

  const jobToken = asyncJobToken ?? createOpaqueToken("job");
  const acceptedBody = {
    jobToken,
    status: "pending",
    pollAfterMs: executeResult.pollAfterMs ?? 5_000
  };

  await recordProviderAttemptSafely(input.store, {
    jobToken: acceptedBody.jobToken,
    paymentId: paymentHeaders.paymentId,
    routeId: input.route.routeId,
    requestId,
    phase: "execute",
    status: "succeeded",
    requestPayload: requestBody,
    responsePayload: executeResult
  });

  try {
    await input.store.savePendingAsyncJob({
      jobToken: acceptedBody.jobToken,
      paymentId: paymentHeaders.paymentId,
      buyerWallet,
      route: input.route,
      quotedPrice,
      payoutSplit,
      serviceId: input.route.serviceId,
      requestId,
      providerJobId: executeResult.providerJobId,
      requestBody,
      providerState: executeResult.providerState,
      nextPollAt: computeNextPollAt(executeResult.pollAfterMs),
      timeoutAt: computeTimeoutAt(input.route)
    });
    await input.store.saveAsyncAcceptance({
      paymentId: paymentHeaders.paymentId,
      normalizedRequestHash: requestHash,
      buyerWallet,
      route: input.route,
      quotedPrice,
      payoutSplit,
      paymentPayload: paymentHeaders.paymentPayload,
      facilitatorResponse: verifyResult,
      jobToken: acceptedBody.jobToken,
      serviceId: input.route.serviceId,
      requestId,
      providerJobId: executeResult.providerJobId,
      requestBody,
      providerState: executeResult.providerState,
      nextPollAt: computeNextPollAt(executeResult.pollAfterMs),
      timeoutAt: computeTimeoutAt(input.route),
      responseBody: acceptedBody,
      responseHeaders: paymentResponseHeaders
    });
  } catch (error) {
    let acceptedAttemptRecorded = false;
    try {
      await input.store.recordProviderAttempt({
        jobToken: acceptedBody.jobToken,
        paymentId: paymentHeaders.paymentId,
        routeId: input.route.routeId,
        requestId,
        phase: "execute",
        status: "succeeded",
        requestPayload: requestBody,
        responsePayload: executeResult
      });
      acceptedAttemptRecorded = true;
    } catch (attemptError) {
      console.error("Failed to persist accepted async execute attempt for recovery:", attemptError);
    }

    const recovered = await persistAcceptedAsyncPaymentFallback({
      store: input.store,
      paymentId: paymentHeaders.paymentId,
      buyerWallet,
      routeId: input.route.routeId,
      jobToken: acceptedBody.jobToken,
      responseBody: acceptedBody,
      responseHeaders: paymentResponseHeaders
    });
    if (!recovered && !acceptedAttemptRecorded) {
      return input.res.status(500).json({
        error: error instanceof Error ? error.message : "Async acceptance persistence failed."
      });
    }
  }

  return input.res.status(202).set(paymentResponseHeaders).json(acceptedBody);
}

async function recordProviderAttemptSafely(
  store: MarketplaceStore,
  attempt: Parameters<MarketplaceStore["recordProviderAttempt"]>[0]
) {
  try {
    await store.recordProviderAttempt(attempt);
  } catch (error) {
    console.error("Failed to record provider attempt:", error);
  }
}

async function failPendingAsyncJobSafely(store: MarketplaceStore, jobToken: string, errorMessage: string) {
  try {
    const job = await store.getJob(jobToken);
    if (!job || job.status !== "pending") {
      return;
    }

    await store.failJob(jobToken, errorMessage);
  } catch (error) {
    console.error("Failed to fail pending async job:", error);
  }
}

async function persistAcceptedAsyncPaymentFallback(input: {
  store: MarketplaceStore;
  paymentId: string;
  buyerWallet: string;
  routeId: string;
  jobToken: string;
  responseBody: unknown;
  responseHeaders: Record<string, string>;
}) {
  try {
    await input.store.completePendingJobExecution({
      paymentId: input.paymentId,
      jobToken: input.jobToken,
      responseBody: input.responseBody,
      responseHeaders: input.responseHeaders
    });
    await input.store.createAccessGrant({
      resourceType: "job",
      resourceId: input.jobToken,
      wallet: input.buyerWallet,
      paymentId: input.paymentId,
      metadata: {
        routeId: input.routeId
      }
    });
    return true;
  } catch (error) {
    console.error("Failed to persist accepted async payment fallback:", error);
    return false;
  }
}

async function executeMockRoute(
  route: MarketplaceRoute,
  input: unknown,
  buyerWallet: string,
  requestId: string,
  paymentId: string | null,
  providers: ProviderRegistry
) {
  const provider = providers[route.provider];
  if (!provider) {
    throw new Error(`Provider adapter missing: ${route.provider}`);
  }

  return provider.execute({
    route,
    input,
    buyerWallet,
    requestId,
    paymentId
  });
}

async function executeRoute(input: {
  route: MarketplaceRoute;
  input: unknown;
  buyerWallet: string;
  requestId: string;
  paymentId: string | null;
  jobToken?: string | null;
  marketplaceBaseUrl?: string;
  providers: ProviderRegistry;
  store: MarketplaceStore;
  secretsKey: string;
}) {
  switch (input.route.executorKind) {
    case "mock":
      return executeMockRoute(
        input.route,
        input.input,
        input.buyerWallet,
        input.requestId,
        input.paymentId,
        input.providers
      );
    case "http":
      return executeHttpRoute({
        route: input.route,
        input: input.input,
        buyerWallet: input.buyerWallet,
        requestId: input.requestId,
        paymentId: input.paymentId,
        jobToken: input.jobToken,
        marketplaceBaseUrl: input.marketplaceBaseUrl,
        store: input.store,
        secretsKey: input.secretsKey
      });
    default:
      throw new Error(`Unsupported route executor: ${String(input.route.executorKind)}`);
  }
}

async function executeHttpRoute(input: {
  route: MarketplaceRoute;
  input: unknown;
  buyerWallet: string | null;
  requestId: string;
  paymentId: string | null;
  jobToken?: string | null;
  marketplaceBaseUrl?: string;
  store: MarketplaceStore;
  secretsKey: string;
}) {
  if (!input.route.upstreamBaseUrl || !input.route.upstreamPath || !input.route.upstreamAuthMode) {
    throw new Error("HTTP route is missing upstream configuration.");
  }

  if (input.route.mode === "async" && !input.route.asyncConfig) {
    throw new Error("Async HTTP routes require asyncConfig.");
  }

  const headers: Record<string, string> = {
    [MARKETPLACE_IDENTITY_REQUEST_HEADER]: input.requestId,
    [MARKETPLACE_IDENTITY_PAYMENT_HEADER]: input.paymentId ?? ""
  };

  if (input.route.method === "POST") {
    headers["content-type"] = "application/json";
  }

  if (input.route.upstreamAuthMode !== "none") {
    if (!input.route.upstreamSecretRef) {
      throw new Error("HTTP route is missing upstream secret.");
    }

    const secret = await input.store.getProviderSecret(input.route.upstreamSecretRef);
    if (!secret) {
      throw new Error("Upstream secret not found.");
    }

    const decrypted = decryptSecret({
      ciphertext: secret.secretCiphertext,
      iv: secret.iv,
      authTag: secret.authTag,
      secret: input.secretsKey
    });

    applyUpstreamAuthHeaders(headers, input.route.upstreamAuthMode, decrypted, input.route.upstreamAuthHeaderName ?? null);
  }

  if ("serviceId" in input.route) {
    const publishedRoute = input.route as PublishedEndpointVersionRecord;
    const detail = await input.store.getAdminProviderService(publishedRoute.serviceId);
    const runtimeKeyRecord = detail
      ? await input.store.getProviderRuntimeKeyForOwner(publishedRoute.serviceId, detail.account.ownerWallet)
      : null;

    if (runtimeKeyRecord) {
      if (!input.buyerWallet && isPrepaidCreditBilling(input.route)) {
        throw new Error("Buyer wallet is required for prepaid-credit routes.");
      }

      const runtimeKey = decryptProviderRuntimeKey({
        ciphertext: runtimeKeyRecord.secretCiphertext,
        iv: runtimeKeyRecord.iv,
        authTag: runtimeKeyRecord.authTag,
        secret: input.secretsKey
      });

      Object.assign(
        headers,
        buildMarketplaceIdentityHeaders({
          buyerWallet: input.buyerWallet,
          serviceId: publishedRoute.serviceId,
          requestId: input.requestId,
          paymentId: input.paymentId,
          signingSecret: runtimeKey
        })
      );

      if (input.route.mode === "async") {
        if (!input.jobToken) {
          throw new Error("Async HTTP routes require a marketplace job token.");
        }

        headers[MARKETPLACE_JOB_TOKEN_HEADER] = input.jobToken;

        if (input.route.asyncConfig?.strategy === "webhook") {
          if (!isHttpsUrl(input.marketplaceBaseUrl)) {
            throw new Error("Webhook async routes require an HTTPS marketplace base URL.");
          }

          headers[MARKETPLACE_CALLBACK_URL_HEADER] = joinUrl(
            input.marketplaceBaseUrl!,
            `/provider/runtime/jobs/${input.jobToken}/callback`
          );
          headers[MARKETPLACE_CALLBACK_AUTH_HEADER] = `Bearer ${createMarketplaceCallbackAuthToken({
            jobToken: input.jobToken,
            secret: input.secretsKey
          })}`;
        }
      }
    } else if (input.route.mode === "async" || isPrepaidCreditBilling(input.route)) {
      throw new Error("Provider runtime key is required for this settlement flow.");
    }
  }

  return executeUpstreamHttpRequest({
    mode: input.route.mode,
    method: input.route.method,
    upstreamBaseUrl: input.route.upstreamBaseUrl!,
    upstreamPath: input.route.upstreamPath!,
    requestSchemaJson: input.route.requestSchemaJson
  }, input.input, headers);
}

async function executeUpstreamHttpRequest(
  route: {
    mode: MarketplaceRoute["mode"];
    method: MarketplaceRoute["method"];
    upstreamBaseUrl: string;
    upstreamPath: string;
    requestSchemaJson: MarketplaceRoute["requestSchemaJson"];
  },
  requestInput: unknown,
  headers: Record<string, string>
) {
  let response: globalThis.Response;
  try {
    const url = route.method === "GET"
      ? `${joinUrl(route.upstreamBaseUrl, route.upstreamPath)}${serializeQueryInput({
          schema: route.requestSchemaJson,
          value: requestInput,
          label: "HTTP route request"
        })}`
      : joinUrl(route.upstreamBaseUrl, route.upstreamPath);
    response = await fetch(url, route.method === "GET"
      ? {
          method: "GET",
          headers
        }
      : {
          method: "POST",
          headers,
          body: JSON.stringify(requestInput)
        });
  } catch (error) {
    return {
      kind: "sync" as const,
      statusCode: 502,
      body: {
        error: error instanceof Error ? error.message : "Upstream request failed."
      },
      headers: {
        "content-type": "application/json"
      }
    };
  }

  if (route.mode === "async") {
    if (response.status !== 202) {
      return {
        kind: "sync" as const,
        statusCode: response.status,
        body: await safeResponseBody(response),
        headers: {
          "content-type": response.headers.get("content-type") ?? "application/json"
        }
      };
    }

    return parseAsyncExecuteResponse(response);
  }

  return {
    kind: "sync" as const,
    statusCode: response.status,
    body: await safeResponseBody(response),
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json"
    }
  };
}

async function parseAsyncExecuteResponse(response: globalThis.Response) {
  const body = await safeResponseBody(response);
  if (!body || typeof body !== "object") {
    throw new Error("Async upstream acceptance body must be a JSON object.");
  }

  const accepted = body as Record<string, unknown>;
  if (accepted.status !== "accepted" || typeof accepted.providerJobId !== "string" || accepted.providerJobId.length === 0) {
    throw new Error("Async upstream acceptance body must include status=accepted and providerJobId.");
  }

  return {
    kind: "async" as const,
    providerJobId: accepted.providerJobId,
    providerState: isJsonObject(accepted.providerState) ? accepted.providerState : undefined,
    pollAfterMs: typeof accepted.pollAfterMs === "number" && Number.isFinite(accepted.pollAfterMs)
      ? accepted.pollAfterMs
      : undefined
  };
}

async function buildRejectedSyncResponse(input: {
  executeResult: {
    kind: "sync";
    statusCode: number;
    body: unknown;
    headers?: Record<string, string>;
  };
  paymentId: string;
  buyerWallet: string;
  quotedPrice: string;
  route: MarketplaceRoute;
  store: MarketplaceStore;
  refundService: RefundService;
}) {
  const refund = await input.store.createRefund({
    paymentId: input.paymentId,
    wallet: input.buyerWallet,
    amount: input.quotedPrice
  });
  const claimedRefund = refund.status === "pending"
    ? await input.store.claimRefundForSend(refund.id)
    : null;

  if (refund.status === "sent") {
    return {
      statusCode: input.executeResult.statusCode,
      headers: {
        "content-type": "application/json"
      },
      body: {
        error: "Upstream request failed. Payment was refunded.",
        upstreamStatus: input.executeResult.statusCode,
        upstreamBody: input.executeResult.body,
        refund: {
          status: refund.status,
          txHash: refund.txHash
        }
      }
    };
  }

  if (refund.status === "failed" || !claimedRefund) {
    return {
      statusCode: input.executeResult.statusCode,
      headers: {
        "content-type": "application/json"
      },
      body: {
        error: "Upstream request failed and the automatic refund did not complete.",
        upstreamStatus: input.executeResult.statusCode,
        upstreamBody: input.executeResult.body,
        refund: {
          status: refund.status,
          error: refund.errorMessage
        }
      }
    };
  }

  try {
    const receipt = await input.refundService.issueRefund({
      wallet: input.buyerWallet,
      amount: input.quotedPrice,
      reason: `Sync upstream request rejected for ${input.route.routeId}.`
    });
    const sentRefund = await input.store.markRefundSent(claimedRefund.id, receipt.txHash);

    return {
      statusCode: input.executeResult.statusCode,
      headers: {
        "content-type": "application/json"
      },
      body: {
        error: "Upstream request failed. Payment was refunded.",
        upstreamStatus: input.executeResult.statusCode,
        upstreamBody: input.executeResult.body,
        refund: {
          status: sentRefund.status,
          txHash: sentRefund.txHash
        }
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Refund failed.";
    const failedRefund = await input.store.markRefundFailed(claimedRefund.id, message);

    return {
      statusCode: input.executeResult.statusCode,
      headers: {
        "content-type": "application/json"
      },
      body: {
        error: "Upstream request failed and the automatic refund did not complete.",
        upstreamStatus: input.executeResult.statusCode,
        upstreamBody: input.executeResult.body,
        refund: {
          status: failedRefund.status,
          error: failedRefund.errorMessage
        }
      }
    };
  }
}

function resolvePaymentDestinationWallet(route: PublishedEndpointVersionRecord, treasuryWallet: string): string {
  return treasuryWallet;
}

async function persistProviderPayoutSafely(
  store: MarketplaceStore,
  input: {
    payoutSplit: {
      usesTreasurySettlement?: boolean;
      providerAmount: string;
      providerWallet: string | null;
      providerAccountId: string;
      currency: "USDC" | "testUSDC";
    };
    sourceKind: "route_charge" | "credit_topup";
    sourceId: string;
  }
) {
  if (
    input.payoutSplit.usesTreasurySettlement === false
    || BigInt(input.payoutSplit.providerAmount) <= 0n
    || !input.payoutSplit.providerWallet
  ) {
    return;
  }

  try {
    await store.createProviderPayout({
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      providerAccountId: input.payoutSplit.providerAccountId,
      providerWallet: input.payoutSplit.providerWallet,
      currency: input.payoutSplit.currency,
      amount: input.payoutSplit.providerAmount
    });
  } catch (error) {
    console.error("Failed to persist provider payout:", error);
  }
}

function applyUpstreamAuthHeaders(
  headers: Record<string, string>,
  mode: UpstreamAuthMode,
  secret: string,
  headerName: string | null
) {
  if (mode === "bearer") {
    headers.authorization = `Bearer ${secret}`;
    return;
  }

  if (mode === "header") {
    if (!headerName) {
      throw new Error("Custom header auth requires upstreamAuthHeaderName.");
    }

    headers[headerName] = secret;
  }
}

function encryptSecretForStore(secret: string, secretsKey: string) {
  return encryptSecret({ plaintext: secret, secret: secretsKey });
}

async function validateProviderEndpointInput(input: {
  mode: "create" | "update";
  service: { websiteUrl: string | null };
  existingEndpoint: {
    method: MarketplaceRoute["method"];
    mode: MarketplaceRoute["mode"];
    asyncConfig: RouteAsyncConfig | null;
    billing: MarketplaceRoute["billing"];
    requestSchemaJson: MarketplaceRoute["requestSchemaJson"];
    upstreamBaseUrl: string | null;
    upstreamPath: string | null;
    upstreamAuthMode: UpstreamAuthMode | null;
    upstreamAuthHeaderName: string | null;
    upstreamSecretRef: string | null;
  } | null;
  input:
    | z.infer<typeof marketplaceEndpointSchemaInput>
    | z.infer<typeof marketplaceEndpointUpdateSchema>;
}): Promise<{ ok: true } | { ok: false; statusCode: number; error: string }> {
  const billingType = (input.input.billingType ??
    input.existingEndpoint?.billing.type) as RouteBillingType | undefined;
  if (!billingType) {
    return { ok: false, statusCode: 400, error: "billingType is required." };
  }

  const nextMethod = (input.input.method ?? input.existingEndpoint?.method) as MarketplaceRoute["method"] | undefined;
  if (!nextMethod) {
    return { ok: false, statusCode: 400, error: "method is required." };
  }
  const nextMode = (input.input.mode ?? input.existingEndpoint?.mode) as MarketplaceRoute["mode"] | undefined;
  if (!nextMode) {
    return { ok: false, statusCode: 400, error: "mode is required." };
  }

  const nextBaseUrl = input.input.upstreamBaseUrl ?? input.existingEndpoint?.upstreamBaseUrl ?? null;
  const nextPath = input.input.upstreamPath ?? input.existingEndpoint?.upstreamPath ?? null;
  const nextAuthMode = input.input.upstreamAuthMode ?? input.existingEndpoint?.upstreamAuthMode ?? null;
  const nextHeaderName =
    input.input.upstreamAuthHeaderName === undefined
      ? input.existingEndpoint?.upstreamAuthHeaderName ?? null
      : input.input.upstreamAuthHeaderName;
  const existingAsyncConfig = input.existingEndpoint?.asyncConfig ?? null;
  const nextAsyncStrategy = input.input.asyncStrategy ?? existingAsyncConfig?.strategy ?? null;
  const nextAsyncTimeoutMs = input.input.asyncTimeoutMs ?? existingAsyncConfig?.timeoutMs ?? null;
  const nextPollPath = input.input.pollPath === undefined ? (existingAsyncConfig?.pollPath ?? null) : input.input.pollPath;
  const hasStoredSecret = Boolean(input.existingEndpoint?.upstreamSecretRef) && !("clearUpstreamSecret" in input.input && input.input.clearUpstreamSecret);
  const nextWebsiteUrl = input.service.websiteUrl;
  const nextRequestSchemaJson = input.input.requestSchemaJson ?? input.existingEndpoint?.requestSchemaJson ?? {};

  if (!nextWebsiteUrl) {
    return { ok: false, statusCode: 400, error: "websiteUrl is required before managing endpoints." };
  }

  if (billingType === "fixed_x402") {
    if (!input.input.price && input.mode === "create") {
      return { ok: false, statusCode: 400, error: "price is required when billingType=fixed_x402." };
    }
  }

  if (billingType !== "free" && nextMethod !== "POST") {
    return { ok: false, statusCode: 400, error: "Paid marketplace routes must use method=POST." };
  }

  if (billingType === "topup_x402_variable") {
    if (nextMode !== "sync") {
      return { ok: false, statusCode: 400, error: "Marketplace top-up routes must use mode=sync." };
    }
    if (!input.input.minAmount || !input.input.maxAmount) {
      return { ok: false, statusCode: 400, error: "minAmount and maxAmount are required when billingType=topup_x402_variable." };
    }
    if (BigInt(decimalToRawString(input.input.minAmount, 6)) > BigInt(decimalToRawString(input.input.maxAmount, 6))) {
      return { ok: false, statusCode: 400, error: "minAmount cannot be greater than maxAmount." };
    }
    if (nextBaseUrl || nextPath || nextAuthMode || nextHeaderName || input.input.upstreamSecret || hasStoredSecret) {
      return { ok: false, statusCode: 400, error: "Marketplace top-up routes cannot include upstream configuration." };
    }
  } else {
    if (!nextBaseUrl || !nextPath || !nextAuthMode) {
      return { ok: false, statusCode: 400, error: "upstreamBaseUrl, upstreamPath, and upstreamAuthMode are required." };
    }
    if (nextAuthMode === "header" && !nextHeaderName) {
      return { ok: false, statusCode: 400, error: "upstreamAuthHeaderName is required when upstreamAuthMode=header." };
    }
    if ((nextAuthMode === "bearer" || nextAuthMode === "header") && !input.input.upstreamSecret && !hasStoredSecret) {
      return { ok: false, statusCode: 400, error: "upstreamSecret is required for authenticated upstream routes." };
    }
  }

  if (nextMode === "async") {
    if (billingType === "topup_x402_variable") {
      return { ok: false, statusCode: 400, error: "Marketplace top-up routes do not support async mode." };
    }
    if (!nextAsyncStrategy || typeof nextAsyncTimeoutMs !== "number" || !Number.isFinite(nextAsyncTimeoutMs)) {
      return { ok: false, statusCode: 400, error: "asyncStrategy and asyncTimeoutMs are required for async routes." };
    }
    if (nextAsyncTimeoutMs < 1_000 || nextAsyncTimeoutMs > MAX_ASYNC_TIMEOUT_MS) {
      return {
        ok: false,
        statusCode: 400,
        error: `asyncTimeoutMs must be between 1000 and ${MAX_ASYNC_TIMEOUT_MS}.`
      };
    }
    if (nextAsyncStrategy === "poll" && !nextPollPath) {
      return { ok: false, statusCode: 400, error: "pollPath is required for poll-based async routes." };
    }
    if (nextAsyncStrategy === "webhook" && nextPollPath) {
      return { ok: false, statusCode: 400, error: "pollPath is not used for webhook async routes." };
    }
  }

  try {
    if (nextMethod === "GET") {
      getQuerySchemaProperties(nextRequestSchemaJson);
    }
    validateJsonSchema({
      schema: nextRequestSchemaJson,
      value: input.input.requestExample,
      label: "requestExample"
    });
    validateJsonSchema({
      schema: input.input.responseSchemaJson ?? {},
      value: input.input.responseExample,
      label: "responseExample"
    });
  } catch (error) {
    return {
      ok: false,
      statusCode: 400,
      error: error instanceof Error ? error.message : "Invalid endpoint schema."
    };
  }

  if (nextMethod === "GET" && nextPath?.includes("{")) {
    return { ok: false, statusCode: 400, error: "GET marketplace routes do not support path parameters in upstreamPath." };
  }

  if (billingType !== "topup_x402_variable") {
    const rootHost = new URL(nextWebsiteUrl).hostname;
    const upstreamHost = new URL(nextBaseUrl ?? nextWebsiteUrl).hostname;
    if (!isSameOrSubdomain(rootHost, upstreamHost)) {
      return {
        ok: false,
        statusCode: 400,
        error: "upstreamBaseUrl host must match the service website host or one of its subdomains."
      };
    }
  }

  return { ok: true };
}

function validateExternalEndpointInput(input: {
  service: Pick<ProviderServiceRecord, "websiteUrl">;
  existingEndpoint?: Pick<ExternalProviderEndpointDraftRecord, "method" | "publicUrl" | "docsUrl"> | null;
  input: z.infer<typeof externalEndpointSchemaInput> | z.infer<typeof externalEndpointUpdateSchema>;
}): { ok: true } | { ok: false; statusCode: number; error: string } {
  const websiteUrl = input.service.websiteUrl;
  if (!websiteUrl) {
    return { ok: false, statusCode: 400, error: "websiteUrl is required before managing endpoints." };
  }

  const serviceHost = new URL(websiteUrl).hostname;
  const publicUrl = input.input.publicUrl ?? input.existingEndpoint?.publicUrl;
  const docsUrl = input.input.docsUrl ?? input.existingEndpoint?.docsUrl;

  if (!publicUrl || !docsUrl) {
    return { ok: false, statusCode: 400, error: "publicUrl and docsUrl are required." };
  }

  if (!isSameOrSubdomain(serviceHost, new URL(publicUrl).hostname)) {
    return {
      ok: false,
      statusCode: 400,
      error: "publicUrl host must match the service website host or one of its subdomains."
    };
  }

  if (!isSameOrSubdomain(serviceHost, new URL(docsUrl).hostname)) {
    return {
      ok: false,
      statusCode: 400,
      error: "docsUrl host must match the service website host or one of its subdomains."
    };
  }

  return { ok: true };
}

async function validateProviderServiceForSubmit(detail: ProviderServiceDetailRecord) {
  if (!detail.service.websiteUrl) {
    return { ok: false as const, statusCode: 400, error: "websiteUrl is required before submit." };
  }

  if (detail.endpoints.length === 0) {
    return { ok: false as const, statusCode: 400, error: "At least one endpoint is required before submit." };
  }

  const serviceUrl = new URL(detail.service.websiteUrl);
  const serviceHost = serviceUrl.host;
  const serviceHostname = serviceUrl.hostname;

  if (detail.service.serviceType === "external_registry") {
    for (const endpoint of detail.endpoints) {
      if (endpoint.endpointType !== "external_registry") {
        return {
          ok: false as const,
          statusCode: 400,
          error: "External registry services can only publish external endpoints."
        };
      }

      if (!isSameOrSubdomain(serviceHostname, new URL(endpoint.publicUrl).hostname)) {
        return {
          ok: false as const,
          statusCode: 400,
          error: "All external endpoint URLs must match the verified website host or a subdomain."
        };
      }

      if (!isSameOrSubdomain(serviceHostname, new URL(endpoint.docsUrl).hostname)) {
        return {
          ok: false as const,
          statusCode: 400,
          error: "All external docs URLs must match the verified website host or a subdomain."
        };
      }
    }

    return { ok: true as const };
  }

  const verification = detail.verification;
  if (!verification || verification.status !== "verified") {
    return { ok: false as const, statusCode: 400, error: "Verify website ownership before submit." };
  }

  if (verification.verifiedHost !== serviceHost) {
    return {
      ok: false as const,
      statusCode: 400,
      error: "Website URL changed since verification. Re-verify ownership before submit."
    };
  }

  if (!detail.service.payoutWallet) {
    return { ok: false as const, statusCode: 400, error: "payoutWallet is required before submit." };
  }

  for (const endpoint of detail.endpoints) {
    if (endpoint.endpointType !== "marketplace_proxy") {
      return {
        ok: false as const,
        statusCode: 400,
        error: "Marketplace proxy services can only publish marketplace endpoints."
      };
    }

    if (endpoint.executorKind === "marketplace") {
      continue;
    }

    if (endpoint.mode === "async" && !endpoint.asyncConfig) {
      return { ok: false as const, statusCode: 400, error: `Endpoint ${endpoint.operation} is missing asyncConfig.` };
    }

    if (!endpoint.upstreamBaseUrl || !isSameOrSubdomain(serviceHostname, new URL(endpoint.upstreamBaseUrl).hostname)) {
      return {
        ok: false as const,
        statusCode: 400,
        error: "All endpoint upstream hosts must match the service website host or a subdomain."
      };
    }
  }

  return { ok: true as const };
}

async function validateProviderServiceForSettlement(input: {
  detail: ProviderServiceDetailRecord;
  store: MarketplaceStore;
  settlementMode: SettlementMode | null;
  marketplaceBaseUrl: string;
}) {
  const baseValidation = await validateProviderServiceForSubmit(input.detail);
  if (!baseValidation.ok) {
    return baseValidation;
  }

  if (input.detail.service.serviceType === "external_registry") {
    return { ok: true as const };
  }

  if (!input.settlementMode) {
    return { ok: false as const, statusCode: 400, error: "settlementMode is required for marketplace proxy services." };
  }

  const runtimeKey = await input.store.getProviderRuntimeKeyForOwner(
    input.detail.service.id,
    input.detail.account.ownerWallet
  );
  const requiresRuntimeKey = input.detail.endpoints.some((endpoint) =>
    endpoint.endpointType === "marketplace_proxy"
    && (endpoint.mode === "async" || endpoint.billing.type === "prepaid_credit")
  );

  if (requiresRuntimeKey && !runtimeKey) {
    return {
      ok: false as const,
      statusCode: 400,
      error: "Async and prepaid-credit services require a provider runtime key before publish."
    };
  }

  if (
    input.detail.endpoints.some((endpoint) =>
      endpoint.endpointType === "marketplace_proxy"
      && endpoint.mode === "async"
      && endpoint.asyncConfig?.strategy === "webhook"
    )
    && !isHttpsUrl(input.marketplaceBaseUrl)
  ) {
    return {
      ok: false as const,
      statusCode: 400,
      error: "Webhook async routes require an HTTPS MARKETPLACE_BASE_URL before publish."
    };
  }

  return { ok: true as const };
}

function isSameOrSubdomain(rootHost: string, candidateHost: string): boolean {
  const root = rootHost.toLowerCase();
  const candidate = candidateHost.toLowerCase();
  return candidate === root || candidate.endsWith(`.${root}`);
}

function websiteHostChanged(previousUrl: string | null, nextUrl: string | null): boolean {
  if (!previousUrl || !nextUrl) {
    return false;
  }

  return new URL(previousUrl).host !== new URL(nextUrl).host;
}

async function fetchSafePublicHttpsUrl(input: {
  url: string;
  init?: RequestInit;
  validateUrl?: (url: URL) => boolean;
  invalidRedirectMessage: string;
  maxRedirects?: number;
}): Promise<{ response: globalThis.Response; finalUrl: string }> {
  let currentUrl = new URL(input.url);
  const maxRedirects = input.maxRedirects ?? 5;

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    if (!isSafePublicHttpsUrl(currentUrl.toString())) {
      throw new UnsafePublicUrlError("Only public HTTPS URLs are supported.");
    }
    if (input.validateUrl && !input.validateUrl(currentUrl)) {
      throw new UnsafePublicUrlError(input.invalidRedirectMessage);
    }

    const response = await fetch(currentUrl.toString(), {
      ...input.init,
      redirect: "manual"
    });
    if (!isRedirectStatusCode(response.status)) {
      return {
        response,
        finalUrl: currentUrl.toString()
      };
    }

    if (redirects >= maxRedirects) {
      throw new UnsafePublicUrlError("Too many redirects.");
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new UnsafePublicUrlError("Redirect response was missing a Location header.");
    }

    currentUrl = new URL(location, currentUrl);
  }

  throw new UnsafePublicUrlError("Too many redirects.");
}

function isRedirectStatusCode(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isSafePublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return false;
    }

    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || !host.includes(".")) {
      return false;
    }

    const family = isIP(host);
    if (family === 4) {
      const [a, b] = host.split(".").map((part) => Number(part));
      if (
        a === 10
        || a === 127
        || a === 0
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
      ) {
        return false;
      }
    }

    if (family === 6) {
      if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

function parseServiceStatus(value: string | undefined | null) {
  switch (value) {
    case "draft":
    case "pending_review":
    case "changes_requested":
    case "published":
    case "suspended":
    case "archived":
      return value;
    default:
      return null;
  }
}

function handleProviderMutationError(res: ExpressResponse, error: unknown) {
  const message = error instanceof Error ? error.message : "Provider mutation failed.";

  if (
    message.includes("already exists") ||
    message.includes("cannot change after endpoints exist") ||
    message.includes("can only change before") ||
    message.includes("already claimed") ||
    message.includes("not claimable")
  ) {
    return res.status(409).json({ error: message });
  }

  if (message.includes("not found")) {
    return res.status(404).json({ error: message });
  }

  return res.status(400).json({ error: message });
}

function requireAdminToken(req: Request, res: ExpressResponse, adminToken: string): boolean {
  const token = parseBearerToken(req.header("authorization"));
  if (!token || token !== adminToken) {
    res.status(401).json({ error: "Missing or invalid admin token." });
    return false;
  }

  return true;
}

function requireSiteSession(req: Request, res: ExpressResponse, secret: string, webBaseUrl: string) {
  const token = parseBearerToken(req.header("authorization"));
  if (!token) {
    res.status(401).json({ error: "Missing bearer token." });
    return null;
  }

  const session = verifySessionToken(token, secret);
  if (!session) {
    res.status(401).json({ error: "Invalid or expired bearer token." });
    return null;
  }

  if (session.resourceType !== "site" || session.resourceId !== webBaseUrl) {
    res.status(403).json({ error: "Bearer token scope does not match this site." });
    return null;
  }

  return session;
}

function requireApiSession(req: Request, res: ExpressResponse, secret: string, routeId: string) {
  const token = parseBearerToken(req.header("authorization"));
  if (!token) {
    res.status(401).json({ error: "Missing bearer token." });
    return null;
  }

  const session = verifySessionToken(token, secret);
  if (!session) {
    res.status(401).json({ error: "Invalid or expired bearer token." });
    return null;
  }

  if (session.resourceType !== "api" || session.resourceId !== routeId) {
    res.status(403).json({ error: "Bearer token scope does not match this route." });
    return null;
  }

  return session;
}

async function requireProviderRuntimeKey(req: Request, res: ExpressResponse, store: MarketplaceStore): Promise<ProviderRuntimeKeyRecord | null> {
  const token = parseBearerToken(req.header("authorization"));
  if (!token) {
    res.status(401).json({ error: "Missing bearer token." });
    return null;
  }

  const runtimeKey = await store.getProviderRuntimeKeyByPlaintext(token);
  if (!runtimeKey) {
    res.status(401).json({ error: "Invalid runtime key." });
    return null;
  }

  return runtimeKey;
}

function verifyRuntimeMarketplaceIdentity(input: {
  req: Request;
  runtimeKey: ProviderRuntimeKeyRecord;
  secretsKey: string;
  expectedBuyerWallet: string;
}) {
  try {
    const runtimeSecret = decryptProviderRuntimeKey({
      ciphertext: input.runtimeKey.secretCiphertext,
      iv: input.runtimeKey.iv,
      authTag: input.runtimeKey.authTag,
      secret: input.secretsKey
    });
    const identity = verifyMarketplaceIdentityHeaders({
      headers: input.req.headers as Record<string, string | string[] | undefined>,
      signingSecret: runtimeSecret
    });
    if (identity.serviceId !== input.runtimeKey.serviceId) {
      return null;
    }
    if (identity.buyerWallet !== input.expectedBuyerWallet) {
      return null;
    }
    return identity;
  } catch {
    return null;
  }
}

async function findPublishedRouteByRouteId(store: MarketplaceStore, routeId: string): Promise<PublishedEndpointVersionRecord | null> {
  const routes = await store.listPublishedRoutes();
  return routes.find((route) => route.routeId === routeId) ?? null;
}

function serializeCreditAccount(account: {
  id: string;
  serviceId: string;
  buyerWallet: string;
  currency: string;
  availableAmount: string;
  reservedAmount: string;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    ...account,
    availableAmountDecimal: rawToDecimalString(account.availableAmount, 6),
    reservedAmountDecimal: rawToDecimalString(account.reservedAmount, 6)
  };
}

function serializeCreditReservation(reservation: {
  id: string;
  serviceId: string;
  buyerWallet: string;
  currency: string;
  status: string;
  reservedAmount: string;
  capturedAmount: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
  providerReference: string | null;
}) {
  return {
    ...reservation,
    reservedAmountDecimal: rawToDecimalString(reservation.reservedAmount, 6),
    capturedAmountDecimal: rawToDecimalString(reservation.capturedAmount, 6)
  };
}

function serializeCreditEntry(entry: {
  id: string;
  accountId: string;
  serviceId: string;
  buyerWallet: string;
  currency: string;
  kind: string;
  amount: string;
  reservationId: string | null;
  paymentId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}) {
  return {
    ...entry,
    amountDecimal: rawToDecimalString(entry.amount, 6)
  };
}

function buildTopupResponseBody(
  route: PublishedEndpointVersionRecord,
  buyerWallet: string,
  quotedPrice: string,
  account: {
    id: string;
    serviceId: string;
    buyerWallet: string;
    currency: string;
    availableAmount: string;
    reservedAmount: string;
    createdAt: string;
    updatedAt: string;
  },
  entry: {
    id: string;
    accountId: string;
    serviceId: string;
    buyerWallet: string;
    currency: string;
    kind: string;
    amount: string;
    reservationId: string | null;
    paymentId: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
  }
) {
  return {
    routeId: route.routeId,
    serviceId: route.serviceId,
    wallet: buyerWallet,
    topupAmount: rawToDecimalString(quotedPrice, 6),
    account: serializeCreditAccount(account),
    entry: serializeCreditEntry(entry)
  };
}

function isPendingExecutionRecoverable(record: IdempotencyRecord) {
  const updatedAt = Date.parse(record.updatedAt);
  if (Number.isNaN(updatedAt)) {
    return false;
  }

  return Date.now() - updatedAt >= PAYMENT_EXECUTION_RECOVERY_MS;
}

function pendingPaymentRecoveryActionForRoute(
  route: Pick<PublishedEndpointVersionRecord, "executorKind" | "settlementMode">
) {
  return route.executorKind === "mock"
    || route.executorKind === "marketplace"
    ? "retry"
    : "refund";
}

function hasStoredTopupResponseBody(body: unknown): body is {
  routeId: string;
  serviceId: string;
  wallet: string;
  topupAmount: string;
  account: Record<string, unknown>;
  entry: Record<string, unknown>;
} {
  if (!body || typeof body !== "object") {
    return false;
  }

  const candidate = body as Record<string, unknown>;
  return (
    typeof candidate.routeId === "string"
    && typeof candidate.serviceId === "string"
    && typeof candidate.wallet === "string"
    && typeof candidate.topupAmount === "string"
    && typeof candidate.account === "object"
    && candidate.account !== null
    && typeof candidate.entry === "object"
    && candidate.entry !== null
  );
}

async function replayExistingResponse(
  record: IdempotencyRecord,
  requestHash: string,
  buyerWallet: string,
  routeVersion: string,
  store: MarketplaceStore,
  res: ExpressResponse
) {
  if (
    record.normalizedRequestHash !== requestHash ||
    record.buyerWallet !== buyerWallet ||
    record.routeVersion !== routeVersion
  ) {
    return res.status(409).json({
      error: "PAYMENT-IDENTIFIER has already been used for a different request."
    });
  }

  if (record.providerPayoutSourceKind === "credit_topup" && !hasStoredTopupResponseBody(record.responseBody)) {
    const route = await findPublishedRouteByRouteId(store, record.routeId);
    if (route && isTopupX402Billing(route)) {
      const topup = await store.getCreditTopupByPaymentId(route.serviceId, record.paymentId);
      if (topup) {
        return res
          .status(200)
          .set(record.responseHeaders)
          .json(buildTopupResponseBody(route, buyerWallet, record.quotedPrice, topup.account, topup.entry));
      }
    }
  }

  if (record.responseKind === "job" && record.jobToken) {
    await store.createAccessGrant({
      resourceType: "job",
      resourceId: record.jobToken,
      wallet: buyerWallet,
      paymentId: record.paymentId,
      metadata: {
        routeId: record.routeId
      }
    });
    return res.status(record.responseStatusCode).set(record.responseHeaders).json(record.responseBody);
  }

  return res.status(record.responseStatusCode).set(record.responseHeaders).json(record.responseBody);
}

function buildJobResponse(job: JobRecord, refund: Awaited<ReturnType<MarketplaceStore["getRefundByJobToken"]>>) {
  return {
    jobToken: job.jobToken,
    status: job.status,
    result: job.status === "completed" ? job.resultBody : undefined,
    error: job.status === "failed" ? job.errorMessage : undefined,
    refund: refund
      ? {
          status: refund.status,
          txHash: refund.txHash,
          error: refund.errorMessage
        }
      : undefined,
    updatedAt: job.updatedAt
  };
}

function buildProviderRequestResponse(
  request: SuggestionRecord,
  currentProviderAccountId: string
): ProviderRequestRecord {
  return {
    id: request.id,
    type: request.type,
    serviceSlug: request.serviceSlug,
    title: request.title,
    description: request.description,
    sourceUrl: request.sourceUrl,
    status: request.status,
    claimedByProviderName: request.claimedByProviderName,
    claimedAt: request.claimedAt,
    claimedByCurrentProvider: request.claimedByProviderAccountId === currentProviderAccountId,
    claimable:
      !request.claimedByProviderAccountId && request.status !== "rejected" && request.status !== "shipped",
    createdAt: request.createdAt,
    updatedAt: request.updatedAt
  };
}

async function safeResponseBody(response: globalThis.Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  return response.text();
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isHttpsUrl(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }

  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function clampCreditReservationExpiry(expiresAt: string | null): string {
  const latestAllowed = Date.now() + CREDIT_RESERVATION_TTL_MS;
  if (!expiresAt) {
    return new Date(latestAllowed).toISOString();
  }

  const parsed = Date.parse(expiresAt);
  if (Number.isNaN(parsed)) {
    throw new Error("expiresAt must be a valid ISO timestamp.");
  }

  return new Date(Math.min(parsed, latestAllowed)).toISOString();
}

async function expireAsyncPrepaidReservation(store: MarketplaceStore, job: Pick<JobRecord, "jobToken" | "serviceId" | "routeSnapshot">) {
  if (!job.serviceId || !isPrepaidCreditBilling(job.routeSnapshot)) {
    return;
  }

  const reservation = await store.getCreditReservationByJobToken(job.serviceId, job.jobToken);
  if (!reservation) {
    return;
  }

  if (reservation.status === "reserved") {
    await store.expireCreditReservation(reservation.id);
    return;
  }

  if (reservation.status === "captured") {
    await store.reverseCapturedCreditReservation({
      reservationId: reservation.id,
      metadata: {
        reason: "async_job_failed"
      }
    });
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

export function createX402FacilitatorClient(url: string): FacilitatorClient {
  return {
    async verify(paymentPayload, paymentRequirement) {
      return verifyPayment(
        paymentPayload,
        paymentRequirement as Parameters<typeof verifyPayment>[1],
        { url }
      );
    }
  };
}

function safeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

function parseAllowedOrigins(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => safeOrigin(entry))
  );
}
