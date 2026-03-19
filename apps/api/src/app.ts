import { URL } from "node:url";

import type { Express, Request, Response as ExpressResponse } from "express";
import express from "express";
import { verifyPayment } from "@fastxyz/x402-server";
import { z } from "zod";
import {
  LEGACY_PAYMENT_HEADER,
  LEGACY_PAYMENT_IDENTIFIER_HEADER,
  LEGACY_PAYMENT_RESPONSE_HEADER,
  buildLlmsTxt,
  buildMarketplaceCatalog,
  buildOpenApiDocument,
  buildPaymentRequiredHeaders,
  buildPaymentRequiredResponse,
  buildPaymentRequirementForRoute,
  buildPaymentResponseHeaders,
  buildPayoutSplit,
  buildServiceDetail,
  buildServiceSummary,
  createChallenge,
  createDefaultProviderRegistry,
  createOpaqueToken,
  createSessionToken,
  decryptSecret,
  encryptSecret,
  getDefaultMarketplaceNetworkConfig,
  hashNormalizedRequest,
  normalizeFastWalletAddress,
  normalizePaymentHeaders,
  parseBearerToken,
  quotedPriceRaw,
  validateJsonSchema,
  verifySessionToken,
  verifyWalletChallenge,
  PAYMENT_IDENTIFIER_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type CreateProviderEndpointDraftInput,
  type FacilitatorClient,
  type IdempotencyRecord,
  type JobRecord,
  type MarketplaceRoute,
  type MarketplaceStore,
  type ProviderRequestRecord,
  type ProviderServiceDetailRecord,
  type ProviderRegistry,
  type PublishedEndpointVersionRecord,
  type PublishedServiceVersionRecord,
  type RefundService,
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
  secretsKey?: string;
  tavilyApiKey?: string;
}

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

const providerServiceCreateSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{3,64}$/),
  apiNamespace: z.string().regex(/^[a-z0-9-]{3,64}$/),
  name: z.string().min(2).max(120),
  tagline: z.string().min(5).max(240),
  about: z.string().min(20).max(4_000),
  categories: z.array(z.string().min(2).max(40)).min(1).max(8),
  promptIntro: z.string().min(10).max(500),
  setupInstructions: z.array(z.string().min(3).max(240)).min(1).max(10),
  websiteUrl: z.string().url().optional().nullable(),
  payoutWallet: z.string().min(1),
  featured: z.boolean().optional()
});

const providerServiceUpdateSchema = providerServiceCreateSchema.partial();

const endpointSchemaInput = z.object({
  operation: z.string().regex(/^[a-z0-9-]{2,64}$/),
  title: z.string().min(2).max(120),
  description: z.string().min(10).max(500),
  price: z.string().regex(/^\$\d+(?:\.\d{1,6})?$/),
  mode: z.literal("sync"),
  requestSchemaJson: z.record(z.string(), z.any()),
  responseSchemaJson: z.record(z.string(), z.any()),
  requestExample: z.unknown(),
  responseExample: z.unknown(),
  usageNotes: z.string().max(1_000).optional().nullable(),
  upstreamBaseUrl: z.string().url(),
  upstreamPath: z.string().startsWith("/"),
  upstreamAuthMode: z.enum(["none", "bearer", "header"]),
  upstreamAuthHeaderName: z.string().min(1).max(120).optional().nullable(),
  upstreamSecret: z.string().min(1).max(4_000).optional().nullable()
});

const endpointCreateSchema = endpointSchemaInput;

const endpointUpdateSchema = endpointSchemaInput
  .omit({
    mode: true
  })
  .partial()
  .extend({
    clearUpstreamSecret: z.boolean().optional()
  });

const reviewRequestSchema = z.object({
  reviewNotes: z.string().min(3).max(4_000),
  reviewerIdentity: z.string().min(1).max(120).optional().nullable()
});

const publishSchema = z.object({
  reviewerIdentity: z.string().min(1).max(120).optional().nullable()
});

const suspendSchema = z.object({
  reviewNotes: z.string().min(1).max(4_000).optional().nullable(),
  reviewerIdentity: z.string().min(1).max(120).optional().nullable()
});

