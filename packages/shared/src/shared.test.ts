import { FastProvider, FastWallet } from "@fastxyz/sdk";
import { describe, expect, it } from "vitest";

import {
  InMemoryMarketplaceStore,
  buildPriceRange,
  buildMarketplaceRoutes,
  buildServiceDetail,
  buildOpenApiDocument,
  buildPayoutSplit,
  createChallenge,
  hashNormalizedRequest,
  listServiceDefinitions,
  marketplaceRoutes,
  normalizeFastWalletAddress,
  normalizePaymentHeaders,
  resolveMarketplaceNetworkConfig,
  validateJsonSchema,
  verifyWalletChallenge
} from "./index.js";
import type {
  MarketplaceRoute,
  ProviderEndpointDraftRecord,
  PublishedEndpointVersionRecord,
  PublishedServiceEndpointVersionRecord
} from "./index.js";

const TEST_PRIVATE_KEY = "11".repeat(32);
const TEST_TIMESTAMP = "2026-03-20T00:00:00.000Z";

async function createTestWallet() {
  const provider = new FastProvider({
    network: "mainnet",
    networks: {
      mainnet: {
        rpc: "https://api.fast.xyz/proxy",
        explorer: "https://explorer.fast.xyz"
      }
    }
  });

  const wallet = await FastWallet.fromPrivateKey(TEST_PRIVATE_KEY, provider);
  const exported = await wallet.exportKeys();
  return {
    wallet,
    address: wallet.address,
    publicKey: exported.publicKey
  };
}

function buildEscrowSplit(input: {
  providerAccountId: string;
  providerWallet: string | null;
  marketplaceAmount: string;
  providerAmount: string;
  marketplaceBps: number;
  providerBps: number;
}) {
  return {
    currency: "fastUSDC" as const,
    settlementMode: "verified_escrow" as const,
    paymentDestinationWallet: "fast1market",
    usesTreasurySettlement: true,
    marketplaceWallet: "fast1market",
    marketplaceBps: input.marketplaceBps,
    marketplaceAmount: input.marketplaceAmount,
    providerAccountId: input.providerAccountId,
    providerWallet: input.providerWallet,
    providerBps: input.providerBps,
    providerAmount: input.providerAmount
  };
}

function buildPublishedEndpointFromRoute(
  route: MarketplaceRoute,
  overrides: Partial<PublishedEndpointVersionRecord> = {}
): PublishedEndpointVersionRecord {
  return {
    endpointType: "marketplace_proxy",
    endpointVersionId: overrides.endpointVersionId ?? `published_${route.routeId}`,
    serviceId: overrides.serviceId ?? "service_test",
    serviceVersionId: overrides.serviceVersionId ?? "service_version_test",
    endpointDraftId: overrides.endpointDraftId ?? `draft_${route.routeId}`,
    ...route,
    createdAt: overrides.createdAt ?? TEST_TIMESTAMP,
    updatedAt: overrides.updatedAt ?? TEST_TIMESTAMP,
    ...overrides
  };
}

function expectMarketplaceCatalogEndpoint(
  endpoint: PublishedServiceEndpointVersionRecord | ProviderEndpointDraftRecord | undefined | null
) {
  expect(endpoint?.endpointType).toBe("marketplace_proxy");
  return endpoint as Extract<
    PublishedServiceEndpointVersionRecord | ProviderEndpointDraftRecord,
    { endpointType: "marketplace_proxy" }
  >;
}

