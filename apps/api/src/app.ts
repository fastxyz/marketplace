import type { Express, Request, Response } from "express";
import express from "express";
import { verifyPayment } from "@fastxyz/x402-server";
import { z } from "zod";
import {
  buildServiceDetail,
  buildServiceSummary,
  buildLlmsTxt,
  buildMarketplaceCatalog,
  buildOpenApiDocument,
  buildPaymentRequiredHeaders,
  buildPaymentRequiredResponse,
  buildPaymentRequirementForRoute,
  buildPaymentResponseHeaders,
  buildPayoutSplit,
  getServiceDefinition,
  listServiceDefinitions,
  createChallenge,
  createOpaqueToken,
  createSessionToken,
  createDefaultProviderRegistry,
  findMarketplaceRoute,
  hashNormalizedRequest,
  normalizeFastWalletAddress,
  normalizePaymentHeaders,
  parseBearerToken,
  quotedPriceRaw,
  verifySessionToken,
  verifyWalletChallenge,
  type FacilitatorClient,
  type IdempotencyRecord,
  type JobRecord,
  type MarketplaceStore,
  type ProviderRegistry
} from "@marketplace/shared";

export interface MarketplaceApiOptions {
  store: MarketplaceStore;
  payTo: string;
  sessionSecret: string;
  adminToken: string;
  facilitatorClient: FacilitatorClient;
  providers?: ProviderRegistry;
  baseUrl?: string;
  webBaseUrl?: string;
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

export function createMarketplaceApi(options: MarketplaceApiOptions): Express {
  const app = express();
  const providers = options.providers ?? createDefaultProviderRegistry();
  const baseUrl = options.baseUrl ?? "http://localhost:3000";
  const webBaseUrl = options.webBaseUrl ?? baseUrl;

  app.use(express.json());

  app.get("/openapi.json", (_req, res) => {
    res.json(buildOpenApiDocument(baseUrl));
  });

  app.get("/llms.txt", (_req, res) => {
    res.type("text/plain").send(buildLlmsTxt(baseUrl));
  });

  app.get("/.well-known/marketplace.json", (_req, res) => {
    res.json(buildMarketplaceCatalog(baseUrl));
  });

  app.get("/catalog/services", async (_req, res) => {
    const services = await Promise.all(
      listServiceDefinitions().map(async (service) =>
        buildServiceSummary({
          service,
          analytics: await options.store.getServiceAnalytics(service.routeIds)
        })
      )
    );

    return res.json({ services });
  });

  app.get("/catalog/services/:slug", async (req, res) => {
    const service = getServiceDefinition(req.params.slug);
    if (!service) {
      return res.status(404).json({ error: "Service not found." });
    }

    const detail = buildServiceDetail({
      service,
      analytics: await options.store.getServiceAnalytics(service.routeIds),
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

    if (parsed.data.serviceSlug && !getServiceDefinition(parsed.data.serviceSlug)) {
      return res.status(400).json({ error: "Unknown serviceSlug." });
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
    const route = findMarketplaceRoute(req.params.provider, req.params.operation);
    if (!route) {
      return res.status(404).json({ error: "Route not found." });
    }

    const parsedBody = route.inputSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      return res.status(400).json({
        error: "Request body validation failed.",
        issues: parsedBody.error.issues
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

    const requestHash = hashNormalizedRequest(route, parsedBody.data);
    const existing = await options.store.getIdempotencyByPaymentId(paymentHeaders.paymentId);
    if (existing) {
      return replayExistingResponse(existing, requestHash, buyerWallet, route.version, options.store, res);
    }

    const provider = providers[route.provider];
    if (!provider) {
      return res.status(500).json({ error: `Provider adapter missing: ${route.provider}` });
    }

    const quotedPrice = quotedPriceRaw(route);
    const payoutSplit = buildPayoutSplit({
      route,
      marketplaceWallet: options.payTo,
      quotedPrice
    });

    const executeResult = await provider.execute({
      route,
      input: parsedBody.data,
      buyerWallet,
      paymentId: paymentHeaders.paymentId
    });

    if (executeResult.kind === "sync") {
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
      requestBody: parsedBody.data,
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
      requestPayload: parsedBody.data,
      responsePayload: executeResult
    });

    return res.status(202).set(paymentResponseHeaders).json(acceptedBody);
  });

  app.use((error: unknown, _req: Request, res: Response, _next: unknown) => {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unexpected marketplace error."
    });
  });

  return app;
}

async function replayExistingResponse(
  record: IdempotencyRecord,
  requestHash: string,
  buyerWallet: string,
  routeVersion: string,
  store: MarketplaceStore,
  res: Response
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

function requireAdminToken(req: Request, res: Response, adminToken: string): boolean {
  const token = parseBearerToken(req.header("authorization"));
  if (!token || token !== adminToken) {
    res.status(401).json({ error: "Missing or invalid admin token." });
    return false;
  }

  return true;
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