export function createMarketplaceApi(options: MarketplaceApiOptions): Express {
  const app = express();
  const providers = options.providers ?? createDefaultProviderRegistry();
  const baseUrl = options.baseUrl ?? "http://localhost:3000";
  const webBaseUrl = options.webBaseUrl ?? baseUrl;
  const allowedWebOrigin = safeOrigin(webBaseUrl);
  const networkConfig = getDefaultMarketplaceNetworkConfig();
  const secretsKey = options.secretsKey ?? "development-marketplace-secrets-key";
  const tavilyEnabled = Boolean(options.tavilyApiKey);

  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (origin && origin === allowedWebOrigin) {
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
          PAYMENT_RESPONSE_HEADER,
          LEGACY_PAYMENT_HEADER,
          LEGACY_PAYMENT_IDENTIFIER_HEADER,
          LEGACY_PAYMENT_RESPONSE_HEADER
        ].join(", ")
      );
      res.setHeader(
        "Access-Control-Expose-Headers",
        [PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER, LEGACY_PAYMENT_RESPONSE_HEADER].join(", ")
      );
    }

    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }

    return next();
  });

  app.get("/openapi.json", async (_req, res) => {
    const catalog = filterVisibleCatalog(await loadPublishedCatalog(options.store), tavilyEnabled);
    res.json(
      buildOpenApiDocument({
        baseUrl,
        services: catalog.services,
        routes: catalog.routes
      })
    );
  });

  app.get("/llms.txt", async (_req, res) => {
    const catalog = filterVisibleCatalog(await loadPublishedCatalog(options.store), tavilyEnabled);
    res.type("text/plain").send(
      buildLlmsTxt({
        baseUrl,
        services: catalog.services,
        routes: catalog.routes
      })
    );
  });

  app.get("/.well-known/marketplace.json", async (_req, res) => {
    const catalog = filterVisibleCatalog(await loadPublishedCatalog(options.store), tavilyEnabled);
    res.json(
      buildMarketplaceCatalog({
        baseUrl,
        services: catalog.services,
        routes: catalog.routes
      })
    );
  });

  app.get("/catalog/services", async (_req, res) => {
    const catalog = filterVisibleCatalog(await loadPublishedCatalog(options.store), tavilyEnabled);

    const services = await Promise.all(
      catalog.services.map(async (service) =>
        buildServiceSummary({
          service,
          endpoints: catalog.routes.filter((route) => route.serviceVersionId === service.versionId),
          analytics: await options.store.getServiceAnalytics(service.routeIds)
        })
      )
    );

    return res.json({ services });
  });

  app.get("/catalog/services/:slug", async (req, res) => {
    const published = await options.store.getPublishedServiceBySlug(req.params.slug);
    const visible = published ? filterVisibleServiceDetail(published, tavilyEnabled) : null;
    if (!visible) {
      return res.status(404).json({ error: "Service not found." });
    }

    const detail = buildServiceDetail({
      service: visible.service,
      endpoints: visible.endpoints,
      analytics: await options.store.getServiceAnalytics(visible.service.routeIds),
      apiBaseUrl: baseUrl,
      webBaseUrl
    });

    return res.json(detail);
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
      if (!published || !filterVisibleServiceDetail(published, tavilyEnabled)) {
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

    if (resourceType !== "job" || !wallet || !resourceId) {
      return res.status(400).json({ error: "wallet, resourceType=job, and resourceId are required" });
    }

    let normalizedWallet: string;
    try {
      normalizedWallet = normalizeFastWalletAddress(wallet);
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : "Invalid wallet address."
      });
    }

    const accessGrant = await options.store.getAccessGrant("job", resourceId, normalizedWallet);
    if (!accessGrant) {
      return res.status(403).json({ error: "No paid access grant exists for that wallet and resource." });
    }

    return res.json(createChallenge({ wallet: normalizedWallet, resourceType: "job", resourceId }));
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

    if (resourceType !== "job" || !wallet || !signature || !nonce || !expiresAt || !resourceId) {
      return res.status(400).json({
        error: "wallet, signature, nonce, expiresAt, resourceType=job, and resourceId are required"
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

    const accessGrant = await options.store.getAccessGrant("job", resourceId, normalizedWallet);
    if (!accessGrant) {
      return res.status(403).json({ error: "No paid access grant exists for that wallet and resource." });
    }

    const verified = await verifyWalletChallenge({
      wallet: normalizedWallet,
      signature,
      challenge: {
        wallet: normalizedWallet,
        resourceType: "job",
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
        resourceType: "job",
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

    let payoutWallet: string;
    try {
      payoutWallet = normalizeFastWalletAddress(parsed.data.payoutWallet);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid payout wallet." });
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

    if (
      parsed.data.apiNamespace &&
      parsed.data.apiNamespace !== existing.service.apiNamespace &&
      existing.endpoints.length > 0
    ) {
      return res.status(409).json({ error: "apiNamespace cannot change after endpoints exist." });
    }

    let payoutWallet = parsed.data.payoutWallet;
    if (payoutWallet) {
      try {
        payoutWallet = normalizeFastWalletAddress(payoutWallet);
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid payout wallet." });
      }
    }

    const updated = await options.store.updateProviderServiceForOwner(req.params.id, session.wallet, {
      ...parsed.data,
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

    const parsed = endpointCreateSchema.safeParse(req.body ?? {});
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

    const parsed = endpointUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Endpoint validation failed.", issues: parsed.error.issues });
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

    const latestVerification = await options.store.getLatestProviderVerification(req.params.id);
    if (!latestVerification) {
      return res.status(400).json({ error: "Create a verification challenge first." });
    }

    const serviceHost = new URL(detail.service.websiteUrl).host;
    const expectedUrl = `https://${serviceHost}/.well-known/fast-marketplace-verification.txt`;

    try {
      const verificationResponse = await fetch(expectedUrl);
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

    const updated = await options.store.publishProviderService(req.params.id, parsed.data);
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

  app.post("/api/:provider/:operation", async (req, res) => {
    const route = await options.store.findPublishedRoute(
      req.params.provider,
      req.params.operation,
      networkConfig.paymentNetwork
    );
    if (!route) {
      return res.status(404).json({ error: "Route not found." });
    }

    if (!isRouteVisible(route, tavilyEnabled)) {
      return res.status(404).json({ error: "Route not found." });
    }

    try {
      validateJsonSchema({
        schema: route.requestSchemaJson,
        value: req.body ?? {},
        label: "Request body"
      });
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : "Request body validation failed."
      });
    }

    const paymentHeaders = normalizePaymentHeaders(
      req.headers as Record<string, string | string[] | undefined>
    );
    if (!paymentHeaders.paymentPayload) {
      const requiredBody = buildPaymentRequiredResponse(route, options.payTo);
      return res
        .status(402)
        .set(buildPaymentRequiredHeaders(route, options.payTo))
        .json(requiredBody);
    }

    if (!paymentHeaders.paymentId) {
      return res.status(400).json({
        error: "PAYMENT-IDENTIFIER is required for paid trigger routes."
      });
    }

    const paymentRequirement = buildPaymentRequirementForRoute(route, options.payTo);
    const verifyResult = await options.facilitatorClient.verify(
      paymentHeaders.paymentPayload,
      paymentRequirement
    );

    if (!verifyResult.isValid || !verifyResult.payer) {
      return res
        .status(402)
        .set(buildPaymentRequiredHeaders(route, options.payTo))
        .json({
          ...buildPaymentRequiredResponse(route, options.payTo),
          error: verifyResult.invalidReason ?? "Payment verification failed."
        });
    }

    if (verifyResult.network && verifyResult.network !== route.network) {
      return res
        .status(402)
        .set(buildPaymentRequiredHeaders(route, options.payTo))
        .json({
          ...buildPaymentRequiredResponse(route, options.payTo),
          error: `Payment network mismatch. Expected ${route.network}, received ${verifyResult.network}.`
        });
    }

    let buyerWallet: string;
    try {
      buyerWallet = normalizeFastWalletAddress(verifyResult.payer);
    } catch (error) {
      return res.status(402).json({
        error: error instanceof Error ? error.message : "Invalid payer returned by facilitator."
      });
    }

    const requestHash = hashNormalizedRequest(route, req.body ?? {});
    const existing = await options.store.getIdempotencyByPaymentId(paymentHeaders.paymentId);
    if (existing) {
      return replayExistingResponse(existing, requestHash, buyerWallet, route.version, options.store, res);
    }

    const quotedPrice = quotedPriceRaw(route);
    const payoutSplit = buildPayoutSplit({
      route,
      marketplaceWallet: options.payTo,
      quotedPrice
    });

    const executeResult = await executeRoute({
      route,
      input: req.body ?? {},
      buyerWallet,
      paymentId: paymentHeaders.paymentId,
      providers,
      store: options.store,
      secretsKey,
      tavilyApiKey: options.tavilyApiKey
    });

    if (executeResult.kind === "sync") {
      if (executeResult.statusCode < 200 || executeResult.statusCode >= 400) {
        const failedResponse = await buildRejectedSyncResponse({
          executeResult,
          paymentId: paymentHeaders.paymentId,
          buyerWallet,
          quotedPrice,
          route,
          store: options.store,
          refundService: options.refundService
        });

        await options.store.saveSyncIdempotency({
          paymentId: paymentHeaders.paymentId,
          normalizedRequestHash: requestHash,
          buyerWallet,
          routeId: route.routeId,
          routeVersion: route.version,
          quotedPrice,
          payoutSplit,
          paymentPayload: paymentHeaders.paymentPayload,
          facilitatorResponse: verifyResult,
          statusCode: failedResponse.statusCode,
          body: failedResponse.body,
          headers: failedResponse.headers
        });

        return res.status(failedResponse.statusCode).set(failedResponse.headers).json(failedResponse.body);
      }

      const paymentResponseHeaders = buildPaymentResponseHeaders({
        success: true,
        network: route.network,
        payer: buyerWallet
      });

      const persisted = await options.store.saveSyncIdempotency({
        paymentId: paymentHeaders.paymentId,
        normalizedRequestHash: requestHash,
        buyerWallet,
        routeId: route.routeId,
        routeVersion: route.version,
        quotedPrice,
        payoutSplit,
        paymentPayload: paymentHeaders.paymentPayload,
        facilitatorResponse: verifyResult,
        statusCode: executeResult.statusCode,
        body: executeResult.body,
        headers: {
          ...paymentResponseHeaders,
          ...(executeResult.headers ?? {})
        }
      });

      return res
        .status(executeResult.statusCode)
        .set(persisted.responseHeaders)
        .json(executeResult.body);
    }

    const jobToken = createOpaqueToken("job");
    const acceptedBody = {
      jobToken,
      status: "pending",
      pollAfterMs: executeResult.pollAfterMs ?? 5_000
    };

    const paymentResponseHeaders = buildPaymentResponseHeaders({
      success: true,
      network: route.network,
      payer: buyerWallet
    });

    const { job } = await options.store.saveAsyncAcceptance({
      paymentId: paymentHeaders.paymentId,
      normalizedRequestHash: requestHash,
      buyerWallet,
      route,
      quotedPrice,
      payoutSplit,
      paymentPayload: paymentHeaders.paymentPayload,
      facilitatorResponse: verifyResult,
      jobToken,
      providerJobId: executeResult.providerJobId,
      requestBody: req.body ?? {},
      providerState: executeResult.state,
      responseBody: acceptedBody,
      responseHeaders: paymentResponseHeaders
    });

    await options.store.createAccessGrant({
      resourceType: "job",
      resourceId: job.jobToken,
      wallet: buyerWallet,
      paymentId: job.paymentId,
      metadata: {
        routeId: job.routeId
      }
    });

    await options.store.recordProviderAttempt({
      jobToken,
      phase: "execute",
      status: "succeeded",
      requestPayload: req.body ?? {},
      responsePayload: executeResult
    });

    return res.status(202).set(paymentResponseHeaders).json(acceptedBody);
  });

  app.use((error: unknown, _req: Request, res: ExpressResponse, _next: unknown) => {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unexpected marketplace error."
    });
  });

  return app;
}

async function loadPublishedCatalog(store: MarketplaceStore): Promise<{
  services: PublishedServiceVersionRecord[];
  routes: PublishedEndpointVersionRecord[];
}> {
  const [services, routes] = await Promise.all([store.listPublishedServices(), store.listPublishedRoutes()]);
  return { services, routes };
}

function isRouteVisible(route: Pick<MarketplaceRoute, "executorKind">, tavilyEnabled: boolean): boolean {
  if (route.executorKind === "tavily") {
    return tavilyEnabled;
  }

  return true;
}

function filterVisibleCatalog(input: {
  services: PublishedServiceVersionRecord[];
  routes: PublishedEndpointVersionRecord[];
}, tavilyEnabled: boolean): {
  services: PublishedServiceVersionRecord[];
  routes: PublishedEndpointVersionRecord[];
} {
  const routes = input.routes.filter((route) => isRouteVisible(route, tavilyEnabled));
  const routeIds = new Set(routes.map((route) => route.routeId));
  const services = input.services
    .map((service) => ({
      ...service,
      routeIds: service.routeIds.filter((routeId) => routeIds.has(routeId))
    }))
    .filter((service) => service.routeIds.length > 0);

  return { services, routes };
}

function filterVisibleServiceDetail(
  input: { service: PublishedServiceVersionRecord; endpoints: PublishedEndpointVersionRecord[] },
  tavilyEnabled: boolean
): { service: PublishedServiceVersionRecord; endpoints: PublishedEndpointVersionRecord[] } | null {
  const endpoints = input.endpoints.filter((endpoint) => isRouteVisible(endpoint, tavilyEnabled));
  if (endpoints.length === 0) {
    return null;
  }

  const routeIds = new Set(endpoints.map((endpoint) => endpoint.routeId));
  return {
    service: {
      ...input.service,
      routeIds: input.service.routeIds.filter((routeId) => routeIds.has(routeId))
    },
    endpoints
  };
}

async function executeMockRoute(
  route: MarketplaceRoute,
  input: unknown,
  buyerWallet: string,
  paymentId: string,
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
    paymentId
  });
}

async function executeRoute(input: {
  route: MarketplaceRoute;
  input: unknown;
  buyerWallet: string;
  paymentId: string;
  providers: ProviderRegistry;
  store: MarketplaceStore;
  secretsKey: string;
  tavilyApiKey?: string;
}) {
  switch (input.route.executorKind) {
    case "mock":
      return executeMockRoute(
        input.route,
        input.input,
        input.buyerWallet,
        input.paymentId,
        input.providers
      );
    case "http":
      return executeHttpRoute(input.route, input.input, input.store, input.secretsKey);
    case "tavily":
      return executeTavilyRoute(input.route, input.input, input.tavilyApiKey);
    default:
      throw new Error(`Unsupported route executor: ${String(input.route.executorKind)}`);
  }
}

async function executeHttpRoute(
  route: MarketplaceRoute,
  input: unknown,
  store: MarketplaceStore,
  secretsKey: string
) {
  if (route.mode !== "sync") {
    throw new Error("HTTP executor only supports sync routes in v1.");
  }

  if (!route.upstreamBaseUrl || !route.upstreamPath || !route.upstreamAuthMode) {
    throw new Error("HTTP route is missing upstream configuration.");
  }

  const headers: Record<string, string> = {
    "content-type": "application/json"
  };

  if (route.upstreamAuthMode !== "none") {
    if (!route.upstreamSecretRef) {
      throw new Error("HTTP route is missing upstream secret.");
    }

    const secret = await store.getProviderSecret(route.upstreamSecretRef);
    if (!secret) {
      throw new Error("Upstream secret not found.");
    }

    const decrypted = decryptSecret({
      ciphertext: secret.secretCiphertext,
      iv: secret.iv,
      authTag: secret.authTag,
      secret: secretsKey
    });

    applyUpstreamAuthHeaders(headers, route.upstreamAuthMode, decrypted, route.upstreamAuthHeaderName ?? null);
  }

  let response: globalThis.Response;
  try {
    response = await fetch(joinUrl(route.upstreamBaseUrl, route.upstreamPath), {
      method: "POST",
      headers,
      body: JSON.stringify(input)
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

  return {
    kind: "sync" as const,
    statusCode: response.status,
    body: await safeResponseBody(response),
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json"
    }
  };
}

async function executeTavilyRoute(route: MarketplaceRoute, input: unknown, tavilyApiKey?: string) {
  if (route.mode !== "sync") {
    throw new Error("Tavily executor only supports sync routes in v1.");
  }

  if (!tavilyApiKey) {
    return {
      kind: "sync" as const,
      statusCode: 503,
      body: {
        error: "Tavily API key is not configured."
      },
      headers: {
        "content-type": "application/json"
      }
    };
  }

  let response: globalThis.Response;
  try {
    response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        authorization: `Bearer ${tavilyApiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(input)
    });
  } catch (error) {
    return {
      kind: "sync" as const,
      statusCode: 502,
      body: {
        error: error instanceof Error ? error.message : "Tavily request failed."
      },
      headers: {
        "content-type": "application/json"
      }
    };
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

  try {
    const receipt = await input.refundService.issueRefund({
      wallet: input.buyerWallet,
      amount: input.quotedPrice,
      reason: `Sync upstream request rejected for ${input.route.routeId}.`
    });
    const sentRefund = await input.store.markRefundSent(refund.id, receipt.txHash);

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
    const failedRefund = await input.store.markRefundFailed(refund.id, message);

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
  service: { websiteUrl: string | null; apiNamespace: string };
  existingEndpoint: { upstreamSecretRef: string | null } | null;
  input:
    | z.infer<typeof endpointCreateSchema>
    | z.infer<typeof endpointUpdateSchema>;
}): Promise<{ ok: true } | { ok: false; statusCode: number; error: string }> {
  const nextAuthMode = input.input.upstreamAuthMode ?? "none";
  const nextWebsiteUrl = input.service.websiteUrl;

  if (!nextWebsiteUrl) {
    return { ok: false, statusCode: 400, error: "websiteUrl is required before managing endpoints." };
  }

  if (nextAuthMode === "header" && !input.input.upstreamAuthHeaderName) {
    return { ok: false, statusCode: 400, error: "upstreamAuthHeaderName is required when upstreamAuthMode=header." };
  }

  if (
    (nextAuthMode === "bearer" || nextAuthMode === "header") &&
    !input.input.upstreamSecret &&
    !input.existingEndpoint?.upstreamSecretRef
  ) {
    return { ok: false, statusCode: 400, error: "upstreamSecret is required for authenticated upstream routes." };
  }

  try {
    validateJsonSchema({
      schema: input.input.requestSchemaJson ?? {},
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

  const rootHost = new URL(nextWebsiteUrl).hostname;
  const upstreamHost = new URL(input.input.upstreamBaseUrl ?? nextWebsiteUrl).hostname;
  if (!isSameOrSubdomain(rootHost, upstreamHost)) {
    return {
      ok: false,
      statusCode: 400,
      error: "upstreamBaseUrl host must match the service website host or one of its subdomains."
    };
  }

  return { ok: true };
}

async function validateProviderServiceForSubmit(detail: ProviderServiceDetailRecord) {
  if (!detail.service.websiteUrl) {
    return { ok: false as const, statusCode: 400, error: "websiteUrl is required before submit." };
  }

  if (!detail.service.payoutWallet) {
    return { ok: false as const, statusCode: 400, error: "payoutWallet is required before submit." };
  }

  if (detail.endpoints.length === 0) {
    return { ok: false as const, statusCode: 400, error: "At least one endpoint is required before submit." };
  }

  const verification = detail.verification;
  if (!verification || verification.status !== "verified") {
    return { ok: false as const, statusCode: 400, error: "Verify website ownership before submit." };
  }

  const serviceHost = new URL(detail.service.websiteUrl).hostname;
  if (verification.verifiedHost !== serviceHost) {
    return {
      ok: false as const,
      statusCode: 400,
      error: "Website URL changed since verification. Re-verify ownership before submit."
    };
  }

  for (const endpoint of detail.endpoints) {
    if (endpoint.mode !== "sync") {
      return { ok: false as const, statusCode: 400, error: "Provider-authored endpoints must be sync-only in v1." };
    }

    if (!endpoint.upstreamBaseUrl || !isSameOrSubdomain(serviceHost, new URL(endpoint.upstreamBaseUrl).hostname)) {
      return {
        ok: false as const,
        statusCode: 400,
        error: "All endpoint upstream hosts must match the service website host or a subdomain."
      };
    }
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

  return new URL(previousUrl).hostname !== new URL(nextUrl).hostname;
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

  if (record.responseKind === "job" && record.jobToken) {
    const job = await store.getJob(record.jobToken);
    return res.status(202).set(record.responseHeaders).json({
      jobToken: record.jobToken,
      status: job?.status ?? "pending"
    });
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