describe("shared marketplace helpers", () => {
  it("normalizes payment headers across new and legacy names", () => {
    expect(
      normalizePaymentHeaders({
        "payment-signature": "new-header",
        "x-payment-identifier": "legacy-id"
      })
    ).toEqual({
      paymentId: "legacy-id",
      paymentPayload: "new-header"
    });

    expect(
      normalizePaymentHeaders({
        "x-payment": "legacy-header",
        "payment-identifier": "new-id"
      })
    ).toEqual({
      paymentId: "new-id",
      paymentPayload: "legacy-header"
    });
  });

  it("hashes normalized requests deterministically", () => {
    const route = marketplaceRoutes[0];
    const first = hashNormalizedRequest(route, {
      query: "alpha",
      nested: {
        b: 2,
        a: 1
      }
    });
    const second = hashNormalizedRequest(route, {
      nested: {
        a: 1,
        b: 2
      },
      query: "alpha"
    });

    expect(first).toBe(second);
  });

  it("normalizes a hex Fast payer into a canonical bech32 address", async () => {
    const testWallet = await createTestWallet();
    expect(normalizeFastWalletAddress(`0x${testWallet.publicKey}`)).toBe(testWallet.address);
  });

  it("verifies a wallet challenge signature", async () => {
    const testWallet = await createTestWallet();
    const challenge = createChallenge({
      wallet: testWallet.address,
      resourceType: "job",
      resourceId: "job_123"
    });
    const signed = await testWallet.wallet.sign({ message: challenge.message });

    await expect(
      verifyWalletChallenge({
        wallet: testWallet.address,
        signature: signed.signature,
        challenge
      })
    ).resolves.toBe(true);
  });

  it("builds route entries into the OpenAPI document", () => {
    const document = buildOpenApiDocument({
      baseUrl: "http://localhost:3000",
      services: listServiceDefinitions(),
      routes: marketplaceRoutes
    });
    expect(document.paths["/api/mock/quick-insight"]).toBeDefined();
    expect(document.paths["/api/mock/async-report"]).toBeDefined();
    expect(document.paths["/api/tavily/search"]).toBeDefined();
    expect(document.paths["/catalog/services"]).toBeDefined();

    const asyncPath = document.paths["/api/mock/async-report"] as {
      post?: {
        responses?: Record<string, unknown>;
      };
    };
    const syncPaidPath = document.paths["/api/mock/quick-insight"] as {
      post?: {
        responses?: Record<string, unknown>;
      };
    };
    expect(asyncPath.post?.responses?.["202"]).toBeDefined();
    expect(asyncPath.post?.responses?.["200"]).toBeUndefined();
    expect(syncPaidPath.post?.responses?.["200"]).toBeDefined();
    expect(syncPaidPath.post?.responses?.["202"]).toBeDefined();
  });

  it("describes free routes without x402 headers or token pricing", () => {
    const seededService = listServiceDefinitions().find((candidate) => candidate.slug === "mock-research-signals");
    const seededRoute = marketplaceRoutes.find((candidate) => candidate.routeId === "mock.quick-insight.v1");
    if (!seededService || !seededRoute) {
      throw new Error("Mock seeded service is missing.");
    }

    const freeRoute = {
      ...seededRoute,
      routeId: "mock.free-insight.v1",
      operation: "free-insight",
      billing: {
        type: "free" as const
      },
      price: "Free"
    };
    const freeService = {
      ...seededService,
      slug: "mock-free-signals",
      routeIds: [freeRoute.routeId]
    };

    const document = buildOpenApiDocument({
      baseUrl: "https://api.marketplace.example.com",
      services: [freeService],
      routes: [freeRoute]
    });
    const freePath = document.paths["/api/mock/free-insight"] as {
      post?: {
        responses?: Record<string, unknown>;
        parameters?: unknown[];
      };
    };

    expect(freePath.post?.responses?.["402"]).toBeUndefined();
    expect(freePath.post?.responses?.["202"]).toBeUndefined();
    expect(freePath.post?.parameters).toEqual([]);

    const detail = buildServiceDetail({
      service: freeService,
      endpoints: [buildPublishedEndpointFromRoute(freeRoute)],
      analytics: {
        totalCalls: 0,
        revenueRaw: "0",
        successRate30d: 0,
        volume30d: []
      },
      apiBaseUrl: "https://api.marketplace.example.com",
      webBaseUrl: "https://marketplace.example.com"
    });

    expect(detail.summary.priceRange).toBe("Free");
    expect(detail.useThisServicePrompt).toContain("(Free)");
    expect(detail.useThisServicePrompt).not.toContain("(Free fastUSDC)");
    expect(detail.useThisServicePrompt).toContain("No payment headers are required.");
  });

  it("builds testnet routes when the deployment targets testnet", () => {
    const routes = buildMarketplaceRoutes(
      resolveMarketplaceNetworkConfig({
        deploymentNetwork: "testnet"
      })
    );

    expect(routes[0]?.network).toBe("fast-testnet");
  });

  it("freezes payout split amounts from the quoted price", () => {
    const split = buildPayoutSplit({
      route: marketplaceRoutes[0],
      treasuryWallet: "fast1marketplacetreasury000000000000000000000000000000000000",
      paymentDestinationWallet: "fast1marketplacetreasury000000000000000000000000000000000000",
      quotedPrice: "50000"
    });

    expect(split.providerBps).toBe(0);
    expect(split.marketplaceAmount).toBe("50000");
    expect(split.providerAmount).toBe("0");
  });

  it("builds service catalog summaries and prompts from the shared registry", () => {
    const service = listServiceDefinitions().find((candidate) => candidate.slug === "mock-research-signals");
    if (!service) {
      throw new Error("Mock seeded service is missing.");
    }

    const endpoints = marketplaceRoutes.filter((route) => service.routeIds.includes(route.routeId));
    const publishedEndpoints = endpoints.map((endpoint) => buildPublishedEndpointFromRoute(endpoint));
    const detail = buildServiceDetail({
      service,
      endpoints: publishedEndpoints,
      analytics: {
        totalCalls: 12,
        revenueRaw: "420000",
        successRate30d: 66.666,
        volume30d: [{ date: "2026-03-18", amountRaw: "150000" }]
      },
      apiBaseUrl: "https://api.marketplace.example.com",
      webBaseUrl: "https://marketplace.example.com"
    });

    expect(buildPriceRange(endpoints)).toBe("$0.05 fastUSDC - $0.15 fastUSDC");
    expect(detail.skillUrl).toBe("https://marketplace.example.com/skill.md");
    expect(detail.summary.endpointCount).toBe(2);
    expect(detail.summary.settlementToken).toBe("fastUSDC");
    expect(detail.useThisServicePrompt).toContain('I want to use the "Mock Research Signals" service');
    expect(detail.useThisServicePrompt).toContain("https://api.marketplace.example.com/api/mock/quick-insight");
    expect(detail.useThisServicePrompt).toContain("($0.05 fastUSDC)");
  });

  it("publishes the seeded Tavily service from the shared registry", () => {
    const tavilyService = listServiceDefinitions().find((service) => service.slug === "tavily-search");
    if (!tavilyService) {
      throw new Error("Tavily seeded service is missing.");
    }

    const tavilyRoute = marketplaceRoutes.find((route) => route.routeId === "tavily.search.v1");
    if (!tavilyRoute) {
      throw new Error("Tavily seeded route is missing.");
    }

    expect(tavilyRoute.executorKind).toBe("tavily");

    const detail = buildServiceDetail({
      service: tavilyService,
      endpoints: [buildPublishedEndpointFromRoute(tavilyRoute)],
      analytics: {
        totalCalls: 3,
        revenueRaw: "150000",
        successRate30d: 100,
        volume30d: [{ date: "2026-03-18", amountRaw: "150000" }]
      },
      apiBaseUrl: "https://api.marketplace.example.com",
      webBaseUrl: "https://marketplace.example.com"
    });

    expect(detail.summary.endpointCount).toBe(1);
    const endpoint = detail.endpoints[0];
    expect(endpoint?.endpointType).toBe("marketplace_proxy");
    expect(endpoint && "proxyUrl" in endpoint ? endpoint.proxyUrl : null).toBe("https://api.marketplace.example.com/api/tavily/search");
    expect(detail.useThisServicePrompt).toContain("https://api.marketplace.example.com/api/tavily/search");
  });

  it("rejects invalid Tavily request combinations in the shared schema", () => {
    const tavilyRoute = marketplaceRoutes.find((route) => route.routeId === "tavily.search.v1");
    if (!tavilyRoute) {
      throw new Error("Tavily seeded route is missing.");
    }

    expect(() =>
      validateJsonSchema({
        schema: tavilyRoute.requestSchemaJson,
        value: {
          query: "fast payments",
          country: "united states"
        },
        label: "Request body"
      })
    ).not.toThrow();

    expect(() =>
      validateJsonSchema({
        schema: tavilyRoute.requestSchemaJson,
        value: {
          query: "fast payments",
          topic: "news",
          country: "united states"
        },
        label: "Request body"
      })
    ).toThrow(/schema validation/i);

    expect(() =>
      validateJsonSchema({
        schema: tavilyRoute.requestSchemaJson,
        value: {
          query: "fast payments",
          country: "us"
        },
        label: "Request body"
      })
    ).toThrow(/schema validation/i);

    expect(() =>
      validateJsonSchema({
        schema: tavilyRoute.requestSchemaJson,
        value: {
          query: "fast payments",
          search_depth: "basic",
          chunks_per_source: 2
        },
        label: "Request body"
      })
    ).toThrow(/schema validation/i);
  });

  it("computes service analytics and provider request queue state in the in-memory store", async () => {
    const store = new InMemoryMarketplaceStore();

    await store.saveSyncIdempotency({
      paymentId: "payment_sync_catalog_1",
      normalizedRequestHash: "hash_sync",
      buyerWallet: "fast1buyer00000000000000000000000000000000000000000000000000000000",
      routeId: "mock.quick-insight.v1",
      routeVersion: "v1",
      quotedPrice: "50000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 6000,
        marketplaceAmount: "30000",
        providerBps: 4000,
        providerAmount: "20000"
      }),
      paymentPayload: "payload",
      facilitatorResponse: { isValid: true },
      statusCode: 200,
      body: { ok: true }
    });

    await store.saveAsyncAcceptance({
      paymentId: "payment_async_catalog_1",
      normalizedRequestHash: "hash_async",
      buyerWallet: "fast1buyer00000000000000000000000000000000000000000000000000000000",
      route: marketplaceRoutes[1],
      quotedPrice: "150000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 7334,
        marketplaceAmount: "110000",
        providerBps: 2666,
        providerAmount: "40000"
      }),
      paymentPayload: "payload",
      facilitatorResponse: { isValid: true },
      jobToken: "job_catalog_1",
      providerJobId: "provider_catalog_1",
      requestBody: { topic: "catalog analytics" },
      responseBody: { jobToken: "job_catalog_1", status: "pending" },
      responseHeaders: {}
    });

    expect(
      await store.getAccessGrant(
        "job",
        "job_catalog_1",
        "fast1buyer00000000000000000000000000000000000000000000000000000000"
      )
    ).not.toBeNull();

    await store.completeJob("job_catalog_1", { report: "done" });

    await store.saveSyncIdempotency({
      paymentId: "payment_sync_catalog_failed_1",
      normalizedRequestHash: "hash_sync_failed",
      buyerWallet: "fast1buyer00000000000000000000000000000000000000000000000000000000",
      routeId: "mock.quick-insight.v1",
      routeVersion: "v1",
      quotedPrice: "50000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "provider_marketplace",
        providerWallet: null,
        marketplaceBps: 6000,
        marketplaceAmount: "30000",
        providerBps: 4000,
        providerAmount: "20000"
      }),
      paymentPayload: "payload",
      facilitatorResponse: { isValid: true },
      statusCode: 502,
      body: { error: "refunded" }
    });

    await store.recordProviderAttempt({
      routeId: "mock.quick-insight.v1",
      requestId: "free_request_catalog_1",
      responseStatusCode: 200,
      phase: "execute",
      status: "succeeded",
      requestPayload: { symbol: "FAST" },
      responsePayload: { ok: true }
    });

    await store.recordProviderAttempt({
      routeId: "mock.quick-insight.v1",
      requestId: "free_request_catalog_2",
      responseStatusCode: 502,
      phase: "execute",
      status: "failed",
      requestPayload: { symbol: "FAIL" },
      responsePayload: { error: "upstream failed" }
    });

    const pendingAttempt = await store.recordProviderAttempt({
      routeId: "mock.quick-insight.v1",
      requestId: "free_request_catalog_3",
      phase: "execute",
      status: "pending",
      requestPayload: { symbol: "LATE" }
    });
    const completedAttempt = await store.recordProviderAttempt({
      routeId: "mock.quick-insight.v1",
      requestId: "free_request_catalog_3",
      responseStatusCode: 200,
      phase: "execute",
      status: "succeeded",
      requestPayload: { symbol: "LATE" },
      responsePayload: { ok: true }
    });
    await store.recordProviderAttempt({
      routeId: "mock.quick-insight.v1",
      requestId: "free_request_catalog_4",
      phase: "execute",
      status: "pending",
      requestPayload: { symbol: "PENDING" }
    });

    const internalAttempts = (store as unknown as {
      attempts: Array<{ id: string; createdAt: string }>;
    }).attempts;
    const sharedCreatedAt = completedAttempt.createdAt;
    const stalePending = internalAttempts.find((attempt) => attempt.id === pendingAttempt.id);
    const resolvedAttempt = internalAttempts.find((attempt) => attempt.id === completedAttempt.id);
    if (!stalePending || !resolvedAttempt) {
      throw new Error("Expected recorded provider attempts.");
    }
    stalePending.createdAt = sharedCreatedAt;
    resolvedAttempt.createdAt = sharedCreatedAt;
    (store as unknown as {
      attempts: Array<{ id: string; createdAt: string }>;
    }).attempts = [
      resolvedAttempt,
      stalePending,
      ...internalAttempts.filter((attempt) => attempt.id !== pendingAttempt.id && attempt.id !== completedAttempt.id)
    ];

    const analytics = await store.getServiceAnalytics(["mock.quick-insight.v1", "mock.async-report.v1"]);
    expect(analytics.totalCalls).toBe(6);
    expect(analytics.revenueRaw).toBe("60000");
    expect(analytics.successRate30d).toBe(80);

    const created = await store.createSuggestion({
      type: "endpoint",
      serviceSlug: "mock-research-signals",
      title: "Add a historical trend endpoint",
      description: "Expose a historical trend snapshot for repeated market checks."
    });
    const provider = await store.upsertProviderAccount("fast1providerwallet000000000000000000000000000000000000000000000000", {
      displayName: "Signal Labs"
    });
    await store.upsertProviderAccount("fast1otherproviderwallet00000000000000000000000000000000000000000000", {
      displayName: "Other Provider"
    });
    const claimed = await store.claimProviderRequest(
      created.id,
      "fast1providerwallet000000000000000000000000000000000000000000000000"
    );
    const updated = await store.updateSuggestion(created.id, {
      internalNotes: "Assign to provider after mock launch."
    });
    const reopened = await store.updateSuggestion(created.id, {
      status: "submitted"
    });
    const reassigned = await store.claimProviderRequest(
      created.id,
      "fast1otherproviderwallet00000000000000000000000000000000000000000000"
    );
    await store.updateSuggestion(created.id, {
      status: "shipped"
    });

    expect(claimed?.status).toBe("reviewing");
    expect(claimed?.claimedByProviderAccountId).toBe(provider.id);
    expect(claimed?.claimedByProviderName).toBe("Signal Labs");
    expect(updated?.status).toBe("reviewing");
    expect(reopened?.claimedByProviderAccountId).toBeNull();
    expect(reassigned?.claimedByProviderName).toBe("Other Provider");
    expect((await store.listSuggestions()).length).toBe(1);
    expect((await store.listProviderRequests("fast1providerwallet000000000000000000000000000000000000000000000000")).length).toBe(0);
  });

  it("deduplicates refunds by payment id in the in-memory store", async () => {
    const store = new InMemoryMarketplaceStore();

    const first = await store.createRefund({
      paymentId: "payment_refund_1",
      wallet: "fast1buyer00000000000000000000000000000000000000000000000000000000",
      amount: "50000"
    });

    const second = await store.createRefund({
      jobToken: "job_refund_1",
      paymentId: "payment_refund_1",
      wallet: "fast1buyer00000000000000000000000000000000000000000000000000000000",
      amount: "50000"
    });

    expect(second.id).toBe(first.id);
    expect(second.paymentId).toBe(first.paymentId);
    expect(second.jobToken).toBeNull();
  });

  it("tracks prepaid credit balances across topup, reserve, capture, release, and expiry", async () => {
    const store = new InMemoryMarketplaceStore();
    const serviceId = "service_credit_1";
    const buyerWallet = "fast1buyer00000000000000000000000000000000000000000000000000000000";

    const topup = await store.createCreditTopup({
      serviceId,
      buyerWallet,
      currency: "fastUSDC",
      amount: "1000000",
      paymentId: "payment_credit_1"
    });
    expect(topup.account.availableAmount).toBe("1000000");
    expect(topup.account.reservedAmount).toBe("0");

    const reserved = await store.reserveCredit({
      serviceId,
      buyerWallet,
      currency: "fastUSDC",
      amount: "600000",
      idempotencyKey: "reserve_1",
      providerReference: "amazon-order-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    expect(reserved.account.availableAmount).toBe("400000");
    expect(reserved.account.reservedAmount).toBe("600000");

    const repeatedReserve = await store.reserveCredit({
      serviceId,
      buyerWallet,
      currency: "fastUSDC",
      amount: "600000",
      idempotencyKey: "reserve_1",
      providerReference: "amazon-order-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    expect(repeatedReserve.reservation.id).toBe(reserved.reservation.id);
    expect(repeatedReserve.account.availableAmount).toBe("400000");

    const captured = await store.captureCreditReservation({
      reservationId: reserved.reservation.id,
      amount: "400000"
    });
    expect(captured.account.availableAmount).toBe("600000");
    expect(captured.account.reservedAmount).toBe("0");
    expect(captured.reservation.status).toBe("captured");
    expect(captured.captureEntry.amount).toBe("400000");
    expect(captured.releaseEntry?.amount).toBe("200000");

    const releasable = await store.reserveCredit({
      serviceId,
      buyerWallet,
      currency: "fastUSDC",
      amount: "100000",
      idempotencyKey: "reserve_2",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const released = await store.releaseCreditReservation({
      reservationId: releasable.reservation.id
    });
    expect(released.reservation.status).toBe("released");
    expect(released.account.availableAmount).toBe("600000");

    const expirable = await store.reserveCredit({
      serviceId,
      buyerWallet,
      currency: "fastUSDC",
      amount: "50000",
      idempotencyKey: "reserve_3",
      expiresAt: new Date(Date.now() - 1_000).toISOString()
    });
    const expired = await store.expireCreditReservation(expirable.reservation.id);
    expect(expired.reservation.status).toBe("expired");
    expect(expired.account.availableAmount).toBe("600000");

    await expect(
      store.reserveCredit({
        serviceId,
        buyerWallet,
        currency: "fastUSDC",
        amount: "700000",
        idempotencyKey: "reserve_4",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      })
    ).rejects.toThrow("Insufficient prepaid credit");
  });

  it("deduplicates top-up credit by payment id", async () => {
    const store = new InMemoryMarketplaceStore();
    const serviceId = "service_credit_dedupe_1";
    const buyerWallet = "fast1buyer00000000000000000000000000000000000000000000000000000000";

    const first = await store.createCreditTopup({
      serviceId,
      buyerWallet,
      currency: "fastUSDC",
      amount: "250000",
      paymentId: "payment_credit_dedupe_1",
      metadata: {
        routeId: "orders.topup.v1"
      }
    });

    const second = await store.createCreditTopup({
      serviceId,
      buyerWallet,
      currency: "fastUSDC",
      amount: "999999",
      paymentId: "payment_credit_dedupe_1",
      metadata: {
        routeId: "orders.topup.v1"
      }
    });

    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry.amount).toBe("250000");
    expect(second.account.availableAmount).toBe("250000");
  });

  it("publishes provider snapshots and resolves them by api namespace and operation", async () => {
    const store = new InMemoryMarketplaceStore();
    const wallet = "fast1provider000000000000000000000000000000000000000000000000000000";

    await store.upsertProviderAccount(wallet, {
      displayName: "Signal Labs",
      websiteUrl: "https://provider.example.com"
    });

    const created = await store.createProviderService(wallet, {
      serviceType: "marketplace_proxy",
      slug: "signal-labs",
      apiNamespace: "signals",
      name: "Signal Labs",
      tagline: "Short-form market signals",
      about: "Provider-authored signal endpoints.",
      categories: ["Research"],
      promptIntro: 'I want to use the "Signal Labs" service on Fast Marketplace.',
      setupInstructions: ["Use a funded Fast wallet."],
      websiteUrl: "https://provider.example.com",
      payoutWallet: wallet
    });

    await store.createProviderEndpointDraft(created.service.id, wallet, {
      endpointType: "marketplace_proxy",
      operation: "quote",
      title: "Quote",
      description: "Return a single quote snapshot.",
      billingType: "fixed_x402",
      price: "$0.25",
      mode: "sync",
      requestSchemaJson: {
        type: "object",
        properties: {
          symbol: { type: "string" }
        },
        required: ["symbol"],
        additionalProperties: false
      },
      responseSchemaJson: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          price: { type: "number" }
        },
        required: ["symbol", "price"],
        additionalProperties: false
      },
      requestExample: { symbol: "FAST" },
      responseExample: { symbol: "FAST", price: 42.5 },
      upstreamBaseUrl: "https://provider.example.com",
      upstreamPath: "/api/quote",
      upstreamAuthMode: "none"
    });

    await store.createProviderVerificationChallenge(created.service.id, wallet);
    await store.markProviderVerificationResult(created.service.id, "verified", {
      verifiedHost: "provider.example.com"
    });
    await store.submitProviderService(created.service.id, wallet);
    await store.publishProviderService(created.service.id, {
      reviewerIdentity: "ops@test"
    });

    const published = await store.findPublishedRoute("signals", "quote", "fast-mainnet");
    expect(published?.routeId).toBe("signals.quote.v1");

    const publicService = await store.getPublishedServiceBySlug("signal-labs");
    expect(publicService?.service.status).toBe("published");
    expect(publicService?.endpoints).toHaveLength(1);
  });

  it("publishes external registry services without creating executable marketplace routes", async () => {
    const store = new InMemoryMarketplaceStore();
    const wallet = "fast1provider000000000000000000000000000000000000000000000000000000";

    await store.upsertProviderAccount(wallet, {
      displayName: "Signal Labs",
      websiteUrl: "https://provider.example.com"
    });

    const created = await store.createProviderService(wallet, {
      serviceType: "external_registry",
      slug: "signal-labs-direct",
      name: "Signal Labs Direct",
      tagline: "Discovery-only external endpoints",
      about: "Direct provider APIs listed in the marketplace catalog without proxy execution.",
      categories: ["Research"],
      promptIntro: 'I want to use the "Signal Labs Direct" service.',
      setupInstructions: ["Read the provider docs before calling the API directly."],
      websiteUrl: "https://provider.example.com"
    });

    await store.createProviderEndpointDraft(created.service.id, wallet, {
      endpointType: "external_registry",
      title: "Status",
      description: "Returns service status directly from the provider.",
      method: "GET",
      publicUrl: "https://provider.example.com/api/status",
      docsUrl: "https://provider.example.com/docs/status",
      authNotes: "Bearer token required.",
      requestExample: {},
      responseExample: { status: "ok" }
    });

    await store.createProviderVerificationChallenge(created.service.id, wallet);
    await store.markProviderVerificationResult(created.service.id, "verified", {
      verifiedHost: "provider.example.com"
    });
    await store.submitProviderService(created.service.id, wallet);
    await store.publishProviderService(created.service.id, {
      reviewerIdentity: "ops@test"
    });

    const published = await store.getPublishedServiceBySlug("signal-labs-direct");
    expect(published?.service.serviceType).toBe("external_registry");
    expect(published?.service.routeIds).toEqual([]);
    expect(published?.endpoints).toHaveLength(1);
    expect(published?.endpoints[0]?.endpointType).toBe("external_registry");

    const route = await store.findPublishedRoute("signal-labs-direct", "status", "fast-mainnet");
    expect(route).toBeNull();
  });

  it("resolves published services by the published snapshot slug even after draft slug edits", async () => {
    const store = new InMemoryMarketplaceStore();
    const wallet = "fast1provider000000000000000000000000000000000000000000000000000000";

    await store.upsertProviderAccount(wallet, {
      displayName: "Signal Labs",
      websiteUrl: "https://provider.example.com"
    });

    const created = await store.createProviderService(wallet, {
      serviceType: "marketplace_proxy",
      slug: "signal-labs",
      apiNamespace: "signals",
      name: "Signal Labs",
      tagline: "Short-form market signals",
      about: "Provider-authored signal endpoints.",
      categories: ["Research"],
      promptIntro: 'I want to use the "Signal Labs" service on Fast Marketplace.',
      setupInstructions: ["Use a funded Fast wallet."],
      websiteUrl: "https://provider.example.com",
      payoutWallet: wallet
    });

    await store.createProviderEndpointDraft(created.service.id, wallet, {
      endpointType: "marketplace_proxy",
      operation: "quote",
      title: "Quote",
      description: "Return a single quote snapshot.",
      billingType: "fixed_x402",
      price: "$0.25",
      mode: "sync",
      requestSchemaJson: {
        type: "object",
        properties: {
          symbol: { type: "string" }
        },
        required: ["symbol"],
        additionalProperties: false
      },
      responseSchemaJson: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          price: { type: "number" }
        },
        required: ["symbol", "price"],
        additionalProperties: false
      },
      requestExample: { symbol: "FAST" },
      responseExample: { symbol: "FAST", price: 42.5 },
      upstreamBaseUrl: "https://provider.example.com",
      upstreamPath: "/api/quote",
      upstreamAuthMode: "none"
    });

    await store.createProviderVerificationChallenge(created.service.id, wallet);
    await store.markProviderVerificationResult(created.service.id, "verified", {
      verifiedHost: "provider.example.com"
    });
    await store.submitProviderService(created.service.id, wallet);
    await store.publishProviderService(created.service.id, {
      reviewerIdentity: "ops@test"
    });

    await store.updateProviderServiceForOwner(created.service.id, wallet, {
      slug: "signal-labs-next"
    });

    const publishedByOriginalSlug = await store.getPublishedServiceBySlug("signal-labs");
    const publishedByDraftSlug = await store.getPublishedServiceBySlug("signal-labs-next");

    expect(publishedByOriginalSlug?.service.slug).toBe("signal-labs");
    expect(publishedByOriginalSlug?.endpoints).toHaveLength(1);
    expect(publishedByDraftSlug).toBeNull();
  });

  it("keeps a live published slug reserved after the next draft slug changes", async () => {
    const store = new InMemoryMarketplaceStore();
    const wallet = "fast1provider000000000000000000000000000000000000000000000000000000";

    await store.upsertProviderAccount(wallet, {
      displayName: "Signal Labs",
      websiteUrl: "https://provider.example.com"
    });

    const created = await store.createProviderService(wallet, {
      serviceType: "marketplace_proxy",
      slug: "signal-labs",
      apiNamespace: "signals",
      name: "Signal Labs",
      tagline: "Short-form market signals",
      about: "Provider-authored signal endpoints.",
      categories: ["Research"],
      promptIntro: 'I want to use the "Signal Labs" service on Fast Marketplace.',
      setupInstructions: ["Use a funded Fast wallet."],
      websiteUrl: "https://provider.example.com",
      payoutWallet: wallet
    });

    await store.createProviderEndpointDraft(created.service.id, wallet, {
      endpointType: "marketplace_proxy",
      operation: "quote",
      title: "Quote",
      description: "Return a single quote snapshot.",
      billingType: "fixed_x402",
      price: "$0.25",
      mode: "sync",
      requestSchemaJson: {
        type: "object",
        properties: {
          symbol: { type: "string" }
        },
        required: ["symbol"],
        additionalProperties: false
      },
      responseSchemaJson: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          price: { type: "number" }
        },
        required: ["symbol", "price"],
        additionalProperties: false
      },
      requestExample: { symbol: "FAST" },
      responseExample: { symbol: "FAST", price: 42.5 },
      upstreamBaseUrl: "https://provider.example.com",
      upstreamPath: "/api/quote",
      upstreamAuthMode: "none"
    });

    await store.createProviderVerificationChallenge(created.service.id, wallet);
    await store.markProviderVerificationResult(created.service.id, "verified", {
      verifiedHost: "provider.example.com"
    });
    await store.submitProviderService(created.service.id, wallet);
    await store.publishProviderService(created.service.id, {
      reviewerIdentity: "ops@test"
    });
    await store.updateProviderServiceForOwner(created.service.id, wallet, {
      slug: "signal-labs-next"
    });

    await expect(
      store.createProviderService(wallet, {
        serviceType: "external_registry",
        slug: "signal-labs",
        name: "Signal Labs Direct",
        tagline: "Discovery-only external endpoints",
        about: "Direct provider APIs listed in the marketplace catalog without proxy execution.",
        categories: ["Research"],
        promptIntro: 'I want to use the "Signal Labs Direct" service.',
        setupInstructions: ["Read the provider docs before calling the API directly."],
        websiteUrl: "https://provider.example.com"
      })
    ).rejects.toThrow("Service slug already exists: signal-labs");
  });

  it("keeps a live published apiNamespace reserved after the next draft namespace changes", async () => {
    const store = new InMemoryMarketplaceStore();
    const wallet = "fast1provider000000000000000000000000000000000000000000000000000000";

    await store.upsertProviderAccount(wallet, {
      displayName: "Signal Labs",
      websiteUrl: "https://provider.example.com"
    });

    const created = await store.createProviderService(wallet, {
      serviceType: "marketplace_proxy",
      slug: "signal-labs-namespace",
      apiNamespace: "signals-namespace",
      name: "Signal Labs Namespace",
      tagline: "Short-form market signals",
      about: "Provider-authored signal endpoints.",
      categories: ["Research"],
      promptIntro: 'I want to use the "Signal Labs Namespace" service on Fast Marketplace.',
      setupInstructions: ["Use a funded Fast wallet."],
      websiteUrl: "https://provider.example.com",
      payoutWallet: wallet
    });

    const endpoint = await store.createProviderEndpointDraft(created.service.id, wallet, {
      endpointType: "marketplace_proxy",
      operation: "quote",
      title: "Quote",
      description: "Return a single quote snapshot.",
      billingType: "fixed_x402",
      price: "$0.25",
      mode: "sync",
      requestSchemaJson: {
        type: "object",
        properties: {
          symbol: { type: "string" }
        },
        required: ["symbol"],
        additionalProperties: false
      },
      responseSchemaJson: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          price: { type: "number" }
        },
        required: ["symbol", "price"],
        additionalProperties: false
      },
      requestExample: { symbol: "FAST" },
      responseExample: { symbol: "FAST", price: 42.5 },
      upstreamBaseUrl: "https://provider.example.com",
      upstreamPath: "/api/quote",
      upstreamAuthMode: "none"
    });

    await store.createProviderVerificationChallenge(created.service.id, wallet);
    await store.markProviderVerificationResult(created.service.id, "verified", {
      verifiedHost: "provider.example.com"
    });
    await store.submitProviderService(created.service.id, wallet);
    await store.publishProviderService(created.service.id, {
      reviewerIdentity: "ops@test"
    });
    await store.deleteProviderEndpointDraft(created.service.id, endpoint.id, wallet);
    await store.updateProviderServiceForOwner(created.service.id, wallet, {
      apiNamespace: "signals-namespace-next"
    });

    await expect(
      store.createProviderService(wallet, {
        serviceType: "marketplace_proxy",
        slug: "signal-labs-namespace-two",
        apiNamespace: "signals-namespace",
        name: "Signal Labs Namespace Two",
        tagline: "Short-form market signals",
        about: "Provider-authored signal endpoints.",
        categories: ["Research"],
        promptIntro: 'I want to use the "Signal Labs Namespace Two" service on Fast Marketplace.',
        setupInstructions: ["Use a funded Fast wallet."],
        websiteUrl: "https://provider.example.com",
        payoutWallet: wallet
      })
    ).rejects.toThrow("API namespace already exists: signals-namespace");
  });

  it("propagates service payout-wallet changes into existing endpoint drafts before submit", async () => {
    const store = new InMemoryMarketplaceStore();
    const wallet = "fast1provider000000000000000000000000000000000000000000000000000000";
    const replacementWallet = "fast1replacement00000000000000000000000000000000000000000000000000";

    await store.upsertProviderAccount(wallet, {
      displayName: "Signal Labs",
      websiteUrl: "https://provider.example.com"
    });

    const created = await store.createProviderService(wallet, {
      serviceType: "marketplace_proxy",
      slug: "signal-labs-wallet-sync",
      apiNamespace: "signals-wallet-sync",
      name: "Signal Labs Wallet Sync",
      tagline: "Provider payout wallet propagation.",
      about: "Provider-authored signal endpoints used to verify payout wallet propagation into drafts and snapshots.",
      categories: ["Research"],
      promptIntro: 'I want to use the "Signal Labs Wallet Sync" service on Fast Marketplace.',
      setupInstructions: ["Use a funded Fast wallet."],
      websiteUrl: "https://provider.example.com",
      payoutWallet: wallet
    });

    const endpoint = await store.createProviderEndpointDraft(created.service.id, wallet, {
      endpointType: "marketplace_proxy",
      operation: "quote",
      title: "Quote",
      description: "Return a single quote snapshot.",
      billingType: "fixed_x402",
      price: "$0.25",
      mode: "sync",
      requestSchemaJson: {
        type: "object",
        properties: {
          symbol: { type: "string" }
        },
        required: ["symbol"],
        additionalProperties: false
      },
      responseSchemaJson: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          price: { type: "number" }
        },
        required: ["symbol", "price"],
        additionalProperties: false
      },
      requestExample: { symbol: "FAST" },
      responseExample: { symbol: "FAST", price: 42.5 },
      upstreamBaseUrl: "https://provider.example.com",
      upstreamPath: "/api/quote",
      upstreamAuthMode: "none"
    });

    expect(expectMarketplaceCatalogEndpoint(endpoint).payout.providerWallet).toBe(wallet);

    await store.updateProviderServiceForOwner(created.service.id, wallet, {
      payoutWallet: replacementWallet
    });

    const updatedDetail = await store.getProviderServiceForOwner(created.service.id, wallet);
    expect(updatedDetail?.service.payoutWallet).toBe(replacementWallet);
    expect(expectMarketplaceCatalogEndpoint(updatedDetail?.endpoints[0]).payout.providerWallet).toBe(replacementWallet);

    await store.createProviderVerificationChallenge(created.service.id, wallet);
    await store.markProviderVerificationResult(created.service.id, "verified", {
      verifiedHost: "provider.example.com"
    });
    await store.submitProviderService(created.service.id, wallet);
    await store.publishProviderService(created.service.id, {
      reviewerIdentity: "ops@test",
      settlementMode: "community_direct"
    });

    const published = await store.getPublishedServiceBySlug("signal-labs-wallet-sync");
    expect(published?.service.payoutWallet).toBe(replacementWallet);
    expect(expectMarketplaceCatalogEndpoint(published?.endpoints[0]).payout.providerWallet).toBe(replacementWallet);
  });
});
