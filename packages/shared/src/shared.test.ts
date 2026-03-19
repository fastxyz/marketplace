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

const TEST_PRIVATE_KEY = "11".repeat(32);

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
      marketplaceWallet: "fast1marketplacetreasury000000000000000000000000000000000000",
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
    const detail = buildServiceDetail({
      service,
      endpoints,
      analytics: {
        totalCalls: 12,
        revenueRaw: "420000",
        successRate30d: 66.666,
        volume30d: [{ date: "2026-03-18", amountRaw: "150000" }]
      },
      apiBaseUrl: "https://fastapi.8o.vc",
      webBaseUrl: "https://fast.8o.vc"
    });

    expect(buildPriceRange(endpoints)).toBe("$0.05 fastUSDC - $0.15 fastUSDC");
    expect(detail.skillUrl).toBe("https://fast.8o.vc/skill.md");
    expect(detail.summary.endpointCount).toBe(2);
    expect(detail.summary.settlementToken).toBe("fastUSDC");
    expect(detail.useThisServicePrompt).toContain('I want to use the "Mock Research Signals" service');
    expect(detail.useThisServicePrompt).toContain("https://fastapi.8o.vc/api/mock/quick-insight");
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
      endpoints: [tavilyRoute],
      analytics: {
        totalCalls: 3,
        revenueRaw: "150000",
        successRate30d: 100,
        volume30d: [{ date: "2026-03-18", amountRaw: "150000" }]
      },
      apiBaseUrl: "https://fastapi.8o.vc",
      webBaseUrl: "https://fast.8o.vc"
    });

    expect(detail.summary.endpointCount).toBe(1);
    expect(detail.endpoints[0]?.proxyUrl).toBe("https://fastapi.8o.vc/api/tavily/search");
    expect(detail.useThisServicePrompt).toContain("https://fastapi.8o.vc/api/tavily/search");
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
      payoutSplit: {
        currency: "fastUSDC",
        marketplaceWallet: "fast1market",
        marketplaceBps: 6000,
        marketplaceAmount: "30000",
        providerAccountId: "mock",
        providerWallet: null,
        providerBps: 4000,
        providerAmount: "20000"
      },
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
      payoutSplit: {
        currency: "fastUSDC",
        marketplaceWallet: "fast1market",
        marketplaceBps: 7334,
        marketplaceAmount: "110000",
        providerAccountId: "mock",
        providerWallet: null,
        providerBps: 2666,
        providerAmount: "40000"
      },
      paymentPayload: "payload",
      facilitatorResponse: { isValid: true },
      jobToken: "job_catalog_1",
      providerJobId: "provider_catalog_1",
      requestBody: { topic: "catalog analytics" },
      responseBody: { jobToken: "job_catalog_1", status: "pending" },
      responseHeaders: {}
    });

    await store.completeJob("job_catalog_1", { report: "done" });

    await store.saveSyncIdempotency({
      paymentId: "payment_sync_catalog_failed_1",
      normalizedRequestHash: "hash_sync_failed",
      buyerWallet: "fast1buyer00000000000000000000000000000000000000000000000000000000",
      routeId: "mock.quick-insight.v1",
      routeVersion: "v1",
      quotedPrice: "50000",
      payoutSplit: {
        currency: "fastUSDC",
        marketplaceWallet: "fast1market",
        marketplaceBps: 6000,
        marketplaceAmount: "30000",
        providerAccountId: "provider_marketplace",
        providerWallet: null,
        providerBps: 4000,
        providerAmount: "20000"
      },
      paymentPayload: "payload",
      facilitatorResponse: { isValid: true },
      statusCode: 502,
      body: { error: "refunded" }
    });

    const analytics = await store.getServiceAnalytics(["mock.quick-insight.v1", "mock.async-report.v1"]);
    expect(analytics.totalCalls).toBe(2);
    expect(analytics.revenueRaw).toBe("60000");
    expect(analytics.successRate30d).toBe(100);

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

  it("publishes provider snapshots and resolves them by api namespace and operation", async () => {
    const store = new InMemoryMarketplaceStore();
    const wallet = "fast1provider000000000000000000000000000000000000000000000000000000";

    await store.upsertProviderAccount(wallet, {
      displayName: "Signal Labs",
      websiteUrl: "https://provider.example.com"
    });

    const created = await store.createProviderService(wallet, {
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
      operation: "quote",
      title: "Quote",
      description: "Return a single quote snapshot.",
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
});
